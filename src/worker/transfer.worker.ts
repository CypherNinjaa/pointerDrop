/**
 * Dedicated off-main-thread transfer & benchmark worker.
 *
 * Sender pipeline:
 *   OS File (8 MiB double-buffered macro-reads) or synthetic benchmark buffer →
 *   16 KiB block order-independent integrity hash →
 *   AdaptiveTuner (16..256 KiB chunk ladder + parallel SCTP lanes + BDP watermark) →
 *   optional WASM LZ4 block compression with auto-bypass →
 *   application-level receiver credit gate + local SCTP watermark gate →
 *   zero-allocation native RTCDataChannel send (or transferable ArrayBuffer bridge).
 *
 * Receiver pipeline:
 *   bounded MessageChannel frame hand-off →
 *   8-byte header demux + optional WASM LZ4 decode →
 *   16 KiB block order-independent integrity hash →
 *   OPFS SyncAccessHandle / bounded async OPFS Writable / DiscardSink →
 *   persisted-bytes credit ACKs (`credit-out`) back to sender.
 */
import {
  AdaptiveTuner,
  detectDeviceProfile,
  largestChunkFor,
  lowWatermarkFor,
  memorySinkBudget,
  receiverCreditWindow,
} from '../engine/autotune';
import { ChannelPool } from '../engine/channelPool';
import { analyzeBlob } from '../engine/entropy';
import { decodeFrame, encodeFrame, writeFrameHeader } from '../engine/framing';
import { OrderIndependentHasher } from '../engine/integrity';
import {
  openDiskSink,
  opfsSupported,
  probeOpfsCapability,
  purgeInbox,
  removeInboxFile,
  streamToHandle,
  type DiskSink,
} from '../engine/opfsDiskStream';
import {
  CHANNEL_COUNT,
  CREDIT_STEP_BYTES,
  DEFAULT_CHUNK,
  FRAME_HEADER_BYTES,
  INITIAL_HIGH_WATERMARK,
  MAX_CHUNK,
  type FromWorker,
  type SchedulePolicy,
  type TuneConfig,
  type ToWorker,
} from '../engine/protocol';
import { instantiateLz4, type Lz4Codec } from './lz4';
import lz4WasmUrl from './lz4.wasm?url';

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ToWorker>) => void): void;
  isSecureContext?: boolean;
}
const scope = self as unknown as WorkerScope;
const post = (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

const PROGRESS_INTERVAL_MS = 100;
const DISK_MACRO_BYTES = 8 * 1024 * 1024;
const EPOCH_MIN_MS = 550;
const RX_SLICE_BUDGET_MS = 6;

const deviceProfile = detectDeviceProfile();
const scratchFrame = new ArrayBuffer(MAX_CHUNK + FRAME_HEADER_BYTES + 64);

let codec: Lz4Codec | null = null;
let lz4Error: string | undefined;

// Cached synthetic 8 MiB macro-buffers for zero-disk benchmark runs
let cachedRandomMacro: ArrayBuffer | null = null;
let cachedTextMacro: ArrayBuffer | null = null;

function getSyntheticMacro(compressible: boolean): ArrayBuffer {
  if (!compressible) {
    if (!cachedRandomMacro) {
      const buf = new ArrayBuffer(DISK_MACRO_BYTES);
      const view = new Uint8Array(buf);
      for (let off = 0; off < view.byteLength; off += 65536) {
        crypto.getRandomValues(view.subarray(off, Math.min(view.byteLength, off + 65536)));
      }
      cachedRandomMacro = buf;
    }
    return cachedRandomMacro;
  }
  if (!cachedTextMacro) {
    const sampleLine =
      '{"ts":1761529200,"service":"airdrop-lan-warp","lane":0,"route":"host","msg":"structured-telemetry-record-payload-benchmark"}\n';
    const encoded = new TextEncoder().encode(sampleLine);
    const buf = new ArrayBuffer(DISK_MACRO_BYTES);
    const view = new Uint8Array(buf);
    for (let off = 0; off < view.byteLength; off += encoded.byteLength) {
      const slice = encoded.subarray(0, Math.min(encoded.byteLength, view.byteLength - off));
      view.set(slice, off);
    }
    cachedTextMacro = buf;
  }
  return cachedTextMacro;
}

// ───────────────────────────── Link state ─────────────────────────────

interface LinkState {
  id: string;
  /** Present when RTCDataChannels are transferred natively into this worker. */
  pool: ChannelPool | null;
  paused: boolean;
  inFlightBytes: number;
  bridgeSentBytes: number;
  bridgeBuffered: number[];
  bridgeOpenLanes: number;
  resumeWaiters: Array<() => void>;
  rttMs: number;
  maxMessageSize: number;
  seed: Partial<TuneConfig> | null;
  queueTimer: ReturnType<typeof setInterval> | null;
}

const links = new Map<string, LinkState>();

function getLink(linkId: string): LinkState {
  let link = links.get(linkId);
  if (!link) {
    link = {
      id: linkId,
      pool: null,
      paused: false,
      inFlightBytes: 0,
      bridgeSentBytes: 0,
      bridgeBuffered: [0, 0, 0, 0],
      bridgeOpenLanes: 1,
      resumeWaiters: [],
      rttMs: 0,
      maxMessageSize: MAX_CHUNK + FRAME_HEADER_BYTES + 64,
      seed: null,
      queueTimer: null,
    };
    links.set(linkId, link);
  }
  return link;
}

function releaseWaiters(link: LinkState): void {
  const waiters = link.resumeWaiters;
  link.resumeWaiters = [];
  for (const resolve of waiters) resolve();
}

function openLanesFor(link: LinkState, forceBridge: boolean): number {
  if (link.pool && !forceBridge) return Math.max(1, link.pool.openLaneCount);
  return Math.max(1, link.bridgeOpenLanes);
}

function drainedBytesOnLink(link: LinkState, forceBridge: boolean): number {
  if (link.pool && !forceBridge) {
    return Math.max(0, link.pool.sentBytes - link.pool.totalBuffered);
  }
  const bufferedSum = link.bridgeBuffered.reduce((a, b) => a + b, 0);
  return Math.max(0, link.bridgeSentBytes - bufferedSum);
}

// ───────────────────────────── Sender ─────────────────────────────

interface SendJob {
  id: string;
  linkId: string;
  file: File | null;
  syntheticBytes?: number;
  compressibleBench: boolean;
  forceBridge: boolean;
  compress: boolean;
  creditWindow: number;
  creditedBytes: number;
  creditWaiters: Array<() => void>;
  durationMs?: number;
  pinned?: Partial<TuneConfig> | null;
  cancelled: boolean;
  userPaused: boolean;
  pauseWaiters: Array<() => void>;
  rawBytes: number;
  wireBytes: number;
  lastProgress: number;
  hasher: OrderIndependentHasher;
}

const sendJobs = new Map<string, SendJob>();

function releaseCredits(job: SendJob): void {
  const waiters = job.creditWaiters;
  job.creditWaiters = [];
  for (const resolve of waiters) resolve();
}

async function waitForOpen(pool: ChannelPool, job: SendJob): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!pool.isOpen) {
    if (job.cancelled) return;
    if (performance.now() > deadline) throw new Error('Data channels did not open');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function syncTuneToPoolOrBridge(link: LinkState, cfg: TuneConfig, forceBridge: boolean): void {
  const channels = cfg.channels ?? CHANNEL_COUNT;
  const schedule: SchedulePolicy = cfg.schedule ?? 'least-buffered';
  if (link.pool && !forceBridge) {
    link.pool.setActiveLanes(cfg.lanes);
    link.pool.setActiveChannelsPerLane(channels);
    link.pool.setSchedulePolicy(schedule);
    link.pool.setHighWatermark(cfg.highWatermark);
  }
  const activeChannelTotal = channels + Math.max(0, cfg.lanes - 1) * 2;
  post({
    type: 'tune',
    linkId: link.id,
    highWatermark: cfg.highWatermark,
    lowWatermark: lowWatermarkFor(cfg.highWatermark, activeChannelTotal),
    lanes: cfg.lanes,
    channels,
    schedule,
  });
}

async function gate(
  link: LinkState,
  job: SendJob,
  highWatermark: number,
): Promise<{ queueMs: number; creditMs: number }> {
  let queueMs = 0;
  let creditMs = 0;

  while (!job.cancelled && job.userPaused) {
    await new Promise<void>((resolve) => job.pauseWaiters.push(resolve));
  }
  if (job.cancelled) return { queueMs, creditMs };

  // 1. Application-level receiver credit gate (protects async OPFS & mobile RAM).
  if (Number.isFinite(job.creditWindow)) {
    while (!job.cancelled && job.rawBytes - job.creditedBytes >= job.creditWindow) {
      const t0 = performance.now();
      await new Promise<void>((resolve) => job.creditWaiters.push(resolve));
      creditMs += performance.now() - t0;
      while (!job.cancelled && job.userPaused) {
        await new Promise<void>((resolve) => job.pauseWaiters.push(resolve));
      }
    }
  }
  if (job.cancelled) return { queueMs, creditMs };

  // 2. Local browser SCTP send-buffer watermark gate.
  if (link.pool && !job.forceBridge) {
    while (!job.cancelled && !link.pool.canSend) {
      const t0 = performance.now();
      await link.pool.waitForDrain();
      queueMs += performance.now() - t0;
      while (!job.cancelled && job.userPaused) {
        await new Promise<void>((resolve) => job.pauseWaiters.push(resolve));
      }
    }
    return { queueMs, creditMs };
  }

  while (!job.cancelled && (link.paused || link.inFlightBytes >= highWatermark)) {
    const t0 = performance.now();
    await new Promise<void>((resolve) => link.resumeWaiters.push(resolve));
    queueMs += performance.now() - t0;
    while (!job.cancelled && job.userPaused) {
      await new Promise<void>((resolve) => job.pauseWaiters.push(resolve));
    }
  }
  return { queueMs, creditMs };
}

function emitSendProgress(job: SendJob, tuner: AdaptiveTuner, useLz4: boolean, force = false): void {
  const now = performance.now();
  if (!force && now - job.lastProgress < PROGRESS_INTERVAL_MS) return;
  job.lastProgress = now;
  post({
    type: 'send-progress',
    transferId: job.id,
    rawBytes: job.rawBytes,
    wireBytes: job.wireBytes,
    creditedBytes: job.creditedBytes,
    tuner: tuner.snapshot(useLz4),
  });
}

async function runSend(job: SendJob): Promise<void> {
  const link = getLink(job.linkId);
  const isBench = job.file === null;
  const totalLimit = job.file ? job.file.size : (job.syntheticBytes ?? Number.POSITIVE_INFINITY);
  let useLz4 = job.compress && codec !== null;
  if (job.compress && !codec) throw new Error('LZ4 codec unavailable in sender worker');

  if (link.pool && !job.forceBridge) await waitForOpen(link.pool, job);

  const maxChunkInit = largestChunkFor(link.maxMessageSize, FRAME_HEADER_BYTES);
  const tuner = new AdaptiveTuner(
    deviceProfile,
    maxChunkInit,
    openLanesFor(link, job.forceBridge),
    link.seed,
  );
  if (job.pinned) tuner.pin(job.pinned);
  syncTuneToPoolOrBridge(link, tuner.config, job.forceBridge);

  const startedAt = performance.now();
  const stopDeadline = job.durationMs ? startedAt + job.durationMs : Number.POSITIVE_INFINITY;

  let epochStart = startedAt;
  let lastDrained = drainedBytesOnLink(link, job.forceBridge);
  let epochQueueMs = 0;
  let epochCreditMs = 0;
  let epochDiskMs = 0;
  let epochLz4Ms = 0;

  let totalQueueMs = 0;
  let totalCreditMs = 0;
  let totalDiskMs = 0;
  let totalLz4Ms = 0;

  const readMacro = (offset: number, length: number): Promise<ArrayBuffer> => {
    if (!job.file) {
      const synth = getSyntheticMacro(job.compressibleBench);
      return Promise.resolve(length >= synth.byteLength ? synth : synth.slice(0, length));
    }
    return job.file.slice(offset, offset + length).arrayBuffer();
  };

  let macroOffset = 0;
  let pendingMacro: Promise<ArrayBuffer> | null =
    totalLimit > 0 ? readMacro(0, Math.min(DISK_MACRO_BYTES, totalLimit)) : null;

  outer: while (macroOffset < totalLimit && pendingMacro) {
    if (job.cancelled || performance.now() >= stopDeadline) break;

    const d0 = performance.now();
    const macroBuf = await pendingMacro;
    const dElapsed = performance.now() - d0;
    if (!isBench) {
      epochDiskMs += dElapsed;
      totalDiskMs += dElapsed;
    }

    if (macroBuf.byteLength === 0) throw new Error('Source file shrank or became unreadable during transfer');
    const nextMacroOffset = macroOffset + macroBuf.byteLength;

    pendingMacro =
      nextMacroOffset < totalLimit && performance.now() < stopDeadline
        ? readMacro(nextMacroOffset, Math.min(DISK_MACRO_BYTES, totalLimit - nextMacroOffset))
        : null;

    let innerOffset = 0;
    while (innerOffset < macroBuf.byteLength) {
      if (job.cancelled) return;
      if (performance.now() >= stopDeadline) break outer;

      const waits = await gate(link, job, tuner.config.highWatermark);
      epochQueueMs += waits.queueMs;
      epochCreditMs += waits.creditMs;
      totalQueueMs += waits.queueMs;
      totalCreditMs += waits.creditMs;
      if (job.cancelled) return;
      if (performance.now() >= stopDeadline) break outer;

      // Refresh dynamic SCTP / lane ceilings in case an extra parallel lane just opened.
      if (
        tuner.setLimits(
          largestChunkFor(link.maxMessageSize, FRAME_HEADER_BYTES),
          openLanesFor(link, job.forceBridge),
        )
      ) {
        syncTuneToPoolOrBridge(link, tuner.config, job.forceBridge);
      }

      const chunkLen = Math.min(tuner.config.chunk, macroBuf.byteLength - innerOffset);
      const raw = new Uint8Array(macroBuf, innerOffset, chunkLen);
      const fileOffset = macroOffset + innerOffset;

      // Order-independent 16 KB sub-block integrity hash
      job.hasher.update(fileOffset, raw);

      const useNativeZeroAlloc = link.pool !== null && !job.forceBridge;
      let wireLength = 0;

      if (useLz4) {
        const c0 = performance.now();
        const compressedFrame = codec!.compressFrame(raw, FRAME_HEADER_BYTES);
        const cElapsed = performance.now() - c0;
        epochLz4Ms += cElapsed;
        totalLz4Ms += cElapsed;

        if (compressedFrame.byteLength < FRAME_HEADER_BYTES + raw.byteLength * 0.96) {
          writeFrameHeader(compressedFrame, fileOffset, true);
          wireLength = compressedFrame.byteLength;
          if (useNativeZeroAlloc) {
            if (!link.pool!.send(compressedFrame)) throw new Error('All data channels closed');
          } else {
            link.inFlightBytes += wireLength;
            post(
              { type: 'frame-out', linkId: job.linkId, transferId: job.id, data: compressedFrame, viaForceBridge: job.forceBridge },
              [compressedFrame],
            );
          }
        } else if (useNativeZeroAlloc) {
          writeFrameHeader(scratchFrame, fileOffset, false);
          new Uint8Array(scratchFrame, FRAME_HEADER_BYTES, raw.byteLength).set(raw);
          wireLength = FRAME_HEADER_BYTES + raw.byteLength;
          if (!link.pool!.send(new Uint8Array(scratchFrame, 0, wireLength))) {
            throw new Error('All data channels closed');
          }
        } else {
          const frame = encodeFrame(fileOffset, raw, false);
          wireLength = frame.byteLength;
          link.inFlightBytes += wireLength;
          post(
            { type: 'frame-out', linkId: job.linkId, transferId: job.id, data: frame, viaForceBridge: job.forceBridge },
            [frame],
          );
        }
      } else if (useNativeZeroAlloc) {
        // Hot path for pre-compressed media / archives / raw benchmarks: zero ArrayBuffer allocations per chunk.
        writeFrameHeader(scratchFrame, fileOffset, false);
        new Uint8Array(scratchFrame, FRAME_HEADER_BYTES, raw.byteLength).set(raw);
        wireLength = FRAME_HEADER_BYTES + raw.byteLength;
        if (!link.pool!.send(new Uint8Array(scratchFrame, 0, wireLength))) {
          throw new Error('All data channels closed');
        }
      } else {
        const frame = encodeFrame(fileOffset, raw, false);
        wireLength = frame.byteLength;
        link.inFlightBytes += wireLength;
        post(
          { type: 'frame-out', linkId: job.linkId, transferId: job.id, data: frame, viaForceBridge: job.forceBridge },
          [frame],
        );
      }

      innerOffset += chunkLen;
      job.rawBytes = fileOffset + chunkLen;
      job.wireBytes += wireLength;

      // Auto-bypass LZ4 if after 2 MiB the stream proves incompressible (< 1.05x).
      if (useLz4 && !job.pinned && job.rawBytes >= 2 * 1024 * 1024 && job.rawBytes / job.wireBytes < 1.05) {
        useLz4 = false;
      }

      const now = performance.now();
      const epochElapsed = now - epochStart;
      const minEpoch = Math.max(EPOCH_MIN_MS, Math.min(2_000, link.rttMs * 6));
      if (epochElapsed >= minEpoch) {
        const drainedNow = drainedBytesOnLink(link, job.forceBridge);
        const changed = tuner.onEpoch({
          ms: epochElapsed,
          drainedBytes: Math.max(0, drainedNow - lastDrained),
          queueWaitMs: epochQueueMs,
          creditWaitMs: epochCreditMs,
          diskWaitMs: epochDiskMs,
          lz4Ms: epochLz4Ms,
          rttMs: link.rttMs,
        });
        if (changed) syncTuneToPoolOrBridge(link, tuner.config, job.forceBridge);
        lastDrained = drainedNow;
        epochStart = now;
        epochQueueMs = 0;
        epochCreditMs = 0;
        epochDiskMs = 0;
        epochLz4Ms = 0;
      }

      emitSendProgress(job, tuner, useLz4);
    }

    macroOffset = nextMacroOffset;
  }

  if (link.pool && !job.forceBridge) {
    const f0 = performance.now();
    await link.pool.flush();
    totalQueueMs += performance.now() - f0;
  }
  if (job.cancelled) return;

  // Persist learned optimal configuration for subsequent transfers on this link if unpinned.
  if (!job.pinned && tuner.drainBps > 0) {
    link.seed = { chunk: tuner.config.chunk, lanes: tuner.config.lanes, highWatermark: tuner.config.highWatermark };
  }

  const elapsedMs = Math.max(1, performance.now() - startedAt);
  emitSendProgress(job, tuner, useLz4, true);
  post({
    type: 'send-drained',
    transferId: job.id,
    rawBytes: job.rawBytes,
    wireBytes: job.wireBytes,
    elapsedMs,
    queueWaitMs: totalQueueMs,
    creditWaitMs: totalCreditMs,
    diskWaitMs: totalDiskMs,
    lz4Ms: totalLz4Ms,
    hash: job.hasher.digestHex(),
    finalTuner: tuner.snapshot(useLz4),
  });
}

// ───────────────────────────── Receiver ─────────────────────────────

interface RecvJob {
  id: string;
  linkId: string;
  name: string;
  size: number;
  targetBytes: number;
  compress: boolean;
  bench: boolean;
  saveHandle: FileSystemFileHandle | null;
  sink: DiskSink | null;
  creditWindow: number;
  creditStep: number;
  lastCreditedBytes: number;
  backlog: ArrayBuffer[] | null;
  inflight: Set<Promise<void>>;
  pendingWriteBytes: number;
  maxPendingWriteBytes: number;
  persistedBytes: number;
  rawBytes: number;
  wireBytes: number;
  writeMs: number;
  startedAt: number;
  lastProgress: number;
  finished: boolean;
  failed: boolean;
  hasher: OrderIndependentHasher;
  benchStopTimer: ReturnType<typeof setTimeout> | null;
}

const recvJobs = new Map<string, RecvJob>();
const recvByLink = new Map<string, string>();
const deliveredFiles = new Map<string, string>();

// Bounded non-blocking receiver frame hand-off queue via MessageChannel
const rxQueue: Array<{ linkId: string; frame: ArrayBuffer }> = [];
let rxScheduled = false;
const rxChannel = new MessageChannel();

rxChannel.port1.onmessage = () => {
  rxScheduled = false;
  drainRxQueue();
};

function scheduleRxDrain(): void {
  if (rxScheduled || rxQueue.length === 0) return;
  rxScheduled = true;
  rxChannel.port2.postMessage(null);
}

function enqueueIncoming(linkId: string, frame: ArrayBuffer): void {
  rxQueue.push({ linkId, frame });
  scheduleRxDrain();
}

function drainRxQueue(): void {
  const deadline = performance.now() + RX_SLICE_BUDGET_MS;
  while (rxQueue.length > 0) {
    const item = rxQueue.shift()!;
    handleIncoming(item.linkId, item.frame);
    if (performance.now() >= deadline && rxQueue.length > 0) {
      scheduleRxDrain();
      return;
    }
  }
}

function failRecv(job: RecvJob, message: string): void {
  if (job.failed || job.finished) return;
  job.failed = true;
  if (job.benchStopTimer !== null) clearTimeout(job.benchStopTimer);
  recvJobs.delete(job.id);
  if (recvByLink.get(job.linkId) === job.id) recvByLink.delete(job.linkId);
  void job.sink?.abort();
  post({ type: 'transfer-error', transferId: job.id, message });
}

function maybeEmitCredit(job: RecvJob): void {
  if (job.failed || job.finished) return;
  if (job.persistedBytes - job.lastCreditedBytes >= job.creditStep) {
    job.lastCreditedBytes = job.persistedBytes;
    post({ type: 'credit-out', transferId: job.id, bytes: job.persistedBytes });
  }
}

function handleIncoming(linkId: string, frame: ArrayBuffer): void {
  const transferId = recvByLink.get(linkId);
  if (!transferId) return;
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
    const { offset, compressed, payload } = decodeFrame(frame);
    const write = (bytes: Uint8Array) => {
      const len = bytes.byteLength;
      if (!job.bench && offset + len > job.size) {
        throw new RangeError(`Frame at ${offset} overruns file size ${job.size}`);
      }
      job.hasher.update(offset, bytes);

      const t0 = performance.now();
      const result = sink.write(offset, bytes);
      if (result) {
        job.pendingWriteBytes += len;
        if (job.pendingWriteBytes > job.maxPendingWriteBytes) {
          job.maxPendingWriteBytes = job.pendingWriteBytes;
        }
        job.inflight.add(result);
        result.then(
          () => {
            job.inflight.delete(result);
            job.pendingWriteBytes = Math.max(0, job.pendingWriteBytes - len);
            job.writeMs += performance.now() - t0;
            job.persistedBytes += len;
            maybeEmitCredit(job);
            checkRecvCompletion(job);
          },
          (error: unknown) => failRecv(job, `Disk write failed: ${String(error)}`),
        );
      } else {
        job.writeMs += performance.now() - t0;
        job.persistedBytes += len;
        maybeEmitCredit(job);
      }
    };

    let rawLength: number;
    if (compressed) {
      if (!codec) throw new Error('LZ4 codec unavailable in receiver worker');
      rawLength = codec.decompressInto(payload, write);
    } else {
      write(payload);
      rawLength = payload.byteLength;
    }

    if (job.rawBytes === 0) job.startedAt = performance.now();
    job.rawBytes += rawLength;
    job.wireBytes += frame.byteLength;
  } catch (error) {
    failRecv(job, error instanceof Error ? error.message : String(error));
    return;
  }

  const now = performance.now();
  if (now - job.lastProgress >= PROGRESS_INTERVAL_MS || job.rawBytes >= job.targetBytes) {
    job.lastProgress = now;
    post({
      type: 'recv-progress',
      transferId: job.id,
      rawBytes: job.rawBytes,
      wireBytes: job.wireBytes,
      persistedBytes: job.persistedBytes,
      pendingWriteBytes: job.pendingWriteBytes,
      pendingWriteCount: job.inflight.size,
      writeMs: job.writeMs,
      sink: sink.kind,
    });
  }
  checkRecvCompletion(job);
}

