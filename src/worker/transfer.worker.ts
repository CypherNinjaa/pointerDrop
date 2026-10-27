/**
 * Dedicated off-main-thread transfer, RAM-cache, NACK-blast & benchmark worker.
 *
 * Key subsystems:
 *   1. `SharedBlockCache`: 64–96 MiB LRU macro-block RAM cache + full-RAM preload
 *      for small/medium files. Eliminates duplicate disk reads across multi-peer
 *      sends and serves NACK block repairs from RAM in < 0.01 ms.
 *   2. Dual Transport Pools per Link:
 *        • `pool`      — Reliable Unordered (`ordered: false`)
 *        • `blastPool` — RBUDP Blast Unordered (`ordered: false, maxRetransmits: 0`)
 *      In `blast-nack` mode, Pass 1 streams continuously over `blastPool` (zero
 *      dcSCTP C++ `rwnd` reassembly stalls), while rolling + end-of-pass 16 KiB
 *      `BlockBitmap` NACKs selectively retransmit ONLY dropped blocks over the
 *      reliable `pool`!
 *   3. Multi-Peer Fair Mesh Pacing: scales watermarks across simultaneous peer
 *      transfers and applies Shortest-Remaining-Processing-Time (SRPT) priority so
 *      small files complete immediately alongside multi-GB transfers.
 *   4. 3-Tier Receiver Sink (`ram-arena` → `direct-handle` → coalesced `opfs-sync`)
 *      with idempotent `BlockBitmap` deduplication and 128-bit `OrderIndependentHasher`.
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
import { BLOCK_BYTES, BlockBitmap, type MissingRange } from '../engine/nackBitmap';
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
  type ActiveTransportKind,
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
const EPOCH_MIN_MS = 420;
const RX_SLICE_BUDGET_MS = 6;
const ROLLING_NACK_STRIDE_BLOCKS = 1024; // Scan every 16 MiB of progress
const ROLLING_REORDER_MARGIN_BLOCKS = 256; // 4 MiB reorder safety margin across unordered channels

const deviceProfile = detectDeviceProfile();
const scratchFrame = new ArrayBuffer(MAX_CHUNK + FRAME_HEADER_BYTES + 64);

let codec: Lz4Codec | null = null;
let lz4Error: string | undefined;

// ───────────────────── Shared Sender RAM Macro-Block Cache ─────────────────────

interface CachedMacro {
  key: string;
  buf: ArrayBuffer;
  touchedAt: number;
}

class SharedBlockCache {
  private readonly entries = new Map<string, CachedMacro>();
  private seq = 0;
  private readonly maxEntries: number;

  constructor(maxBudgetBytes: number) {
    this.maxEntries = Math.max(4, Math.floor(maxBudgetBytes / DISK_MACRO_BYTES));
  }

  get(key: string): ArrayBuffer | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    hit.touchedAt = ++this.seq;
    return hit.buf;
  }

  put(key: string, buf: ArrayBuffer): void {
    const existing = this.entries.get(key);
    if (existing) {
      existing.buf = buf;
      existing.touchedAt = ++this.seq;
      return;
    }
    while (this.entries.size >= this.maxEntries) {
      let oldestKey: string | null = null;
      let oldestTouch = Number.POSITIVE_INFINITY;
      for (const [k, v] of this.entries) {
        if (v.touchedAt < oldestTouch) {
          oldestTouch = v.touchedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.entries.delete(oldestKey);
      else break;
    }
    this.entries.set(key, { key, buf, touchedAt: ++this.seq });
  }
}

const sharedBlockCache = new SharedBlockCache(deviceProfile.mobile ? 32 * 1024 * 1024 : 96 * 1024 * 1024);

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
  /** Reliable unordered DataChannel pool (`ordered: false`). */
  pool: ChannelPool | null;
  /** Blast UDP DataChannel pool (`ordered: false, maxRetransmits: 0`). */
  blastPool: ChannelPool | null;
  paused: boolean;
  blastPaused: boolean;
  inFlightBytes: number;
  blastInFlightBytes: number;
  bridgeSentBytes: number;
  bridgeBuffered: number[];
  bridgeOpenLanes: number;
  blastBridgeSentBytes: number;
  blastBridgeBuffered: number[];
  blastBridgeOpenLanes: number;
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
      blastPool: null,
      paused: false,
      blastPaused: false,
      inFlightBytes: 0,
      blastInFlightBytes: 0,
      bridgeSentBytes: 0,
      bridgeBuffered: [0, 0, 0, 0],
      bridgeOpenLanes: 1,
      blastBridgeSentBytes: 0,
      blastBridgeBuffered: [0, 0, 0, 0],
      blastBridgeOpenLanes: 1,
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

function activePoolFor(link: LinkState, transport: ActiveTransportKind, forceBridge: boolean): ChannelPool | null {
  if (forceBridge) return null;
  if (transport === 'blast-nack' && link.blastPool && link.blastPool.isOpen) return link.blastPool;
  return link.pool;
}

function openLanesFor(link: LinkState, transport: ActiveTransportKind, forceBridge: boolean): number {
  const p = activePoolFor(link, transport, forceBridge);
  if (p) return Math.max(1, p.openLaneCount);
  return Math.max(1, transport === 'blast-nack' ? link.blastBridgeOpenLanes : link.bridgeOpenLanes);
}

function drainedBytesOnLink(link: LinkState, forceBridge: boolean): number {
  if ((link.pool || link.blastPool) && !forceBridge) {
    const relDrained = link.pool ? Math.max(0, link.pool.sentBytes - link.pool.totalBuffered) : 0;
    const blastDrained = link.blastPool ? Math.max(0, link.blastPool.sentBytes - link.blastPool.totalBuffered) : 0;
    return relDrained + blastDrained;
  }
  const relBuf = link.bridgeBuffered.reduce((a, b) => a + b, 0);
  const blastBuf = link.blastBridgeBuffered.reduce((a, b) => a + b, 0);
  return Math.max(0, link.bridgeSentBytes - relBuf) + Math.max(0, link.blastBridgeSentBytes - blastBuf);
}

// ───────────────────────────── Sender ─────────────────────────────

