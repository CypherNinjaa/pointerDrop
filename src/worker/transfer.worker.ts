/**
 * Dedicated off-main-thread transfer engine.
 *
 * Responsibilities (sender):
 *   OS file pointer → 64 KB entropy probe → on-demand slice reads (with one-slice
 *   read-ahead) → optional WASM LZ4 block compression → 8-byte offset framing →
 *   watermark-gated dispatch, either
 *     • directly onto the 4 unordered RTCDataChannels when the browser supports
 *       transferable RTCDataChannels ("native" mode, channels live in this worker), or
 *     • to the UI thread as Transferable ArrayBuffers ("bridge" mode — zero-copy
 *       ownership hand-off), where the ChannelPool performs the socket write.
 *
 * Responsibilities (receiver):
 *   frame demux (offset header) → optional LZ4 decode straight out of WASM memory →
 *   random-access OPFS write via FileSystemSyncAccessHandle → finalize / deliver.
 */
import { ChannelPool } from '../engine/channelPool';
import { analyzeBlob } from '../engine/entropy';
import { decodeFrame } from '../engine/framing';
import { openDiskSink, purgeInbox, removeInboxFile, streamToHandle, opfsSupported, type DiskSink } from '../engine/opfsDiskStream';
import {
  DEGRADED_CHANNELS,
  DEGRADED_CHUNK,
  DEGRADED_RTT_MS,
  FRAME_HEADER_BYTES,
  HIGH_WATERMARK,
  CHANNEL_COUNT,
  type FromWorker,
  type ToWorker,
} from '../engine/protocol';
import { instantiateLz4, type Lz4Codec } from './lz4';
import lz4WasmUrl from './lz4.wasm?url';

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ToWorker>) => void): void;
}
const scope = self as unknown as WorkerScope;
const post = (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

const PROGRESS_INTERVAL_MS = 100;

let codec: Lz4Codec | null = null;
let lz4Error: string | undefined;

// ───────────────────────────── Link state ─────────────────────────────

interface LinkState {
  id: string;
  /** Present only in native mode (channels transferred into this worker). */
  pool: ChannelPool | null;
  /** Bridge-mode valve state, driven by the UI thread's ChannelPool. */
  paused: boolean;
  /** Unacknowledged bytes currently in flight across postMessage to the UI bridge. */
  inFlightBytes: number;
  resumeWaiters: Array<() => void>;
  rttMs: number;
  queueTimer: ReturnType<typeof setInterval> | null;
}

const links = new Map<string, LinkState>();

function getLink(linkId: string): LinkState {
  let link = links.get(linkId);
  if (!link) {
    link = { id: linkId, pool: null, paused: false, inFlightBytes: 0, resumeWaiters: [], rttMs: 0, queueTimer: null };
    links.set(linkId, link);
  }
  return link;
}

function releaseWaiters(link: LinkState): void {
  const waiters = link.resumeWaiters;
  link.resumeWaiters = [];
  for (const resolve of waiters) resolve();
}

// ───────────────────────────── Sender ─────────────────────────────

interface SendJob {
  id: string;
  linkId: string;
  file: File;
  compress: boolean;
  chunkSize: number;
  cancelled: boolean;
  userPaused: boolean;
  pauseWaiters: Array<() => void>;
  rawBytes: number;
  wireBytes: number;
  lastProgress: number;
}

const sendJobs = new Map<string, SendJob>();

function effectiveChunk(job: SendJob, link: LinkState): number {
  return link.rttMs > DEGRADED_RTT_MS ? Math.min(job.chunkSize, DEGRADED_CHUNK) : job.chunkSize;
}

function effectiveChannels(link: LinkState): number {
  return link.rttMs > DEGRADED_RTT_MS ? DEGRADED_CHANNELS : CHANNEL_COUNT;
}

async function waitForOpen(pool: ChannelPool, job: SendJob): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!pool.isOpen) {
    if (job.cancelled) return;
    if (performance.now() > deadline) throw new Error('Data channels did not open');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function gate(link: LinkState, job: SendJob): Promise<void> {
  while (!job.cancelled && job.userPaused) {
    await new Promise<void>((resolve) => job.pauseWaiters.push(resolve));
  }
  if (job.cancelled) return;
  if (link.pool) {
    while (!job.cancelled && !link.pool.canSend) {
      await link.pool.waitForDrain();
      while (!job.cancelled && job.userPaused) {
        await new Promise<void>((resolve) => job.pauseWaiters.push(resolve));
      }
    }
    return;
  }
  while (!job.cancelled && (link.paused || link.inFlightBytes >= HIGH_WATERMARK)) {
    await new Promise<void>((resolve) => link.resumeWaiters.push(resolve));
    while (!job.cancelled && job.userPaused) {
      await new Promise<void>((resolve) => job.pauseWaiters.push(resolve));
    }
  }
}

function emitSendProgress(job: SendJob, link: LinkState, force = false): void {
  const now = performance.now();
  if (!force && now - job.lastProgress < PROGRESS_INTERVAL_MS) return;
  job.lastProgress = now;
  post({
    type: 'send-progress',
    transferId: job.id,
    rawBytes: job.rawBytes,
    wireBytes: job.wireBytes,
    chunkSize: effectiveChunk(job, link),
    channels: link.pool ? link.pool.activeCount : effectiveChannels(link),
  });
}

async function runSend(job: SendJob): Promise<void> {
  const link = getLink(job.linkId);
  const size = job.file.size;
  const useLz4 = job.compress && codec !== null;
  if (job.compress && !codec) throw new Error('LZ4 codec unavailable in sender worker');

  if (link.pool) await waitForOpen(link.pool, job);

  const read = (offset: number, length: number) => job.file.slice(offset, offset + length).arrayBuffer();

  let offset = 0;
  let pending: Promise<ArrayBuffer> | null = size > 0 ? read(0, Math.min(effectiveChunk(job, link), size)) : null;

  while (offset < size && pending) {
    if (job.cancelled) return;
    const raw = new Uint8Array(await pending);
    if (raw.byteLength === 0) throw new Error('Source file shrank or became unreadable during transfer');
    const nextOffset = offset + raw.byteLength;

    // Read-ahead: the next disk slice loads while this one is compressed and dispatched.
    pending = nextOffset < size ? read(nextOffset, Math.min(effectiveChunk(job, link), size - nextOffset)) : null;

    let frame: ArrayBuffer;
    if (useLz4) {
      frame = codec!.compressFrame(raw, FRAME_HEADER_BYTES);
    } else {
      frame = new ArrayBuffer(FRAME_HEADER_BYTES + raw.byteLength);
      new Uint8Array(frame, FRAME_HEADER_BYTES).set(raw);
    }
    new DataView(frame).setFloat64(0, offset, false);
    const wireLength = frame.byteLength;

    await gate(link, job);
    if (job.cancelled) return;

    if (link.pool) {
      link.pool.setActiveCount(effectiveChannels(link));
      if (!link.pool.send(frame)) throw new Error('All data channels closed');
    } else {
      link.inFlightBytes += wireLength;
      // Ownership of `frame` moves to the UI thread — no copy is made.
      post({ type: 'frame-out', linkId: job.linkId, transferId: job.id, data: frame }, [frame]);
    }

    job.rawBytes = nextOffset;
    job.wireBytes += wireLength;
    offset = nextOffset;
    emitSendProgress(job, link);
  }

  if (link.pool) await link.pool.flush();
  if (job.cancelled) return;
  emitSendProgress(job, link, true);
  post({ type: 'send-drained', transferId: job.id });
}

// ───────────────────────────── Receiver ─────────────────────────────

interface RecvJob {
  id: string;
  linkId: string;
  name: string;
  size: number;
  compress: boolean;
  saveHandle: FileSystemFileHandle | null;
  sink: DiskSink | null;
  /** Frames that arrived while the OPFS file was still being opened. */
  backlog: ArrayBuffer[] | null;
  inflight: Set<Promise<void>>;
  rawBytes: number;
  wireBytes: number;
  lastProgress: number;
  finished: boolean;
  failed: boolean;
}

const recvJobs = new Map<string, RecvJob>();
const recvByLink = new Map<string, string>();
const deliveredFiles = new Map<string, string>();

function failRecv(job: RecvJob, message: string): void {
  if (job.failed || job.finished) return;
  job.failed = true;
  recvJobs.delete(job.id);
  if (recvByLink.get(job.linkId) === job.id) recvByLink.delete(job.linkId);
  void job.sink?.abort();
  post({ type: 'transfer-error', transferId: job.id, message });
}

function handleIncoming(linkId: string, frame: ArrayBuffer): void {
  const transferId = recvByLink.get(linkId);
  if (!transferId) return; // straggler from a cancelled transfer
  const job = recvJobs.get(transferId);
  if (!job || job.finished || job.failed) return;
  if (job.backlog) {
    job.backlog.push(frame);
    return;
  }
  ingest(job, frame);
}

function ingest(job: RecvJob, frame: ArrayBuffer): void {
  const sink = job.sink!;
  try {
    const { offset, payload } = decodeFrame(frame);
    const write = (bytes: Uint8Array) => {
      if (offset + bytes.byteLength > job.size) throw new RangeError(`Frame at ${offset} overruns file size ${job.size}`);
      const result = sink.write(offset, bytes);
      if (result) {
        job.inflight.add(result);
        result.then(
          () => job.inflight.delete(result),
          (error: unknown) => failRecv(job, `Disk write failed: ${String(error)}`),
        );
      }
    };
    let rawLength: number;
    if (job.compress) {
      if (!codec) throw new Error('LZ4 codec unavailable in receiver worker');
      rawLength = codec.decompressInto(payload, write);
    } else {
      write(payload);
      rawLength = payload.byteLength;
    }
    job.rawBytes += rawLength;
    job.wireBytes += frame.byteLength;
  } catch (error) {
    failRecv(job, error instanceof Error ? error.message : String(error));
    return;
  }

  const now = performance.now();
  if (now - job.lastProgress >= PROGRESS_INTERVAL_MS || job.rawBytes >= job.size) {
    job.lastProgress = now;
    post({ type: 'recv-progress', transferId: job.id, rawBytes: job.rawBytes, wireBytes: job.wireBytes });
  }
  if (job.rawBytes >= job.size) void finalizeRecv(job);
}

async function finalizeRecv(job: RecvJob): Promise<void> {
  if (job.finished || job.failed) return;
  job.finished = true;
  if (recvByLink.get(job.linkId) === job.id) recvByLink.delete(job.linkId);
  try {
    await Promise.all(job.inflight);
    const file = await job.sink!.finalize();
    const opfsName = `${job.id}.part`;
    if (job.saveHandle) {
      await streamToHandle(file, job.saveHandle);
      await removeInboxFile(opfsName);
      post({ type: 'recv-complete', transferId: job.id, file: null, savedToHandle: true });
    } else {
      if (job.sink!.kind !== 'memory') deliveredFiles.set(job.id, opfsName);
      post({ type: 'recv-complete', transferId: job.id, file, savedToHandle: false });
    }
  } catch (error) {
    job.finished = false;
    failRecv(job, `Could not save file: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    recvJobs.delete(job.id);
  }
}

async function startRecv(message: Extract<ToWorker, { type: 'recv-start' }>): Promise<void> {
  const job: RecvJob = {
    id: message.transferId,
    linkId: message.linkId,
    name: message.name,
    size: message.size,
    compress: message.compress,
    saveHandle: message.saveHandle,
    sink: null,
    backlog: [],
    inflight: new Set(),
    rawBytes: 0,
    wireBytes: 0,
    lastProgress: 0,
    finished: false,
    failed: false,
  };
  recvJobs.set(job.id, job);
  recvByLink.set(job.linkId, job.id);
  try {
    job.sink = await openDiskSink(job.id, job.name, job.size);
  } catch (error) {
    failRecv(job, `Could not open disk sink: ${String(error)}`);
    return;
  }
  if (job.failed) {
    await job.sink.abort();
    return;
  }
  const backlog = job.backlog ?? [];
  job.backlog = null;
  for (const frame of backlog) {
    if (job.failed || job.finished) break;
    ingest(job, frame);
  }
  if (job.size === 0) void finalizeRecv(job);
}

// ───────────────────────────── Cancellation / links ─────────────────────────────

function releaseJobPause(job: SendJob): void {
  const waiters = job.pauseWaiters;
  job.pauseWaiters = [];
  for (const resolve of waiters) resolve();
}

function cancelTransfer(transferId: string, notify: string | null): void {
  const send = sendJobs.get(transferId);
  if (send) {
    send.cancelled = true;
    sendJobs.delete(transferId);
    releaseJobPause(send);
    const link = links.get(send.linkId);
    if (link) releaseWaiters(link);
    if (notify) post({ type: 'transfer-error', transferId, message: notify });
  }
  const recv = recvJobs.get(transferId);
  if (recv) {
    if (notify) failRecv(recv, notify);
    else {
      recv.failed = true;
      recvJobs.delete(transferId);
      if (recvByLink.get(recv.linkId) === transferId) recvByLink.delete(recv.linkId);
      void recv.sink?.abort();
    }
  }
}

function detachLink(linkId: string, reason: string): void {
  const link = links.get(linkId);
  for (const job of [...sendJobs.values()]) if (job.linkId === linkId) cancelTransfer(job.id, reason);
  for (const job of [...recvJobs.values()]) if (job.linkId === linkId) cancelTransfer(job.id, reason);
  if (!link) return;
  if (link.queueTimer) clearInterval(link.queueTimer);
  link.pool?.dispose();
  releaseWaiters(link);
  links.delete(linkId);
}

function attachChannels(linkId: string, channels: RTCDataChannel[]): void {
  const link = getLink(linkId);
  link.pool?.dispose();
  const pool = new ChannelPool(channels);
  link.pool = pool;
  for (const channel of channels) {
    channel.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => handleIncoming(linkId, event.data));
    channel.addEventListener('close', () => {
      if (channels.every((c) => c.readyState === 'closed')) detachLink(linkId, 'Peer link closed');
    });
  }
  if (link.queueTimer) clearInterval(link.queueTimer);
  link.queueTimer = setInterval(() => {
    post({ type: 'queue', linkId, buffered: pool.bufferedAmounts, active: pool.activeCount });
  }, 250);
  post({ type: 'attached', linkId });
}

// ───────────────────────────── Boot ─────────────────────────────

async function boot(): Promise<void> {
  try {
    codec = await instantiateLz4(await fetch(lz4WasmUrl));
  } catch (error) {
    codec = null;
    lz4Error = error instanceof Error ? error.message : String(error);
  }
  await purgeInbox();
  post({ type: 'ready', lz4: codec !== null, opfs: opfsSupported(), lz4Error });
}

scope.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      void boot();
      break;
    case 'attach-channels':
      attachChannels(message.linkId, message.channels);
      break;
    case 'detach':
      detachLink(message.linkId, 'Peer link closed');
      break;
    case 'analyze':
      analyzeBlob(message.file).then(
        (verdict) => post({ type: 'analysis', fileId: message.fileId, ...verdict }),
        (error: unknown) => post({ type: 'transfer-error', transferId: message.fileId, message: `Cannot read file: ${String(error)}` }),
      );
      break;
    case 'send-start': {
      const job: SendJob = {
        id: message.transferId,
        linkId: message.linkId,
        file: message.file,
        compress: message.compress,
        chunkSize: message.chunkSize,
        cancelled: false,
        userPaused: false,
        pauseWaiters: [],
        rawBytes: 0,
        wireBytes: 0,
        lastProgress: 0,
      };
      sendJobs.set(job.id, job);
      runSend(job)
        .catch((error: unknown) => {
          if (!job.cancelled) post({ type: 'transfer-error', transferId: job.id, message: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => sendJobs.delete(job.id));
      break;
    }
    case 'flow': {
      const link = getLink(message.linkId);
      link.paused = message.paused;
      if (!message.paused && link.inFlightBytes < HIGH_WATERMARK) releaseWaiters(link);
      break;
    }
    case 'bridge-ack': {
      const link = getLink(message.linkId);
      link.inFlightBytes = Math.max(0, link.inFlightBytes - message.bytes);
      link.paused = message.paused;
      if (!link.paused && link.inFlightBytes < HIGH_WATERMARK) releaseWaiters(link);
      break;
    }
    case 'user-pause': {
      const job = sendJobs.get(message.transferId);
      if (job) {
        job.userPaused = message.paused;
        if (!message.paused) releaseJobPause(job);
      }
      break;
    }
    case 'net': {
      const link = getLink(message.linkId);
      link.rttMs = message.rttMs;
      for (const job of sendJobs.values()) if (job.linkId === message.linkId) job.chunkSize = message.chunkSize;
      break;
    }
    case 'cancel':
      cancelTransfer(message.transferId, null);
      break;
    case 'recv-start':
      void startRecv(message);
      break;
    case 'chunk-in':
      handleIncoming(message.linkId, message.data);
      break;
    case 'release': {
      const name = deliveredFiles.get(message.transferId);
      if (name) {
        deliveredFiles.delete(message.transferId);
        void removeInboxFile(name);
      }
      break;
    }
  }
});
