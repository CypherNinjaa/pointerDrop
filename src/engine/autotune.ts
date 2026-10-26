/**
 * Warp Autotune — device-aware, measurement-driven transport tuning.
 *
 * Nothing here assumes a fixed "best" chunk size or lane count. The tuner:
 *   1. Seeds an initial configuration from the device profile (CPU cores, RAM, mobile/desktop).
 *   2. Every epoch (≥ 550 ms and ≥ 8 RTTs) measures how many bytes actually left the
 *      send queues into SCTP (`drainBps`) and where the sender spent its time
 *      (waiting on the network queue, on receiver persistence credits, or on disk reads).
 *   3. Sizes the send-queue high watermark from the measured bandwidth-delay product.
 *   4. Hill-climbs chunk size (16 → 256 KB ladder, bounded strictly by SCTP maxMessageSize)
 *      and the number of active parallel SCTP lanes:
 *        • When the network queue is the bottleneck, both chunk size and lane count are probed.
 *        • When sender framing CPU is the bottleneck, chunk size is still probed (larger chunks
 *          cut per-frame JS/IPC/SCTP framing cost directly).
 *        • When receiver disk/credits or sender disk is the bottleneck, network hill-climbing
 *          pauses and reports the true bottleneck transparently.
 *   5. Settles when no neighbour improves throughput by ≥ 5 %, and re-probes when the
 *      measured rate drifts by > 30 % or every 15 s.
 */
import {
  CHANNEL_COUNT,
  CHUNK_LADDER,
  INITIAL_HIGH_WATERMARK,
  MAX_HIGH_WATERMARK,
  MIN_HIGH_WATERMARK,
  type Bottleneck,
  type SchedulePolicy,
  type SinkKind,
  type TuneConfig,
  type TunerPhase,
  type TunerSnapshot,
} from './protocol';

const MB = 1024 * 1024;

export interface DeviceProfile {
  cores: number;
  memoryGB: number | null;
  mobile: boolean;
  /** Extra RTCPeerConnections (beyond the primary) this device is willing to run. */
  maxExtraLanes: number;
  initialChunk: number;
  maxWatermark: number;
  tier: 'low' | 'mid' | 'high';
  summary: string;
}

type NavigatorLike = {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgent?: string;
  userAgentData?: { mobile?: boolean; platform?: string; brands?: Array<{ brand: string; version: string }> };
};

export function summarizeBrowserEnv(
  nav: NavigatorLike | undefined = typeof navigator !== 'undefined' ? (navigator as NavigatorLike) : undefined,
): string {
  const ua = nav?.userAgent ?? '';
  let browser = 'Browser';
  const edg = ua.match(/Edg\/(\d+)/);
  const chr = ua.match(/Chrome\/(\d+)/);
  const ffx = ua.match(/Firefox\/(\d+)/);
  const saf = ua.match(/Version\/(\d+).*Safari/);
  if (edg) browser = `Edge ${edg[1]}`;
  else if (chr) browser = `Chrome ${chr[1]}`;
  else if (ffx) browser = `Firefox ${ffx[1]}`;
  else if (saf) browser = `Safari ${saf[1]}`;

  let os = nav?.userAgentData?.platform || '';
  if (!os) {
    if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    else if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac OS X/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    else os = 'OS';
  }
  const cores = nav?.hardwareConcurrency ? `${nav.hardwareConcurrency}c` : '';
  return [browser, os, cores].filter(Boolean).join(' · ');
}