interface SendJob {
  id: string;
  linkId: string;
  file: File | null;
  fileCachePrefix: string;
  preloadedMacros: Map<number, ArrayBuffer> | null;
  syntheticBytes?: number;
  compressibleBench: boolean;
  forceBridge: boolean;
  compress: boolean;
  transport: ActiveTransportKind;
  turboEndpoint: string | null;
  localBusToken: string | null;
  ignoreSeed: boolean;
  abortCtrl: AbortController | null;
  creditWindow: number;
  creditedBytes: number;
  creditWaiters: Array<() => void>;
  ramPreloadBudget: number;
  durationMs?: number;
  pinned?: Partial<TuneConfig> | null;
  cancelled: boolean;
  userPaused: boolean;
  pauseWaiters: Array<() => void>;
  repairQueue: MissingRange[];
  repairWaiters: Array<() => void>;
  finalAuditComplete: boolean;
  retransmittedBlocks: number;
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

function releaseRepairWaiters(job: SendJob): void {
  const waiters = job.repairWaiters;
  job.repairWaiters = [];
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

/** Fair multi-peer watermark share when 2+ outbound transfers run concurrently. */
function fairWatermarkFor(rawWatermark: number, job: SendJob): number {
  const peersActive = Math.max(1, sendJobs.size);
  if (peersActive <= 1) return rawWatermark;
  // SRPT boost: small files (<= 16 MiB) keep full responsiveness while bulk transfers share BDP fairly.
  if (job.file && job.file.size <= 16 * 1024 * 1024) return rawWatermark;
  return Math.max(512 * 1024, Math.floor(rawWatermark / Math.sqrt(peersActive)));
}

function syncTuneToPoolOrBridge(
  link: LinkState,
  cfg: TuneConfig,
  transport: ActiveTransportKind,
  forceBridge: boolean,
  effectiveWatermark: number,
): void {
  const channels = cfg.channels ?? CHANNEL_COUNT;
  const schedule: SchedulePolicy = cfg.schedule ?? 'least-buffered';
  if (!forceBridge) {
    for (const p of [link.pool, link.blastPool]) {
      if (!p) continue;
      p.setActiveLanes(cfg.lanes);
      p.setActiveChannelsPerLane(channels);
      p.setSchedulePolicy(schedule);
      p.setHighWatermark(effectiveWatermark);
    }
  }
  const activeChannelTotal = channels + Math.max(0, cfg.lanes - 1) * 2;
  post({
    type: 'tune',
    linkId: link.id,
    highWatermark: effectiveWatermark,
    lowWatermark: lowWatermarkFor(effectiveWatermark, activeChannelTotal),
    lanes: cfg.lanes,
    channels,
    schedule,
    transport,
  });
}

async function gate(
  link: LinkState,
  job: SendJob,
  highWatermark: number,
  useBlastChannel: boolean,
): Promise<{ queueMs: number; creditMs: number }> {
  let queueMs = 0;
  let creditMs = 0;

  while (!job.cancelled && job.userPaused) {
    await new Promise<void>((resolve) => job.pauseWaiters.push(resolve));
  }
  if (job.cancelled) return { queueMs, creditMs };

  // 1. Application-level receiver credit gate.
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
  const targetPool = !job.forceBridge
    ? useBlastChannel && link.blastPool && link.blastPool.isOpen
      ? link.blastPool
      : link.pool
    : null;

  if (targetPool) {
    while (!job.cancelled && !targetPool.canSend) {
      const t0 = performance.now();
      await targetPool.waitForDrain();
      queueMs += performance.now() - t0;
      while (!job.cancelled && job.userPaused) {
        await new Promise<void>((resolve) => job.pauseWaiters.push(resolve));
      }
    }
    return { queueMs, creditMs };
  }

  const isPaused = () => (useBlastChannel ? link.blastPaused : link.paused);
  const inFlight = () => (useBlastChannel ? link.blastInFlightBytes : link.inFlightBytes);

  while (!job.cancelled && (isPaused() || inFlight() >= highWatermark)) {
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

async function readJobMacro(job: SendJob, macroOffset: number, totalLimit: number): Promise<ArrayBuffer> {
  const length = Math.min(DISK_MACRO_BYTES, totalLimit - macroOffset);
  if (!job.file) {
    const synth = getSyntheticMacro(job.compressibleBench);
    return length >= synth.byteLength ? synth : synth.slice(0, length);
  }
  const macroIdx = Math.floor(macroOffset / DISK_MACRO_BYTES);
  const preloaded = job.preloadedMacros?.get(macroIdx);
  if (preloaded) return preloaded;

  const cacheKey = `${job.fileCachePrefix}:${macroIdx}`;
  const cached = sharedBlockCache.get(cacheKey);
  if (cached && cached.byteLength === length) return cached;

  const buf = await job.file.slice(macroOffset, macroOffset + length).arrayBuffer();
  sharedBlockCache.put(cacheKey, buf);
  if (job.preloadedMacros) job.preloadedMacros.set(macroIdx, buf);
  return buf;
}

/** Sends a single payload slice over either the native worker ChannelPool or the UI bridge. */
function transmitSlice(
  link: LinkState,
  job: SendJob,
  fileOffset: number,
  raw: Uint8Array,
  useLz4: boolean,
  useBlastChannel: boolean,
): { wireLength: number; lz4Ms: number } {
  const targetPool = !job.forceBridge
    ? useBlastChannel && link.blastPool && link.blastPool.isOpen
      ? link.blastPool
      : link.pool
    : null;
  let lz4Ms = 0;
  let wireLength = 0;

  if (useLz4 && codec) {
    const c0 = performance.now();
    const compressedFrame = codec.compressFrame(raw, FRAME_HEADER_BYTES);
    lz4Ms = performance.now() - c0;

    if (compressedFrame.byteLength < FRAME_HEADER_BYTES + raw.byteLength * 0.96) {
      writeFrameHeader(compressedFrame, fileOffset, true);
      wireLength = compressedFrame.byteLength;
      if (targetPool) {
        if (!targetPool.send(compressedFrame)) throw new Error('All data channels closed');
      } else {
        if (useBlastChannel) link.blastInFlightBytes += wireLength;
        else link.inFlightBytes += wireLength;
        post(
          {
            type: 'frame-out',
            linkId: job.linkId,
            transferId: job.id,
            data: compressedFrame,
            blast: useBlastChannel,
            viaForceBridge: job.forceBridge,
          },
          [compressedFrame],
        );
      }
      return { wireLength, lz4Ms };
    }
  }

  if (targetPool) {
    writeFrameHeader(scratchFrame, fileOffset, false);
    new Uint8Array(scratchFrame, FRAME_HEADER_BYTES, raw.byteLength).set(raw);
    wireLength = FRAME_HEADER_BYTES + raw.byteLength;
    if (!targetPool.send(new Uint8Array(scratchFrame, 0, wireLength))) {
      throw new Error('All data channels closed');
    }
  } else {
    const frame = encodeFrame(fileOffset, raw, false);
    wireLength = frame.byteLength;
    if (useBlastChannel) link.blastInFlightBytes += wireLength;
    else link.inFlightBytes += wireLength;
    post(
      {
        type: 'frame-out',
        linkId: job.linkId,
        transferId: job.id,
        data: frame,
        blast: useBlastChannel,
        viaForceBridge: job.forceBridge,
      },
      [frame],
    );
  }
  return { wireLength, lz4Ms };
}

/**
 * Selectively retransmits missing 16 KiB blocks reported via receiver Bitmap NACKs.
 * Always transmits repairs over the RELIABLE unordered `pool` (`useBlastChannel = false`)
 * so repaired blocks are guaranteed to arrive without recursive re-drops!
 */
async function drainRepairQueue(
  link: LinkState,
  job: SendJob,
  totalLimit: number,
  useLz4: boolean,
  watermark: number,
  maxBlocksThisTurn = Number.POSITIVE_INFINITY,
): Promise<{ queueMs: number; diskMs: number; lz4Ms: number }> {
  let queueMs = 0;
  let diskMs = 0;
  let lz4Ms = 0;
  let sentBlocks = 0;

  while (job.repairQueue.length > 0 && sentBlocks < maxBlocksThisTurn && !job.cancelled) {
    const range = job.repairQueue[0];
    const startBlock = range[0];
    const count = range[1];
    if (count <= 0) {
      job.repairQueue.shift();
      continue;
    }

    const blockOffset = startBlock * BLOCK_BYTES;
    if (blockOffset >= totalLimit) {
      job.repairQueue.shift();
      continue;
    }

    const macroIndex = Math.floor(blockOffset / DISK_MACRO_BYTES);
    const macroStart = macroIndex * DISK_MACRO_BYTES;
    const d0 = performance.now();
    const macroBuf = await readJobMacro(job, macroStart, totalLimit);
    diskMs += performance.now() - d0;

    // Coalesce up to 2 contiguous missing blocks (32 KiB) per reliable repair frame inside the same macro-block
    const maxBlocksInMacro = Math.ceil((macroStart + macroBuf.byteLength - blockOffset) / BLOCK_BYTES);
    const batchBlocks = Math.max(1, Math.min(2, count, maxBlocksInMacro, maxBlocksThisTurn - sentBlocks));
    const byteInMacro = blockOffset - macroStart;
    const byteLen = Math.min(batchBlocks * BLOCK_BYTES, macroBuf.byteLength - byteInMacro, totalLimit - blockOffset);

    // Repairs bypass receiver credit gate (blocks were already accounted in Pass 1 rawBytes) and use reliable pool
    if (link.pool && !job.forceBridge) {
      while (!job.cancelled && !link.pool.canSend) {
        const q0 = performance.now();
        await link.pool.waitForDrain();
        queueMs += performance.now() - q0;
      }
    } else {
      while (!job.cancelled && (link.paused || link.inFlightBytes >= watermark)) {
        const q0 = performance.now();
        await new Promise<void>((r) => link.resumeWaiters.push(r));
        queueMs += performance.now() - q0;
      }
    }
    if (job.cancelled) break;

    const slice = new Uint8Array(macroBuf, byteInMacro, byteLen);
    const tx = transmitSlice(link, job, blockOffset, slice, useLz4, false);
    job.wireBytes += tx.wireLength;
    lz4Ms += tx.lz4Ms;
    job.retransmittedBlocks += batchBlocks;
    sentBlocks += batchBlocks;

    if (batchBlocks >= count) {
      job.repairQueue.shift();
    } else {
      range[0] = startBlock + batchBlocks;
      range[1] = count - batchBlocks;
    }
  }

  return { queueMs, diskMs, lz4Ms };
}

async function runLocalBusSend(job: SendJob, link: LinkState): Promise<void> {
  const token = job.localBusToken!;
  const bc = new BroadcastChannel(`warp-data-bus:${token}`);
  const totalLimit = job.file ? job.file.size : (job.syntheticBytes ?? Number.POSITIVE_INFINITY);
  let useLz4 = job.compress && codec !== null;
  const tuner = new AdaptiveTuner(deviceProfile, MAX_CHUNK, 1, null, 'local-bus');
  if (job.pinned) tuner.pin({ ...job.pinned, transport: 'local-bus' });
  tuner.phase = 'settled';
  tuner.lastDecision = 'Zero-Copy Browser Memory Bus active (BroadcastChannel)';

  syncTuneToPoolOrBridge(link, tuner.config, 'local-bus', false, tuner.config.highWatermark);

  const startedAt = performance.now();
  const stopDeadline = job.durationMs ? startedAt + job.durationMs : Number.POSITIVE_INFINITY;
  let totalCreditMs = 0;
  let totalDiskMs = 0;
  let totalLz4Ms = 0;
  let bytesSinceYield = 0;
  let macroOffset = 0;
  let pendingMacro: Promise<ArrayBuffer> | null = totalLimit > 0 ? readJobMacro(job, 0, totalLimit) : null;

  try {
    outer: while (macroOffset < totalLimit && pendingMacro) {
      if (job.cancelled || performance.now() >= stopDeadline) break;
      const d0 = performance.now();
      const macroBuf = await pendingMacro;
      if (job.file !== null) totalDiskMs += performance.now() - d0;
      if (macroBuf.byteLength === 0) throw new Error('Source file shrank or became unreadable');
      const nextMacroOffset = macroOffset + macroBuf.byteLength;
      pendingMacro =
        nextMacroOffset < totalLimit && performance.now() < stopDeadline
          ? readJobMacro(job, nextMacroOffset, totalLimit)
          : null;

      let innerOffset = 0;
      while (innerOffset < macroBuf.byteLength) {
        if (job.cancelled) return;
        if (performance.now() >= stopDeadline) break outer;

        while (!job.cancelled && job.userPaused) {
          await new Promise<void>((r) => job.pauseWaiters.push(r));
        }
        if (Number.isFinite(job.creditWindow)) {
          while (!job.cancelled && job.rawBytes - job.creditedBytes >= job.creditWindow) {
            const c0 = performance.now();
            await new Promise<void>((r) => job.creditWaiters.push(r));
            totalCreditMs += performance.now() - c0;
          }
        }
        if (job.cancelled) return;
        if (performance.now() >= stopDeadline) break outer;

        const chunkLen = Math.min(256 * 1024, macroBuf.byteLength - innerOffset);
        const raw = new Uint8Array(macroBuf, innerOffset, chunkLen);
        const fileOffset = macroOffset + innerOffset;
        job.hasher.update(fileOffset, raw);

        let frame: ArrayBuffer;
        if (useLz4 && codec) {
          const l0 = performance.now();
          const comp = codec.compressFrame(raw, FRAME_HEADER_BYTES);
          totalLz4Ms += performance.now() - l0;
          if (comp.byteLength < FRAME_HEADER_BYTES + raw.byteLength * 0.96) {
            writeFrameHeader(comp, fileOffset, true);
            frame = comp;
          } else {
            frame = encodeFrame(fileOffset, raw, false);
          }
        } else {
          frame = encodeFrame(fileOffset, raw, false);
        }

        bc.postMessage(frame);
        innerOffset += chunkLen;
        job.rawBytes = fileOffset + chunkLen;
        job.wireBytes += frame.byteLength;

        bytesSinceYield += chunkLen;
        if (bytesSinceYield >= 4 * 1024 * 1024) {
          bytesSinceYield = 0;
          await new Promise((r) => setTimeout(r, 0));
        }

        if (useLz4 && job.rawBytes >= 2 * 1024 * 1024 && job.rawBytes / job.wireBytes < 1.05) {
          useLz4 = false;
        }
        const elapsed = Math.max(1, performance.now() - startedAt);
        tuner.drainBps = (job.wireBytes * 1000) / elapsed;
        emitSendProgress(job, tuner, useLz4);
      }
      macroOffset = nextMacroOffset;
    }
  } finally {
    bc.close();
  }

  if (job.cancelled) return;
  const elapsedMs = Math.max(1, performance.now() - startedAt);
  tuner.drainBps = (job.wireBytes * 1000) / elapsedMs;
  emitSendProgress(job, tuner, useLz4, true);
  post({
    type: 'send-drained',
    transferId: job.id,
    rawBytes: job.rawBytes,
    wireBytes: job.wireBytes,
    elapsedMs,
    queueWaitMs: 0,
    creditWaitMs: totalCreditMs,
    diskWaitMs: totalDiskMs,
    lz4Ms: totalLz4Ms,
    retransmittedBlocks: 0,
    hash: job.hasher.digestHex(),
    finalTuner: tuner.snapshot(useLz4),
  });
}

async function runTurboSend(job: SendJob, link: LinkState): Promise<void> {
  const endpoint = job.turboEndpoint!.replace(/\/+$/, '');
  const ctrl = new AbortController();
  job.abortCtrl = ctrl;

  const tuner = new AdaptiveTuner(deviceProfile, MAX_CHUNK, 1, null, 'lan-turbo');
  tuner.phase = 'settled';
  tuner.bottleneck = 'network';
  tuner.lastDecision = 'Unencrypted LAN Turbo TCP Cut-Through Pipe active';
  syncTuneToPoolOrBridge(link, tuner.config, 'lan-turbo', false, tuner.config.highWatermark);

  const startedAt = performance.now();
  let totalDiskMs = 0;

  if (job.file !== null) {
    // Real file transfer: single uninterrupted zero-copy HTTP PUT stream + parallel 128-bit block hash
    const file = job.file;
    const pipeUrl = `${endpoint}/warp-turbo/pipe/${encodeURIComponent(job.id)}?role=put`;

    const progressTimer = setInterval(() => {
      if (job.cancelled) return;
      const shown = Math.max(job.rawBytes, Math.min(file.size, job.creditedBytes));
      job.rawBytes = shown;
      job.wireBytes = shown;
      const elapsed = Math.max(1, performance.now() - startedAt);
      tuner.drainBps = (shown * 1000) / elapsed;
      emitSendProgress(job, tuner, false);
    }, PROGRESS_INTERVAL_MS);

    try {
      const putPromise = fetch(pipeUrl, {
        method: 'PUT',
        headers: { 'X-Warp-Size': String(file.size) },
        body: file,
        signal: ctrl.signal,
        cache: 'no-store',
      });

      const hashPromise = (async () => {
        for (let off = 0; off < file.size && !job.cancelled; off += DISK_MACRO_BYTES) {
          const d0 = performance.now();
          const buf = await readJobMacro(job, off, file.size);
          totalDiskMs += performance.now() - d0;
          job.hasher.update(off, new Uint8Array(buf));
        }
      })();

      const [putRes] = await Promise.all([putPromise, hashPromise]);
      if (!putRes.ok && !job.cancelled) {
        throw new Error(`LAN Turbo pipe HTTP ${putRes.status}`);
      }
    } finally {
      clearInterval(progressTimer);
    }

    if (job.cancelled) return;
    job.rawBytes = file.size;
    job.wireBytes = file.size;
  } else {
    // Benchmark mode: stream 32 MiB zero-copy Blob segments until `durationMs` completes, then send clean 204 EOF
    const synthBuf = getSyntheticMacro(job.compressibleBench);
    const synthView = new Uint8Array(synthBuf);
    const SEG_REPEATS = 4; // 4 × 8 MiB = 32 MiB per TCP cut-through segment
    const SEG_BYTES = SEG_REPEATS * synthBuf.byteLength;
    const segBlob = new Blob(Array.from({ length: SEG_REPEATS }, () => synthBuf));
    const stopDeadline = job.durationMs ? startedAt + job.durationMs : startedAt + 3_500;

    let seg = 0;
    while (!job.cancelled && performance.now() < stopDeadline) {
      const segUrl = `${endpoint}/warp-turbo/pipe/${encodeURIComponent(job.id)}-s${seg}?role=put`;
      const putPromise = fetch(segUrl, {
        method: 'PUT',
        headers: { 'X-Warp-Size': String(SEG_BYTES) },
        body: segBlob,
        signal: ctrl.signal,
        cache: 'no-store',
      });
      const baseOff = seg * SEG_BYTES;
      for (let m = 0; m < SEG_REPEATS; m++) {
        job.hasher.update(baseOff + m * synthBuf.byteLength, synthView);
      }
      const res = await putPromise;
      if (!res.ok && !job.cancelled) {
        throw new Error(`LAN Turbo benchmark HTTP ${res.status}`);
      }
      seg++;
      job.rawBytes += SEG_BYTES;
      job.wireBytes += SEG_BYTES;
      const elapsed = Math.max(1, performance.now() - startedAt);
      tuner.drainBps = (job.wireBytes * 1000) / elapsed;
      emitSendProgress(job, tuner, false);
    }

    if (!job.cancelled) {
      const eofUrl = `${endpoint}/warp-turbo/pipe/${encodeURIComponent(job.id)}-s${seg}?role=put`;
      await fetch(eofUrl, {
        method: 'PUT',
        headers: { 'X-Warp-Eof': '1' },
        body: new Uint8Array(0),
        cache: 'no-store',
      }).catch(() => undefined);
    }
  }

  if (job.cancelled) return;
  const elapsedMs = Math.max(1, performance.now() - startedAt);
  tuner.drainBps = (job.wireBytes * 1000) / elapsedMs;
  tuner.lastDecision = `LAN Turbo TCP · ${((job.wireBytes / (1024 * 1024)) / (elapsedMs / 1000)).toFixed(1)} MB/s`;
  emitSendProgress(job, tuner, false, true);
  post({
    type: 'send-drained',
    transferId: job.id,
    rawBytes: job.rawBytes,
    wireBytes: job.wireBytes,
    elapsedMs,
    queueWaitMs: 0,
    creditWaitMs: 0,
    diskWaitMs: totalDiskMs,
    lz4Ms: 0,
    retransmittedBlocks: 0,
    hash: job.hasher.digestHex(),
    finalTuner: tuner.snapshot(false),
  });
}

async function runSend(job: SendJob): Promise<void> {
  const link = getLink(job.linkId);
  if (job.transport === 'local-bus' && job.localBusToken) {
    await runLocalBusSend(job, link);
    return;
  }
  if (job.transport === 'lan-turbo' && job.turboEndpoint) {
    await runTurboSend(job, link);
    return;
  }

  const isBench = job.file === null;
  const totalLimit = job.file ? job.file.size : (job.syntheticBytes ?? Number.POSITIVE_INFINITY);
  let useLz4 = job.compress && codec !== null;
  if (job.compress && !codec) throw new Error('LZ4 codec unavailable in sender worker');

  const initialPool = activePoolFor(link, job.transport, job.forceBridge);
  if (initialPool) await waitForOpen(initialPool, job);

  const useBlast =
    job.transport === 'blast-nack' &&
    (job.forceBridge ? link.blastBridgeOpenLanes > 0 : link.blastPool !== null && link.blastPool.isOpen);
  const effectiveTransport: ActiveTransportKind = useBlast ? 'blast-nack' : 'reliable-sctp';
  job.transport = effectiveTransport;

  const maxChunkInit = largestChunkFor(link.maxMessageSize, FRAME_HEADER_BYTES);
  const tuner = new AdaptiveTuner(
    deviceProfile,
    maxChunkInit,
    openLanesFor(link, effectiveTransport, job.forceBridge),
    job.ignoreSeed ? null : link.seed,
    effectiveTransport,
  );
  if (job.pinned) tuner.pin(job.pinned);
  syncTuneToPoolOrBridge(
    link,
    tuner.config,
    effectiveTransport,
    job.forceBridge,
    fairWatermarkFor(tuner.config.highWatermark, job),
  );

  // Optional background RAM preload for files within `ramPreloadBudget` (zero disk wait!)
  if (job.file && job.file.size > 0 && job.file.size <= job.ramPreloadBudget) {
    job.preloadedMacros = new Map();
    const preloadTarget = job.file;
    void (async () => {
      for (let off = 0; off < preloadTarget.size && !job.cancelled; off += DISK_MACRO_BYTES) {
        await readJobMacro(job, off, preloadTarget.size).catch(() => undefined);
      }
    })();
  }

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
  let bytesSinceYield = 0;

  let macroOffset = 0;
  let pendingMacro: Promise<ArrayBuffer> | null =
    totalLimit > 0 ? readJobMacro(job, 0, totalLimit) : null;

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
        ? readJobMacro(job, nextMacroOffset, totalLimit)
        : null;

    let innerOffset = 0;
    while (innerOffset < macroBuf.byteLength) {
      if (job.cancelled) return;
      if (performance.now() >= stopDeadline) break outer;

      const effectiveWM = fairWatermarkFor(tuner.config.highWatermark, job);

      // Interleave any rolling NACK block repairs immediately over reliable pool!
      if (job.repairQueue.length > 0) {
        const rep = await drainRepairQueue(link, job, job.rawBytes, useLz4, effectiveWM, 32);
        epochQueueMs += rep.queueMs;
        epochDiskMs += rep.diskMs;
        epochLz4Ms += rep.lz4Ms;
        totalQueueMs += rep.queueMs;
        totalDiskMs += rep.diskMs;
        totalLz4Ms += rep.lz4Ms;
      }

      const waits = await gate(link, job, effectiveWM, effectiveTransport === 'blast-nack');
      epochQueueMs += waits.queueMs;
      epochCreditMs += waits.creditMs;
      totalQueueMs += waits.queueMs;
      totalCreditMs += waits.creditMs;
      if (job.cancelled) return;
      if (performance.now() >= stopDeadline) break outer;

      if (
        tuner.setLimits(
          largestChunkFor(link.maxMessageSize, FRAME_HEADER_BYTES),
          openLanesFor(link, effectiveTransport, job.forceBridge),
        )
      ) {
        syncTuneToPoolOrBridge(
          link,
          tuner.config,
          effectiveTransport,
          job.forceBridge,
          fairWatermarkFor(tuner.config.highWatermark, job),
        );
      }

      const chunkLen = Math.min(tuner.config.chunk, macroBuf.byteLength - innerOffset);
      const raw = new Uint8Array(macroBuf, innerOffset, chunkLen);
      const fileOffset = macroOffset + innerOffset;

      // Hash each logical file byte range ONCE during Pass 1
      job.hasher.update(fileOffset, raw);

      const tx = transmitSlice(link, job, fileOffset, raw, useLz4, effectiveTransport === 'blast-nack');
      innerOffset += chunkLen;
      job.rawBytes = fileOffset + chunkLen;
      job.wireBytes += tx.wireLength;
      epochLz4Ms += tx.lz4Ms;
      totalLz4Ms += tx.lz4Ms;

      // Multi-peer cooperative fairness yield every 512 KiB when multiple transfers are active
      bytesSinceYield += chunkLen;
      if (sendJobs.size > 1 && bytesSinceYield >= 512 * 1024 && (!job.file || job.file.size > 16 * 1024 * 1024)) {
        bytesSinceYield = 0;
        await new Promise((r) => setTimeout(r, 0));
      }

      if (useLz4 && !job.pinned && job.rawBytes >= 2 * 1024 * 1024 && job.rawBytes / job.wireBytes < 1.05) {
        useLz4 = false;
      }

      const now = performance.now();
      const epochElapsed = now - epochStart;
      const minEpoch = Math.max(EPOCH_MIN_MS, Math.min(1_500, link.rttMs * 4));
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
          retransmittedBlocks: job.retransmittedBlocks,
        });
        if (changed) {
          syncTuneToPoolOrBridge(
            link,
            tuner.config,
            effectiveTransport,
            job.forceBridge,
            fairWatermarkFor(tuner.config.highWatermark, job),
          );
        }
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

  // Flush Pass 1 send buffers
  if (!job.forceBridge) {
    const f0 = performance.now();
    if (link.blastPool) await link.blastPool.flush();
    if (link.pool) await link.pool.flush();
    totalQueueMs += performance.now() - f0;
  }
  if (job.cancelled) return;

  const senderHash = job.hasher.digestHex();

  // Blast-NACK End-of-Pass Audit & Selective Missing-Block Repair Loop
  if (effectiveTransport === 'blast-nack' && job.rawBytes > 0) {
    const finalByteCount = job.rawBytes;
    let auditRound = 0;
    while (!job.cancelled && !job.finalAuditComplete && auditRound < 12) {
      auditRound++;
      post({ type: 'blast-eof-out', transferId: job.id, totalBytes: finalByteCount, senderHash });

      // Wait for receiver's final bitmap audit (`nack-in` with finalAudit=true)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_500);
        job.repairWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });

      if (job.cancelled || job.finalAuditComplete) break;
      if (job.repairQueue.length > 0) {
        const effectiveWM = fairWatermarkFor(tuner.config.highWatermark, job);
        const rep = await drainRepairQueue(link, job, finalByteCount, useLz4, effectiveWM);
        totalQueueMs += rep.queueMs;
        totalDiskMs += rep.diskMs;
        totalLz4Ms += rep.lz4Ms;
        if (link.pool && !job.forceBridge) {
          const f0 = performance.now();
          await link.pool.flush();
          totalQueueMs += performance.now() - f0;
        }
        emitSendProgress(job, tuner, useLz4, true);
      }
    }
  }

  if (job.cancelled) return;

  if (!job.pinned && tuner.drainBps > 0) {
    link.seed = {
      chunk: tuner.config.chunk,
      lanes: tuner.config.lanes,
      highWatermark: tuner.config.highWatermark,
      transport: effectiveTransport,
    };
  }

  const elapsedMs = Math.max(1, performance.now() - startedAt);
  tuner.retransmittedBlocks = job.retransmittedBlocks;
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
    retransmittedBlocks: job.retransmittedBlocks,
    hash: senderHash,
    finalTuner: tuner.snapshot(useLz4),
  });
}

