/**
 * Warp Autotune v2 — BBR-inspired delay-aware congestion & topology brain +
 * bidirectional Sender ↔ Receiver hardware capability scanner.
 *
 * Key upgrades over loss-only tuning:
 *   1. Tracks true baseline `minRttMs` separately from loaded `rttMs`. Sizes the
 *      send-queue watermark from `bps × cleanHorizon(minRttMs)` — NEVER from
 *      bufferbloated RTT — breaking the 200+ ms Wi-Fi bufferbloat spiral.
 *   2. Detects standing Wi-Fi TX queue bloat (`rttMs > max(32 ms, 3.2 × minRttMs)`):
 *      automatically collapses extra competing SCTP lanes back to 1–2, trims chunk
 *      size to 32–64 KiB (reducing SCTP fragment blast radius), and drains excess
 *      queued megabytes so RTT stays crisp and packet loss stays near 0%.
 *   3. On clean high-speed pipes (Ethernet ↔ Ethernet, Wi-Fi 6 ↔ Ethernet, clean 5 GHz),
 *      scales watermarks up to 32 MiB, climbs chunk ladder up to 256 KiB, and opens
 *      parallel SCTP associations when measured drain rate improves by ≥ 5%.
 *   4. Scans both Sender and Receiver hardware (CPU cores, RAM GB, Ethernet vs Wi-Fi,
 *      free storage, RAM Arena capacity) to compute an end-to-end joint transfer plan.
 */
import {
  CHANNEL_COUNT,
  CHUNK_LADDER,
  INITIAL_HIGH_WATERMARK,
  MAX_HIGH_WATERMARK,
  MIN_HIGH_WATERMARK,
  type ActiveTransportKind,
  type Bottleneck,
  type IceRoute,
  type NetworkMedium,
  type SchedulePolicy,
  type SinkKind,
  type SystemHardwareProfile,
  type TransportMode,
  type TuneConfig,
  type TunerPhase,
  type TunerSnapshot,
} from './protocol';

const MB = 1024 * 1024;

export interface DeviceProfile {
  cores: number;
  memoryGB: number | null;
  mobile: boolean;
  networkMedium: NetworkMedium;
  downlinkMbps: number | null;
  /** Extra RTCPeerConnections (beyond the primary) this device is willing to run. */
  maxExtraLanes: number;
  initialChunk: number;
  maxWatermark: number;
  ramArenaBudget: number;
  senderRamPreloadBudget: number;
  tier: 'low' | 'mid' | 'high';
  platform: string;
  summary: string;
}

type NetworkInformationLike = {
  type?: string;
  effectiveType?: string;
  downlink?: number;
};

type NavigatorLike = {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgent?: string;
  connection?: NetworkInformationLike;
  mozConnection?: NetworkInformationLike;
  webkitConnection?: NetworkInformationLike;
  storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> };
  userAgentData?: { mobile?: boolean; platform?: string; brands?: Array<{ brand: string; version: string }> };
};

export function detectNetworkMedium(nav?: NavigatorLike): { medium: NetworkMedium; downlinkMbps: number | null } {
  const conn = nav?.connection ?? nav?.mozConnection ?? nav?.webkitConnection;
  const rawType = (conn?.type ?? '').toLowerCase();
  const downlink = typeof conn?.downlink === 'number' && conn.downlink > 0 ? conn.downlink : null;
  if (rawType === 'ethernet') return { medium: 'ethernet', downlinkMbps: downlink };
  if (rawType === 'wifi') return { medium: 'wifi', downlinkMbps: downlink };
  if (rawType === 'cellular' || rawType === 'wimax') return { medium: 'cellular', downlinkMbps: downlink };
  return { medium: 'unknown', downlinkMbps: downlink };
}

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
  const ram = typeof nav?.deviceMemory === 'number' && nav.deviceMemory > 0 ? `${nav.deviceMemory}GB` : '';
  const { medium } = detectNetworkMedium(nav);
  const netLabel = medium !== 'unknown' ? medium : '';
  return [browser, os, cores, ram, netLabel].filter(Boolean).join(' · ');
}