export function detectDeviceProfile(
  nav: NavigatorLike | undefined = typeof navigator !== 'undefined' ? (navigator as NavigatorLike) : undefined,
): DeviceProfile {
  const cores = Math.max(1, Math.min(64, nav?.hardwareConcurrency || 4));
  const memoryGB = typeof nav?.deviceMemory === 'number' && nav.deviceMemory > 0 ? nav.deviceMemory : null;
  const mobile =
    typeof nav?.userAgentData?.mobile === 'boolean'
      ? nav.userAgentData.mobile
      : /Android|iPhone|iPad|iPod|Mobile/i.test(nav?.userAgent ?? '');

  const lowMem = memoryGB !== null && memoryGB <= 2;
  const tier: DeviceProfile['tier'] =
    cores <= 4 || lowMem ? 'low' : cores >= 8 && (memoryGB === null || memoryGB >= 4) ? 'high' : 'mid';

  // Each extra lane is an independent DTLS + SCTP stack: cheap on multi-core desktops, modest on phones.
  const maxExtraLanes = mobile ? (tier === 'low' ? 1 : 2) : tier === 'low' ? 1 : tier === 'mid' ? 2 : 3;
  // Conservative initial chunk size (64 KB on low/mobile, 128 KB on mid/high desktop); autotuner climbs to 256 KB when supported and faster.
  const initialChunk = mobile || tier === 'low' ? 64 * 1024 : 128 * 1024;
  let maxWatermark = memoryGB === null ? 16 * MB : memoryGB >= 8 ? 32 * MB : memoryGB >= 4 ? 16 * MB : 8 * MB;
  if (mobile) maxWatermark = Math.min(maxWatermark, 16 * MB);

  return {
    cores,
    memoryGB,
    mobile,
    maxExtraLanes,
    initialChunk,
    maxWatermark,
    tier,
    summary: summarizeBrowserEnv(nav),
  };
}

/** Raw bytes a receiver lets the sender have outstanding (not yet persisted to disk). */
export function receiverCreditWindow(sink: SinkKind, profile: DeviceProfile): number {
  switch (sink) {
    case 'opfs-sync':
    case 'discard':
      return profile.mobile ? 24 * MB : 64 * MB;
    case 'opfs-writable':
      // Bounded window for async WritableStream so promises and copies cannot accumulate unboundedly.
      return profile.mobile ? 8 * MB : 16 * MB;
    case 'memory':
      return profile.mobile ? 8 * MB : 16 * MB;
  }
}

/** Largest file we are willing to accumulate in JS heap when OPFS is unavailable (e.g. non-HTTPS LAN IP). */
export function memorySinkBudget(profile: DeviceProfile): number {
  const gb = profile.memoryGB ?? (profile.mobile ? 3 : 4);
  const raw = Math.floor(gb * 1024 * MB * 0.12);
  return Math.max(192 * MB, Math.min(profile.mobile ? 384 * MB : 1024 * MB, raw));
}

export function largestChunkFor(maxMessageSize: number | null | undefined, headerBytes: number): number {
  const limit = maxMessageSize && Number.isFinite(maxMessageSize) && maxMessageSize > 0 ? maxMessageSize : 64 * 1024;
  let best: number = CHUNK_LADDER[0];
  for (const size of CHUNK_LADDER) if (size + headerBytes <= limit) best = size;
  return best;
}

export interface EpochSample {
  ms: number;
  drainedBytes: number;
  queueWaitMs: number;
  creditWaitMs: number;
  diskWaitMs: number;
  lz4Ms: number;
  rttMs: number;
}

type Move = 'chunk+' | 'lanes+' | 'chunk-' | 'lanes-';
const MOVE_ORDER: Move[] = ['chunk+', 'lanes+', 'chunk-', 'lanes-'];
const CPU_MOVE_ORDER: Move[] = ['chunk+', 'chunk-'];
const ACCEPT_GAIN = 1.05;
const MEASURE_EPOCHS = 2;
const REPROBE_MS = 15_000;

export function classifyBottleneck(
  s: Pick<EpochSample, 'ms' | 'queueWaitMs' | 'creditWaitMs' | 'diskWaitMs' | 'drainedBytes'>,
): Bottleneck {
  if (s.ms <= 0) return 'idle';
  const qw = s.queueWaitMs / s.ms;
  const cw = s.creditWaitMs / s.ms;
  const dw = s.diskWaitMs / s.ms;
  if (cw >= 0.28) return 'receiver';
  if (qw >= 0.25) return 'network';
  if (dw >= 0.28) return 'disk';
  if (s.drainedBytes <= 0) return 'idle';
  return 'cpu';
}