// ───────────────────────────── Receiver ─────────────────────────────

interface RecvJob {
  id: string;
  linkId: string;
  name: string;
  mime: string;
  size: number;
  targetBytes: number;
  compress: boolean;
  transport: ActiveTransportKind;
  turboEndpoint: string | null;
  localBusChannel: BroadcastChannel | null;
  abortCtrl: AbortController | null;
  bench: boolean;
  saveHandle: FileSystemFileHandle | null;
  sink: DiskSink | null;
  bitmap: BlockBitmap;
  nextRollingScanBlock: number;
  blastEofReceived: boolean;
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

function cleanupRecvTransports(job: RecvJob): void {
  if (job.localBusChannel) {
    try {
      job.localBusChannel.close();
    } catch {
      // Ignore.
    }
    job.localBusChannel = null;
  }
  if (job.abortCtrl) {
    try {
      job.abortCtrl.abort();
    } catch {
      // Ignore.
    }
    job.abortCtrl = null;
  }
}

function failRecv(job: RecvJob, message: string): void {
  if (job.failed || job.finished) return;
  job.failed = true;
  if (job.benchStopTimer !== null) clearTimeout(job.benchStopTimer);
  cleanupRecvTransports(job);
  recvJobs.delete(job.id);
  if (recvByLink.get(job.linkId) === job.id) recvByLink.delete(job.linkId);
  void job.sink?.abort();
  post({ type: 'transfer-error', transferId: job.id, message });
}

function maybeEmitCredit(job: RecvJob): void {
  if (job.failed || job.finished) return;
  // In Blast-NACK mode, sender advances `rawBytes` monotonically across Pass 1 even when a few
  // datagrams drop; adding the small gap inside the scanned window prevents credit deadlock.
  const effectivePersisted =
    job.transport === 'blast-nack'
      ? Math.max(job.persistedBytes, Math.min(job.targetBytes, job.bitmap.highestBlock * BLOCK_BYTES))
      : job.persistedBytes;
  if (effectivePersisted - job.lastCreditedBytes >= job.creditStep) {
    job.lastCreditedBytes = effectivePersisted;
    post({ type: 'credit-out', transferId: job.id, bytes: effectivePersisted });
  }
}

function maybeEmitRollingNack(job: RecvJob): void {
  if (job.transport !== 'blast-nack' || job.blastEofReceived || job.finished || job.failed) return;
  const safeCeiling = job.bitmap.highestBlock - ROLLING_REORDER_MARGIN_BLOCKS;
  if (safeCeiling - job.nextRollingScanBlock < ROLLING_NACK_STRIDE_BLOCKS) return;

  const { ranges, nextScanBlock } = job.bitmap.findMissingRanges(job.nextRollingScanBlock, safeCeiling, 64);
  job.nextRollingScanBlock = nextScanBlock;
  if (ranges.length > 0) {
    post({
      type: 'nack-out',
      transferId: job.id,
      receivedBlocks: job.bitmap.receivedBlocks,
      totalBlocks: job.bitmap.totalBlocks,
      ranges,
      finalAudit: false,
    });
  }
}

function performFinalBlastAudit(job: RecvJob): void {
  if (job.finished || job.failed) return;
  // Drain any frames already queued in rxQueue before auditing the bitmap!
  while (rxQueue.length > 0) {
    const item = rxQueue.shift()!;
    handleIncoming(item.linkId, item.frame);
  }
  if (job.finished || job.failed) return;

  if (job.bitmap.isComplete || job.targetBytes === 0) {
    post({
      type: 'nack-out',
      transferId: job.id,
      receivedBlocks: job.bitmap.receivedBlocks,
      totalBlocks: job.bitmap.totalBlocks,
      ranges: [],
      finalAudit: true,
    });
    checkRecvCompletion(job);
    return;
  }

  const { ranges } = job.bitmap.findMissingRanges(0, job.bitmap.totalBlocks, 256);
  post({
    type: 'nack-out',
    transferId: job.id,
    receivedBlocks: job.bitmap.receivedBlocks,
    totalBlocks: job.bitmap.totalBlocks,
    ranges,
    finalAudit: true,
  });
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
    let newlyAcceptedBytes = 0;

    const write = (bytes: Uint8Array) => {
      const len = bytes.byteLength;
      if (!job.bench && offset + len > job.size) {
        throw new RangeError(`Frame at ${offset} overruns file size ${job.size}`);
      }

      // Process aligned 16 KiB sub-blocks idempotently through BlockBitmap so duplicate
      // packets (if any) are never hashed or persisted twice.
      let pos = 0;
      while (pos < len) {
        const subOffset = offset + pos;
        const subLen = Math.min(BLOCK_BYTES, len - pos);
        const blockIdx = Math.floor(subOffset / BLOCK_BYTES);
        const isFirstArrival = subOffset % BLOCK_BYTES === 0 ? job.bitmap.markBlock(blockIdx) : true;

        if (isFirstArrival) {
          const subSlice = bytes.subarray(pos, pos + subLen);
          job.hasher.update(subOffset, subSlice);
          newlyAcceptedBytes += subLen;

          const t0 = performance.now();
          const result = sink.write(subOffset, subSlice);
          if (result) {
            job.pendingWriteBytes += subLen;
            if (job.pendingWriteBytes > job.maxPendingWriteBytes) {
              job.maxPendingWriteBytes = job.pendingWriteBytes;
            }
            job.inflight.add(result);
            result.then(
              () => {
                job.inflight.delete(result);
                job.pendingWriteBytes = Math.max(0, job.pendingWriteBytes - subLen);
                job.writeMs += performance.now() - t0;
                job.persistedBytes += subLen;
                maybeEmitCredit(job);
                checkRecvCompletion(job);
              },
              (error: unknown) => failRecv(job, `Disk write failed: ${String(error)}`),
            );
          } else {
            job.writeMs += performance.now() - t0;
            job.persistedBytes += subLen;
            maybeEmitCredit(job);
          }
        }
        pos += subLen;
      }
    };

    if (compressed) {
      if (!codec) throw new Error('LZ4 codec unavailable in receiver worker');
      codec.decompressInto(payload, write);
    } else {
      write(payload);
    }

    if (job.rawBytes === 0 && newlyAcceptedBytes > 0) job.startedAt = performance.now();
    job.rawBytes += newlyAcceptedBytes;
    job.wireBytes += frame.byteLength;
    maybeEmitRollingNack(job);
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

function ingestRawBytesAt(job: RecvJob, offset: number, bytes: Uint8Array, checkComplete = true): void {
  if (job.failed || job.finished || bytes.byteLength === 0) return;
  const sink = job.sink!;
  if (!job.bench && offset + bytes.byteLength > job.size) {
    failRecv(job, `Stream at ${offset} overruns file size ${job.size}`);
    return;
  }

  if (job.rawBytes === 0) job.startedAt = performance.now();

  let pos = 0;
  let newlyAccepted = 0;
  while (pos < bytes.byteLength) {
    const subOffset = offset + pos;
    const subLen = Math.min(BLOCK_BYTES, bytes.byteLength - pos);
    const blockIdx = Math.floor(subOffset / BLOCK_BYTES);
    const isFirst = subOffset % BLOCK_BYTES === 0 ? job.bitmap.markBlock(blockIdx) : true;
    if (isFirst) {
      const subSlice = bytes.subarray(pos, pos + subLen);
      job.hasher.update(subOffset, subSlice);
      newlyAccepted += subLen;

      const t0 = performance.now();
      const result = sink.write(subOffset, subSlice);
      if (result) {
        job.pendingWriteBytes += subLen;
        if (job.pendingWriteBytes > job.maxPendingWriteBytes) {
          job.maxPendingWriteBytes = job.pendingWriteBytes;
        }
        job.inflight.add(result);
        result.then(
          () => {
            job.inflight.delete(result);
            job.pendingWriteBytes = Math.max(0, job.pendingWriteBytes - subLen);
            job.writeMs += performance.now() - t0;
            job.persistedBytes += subLen;
            maybeEmitCredit(job);
            if (!job.bench) checkRecvCompletion(job);
          },
          (error: unknown) => failRecv(job, `Disk write failed: ${String(error)}`),
        );
      } else {
        job.writeMs += performance.now() - t0;
        job.persistedBytes += subLen;
        maybeEmitCredit(job);
      }
    }
    pos += subLen;
  }

  job.rawBytes += newlyAccepted;
  job.wireBytes += bytes.byteLength;

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
  if (checkComplete) checkRecvCompletion(job);
}

async function streamReaderAligned(
  job: RecvJob,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  startOffset: number,
  checkComplete: boolean,
): Promise<number> {
  let offset = startOffset;
  const carry = new Uint8Array(BLOCK_BYTES);
  let carryLen = 0;

  while (!job.failed && !job.finished) {
    if (job.pendingWriteBytes >= 16 * 1024 * 1024 && job.inflight.size > 0) {
      await Promise.race(job.inflight);
    }
    const { value, done } = await reader.read();
    if (done || !value || value.byteLength === 0) break;

    let vPos = 0;
    if (carryLen > 0) {
      const need = Math.min(BLOCK_BYTES - carryLen, value.byteLength);
      carry.set(value.subarray(0, need), carryLen);
      carryLen += need;
      vPos += need;
      if (carryLen === BLOCK_BYTES) {
        ingestRawBytesAt(job, offset, job.sink?.synchronous ? carry : carry.slice(), checkComplete);
        offset += BLOCK_BYTES;
        carryLen = 0;
        if (job.failed || job.finished) return offset;
      }
    }

    const rem = value.byteLength - vPos;
    const alignedLen = rem & ~(BLOCK_BYTES - 1);
    if (alignedLen > 0) {
      ingestRawBytesAt(job, offset, value.subarray(vPos, vPos + alignedLen), checkComplete);
      offset += alignedLen;
      vPos += alignedLen;
      if (job.failed || job.finished) return offset;
    }

    const tailLen = value.byteLength - vPos;
    if (tailLen > 0) {
      carry.set(value.subarray(vPos), 0);
      carryLen = tailLen;
    }
  }

  if (carryLen > 0 && !job.failed && !job.finished) {
    ingestRawBytesAt(job, offset, carry.slice(0, carryLen), checkComplete);
    offset += carryLen;
  }
  return offset;
}

async function runTurboRecv(job: RecvJob, endpoint: string): Promise<void> {
  const ep = endpoint.replace(/\/+$/, '');
  try {
    if (!job.bench) {
      const pipeUrl = `${ep}/warp-turbo/pipe/${encodeURIComponent(job.id)}?role=get`;
      const res = await fetch(pipeUrl, {
        method: 'GET',
        signal: job.abortCtrl?.signal,
        cache: 'no-store',
      });
      if (!res.ok || !res.body) {
        throw new Error(`LAN Turbo GET failed (HTTP ${res.status})`);
      }
      await streamReaderAligned(job, res.body.getReader(), 0, true);
      if (!job.failed && !job.finished) {
        if (job.rawBytes >= job.targetBytes) checkRecvCompletion(job);
        else failRecv(job, `LAN Turbo stream truncated (${job.rawBytes} / ${job.targetBytes} bytes)`);
      }
    } else {
      let offset = 0;
      let seg = 0;
      while (!job.failed && !job.finished) {
        const segUrl = `${ep}/warp-turbo/pipe/${encodeURIComponent(job.id)}-s${seg}?role=get`;
        const res = await fetch(segUrl, {
          method: 'GET',
          signal: job.abortCtrl?.signal,
          cache: 'no-store',
        });
        if (res.status === 204 || res.headers.get('x-warp-eof') === '1') {
          break;
        }
        if (!res.ok || !res.body) {
          throw new Error(`LAN Turbo benchmark GET failed (HTTP ${res.status})`);
        }
        offset = await streamReaderAligned(job, res.body.getReader(), offset, false);
        seg++;
      }
      if (!job.failed && !job.finished) {
        job.targetBytes = offset;
        job.bitmap.setFinalByteSize(offset);
        void finalizeBenchRecv(job);
      }
    }
  } catch (error) {
    if (!job.failed && !job.finished) {
      failRecv(job, `LAN Turbo receive error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function checkRecvCompletion(job: RecvJob): void {
  if (job.finished || job.failed) return;
  const bitmapDone = Number.isFinite(job.targetBytes)
    ? job.targetBytes === 0 || (job.bitmap.totalBlocks > 0 && job.bitmap.isComplete)
    : false;
  if (bitmapDone || job.rawBytes >= job.targetBytes) {
    if (job.blastEofReceived) {
      post({
        type: 'nack-out',
        transferId: job.id,
        receivedBlocks: job.bitmap.receivedBlocks,
        totalBlocks: job.bitmap.totalBlocks,
        ranges: [],
        finalAudit: true,
      });
    }
    if (job.bench) void finalizeBenchRecv(job);
    else void finalizeRecv(job);
  }
}

async function finalizeBenchRecv(job: RecvJob): Promise<void> {
  if (job.finished || job.failed) return;
  job.finished = true;
  if (job.benchStopTimer !== null) clearTimeout(job.benchStopTimer);
  cleanupRecvTransports(job);
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
      duplicateBlocks: job.bitmap.duplicateBlocks,
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
  cleanupRecvTransports(job);
  if (recvByLink.get(job.linkId) === job.id) recvByLink.delete(job.linkId);
  const sink = job.sink!;
  const sinkKind = sink.kind;
  try {
    const f0 = performance.now();
    await Promise.all(job.inflight);
    const file = await sink.finalize();
    const opfsName = `${job.id}.part`;
    if (job.saveHandle) {
      // Only stream if the sink didn't already write straight to `saveHandle` (`DirectHandleSink` / `RamArenaSink`)!
      if (!sink.wroteDirectlyToHandle) {
        await streamToHandle(file, job.saveHandle);
      }
      if (sinkKind === 'opfs-sync' || sinkKind === 'opfs-writable') {
        await removeInboxFile(opfsName);
      }
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
      if (sinkKind === 'opfs-sync' || sinkKind === 'opfs-writable') deliveredFiles.set(job.id, opfsName);
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
  const localBusChannel =
    message.transport === 'local-bus' && message.localBusToken
      ? new BroadcastChannel(`warp-data-bus:${message.localBusToken}`)
      : null;
  const abortCtrl = message.transport === 'lan-turbo' && message.turboEndpoint ? new AbortController() : null;

  const job: RecvJob = {
    id: message.transferId,
    linkId: message.linkId,
    name: message.name,
    mime: message.mime ?? 'application/octet-stream',
    size: message.size,
    targetBytes: message.size,
    compress: message.compress,
    transport: message.transport,
    turboEndpoint: message.turboEndpoint ?? null,
    localBusChannel,
    abortCtrl,
    bench: message.bench,
    saveHandle: message.saveHandle,
    sink: null,
    bitmap: new BlockBitmap(message.size),
    nextRollingScanBlock: 0,
    blastEofReceived: false,
    creditWindow: INITIAL_HIGH_WATERMARK * 4,
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
    const arenaBudget = message.ramArenaBudget ?? deviceProfile.ramArenaBudget;
    job.sink = await openDiskSink(job.id, job.name, job.size, {
      mime: job.mime,
      preferredSink: preferred,
      maxMemoryBytes: memorySinkBudget(deviceProfile),
      ramArenaBudget: message.bench && preferred === 'auto' ? 0 : arenaBudget,
      saveHandle: message.saveHandle,
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

  if (localBusChannel) {
    localBusChannel.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      if (ev.data instanceof ArrayBuffer) enqueueIncoming(job.linkId, ev.data);
    };
  }
  if (job.transport === 'lan-turbo' && job.turboEndpoint) {
    void runTurboRecv(job, job.turboEndpoint);
  }

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
    send.abortCtrl?.abort();
    if (send.turboEndpoint) {
      const ep = send.turboEndpoint.replace(/\/+$/, '');
      void fetch(`${ep}/warp-turbo/pipe/${encodeURIComponent(transferId)}`, { method: 'DELETE' }).catch(() => undefined);
    }
    sendJobs.delete(transferId);
    releaseJobPause(send);
    releaseCredits(send);
    releaseRepairWaiters(send);
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
      cleanupRecvTransports(recv);
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
  link.blastPool?.dispose();
  releaseWaiters(link);
  links.delete(linkId);
}

function attachChannels(
  linkId: string,
  lane: string,
  channelKind: 'reliable' | 'blast',
  channels: RTCDataChannel[],
): void {
  const link = getLink(linkId);
  if (channelKind === 'blast') {
    if (!link.blastPool) link.blastPool = new ChannelPool();
    link.blastPool.addLane(lane, channels);
  } else {
    if (!link.pool) link.pool = new ChannelPool();
    link.pool.addLane(lane, channels);
  }

  for (const channel of channels) {
    channel.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
      if (event.data instanceof ArrayBuffer) enqueueIncoming(linkId, event.data);
    });
    if (channelKind === 'reliable') {
      channel.addEventListener('close', () => {
        if (lane === '0' && channels.every((c) => c.readyState === 'closed')) {
          detachLink(linkId, 'Peer link closed');
        }
      });
    }
  }

  if (!link.queueTimer) {
    link.queueTimer = setInterval(() => {
      const activePool =
        link.blastPool && link.blastPool.totalBuffered > 0 ? link.blastPool : link.pool ?? link.blastPool;
      if (!activePool) return;
      post({
        type: 'queue',
        linkId,
        buffered: activePool.bufferedAmounts,
        lanes: activePool.channelLaneIds,
        active: activePool.activeChannelCount,
        highWatermark: activePool.highWatermark,
      });
    }, 200);
  }
  post({ type: 'attached', linkId, lane, channelKind });
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
      attachChannels(message.linkId, message.lane, message.channelKind ?? 'reliable', message.channels);
      break;
    case 'detach-lane': {
      const link = links.get(message.linkId);
      for (const p of [link?.pool, link?.blastPool]) {
        const removed = p?.removeLane(message.lane);
        if (removed) {
          for (const ch of removed) {
            try {
              ch.close();
            } catch {
              // Ignore.
            }
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
      const file = message.file;
      const job: SendJob = {
        id: message.transferId,
        linkId: message.linkId,
        file,
        fileCachePrefix: file ? `${file.name}:${file.size}:${file.lastModified}` : `bench:${message.transferId}`,
        preloadedMacros: null,
        syntheticBytes: message.syntheticBytes,
        compressibleBench: Boolean(message.compressibleBench),
        forceBridge: Boolean(message.forceBridge),
        compress: message.compress,
        transport: message.transport,
        turboEndpoint: message.turboEndpoint ?? null,
        localBusToken: message.localBusToken ?? null,
        ignoreSeed: Boolean(message.ignoreSeed),
        abortCtrl: null,
        creditWindow: message.creditWindow,
        creditedBytes: 0,
        creditWaiters: [],
        ramPreloadBudget: message.ramPreloadBudget ?? deviceProfile.senderRamPreloadBudget,
        durationMs: message.durationMs,
        pinned: message.pinned ?? null,
        cancelled: false,
        userPaused: false,
        pauseWaiters: [],
        repairQueue: [],
        repairWaiters: [],
        finalAuditComplete: false,
        retransmittedBlocks: 0,
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
    case 'nack-in': {
      const job = sendJobs.get(message.transferId);
      if (!job || job.cancelled) break;
      if (message.finalAudit && message.ranges.length === 0) {
        job.finalAuditComplete = true;
        releaseRepairWaiters(job);
        break;
      }
      for (const r of message.ranges) {
        if (r[1] > 0) job.repairQueue.push([r[0], r[1]]);
      }
      if (message.finalAudit) {
        releaseRepairWaiters(job);
      }
      break;
    }
    case 'bridge-stats': {
      const link = getLink(message.linkId);
      link.bridgeSentBytes = message.sentBytes;
      link.bridgeBuffered = message.buffered;
      link.bridgeOpenLanes = Math.max(1, message.openLanes);
      if (message.blastSentBytes !== undefined) link.blastBridgeSentBytes = message.blastSentBytes;
      if (message.blastBuffered !== undefined) link.blastBridgeBuffered = message.blastBuffered;
      if (message.blastOpenLanes !== undefined) link.blastBridgeOpenLanes = Math.max(1, message.blastOpenLanes);
      break;
    }
    case 'flow': {
      const link = getLink(message.linkId);
      if (message.blast) link.blastPaused = message.paused;
      else link.paused = message.paused;
      if (!message.paused) releaseWaiters(link);
      break;
    }
    case 'bridge-ack': {
      const link = getLink(message.linkId);
      if (message.blast) {
        link.blastInFlightBytes = Math.max(0, link.blastInFlightBytes - message.bytes);
        link.blastPaused = message.paused;
      } else {
        link.inFlightBytes = Math.max(0, link.inFlightBytes - message.bytes);
        link.paused = message.paused;
      }
      if (!message.paused) releaseWaiters(link);
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
    case 'blast-eof-in': {
      const job = recvJobs.get(message.transferId);
      if (job && !job.finished && !job.failed) {
        job.blastEofReceived = true;
        job.targetBytes = message.totalBytes;
        job.bitmap.setFinalByteSize(message.totalBytes);
        // Allow 12 ms for any trailing UDP datagrams already in OS receive buffers to land before scanning bitmap
        setTimeout(() => {
          if (!job.finished && !job.failed) performFinalBlastAudit(job);
        }, 12);
      }
      break;
    }
    case 'bench-stop': {
      const job = recvJobs.get(message.transferId);
      if (job && job.bench && !job.finished && !job.failed) {
        job.targetBytes = message.bytes;
        job.bitmap.setFinalByteSize(message.bytes);
        if (message.blast) {
          job.blastEofReceived = true;
          setTimeout(() => {
            if (!job.finished && !job.failed) performFinalBlastAudit(job);
          }, 12);
        } else if (job.transport !== 'lan-turbo') {
          checkRecvCompletion(job);
        }
        if (!job.finished && job.benchStopTimer === null) {
          job.benchStopTimer = setTimeout(() => {
            if (!job.finished && !job.failed) void finalizeBenchRecv(job);
          }, 4_500);
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

void DEFAULT_CHUNK;