function checkRecvCompletion(job: RecvJob): void {
  if (job.finished || job.failed) return;
  if (job.rawBytes >= job.targetBytes) {
    if (job.bench) void finalizeBenchRecv(job);
    else void finalizeRecv(job);
  }
}

async function finalizeBenchRecv(job: RecvJob): Promise<void> {
  if (job.finished || job.failed) return;
  job.finished = true;
  if (job.benchStopTimer !== null) clearTimeout(job.benchStopTimer);
  if (recvByLink.get(job.linkId) === job.id) recvByLink.delete(job.linkId);
  const sinkKind = job.sink?.kind ?? 'discard';
  try {
    const f0 = performance.now();
    await Promise.all(job.inflight);
    await job.sink?.finalize();
    const finalizeMs = performance.now() - f0;
    if (sinkKind === 'opfs-sync' || sinkKind === 'opfs-writable') {
      await removeInboxFile(`${job.id}.part`);
    }
    const elapsedMs = Math.max(1, performance.now() - job.startedAt);
    post({
      type: 'bench-done',
      transferId: job.id,
      bytes: job.rawBytes,
      wireBytes: job.wireBytes,
      elapsedMs,
      writeMs: job.writeMs,
      finalizeMs,
      maxPendingWriteBytes: job.maxPendingWriteBytes,
      sink: sinkKind,
      hash: job.hasher.digestHex(),
      complete: Number.isFinite(job.targetBytes) ? job.rawBytes === job.targetBytes : true,
    });
  } catch (error) {
    job.finished = false;
    failRecv(job, `Benchmark sink finalize failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    recvJobs.delete(job.id);
  }
}

async function finalizeRecv(job: RecvJob): Promise<void> {
  if (job.finished || job.failed) return;
  job.finished = true;
  if (recvByLink.get(job.linkId) === job.id) recvByLink.delete(job.linkId);
  const sinkKind = job.sink!.kind;
  try {
    const f0 = performance.now();
    await Promise.all(job.inflight);
    const file = await job.sink!.finalize();
    const opfsName = `${job.id}.part`;
    if (job.saveHandle) {
      await streamToHandle(file, job.saveHandle);
      await removeInboxFile(opfsName);
      const finalizeMs = performance.now() - f0;
      post({
        type: 'recv-complete',
        transferId: job.id,
        file: null,
        savedToHandle: true,
        hash: job.hasher.digestHex(),
        sink: sinkKind,
        writeMs: job.writeMs,
        finalizeMs,
        maxPendingWriteBytes: job.maxPendingWriteBytes,
      });
    } else {
      const finalizeMs = performance.now() - f0;
      if (sinkKind !== 'memory' && sinkKind !== 'discard') deliveredFiles.set(job.id, opfsName);
      post({
        type: 'recv-complete',
        transferId: job.id,
        file,
        savedToHandle: false,
        hash: job.hasher.digestHex(),
        sink: sinkKind,
        writeMs: job.writeMs,
        finalizeMs,
        maxPendingWriteBytes: job.maxPendingWriteBytes,
      });
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
    targetBytes: message.size,
    compress: message.compress,
    bench: message.bench,
    saveHandle: message.saveHandle,
    sink: null,
    creditWindow: INITIAL_HIGH_WATERMARK * 2,
    creditStep: CREDIT_STEP_BYTES,
    lastCreditedBytes: 0,
    backlog: [],
    inflight: new Set(),
    pendingWriteBytes: 0,
    maxPendingWriteBytes: 0,
    persistedBytes: 0,
    rawBytes: 0,
    wireBytes: 0,
    writeMs: 0,
    startedAt: performance.now(),
    lastProgress: 0,
    finished: false,
    failed: false,
    hasher: new OrderIndependentHasher(),
    benchStopTimer: null,
  };
  recvJobs.set(job.id, job);
  recvByLink.set(job.linkId, job.id);

  try {
    const preferred = message.preferredSink ?? (message.bench ? 'discard' : 'auto');
    job.sink = await openDiskSink(job.id, job.name, job.size, {
      preferredSink: preferred,
      maxMemoryBytes: memorySinkBudget(deviceProfile),
    });
  } catch (error) {
    failRecv(job, error instanceof Error ? error.message : String(error));
    return;
  }

  if (job.failed) {
    await job.sink.abort();
    return;
  }

  const defaultWin = receiverCreditWindow(job.sink.kind, deviceProfile);
  job.creditWindow =
    message.windowOverride && message.windowOverride > 0 ? message.windowOverride : defaultWin;
  job.creditStep = Math.min(CREDIT_STEP_BYTES, Math.max(256 * 1024, Math.floor(job.creditWindow / 4)));

  post({ type: 'recv-ready', transferId: job.id, window: job.creditWindow, sink: job.sink.kind });

  const backlog = job.backlog ?? [];
  job.backlog = null;
  for (const frame of backlog) {
    if (job.failed || job.finished) break;
    ingest(job, frame);
  }
  if (job.targetBytes === 0) checkRecvCompletion(job);
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
    releaseCredits(send);
    const link = links.get(send.linkId);
    if (link) releaseWaiters(link);
    if (notify) post({ type: 'transfer-error', transferId, message: notify });
  }
  const recv = recvJobs.get(transferId);
  if (recv) {
    if (notify) failRecv(recv, notify);
    else {
      recv.failed = true;
      if (recv.benchStopTimer !== null) clearTimeout(recv.benchStopTimer);
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

function attachChannels(linkId: string, lane: string, channels: RTCDataChannel[]): void {
  const link = getLink(linkId);
  if (!link.pool) {
    link.pool = new ChannelPool();
  }
  link.pool.addLane(lane, channels);
  for (const channel of channels) {
    channel.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
      if (event.data instanceof ArrayBuffer) enqueueIncoming(linkId, event.data);
    });
    channel.addEventListener('close', () => {
      if (lane === '0' && channels.every((c) => c.readyState === 'closed')) {
        detachLink(linkId, 'Peer link closed');
      }
    });
  }
  if (!link.queueTimer) {
    link.queueTimer = setInterval(() => {
      if (!link.pool) return;
      post({
        type: 'queue',
        linkId,
        buffered: link.pool.bufferedAmounts,
        lanes: link.pool.channelLaneIds,
        active: link.pool.activeChannelCount,
        highWatermark: link.pool.highWatermark,
      });
    }, 200);
  }
  post({ type: 'attached', linkId, lane });
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
  const cap = await probeOpfsCapability();
  post({
    type: 'ready',
    lz4: codec !== null,
    opfs: cap.opfs || opfsSupported(),
    opfsSync: cap.opfsSync,
    secure: Boolean(scope.isSecureContext),
    lz4Error,
  });
}

scope.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      void boot();
      break;
    case 'attach-channels':
      attachChannels(message.linkId, message.lane, message.channels);
      break;
    case 'detach-lane': {
      const link = links.get(message.linkId);
      const removed = link?.pool?.removeLane(message.lane);
      if (removed) {
        for (const ch of removed) {
          try {
            ch.close();
          } catch {
            // Ignore.
          }
        }
      }
      break;
    }
    case 'detach':
      detachLink(message.linkId, 'Peer link closed');
      break;
    case 'analyze':
      analyzeBlob(message.file).then(
        (verdict) => post({ type: 'analysis', fileId: message.fileId, ...verdict }),
        (error: unknown) =>
          post({ type: 'transfer-error', transferId: message.fileId, message: `Cannot read file: ${String(error)}` }),
      );
      break;
    case 'send-start': {
      const job: SendJob = {
        id: message.transferId,
        linkId: message.linkId,
        file: message.file,
        syntheticBytes: message.syntheticBytes,
        compressibleBench: Boolean(message.compressibleBench),
        forceBridge: Boolean(message.forceBridge),
        compress: message.compress,
        creditWindow: message.creditWindow,
        creditedBytes: 0,
        creditWaiters: [],
        durationMs: message.durationMs,
        pinned: message.pinned ?? null,
        cancelled: false,
        userPaused: false,
        pauseWaiters: [],
        rawBytes: 0,
        wireBytes: 0,
        lastProgress: 0,
        hasher: new OrderIndependentHasher(),
      };
      sendJobs.set(job.id, job);
      runSend(job)
        .catch((error: unknown) => {
          if (!job.cancelled) {
            post({
              type: 'transfer-error',
              transferId: job.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(() => sendJobs.delete(job.id));
      break;
    }
    case 'bridge-stats': {
      const link = getLink(message.linkId);
      link.bridgeSentBytes = message.sentBytes;
      link.bridgeBuffered = message.buffered;
      link.bridgeOpenLanes = Math.max(1, message.openLanes);
      break;
    }
    case 'flow': {
      const link = getLink(message.linkId);
      link.paused = message.paused;
      if (!message.paused) releaseWaiters(link);
      break;
    }
    case 'bridge-ack': {
      const link = getLink(message.linkId);
      link.inFlightBytes = Math.max(0, link.inFlightBytes - message.bytes);
      link.paused = message.paused;
      if (!link.paused) releaseWaiters(link);
      break;
    }
    case 'credit': {
      const job = sendJobs.get(message.transferId);
      if (job && message.bytes > job.creditedBytes) {
        job.creditedBytes = message.bytes;
        releaseCredits(job);
      }
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
      if (message.maxMessageSize > 0) link.maxMessageSize = message.maxMessageSize;
      break;
    }
    case 'seed': {
      const link = getLink(message.linkId);
      link.seed = { ...(link.seed ?? {}), ...message.config };
      break;
    }
    case 'cancel':
      cancelTransfer(message.transferId, null);
      break;
    case 'recv-start':
      void startRecv(message);
      break;
    case 'bench-stop': {
      const job = recvJobs.get(message.transferId);
      if (job && job.bench && !job.finished && !job.failed) {
        job.targetBytes = message.bytes;
        checkRecvCompletion(job);
        // Unordered frames on parallel lanes may still be in flight for a few RTTs after ctrl bench-stop.
        if (!job.finished && job.benchStopTimer === null) {
          job.benchStopTimer = setTimeout(() => {
            if (!job.finished && !job.failed) void finalizeBenchRecv(job);
          }, 3_000);
        }
      }
      break;
    }
    case 'chunk-in':
      enqueueIncoming(message.linkId, message.data);
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

// Keep DEFAULT_CHUNK referenced for bundler completeness
void DEFAULT_CHUNK;