export class AdaptiveTuner {
  config: TuneConfig;
  phase: TunerPhase = 'warmup';
  bottleneck: Bottleneck = 'idle';
  drainBps = 0;
  lastDecision = 'Seeded from device profile';
  private chunkIdx: number;
  private maxChunkIdx: number;
  private availableLanes: number;
  private pinned: Partial<TuneConfig> | null = null;
  private warmupLeft = 1;
  private window: number[] = [];
  private baseline = 0;
  private trial: { move: Move; prev: TuneConfig; settle: number } | null = null;
  private moveIdx = 0;
  private acceptedThisPass = false;
  private settledAt = 0;
  private settledBps = 0;
  private driftEpochs = 0;
  private last: { qw: number; cw: number; dw: number } = { qw: 0, cw: 0, dw: 0 };

  constructor(
    private readonly profile: DeviceProfile,
    maxChunk: number,
    availableLanes: number,
    seed?: Partial<TuneConfig> | null,
  ) {
    this.maxChunkIdx = Math.max(0, ladderIndexAtMost(maxChunk));
    this.chunkIdx = Math.min(this.maxChunkIdx, ladderIndexAtMost(seed?.chunk ?? profile.initialChunk));
    this.availableLanes = Math.max(1, availableLanes);
    const initialLanes = seed?.lanes ?? (profile.mobile ? Math.min(2, this.availableLanes) : this.availableLanes);
    this.config = {
      chunk: CHUNK_LADDER[this.chunkIdx],
      lanes: clamp(initialLanes, 1, this.availableLanes),
      highWatermark: clamp(
        seed?.highWatermark ?? INITIAL_HIGH_WATERMARK,
        MIN_HIGH_WATERMARK,
        Math.min(MAX_HIGH_WATERMARK, profile.maxWatermark),
      ),
      channels: clamp(seed?.channels ?? CHANNEL_COUNT, 1, CHANNEL_COUNT),
      schedule: (seed?.schedule ?? 'least-buffered') as SchedulePolicy,
    };
    if (seed?.chunk || seed?.lanes) this.lastDecision = 'Seeded from measured link profile';
  }

  pin(pinned: Partial<TuneConfig> | null): void {
    const hasPin =
      pinned !== null &&
      pinned !== undefined &&
      (pinned.chunk !== undefined ||
        pinned.lanes !== undefined ||
        pinned.highWatermark !== undefined ||
        pinned.channels !== undefined ||
        pinned.schedule !== undefined);
    this.pinned = hasPin ? pinned : null;
    if (this.pinned) {
      if (this.pinned.chunk !== undefined) {
        this.chunkIdx = Math.min(this.maxChunkIdx, ladderIndexAtMost(this.pinned.chunk));
      }
      this.config = {
        chunk: CHUNK_LADDER[this.chunkIdx],
        lanes: clamp(this.pinned.lanes ?? this.config.lanes, 1, this.availableLanes),
        highWatermark: clamp(
          this.pinned.highWatermark ?? this.config.highWatermark,
          MIN_HIGH_WATERMARK,
          MAX_HIGH_WATERMARK,
        ),
        channels: clamp(this.pinned.channels ?? this.config.channels ?? CHANNEL_COUNT, 1, CHANNEL_COUNT),
        schedule: this.pinned.schedule ?? this.config.schedule ?? 'least-buffered',
      };
      this.phase = 'pinned';
      this.lastDecision = `Pinned ${kb(this.config.chunk)} · ${this.config.channels ?? CHANNEL_COUNT}ch · ${this.config.lanes} lane(s)`;
    }
  }

  /** Called when SCTP maxMessageSize or the number of connected lanes changes. Returns true if config changed. */
  setLimits(maxChunk: number, availableLanes: number): boolean {
    const nextMaxIdx = Math.max(0, ladderIndexAtMost(maxChunk));
    const lanes = Math.max(1, availableLanes);
    let changed = false;
    if (nextMaxIdx !== this.maxChunkIdx) {
      const raised = nextMaxIdx > this.maxChunkIdx;
      this.maxChunkIdx = nextMaxIdx;
      if (this.chunkIdx > nextMaxIdx) {
        this.chunkIdx = nextMaxIdx;
        this.config = { ...this.config, chunk: CHUNK_LADDER[nextMaxIdx] };
        changed = true;
      } else if (raised && this.phase === 'settled') {
        this.startProbe('Larger SCTP message limit negotiated — probing larger chunks');
      }
    }
    if (lanes !== this.availableLanes) {
      const grew = lanes > this.availableLanes;
      const wasUsingAll = this.config.lanes === this.availableLanes;
      this.availableLanes = lanes;
      const target = this.pinned?.lanes
        ? clamp(this.pinned.lanes, 1, lanes)
        : grew && wasUsingAll && !this.profile.mobile
          ? lanes
          : clamp(this.config.lanes, 1, lanes);
      if (target !== this.config.lanes) {
        this.config = { ...this.config, lanes: target };
        changed = true;
      }
      if (grew && this.phase === 'settled') this.startProbe('Parallel SCTP lane connected — re-probing');
    }
    return changed;
  }