export function detectDeviceProfile(
  nav: NavigatorLike | undefined = typeof navigator !== 'undefined' ? (navigator as NavigatorLike) : undefined,
): DeviceProfile {
  const cores = Math.max(1, Math.min(64, nav?.hardwareConcurrency || 4));
  const memoryGB = typeof nav?.deviceMemory === 'number' && nav.deviceMemory > 0 ? nav.deviceMemory : null;
  const ua = nav?.userAgent ?? '';
  const mobile =
    typeof nav?.userAgentData?.mobile === 'boolean'
      ? nav.userAgentData.mobile
      : /Android|iPhone|iPad|iPod|Mobile/i.test(ua);

  let platform = nav?.userAgentData?.platform || '';
  if (!platform) {
    if (/Android/i.test(ua)) platform = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'iOS';
    else if (/Windows/i.test(ua)) platform = 'Windows';
    else if (/Mac OS X/i.test(ua)) platform = 'macOS';
    else if (/Linux/i.test(ua)) platform = 'Linux';
    else platform = 'Unknown';
  }

  const { medium: networkMedium, downlinkMbps } = detectNetworkMedium(nav);
  const lowMem = memoryGB !== null && memoryGB <= 2;
  const tier: DeviceProfile['tier'] =
    cores <= 4 || lowMem ? 'low' : cores >= 8 && (memoryGB === null || memoryGB >= 4) ? 'high' : 'mid';

  const maxExtraLanes = mobile ? (tier === 'low' ? 1 : 2) : tier === 'low' ? 2 : tier === 'mid' ? 3 : 5;
  // Start cleanly at 64 KiB (low SCTP fragment count on Wi-Fi); climb to 128–256 KiB when clean.
  const initialChunk = 64 * 1024;
  let maxWatermark = memoryGB === null ? 16 * MB : memoryGB >= 8 ? 32 * MB : memoryGB >= 4 ? 16 * MB : 8 * MB;
  if (mobile) maxWatermark = Math.min(maxWatermark, 16 * MB);

  // Safe RAM-First Turbo Arena budgets (kept well inside V8 per-worker ArrayBuffer heap limits)
  const ramArenaBudget = mobile
    ? lowMem
      ? 96 * MB
      : 192 * MB
    : memoryGB !== null && memoryGB >= 16
      ? 1024 * MB
      : memoryGB !== null && memoryGB >= 8
        ? 640 * MB
        : 384 * MB;

  const senderRamPreloadBudget = mobile
    ? 96 * MB
    : tier === 'high'
      ? 512 * MB
      : tier === 'mid'
        ? 256 * MB
        : 128 * MB;

  return {
    cores,
    memoryGB,
    mobile,
    networkMedium,
    downlinkMbps,
    maxExtraLanes,
    initialChunk,
    maxWatermark,
    ramArenaBudget,
    senderRamPreloadBudget,
    tier,
    platform,
    summary: summarizeBrowserEnv(nav),
  };
}