  get maxChunk(): number {
    return CHUNK_LADDER[this.maxChunkIdx];
  }

  get lanesAvailable(): number {
    return this.availableLanes;
  }

  snapshot(lz4: boolean): TunerSnapshot {
    return {
      ...this.config,
      phase: this.phase,
      bottleneck: this.bottleneck,
      drainBps: Math.round(this.drainBps),
      availableLanes: this.availableLanes,
      maxChunk: this.maxChunk,
      queueWaitPct: Math.round(this.last.qw * 100),
      creditWaitPct: Math.round(this.last.cw * 100),
      diskWaitPct: Math.round(this.last.dw * 100),
      lz4,
      lastDecision: this.lastDecision,
    };
  }

  /** Feed one measurement epoch. Returns true when the configuration changed. */
  onEpoch(sample: EpochSample, now = Date.now()): boolean {
    if (sample.ms <= 0) return false;
    const bps = (sample.drainedBytes * 1000) / sample.ms;
    this.drainBps = this.drainBps === 0 ? bps : this.drainBps * 0.45 + bps * 0.55;
    this.bottleneck = classifyBottleneck(sample);
    this.last = {
      qw: Math.min(1, sample.queueWaitMs / sample.ms),
      cw: Math.min(1, sample.creditWaitMs / sample.ms),
      dw: Math.min(1, sample.diskWaitMs / sample.ms),
    };

    if (this.phase === 'pinned') return false;

    let changed = this.retuneWatermark(bps, sample.rttMs);

    if (this.phase === 'warmup') {
      if (--this.warmupLeft <= 0) this.startProbe('Warm-up complete — probing chunk & lane ladder');
      return changed;
    }

    const canTune = this.bottleneck === 'network' || this.bottleneck === 'cpu';

    if (this.phase === 'settled') {
      const drift = this.settledBps > 0 ? Math.abs(bps - this.settledBps) / this.settledBps : 0;
      this.driftEpochs = drift > 0.3 ? this.driftEpochs + 1 : 0;
      if (this.driftEpochs >= 3) this.startProbe(`Throughput drifted ${Math.round(drift * 100)}% — re-probing`);
      else if (now - this.settledAt > REPROBE_MS && canTune) this.startProbe('Periodic re-probe');
      return changed;
    }

    // phase === 'probing'
    if (this.trial && this.trial.settle > 0) {
      this.trial.settle--;
      return changed;
    }
    if (!canTune) {
      this.lastDecision = `${label(this.bottleneck)} is the limit — network tuning paused`;
      return changed;
    }
    this.window.push(bps);
    if (this.window.length < MEASURE_EPOCHS) return changed;
    const measured = mean(this.window);
    this.window = [];

    const activeMoves = this.bottleneck === 'cpu' ? CPU_MOVE_ORDER : MOVE_ORDER;

    if (!this.trial) {
      this.baseline = measured;
      changed = this.nextMove(activeMoves) || changed;
      return changed;
    }

    const { move, prev } = this.trial;
    this.trial = null;
    if (measured > this.baseline * ACCEPT_GAIN) {
      this.lastDecision = `${describe(move)} improved ${mbps(this.baseline)} → ${mbps(measured)}`;
      this.baseline = measured;
      this.acceptedThisPass = true;
      // Keep climbing in the winning direction while gains >= 5% continue.
      if (this.applyMove(move)) return true;
      return this.nextMove(activeMoves, true) || changed;
    }
    this.lastDecision = `${describe(move)} (${mbps(measured)} vs ${mbps(this.baseline)}) — kept ${kb(prev.chunk)} × ${prev.lanes}L`;
    this.config = { ...prev, highWatermark: this.config.highWatermark };
    this.chunkIdx = ladderIndexAtMost(prev.chunk);
    this.moveIdx++;
    this.nextMove(activeMoves);
    return true;
  }

  private startProbe(reason: string): void {
    this.phase = 'probing';
    this.window = [];
    this.trial = null;
    this.moveIdx = 0;
    this.acceptedThisPass = false;
    this.driftEpochs = 0;
    this.lastDecision = reason;
  }

  private nextMove(moves: Move[], afterAccept = false): boolean {
    if (afterAccept) this.moveIdx++;
    while (this.moveIdx < moves.length) {
      const move = moves[this.moveIdx];
      if (this.applyMove(move)) return true;
      this.moveIdx++;
    }
    if (this.acceptedThisPass) {
      this.moveIdx = 0;
      this.acceptedThisPass = false;
      for (; this.moveIdx < moves.length; this.moveIdx++) {
        if (this.applyMove(moves[this.moveIdx])) return true;
      }
    }
    this.phase = 'settled';
    this.settledAt = Date.now();
    this.settledBps = this.baseline;
    this.lastDecision = `Optimal ${kb(this.config.chunk)} × ${this.config.lanes} lane(s) · ${mbps(this.baseline)}`;
    return false;
  }

  private applyMove(move: Move): boolean {
    const prev = { ...this.config };
    let { chunkIdx } = this;
    let lanes = this.config.lanes;
    if (move === 'chunk+') chunkIdx++;
    else if (move === 'chunk-') chunkIdx--;
    else if (move === 'lanes+') lanes++;
    else lanes--;
    if (chunkIdx < 0 || chunkIdx > this.maxChunkIdx || lanes < 1 || lanes > this.availableLanes) return false;
    this.chunkIdx = chunkIdx;
    this.config = { ...this.config, chunk: CHUNK_LADDER[chunkIdx], lanes };
    // A newly activated lane begins in SCTP slow-start; give it an extra epoch to ramp.
    this.trial = { move, prev, settle: move === 'lanes+' ? 2 : 1 };
    this.window = [];
    this.lastDecision = `Probing ${describe(move)} → ${kb(this.config.chunk)} × ${lanes} lane(s)`;
    return true;
  }

  /** High watermark ≈ measured bandwidth × max(250 ms + 50 ms·extraLanes, 6·RTT), within device limits. */
  private retuneWatermark(bps: number, rttMs: number): boolean {
    if (this.bottleneck !== 'network' && this.bottleneck !== 'cpu') return false;
    const minHorizon = 0.25 + Math.max(0, this.config.lanes - 1) * 0.05;
    const horizon = Math.max(minHorizon, (6 * Math.max(1, rttMs)) / 1000);
    const target = clamp(
      Math.ceil((bps * horizon) / MB) * MB,
      MIN_HIGH_WATERMARK,
      Math.min(MAX_HIGH_WATERMARK, this.profile.maxWatermark),
    );
    const current = this.config.highWatermark;
    if (Math.abs(target - current) / current < 0.2) return false;
    this.config = { ...this.config, highWatermark: target };
    return true;
  }
}

export function lowWatermarkFor(highWatermark: number, activeChannels: number): number {
  return Math.max(64 * 1024, Math.floor(highWatermark / (2 * Math.max(1, activeChannels))));
}

function ladderIndexAtMost(bytes: number): number {
  let idx = 0;
  for (let i = 0; i < CHUNK_LADDER.length; i++) if (CHUNK_LADDER[i] <= bytes) idx = i;
  return idx;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const kb = (b: number) => `${Math.round(b / 1024)} KB`;
const mbps = (bps: number) => `${(bps / MB).toFixed(1)} MB/s`;
const describe = (m: Move) =>
  m === 'chunk+' ? 'Larger chunks' : m === 'chunk-' ? 'Smaller chunks' : m === 'lanes+' ? 'More lanes' : 'Fewer lanes';
const label = (b: Bottleneck) =>
  b === 'receiver'
    ? 'Receiver disk/CPU'
    : b === 'disk'
      ? 'Sender disk'
      : b === 'cpu'
        ? 'Sender CPU'
        : b === 'network'
          ? 'Network'
          : 'Idle sender';