export async function scanSystemHardware(
  opfsSync: boolean,
  nav: NavigatorLike | undefined = typeof navigator !== 'undefined' ? (navigator as NavigatorLike) : undefined,
): Promise<SystemHardwareProfile> {
  const profile = detectDeviceProfile(nav);
  let storageFreeBytes: number | null = null;
  if (nav?.storage?.estimate) {
    try {
      const est = await nav.storage.estimate();
      if (typeof est.quota === 'number' && typeof est.usage === 'number') {
        storageFreeBytes = Math.max(0, est.quota - est.usage);
      }
    } catch {
      storageFreeBytes = null;
    }
  }
  const directFileHandle =
    typeof window !== 'undefined' &&
    typeof (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';

  return {
    cores: profile.cores,
    memoryGB: profile.memoryGB,
    mobile: profile.mobile,
    platform: profile.platform,
    networkMedium: profile.networkMedium,
    downlinkMbps: profile.downlinkMbps,
    ramArenaBudget: profile.ramArenaBudget,
    storageFreeBytes,
    opfsSync,
    directFileHandle,
    summary: profile.summary,
  };
}

export interface JointTransferPlan {
  transport: ActiveTransportKind;
  initialChunk: number;
  initialLanes: number;
  initialWatermark: number;
  useSenderRamPreload: boolean;
  topologyLabel: string;
}

/**
 * Combines scanned Sender + Receiver hardware profiles, ICE route, and RTT to
 * synthesize the optimal starting transport plan before the first byte is sent.
 */
export function negotiateJointTransferPlan(
  sender: DeviceProfile,
  receiverHw: SystemHardwareProfile | undefined,
  fileSize: number,
  route: IceRoute,
  rttMs: number | null,
  preferredMode: TransportMode,
  peerBlastReady: boolean,
  localBusReady = false,
  sharedTurboEndpoint: string | null = null,
): JointTransferPlan {
  const sMed = sender.networkMedium;
  const rMed = receiverHw?.networkMedium ?? 'unknown';

  let transport: ActiveTransportKind = 'reliable-sctp';
  if (preferredMode === 'lan-turbo' && sharedTurboEndpoint) {
    transport = 'lan-turbo';
  } else if (localBusReady && (preferredMode === 'auto' || preferredMode === 'lan-turbo')) {
    transport = 'local-bus';
  } else if (sharedTurboEndpoint && preferredMode === 'auto') {
    transport = 'lan-turbo';
  } else if (preferredMode === 'blast-nack' && peerBlastReady) {
    transport = 'blast-nack';
  } else if (preferredMode === 'reliable-sctp' || !peerBlastReady) {
    transport = 'reliable-sctp';
  } else if (peerBlastReady && route !== 'relay') {
    // Auto mode: Blast UDP + Selective Reliable Repair avoids dcSCTP rwnd head-of-line stalls on Wi-Fi & WAN!
    transport = 'blast-nack';
  }

  let topologyLabel = 'P2P Link';
  if (transport === 'local-bus') {
    topologyLabel = 'Zero-Copy Browser Memory Bus (No UDP/DTLS)';
  } else if (transport === 'lan-turbo') {
    topologyLabel = 'Unencrypted LAN Turbo TCP (Zero-Copy Pipe)';
  } else if (route === 'relay') {
    topologyLabel = 'TURN Relayed Path';
  } else if (sMed === 'ethernet' && rMed === 'ethernet') {
    topologyLabel = 'Ethernet ↔ Ethernet (Full-Duplex Wire)';
  } else if ((sMed === 'ethernet' && rMed === 'wifi') || (sMed === 'wifi' && rMed === 'ethernet')) {
    topologyLabel = 'Wi-Fi ↔ Ethernet (Single-Air-Hop Hybrid)';
  } else if (sMed === 'wifi' && rMed === 'wifi') {
    topologyLabel = 'Wi-Fi ↔ Wi-Fi (Half-Duplex Double-Hop)';
  } else if (route === 'host') {
    topologyLabel = 'Direct LAN UDP (host ↔ host)';
  } else if (route === 'srflx') {
    topologyLabel = 'NAT Reflexive UDP (srflx)';
  }

  const bothWiredOrUltraLowRtt =
    (sMed === 'ethernet' && rMed === 'ethernet') || (route === 'host' && rttMs !== null && rttMs <= 2.5);
  const isDirectLan = route === 'host';
  const wifiDoubleHop = sMed === 'wifi' && rMed === 'wifi';
  const minCores = Math.min(sender.cores, receiverHw?.cores ?? 4);

  const initialChunk =
    transport === 'local-bus' || transport === 'lan-turbo'
      ? 256 * 1024
      : isDirectLan || bothWiredOrUltraLowRtt
        ? 128 * 1024
        : 64 * 1024;

  const initialLanes =
    transport === 'local-bus' || transport === 'lan-turbo'
      ? 1
      : route === 'relay' || wifiDoubleHop || minCores <= 2
        ? 1
        : isDirectLan
          ? Math.min(sender.maxExtraLanes + 1, receiverHw ? 4 : 3)
          : bothWiredOrUltraLowRtt
            ? 3
            : 2;

  const initialWatermark =
    transport === 'local-bus' || transport === 'lan-turbo'
      ? 32 * MB
      : isDirectLan
        ? 16 * MB
        : bothWiredOrUltraLowRtt
          ? 16 * MB
          : 8 * MB;
  const useSenderRamPreload = fileSize > 0 && fileSize <= sender.senderRamPreloadBudget;

  return {
    transport,
    initialChunk,
    initialLanes,
    initialWatermark,
    useSenderRamPreload,
    topologyLabel,
  };
}

/** Raw bytes a receiver lets the sender have outstanding (not yet persisted). */
export function receiverCreditWindow(sink: SinkKind, profile: DeviceProfile): number {
  switch (sink) {
    case 'ram-arena':
    case 'discard':
      return profile.mobile ? 32 * MB : 96 * MB;
    case 'opfs-sync':
    case 'direct-handle':
      return profile.mobile ? 24 * MB : 64 * MB;
    case 'opfs-writable':
      return profile.mobile ? 12 * MB : 24 * MB;
    case 'memory':
      return profile.mobile ? 8 * MB : 16 * MB;
  }
}

/** Largest file we are willing to accumulate in JS heap when OPFS & Direct Handle are unavailable. */
export function memorySinkBudget(profile: DeviceProfile): number {
  return profile.ramArenaBudget;
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
  retransmittedBlocks?: number;
}

type Move = 'chunk+' | 'lanes+' | 'chunk-' | 'lanes-';
const MOVE_ORDER: Move[] = ['chunk+', 'lanes+', 'chunk-', 'lanes-'];
const CPU_MOVE_ORDER: Move[] = ['chunk+', 'chunk-'];
const ACCEPT_GAIN = 1.01;
const MEASURE_EPOCHS = 2;
const REPROBE_MS = 12_000;

export function classifyBottleneck(
  s: Pick<EpochSample, 'ms' | 'queueWaitMs' | 'creditWaitMs' | 'diskWaitMs' | 'drainedBytes' | 'rttMs'>,
  minRttMs = 0,
): Bottleneck {
  if (s.ms <= 0) return 'idle';
  const qw = s.queueWaitMs / s.ms;
  const cw = s.creditWaitMs / s.ms;
  const dw = s.diskWaitMs / s.ms;
  if (cw >= 0.28) return 'receiver';
  if (dw >= 0.28) return 'disk';
  const baseRtt = minRttMs > 0 ? minRttMs : s.rttMs;
  // Normal 802.11ac/ax A-MPDU aggregation produces 35–80 ms active RTT; only trigger
  // bufferbloat mitigation on severe standing router queue inflation (> 150 ms and > 8x base + 100 ms).
  if (qw >= 0.40 && s.rttMs > Math.max(150, baseRtt * 8 + 100)) return 'bufferbloat';
  if (qw >= 0.22) return 'network';
  if (s.drainedBytes <= 0) return 'idle';
  return 'cpu';
}

export class AdaptiveTuner {
  config: TuneConfig;
  transport: ActiveTransportKind;
  phase: TunerPhase = 'warmup';
  bottleneck: Bottleneck = 'idle';
  drainBps = 0;
  minRttMs = 0;
  lastRttMs = 0;
  retransmittedBlocks = 0;
  lastDecision = 'Seeded from joint hardware profile';
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
    transport: ActiveTransportKind = 'reliable-sctp',
  ) {
    this.transport = transport;
    // Only inherit seeded chunk/lane values when they come from the same transport family.
    const compatibleSeed = seed && (!seed.transport || seed.transport === transport) ? seed : null;
    this.maxChunkIdx = Math.max(0, ladderIndexAtMost(maxChunk));
    const defaultInitChunk =
      this.transport === 'local-bus' || this.transport === 'lan-turbo'
        ? 256 * 1024
        : profile.initialChunk;
    this.chunkIdx = Math.min(this.maxChunkIdx, ladderIndexAtMost(compatibleSeed?.chunk ?? defaultInitChunk));
    this.availableLanes = Math.max(1, availableLanes);
    const initialLanes = compatibleSeed?.lanes ?? (this.availableLanes >= 3 ? Math.min(this.availableLanes, 4) : 1);
    this.config = {
      chunk: CHUNK_LADDER[this.chunkIdx],
      lanes: clamp(initialLanes, 1, this.availableLanes),
      highWatermark: clamp(
        compatibleSeed?.highWatermark ?? Math.max(INITIAL_HIGH_WATERMARK, this.availableLanes * 4 * 1024 * 1024),
        MIN_HIGH_WATERMARK,
        Math.min(MAX_HIGH_WATERMARK, profile.maxWatermark),
      ),
      channels: clamp(compatibleSeed?.channels ?? CHANNEL_COUNT, 1, CHANNEL_COUNT),
      schedule: (compatibleSeed?.schedule ?? 'least-buffered') as SchedulePolicy,
      transport: this.transport,
    };
    if (compatibleSeed?.chunk || compatibleSeed?.lanes) this.lastDecision = 'Seeded from measured link profile';
  }

  pin(pinned: Partial<TuneConfig> | null): void {
    const hasPin =
      pinned !== null &&
      pinned !== undefined &&
      (pinned.chunk !== undefined ||
        pinned.lanes !== undefined ||
        pinned.highWatermark !== undefined ||
        pinned.channels !== undefined ||
        pinned.schedule !== undefined ||
        pinned.transport !== undefined);
    this.pinned = hasPin ? pinned : null;
    if (this.pinned) {
      if (this.pinned.transport) this.transport = this.pinned.transport;
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
        transport: this.transport,
      };
      this.phase = 'pinned';
      this.lastDecision = `Pinned ${kb(this.config.chunk)} · ${this.config.channels ?? CHANNEL_COUNT}ch · ${this.config.lanes}L (${this.transport})`;
    }
  }

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
      this.availableLanes = lanes;
      const target = this.pinned?.lanes ? clamp(this.pinned.lanes, 1, lanes) : Math.max(this.config.lanes, lanes);
      if (target !== this.config.lanes) {
        this.config = { ...this.config, lanes: target };
        changed = true;
      }
      if (grew && this.phase === 'settled' && this.bottleneck !== 'bufferbloat') {
        this.startProbe('Parallel SCTP lane ready — probing multi-lane gain');
      }
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
    const bloatMs =
      this.minRttMs > 0 && this.lastRttMs > this.minRttMs
        ? Math.round((this.lastRttMs - this.minRttMs) * 10) / 10
        : 0;
    return {
      ...this.config,
      transport: this.transport,
      phase: this.phase,
      bottleneck: this.bottleneck,
      drainBps: Math.round(this.drainBps),
      minRttMs: Math.round(this.minRttMs * 10) / 10,
      rttMs: Math.round(this.lastRttMs * 10) / 10,
      bloatMs,
      availableLanes: this.availableLanes,
      maxChunk: this.maxChunk,
      queueWaitPct: Math.round(this.last.qw * 100),
      creditWaitPct: Math.round(this.last.cw * 100),
      diskWaitPct: Math.round(this.last.dw * 100),
      retransmittedBlocks: this.retransmittedBlocks,
      lz4,
      lastDecision: this.lastDecision,
    };
  }

  /** Feed one measurement epoch. Returns true when the configuration changed. */
  onEpoch(sample: EpochSample, now = Date.now()): boolean {
    if (sample.ms <= 0) return false;
    if (sample.rttMs > 0) {
      this.lastRttMs = sample.rttMs;
      if (this.minRttMs === 0 || sample.rttMs < this.minRttMs) {
        this.minRttMs = sample.rttMs;
      }
    }
    if (sample.retransmittedBlocks !== undefined) {
      this.retransmittedBlocks = sample.retransmittedBlocks;
    }

    const bps = (sample.drainedBytes * 1000) / sample.ms;
    this.drainBps = this.drainBps === 0 ? bps : this.drainBps * 0.45 + bps * 0.55;
    this.bottleneck = classifyBottleneck(sample, this.minRttMs);
    this.last = {
      qw: Math.min(1, sample.queueWaitMs / sample.ms),
      cw: Math.min(1, sample.creditWaitMs / sample.ms),
      dw: Math.min(1, sample.diskWaitMs / sample.ms),
    };

    if (this.phase === 'pinned') return false;

    // BBR Bufferbloat Mitigation: if standing queue inflated RTT > 3.2× minRTT (and > 35 ms),
    // immediately drain standing queue and shed competing SCTP lanes so Wi-Fi stops dropping!
    if (this.bottleneck === 'bufferbloat') {
      let bloatChanged = this.retuneWatermark(bps, true);
      if (this.config.lanes > 1) {
        this.config = { ...this.config, lanes: this.config.lanes - 1 };
        bloatChanged = true;
      }
      if (this.chunkIdx > ladderIndexAtMost(32 * 1024)) {
        this.chunkIdx--;
        this.config = { ...this.config, chunk: CHUNK_LADDER[this.chunkIdx] };
        bloatChanged = true;
      }
      this.trial = null;
      this.window = [];
      this.lastDecision = `Bufferbloat guard (${Math.round(this.lastRttMs)}ms vs ${Math.round(this.minRttMs)}ms base) → ${kb(this.config.chunk)} × ${this.config.lanes}L · ${formatWM(this.config.highWatermark)}`;
      return bloatChanged;
    }

    let changed = this.retuneWatermark(bps, false);

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
      changed = this.nextMove(activeMoves, false, now) || changed;
      return changed;
    }

    const { move, prev } = this.trial;
    this.trial = null;
    if (measured > this.baseline * ACCEPT_GAIN) {
      this.lastDecision = `${describe(move)} improved ${mbps(this.baseline)} → ${mbps(measured)}`;
      this.baseline = measured;
      this.acceptedThisPass = true;
      if (this.applyMove(move)) return true;
      return this.nextMove(activeMoves, true, now) || changed;
    }
    this.lastDecision = `${describe(move)} (${mbps(measured)} vs ${mbps(this.baseline)}) — kept ${kb(prev.chunk)} × ${prev.lanes}L`;
    this.config = { ...prev, highWatermark: this.config.highWatermark };
    this.chunkIdx = ladderIndexAtMost(prev.chunk);
    this.moveIdx++;
    this.nextMove(activeMoves, false, now);
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

  private nextMove(moves: Move[], afterAccept = false, now = Date.now()): boolean {
    if (afterAccept) this.moveIdx++;
    while (this.moveIdx < moves.length) {
      const move = moves[this.moveIdx];
      // Do not waste epochs stepping backwards right after upward steps improved speed in this pass
      if (this.acceptedThisPass && (move === 'chunk-' || move === 'lanes-')) {
        this.moveIdx++;
        continue;
      }
      if (this.applyMove(move)) return true;
      this.moveIdx++;
    }
    if (this.acceptedThisPass) {
      this.moveIdx = 0;
      this.acceptedThisPass = false;
      for (; this.moveIdx < moves.length; this.moveIdx++) {
        const move = moves[this.moveIdx];
        if (move === 'chunk-' || move === 'lanes-') continue;
        if (this.applyMove(move)) return true;
      }
    }
    this.phase = 'settled';
    this.settledAt = now;
    this.settledBps = this.baseline;
    this.lastDecision = `Optimal ${kb(this.config.chunk)} × ${this.config.lanes}L (${this.transport}) · ${mbps(this.baseline)}`;
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
    this.trial = { move, prev, settle: move === 'lanes+' ? 2 : 1 };
    this.window = [];
    this.lastDecision = `Probing ${describe(move)} → ${kb(this.config.chunk)} × ${lanes}L`;
    return true;
  }

  /**
   * BBR-inspired watermark sizing:
   *   • Sizes queue strictly from `minRttMs` (unbloated propagation RTT), NEVER from bloated `lastRttMs`!
   *   • When `bloated === true`, targets 120 ms of actual drain rate (`512 KB .. 4 MB`) to flush the router queue.
   *   • When clean, targets `max(220 ms + 50 ms·extraLanes, 6 × minRttMs)` up to 32 MiB so 100+ MB/s links stay full.
   */
  private retuneWatermark(bps: number, bloated: boolean): boolean {
    if (!bloated && this.bottleneck !== 'network' && this.bottleneck !== 'cpu') return false;
    const baseRtt = this.minRttMs > 0 ? this.minRttMs : Math.min(20, Math.max(1, this.lastRttMs || 4));
    const horizon = bloated
      ? 0.12
      : Math.max(0.22 + Math.max(0, this.config.lanes - 1) * 0.06, Math.min(0.6, (6 * baseRtt) / 1000));
    const rawBytes = Math.max(bloated ? 2 * MB : MIN_HIGH_WATERMARK, bps * horizon);
    const quantStep = rawBytes < 2 * MB ? 512 * 1024 : MB;
    const target = clamp(
      Math.ceil(rawBytes / quantStep) * quantStep,
      MIN_HIGH_WATERMARK,
      bloated ? Math.min(2 * MB, this.profile.maxWatermark) : Math.min(MAX_HIGH_WATERMARK, this.profile.maxWatermark),
    );
    const current = this.config.highWatermark;
    if (!bloated && Math.abs(target - current) / Math.max(1, current) < 0.2) return false;
    if (target === current) return false;
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
const formatWM = (b: number) => (b >= MB ? `${(b / MB).toFixed(b % MB === 0 ? 0 : 1)} MB WM` : `${Math.round(b / 1024)} KB WM`);
const mbps = (bps: number) => `${(bps / MB).toFixed(1)} MB/s`;
const describe = (m: Move) =>
  m === 'chunk+' ? 'Larger chunks' : m === 'chunk-' ? 'Smaller chunks' : m === 'lanes+' ? 'More lanes' : 'Fewer lanes';
const label = (b: Bottleneck) =>
  b === 'receiver'
    ? 'Receiver disk/CPU'
    : b === 'disk'
      ? 'Sender disk'
      : b === 'bufferbloat'
        ? 'Wi-Fi bufferbloat'
        : b === 'cpu'
          ? 'Sender CPU'
          : b === 'network'
            ? 'Network'
            : 'Idle sender';
