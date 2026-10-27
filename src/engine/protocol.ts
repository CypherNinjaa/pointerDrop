/**
 * Shared wire + thread protocol definitions for AirDrop-LAN-Warp.
 *
 * Wire format of every payload frame on the unordered data channels:
 *
 *   ┌──────────────────────────────┬──────────────────────────────────────┐
 *   │ Float64 BE byte offset (8 B) │ payload (raw slice or LZ4 block)     │
 *   └──────────────────────────────┴──────────────────────────────────────┘
 *
 * Dual-mode transport per peer link:
 *   • Reliable SCTP (`ordered: false`): zero-HoL-blocking SCTP streams (ids 1..4).
 *   • Blast UDP + Bitmap NACK (`ordered: false, maxRetransmits: 0`, ids 5..8):
 *     RBUDP-style continuous single-shot UDP transmission with rolling + end-of-pass
 *     16 KiB block bitmap NACK selective repair over the reliable control channel,
 *     bypassing dcSCTP C++ reassembly-window stalls on lossy Wi-Fi links.
 */

export const CHANNEL_COUNT = 4;
export const LANE_CHANNELS = 2;
export const FRAME_HEADER_BYTES = 8;

/** Absolute bounds for the adaptive aggregate send-queue high watermark. */
export const MIN_HIGH_WATERMARK = 1024 * 1024;
export const MAX_HIGH_WATERMARK = 32 * 1024 * 1024;
/** Initial watermark (4 MiB) keeps multi-channel pipes full before BDP settles. */
export const INITIAL_HIGH_WATERMARK = 4 * 1024 * 1024;
export const HIGH_WATERMARK = INITIAL_HIGH_WATERMARK;
export const LOW_WATERMARK = 512 * 1024;

export const ENTROPY_SAMPLE_BYTES = 64 * 1024;
export const ENTROPY_THRESHOLD = 7.2;

/** Discrete payload sizes the autotuner may choose from (all exact multiples of 16 KiB MIN_CHUNK). */
export const CHUNK_LADDER = [16 * 1024, 32 * 1024, 64 * 1024, 128 * 1024, 256 * 1024] as const;
export const MIN_CHUNK = CHUNK_LADDER[0];
export const DEFAULT_CHUNK = 64 * 1024;
export const MAX_CHUNK = CHUNK_LADDER[CHUNK_LADDER.length - 1];

/** Receiver credit granularity: a credit message is emitted after this many newly persisted bytes. */
export const CREDIT_STEP_BYTES = 2 * 1024 * 1024;

export type IceRoute = 'host' | 'srflx' | 'relay' | 'unknown';
export type SinkKind = 'ram-arena' | 'direct-handle' | 'opfs-sync' | 'opfs-writable' | 'memory' | 'discard';
export type Bottleneck = 'network' | 'bufferbloat' | 'receiver' | 'disk' | 'cpu' | 'idle';
export type TunerPhase = 'warmup' | 'probing' | 'settled' | 'pinned';
export type SchedulePolicy = 'least-buffered' | 'round-robin';
export type WorkerChannelMode = 'native-worker-dc' | 'transferable-bridge';
export type TransportMode = 'auto' | 'lan-turbo' | 'blast-nack' | 'reliable-sctp';
export type ActiveTransportKind = 'lan-turbo' | 'local-bus' | 'blast-nack' | 'reliable-sctp';
export type NetworkMedium = 'ethernet' | 'wifi' | 'cellular' | 'unknown';

export interface SystemHardwareProfile {
  cores: number;
  memoryGB: number | null;
  mobile: boolean;
  platform: string;
  networkMedium: NetworkMedium;
  downlinkMbps: number | null;
  ramArenaBudget: number;
  storageFreeBytes: number | null;
  opfsSync: boolean;
  directFileHandle: boolean;
  summary: string;
}

export interface TuneConfig {
  chunk: number;
  lanes: number;
  highWatermark: number;
  /** Number of active channels per primary lane (1..4, default 4). */
  channels?: number;
  /** Channel selection strategy inside ChannelPool (default 'least-buffered'). */
  schedule?: SchedulePolicy;
  /** Transport mode override for pinned benchmark steps. */
  transport?: ActiveTransportKind;
}

export interface TunerSnapshot extends TuneConfig {
  phase: TunerPhase;
  bottleneck: Bottleneck;
  transport: ActiveTransportKind;
  /** Bytes per second leaving the send queues into SCTP during the last epoch. */
  drainBps: number;
  minRttMs: number;
  rttMs: number;
  bloatMs: number;
  availableLanes: number;
  maxChunk: number;
  queueWaitPct: number;
  creditWaitPct: number;
  diskWaitPct: number;
  retransmittedBlocks: number;
  lz4: boolean;
  lastDecision: string;
}

export interface PeerCaps {
  /** Number of extra parallel SCTP lanes this device is willing to open. */
  lanes: number;
  credit: boolean;
  bench: boolean;
  /** Supports `maxRetransmits: 0` Blast UDP channels + 16 KiB Bitmap NACK repair. */
  blastNack?: boolean;
  /** Ephemeral BroadcastChannel probe ID to detect same-browser zero-copy memory bus. */
  localBusId?: string;
  /** Reachable unencrypted HTTP Cut-Through Pipe URLs (`http://<LAN-IP>:8787`) advertised by this peer. */
  turboEndpoints?: string[];
  /** Verified LAN Turbo daemon `instanceId`s this peer can currently reach. */
  turboInstances?: string[];
  userAgentSummary?: string;
  hw?: SystemHardwareProfile;
}

// ───────────────────────── Control channel (ordered, JSON) ─────────────────────────

export interface FileOfferMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
  lastModified: number;
  compressed: boolean;
  entropy: number;
  transport?: ActiveTransportKind;
  turboEndpoint?: string | null;
  turboInstanceId?: string | null;
  localBusToken?: string | null;
}

export type ControlMessage =
  | { t: 'hello'; name: string; deviceKind: 'desktop' | 'mobile' | 'extension'; caps?: PeerCaps }
  | { t: 'local-bus-ack'; token: string }
  | { t: 'offer'; file: FileOfferMeta }
  | {
      t: 'accept';
      id: string;
      window?: number;
      sink?: SinkKind;
      transport?: ActiveTransportKind;
      turboEndpoint?: string | null;
      turboInstanceId?: string | null;
      localBusToken?: string | null;
    }
  | { t: 'decline'; id: string }
  | { t: 'pause'; id: string }
  | { t: 'resume'; id: string }
  | { t: 'cancel'; id: string; reason: string }
  | { t: 'complete'; id: string; hash?: string; sink?: SinkKind; writeMs?: number; finalizeMs?: number }
  | { t: 'failed'; id: string; reason: string }
  | { t: 'credit'; id: string; bytes: number }
  | { t: 'eof-blast'; id: string; totalBytes: number; senderHash: string }
  | {
      t: 'nack-report';
      id: string;
      receivedBlocks: number;
      totalBlocks: number;
      ranges: Array<[number, number]>;
      finalAudit: boolean;
    }
  | { t: 'ping'; ts: number; probeId?: string }
  | { t: 'pong'; ts: number; probeId?: string }
  | { t: 'lane-sdp'; lane: string; description: RTCSessionDescriptionInit }
  | { t: 'lane-ice'; lane: string; candidate: RTCIceCandidateInit }
  | { t: 'lane-close'; lane: string }
  | {
      t: 'bench-offer';
      id: string;
      compress: boolean;
      preferredSink?: 'auto' | SinkKind;
      windowOverride?: number;
      sizeBytes?: number;
      transport?: ActiveTransportKind;
      turboEndpoint?: string | null;
      turboInstanceId?: string | null;
      localBusToken?: string | null;
    }
  | { t: 'bench-ready'; id: string; window: number; sink: SinkKind }
  | { t: 'bench-stop'; id: string; bytes: number; senderHash: string; blast?: boolean }
  | {
      t: 'bench-result';
      id: string;
      bytes: number;
      wireBytes: number;
      elapsedMs: number;
      writeMs: number;
      finalizeMs: number;
      maxPendingWriteBytes: number;
      duplicateBlocks: number;
      sink: SinkKind;
      hash: string;
      complete: boolean;
    };

// ───────────────────────── Main thread → Worker ─────────────────────────

export type ToWorker =
  | { type: 'init' }
  | {
      type: 'attach-channels';
      linkId: string;
      lane: string;
      channelKind?: 'reliable' | 'blast';
      channels: RTCDataChannel[];
    }
  | { type: 'detach-lane'; linkId: string; lane: string }
  | { type: 'detach'; linkId: string }
  | { type: 'analyze'; fileId: string; file: File }
  | {
      type: 'send-start';
      linkId: string;
      transferId: string;
      /** null → synthetic benchmark payload (no disk). */
      file: File | null;
      /** Benchmark only: stop at a fixed byte target if specified. */
      syntheticBytes?: number;
      /** Benchmark only: generate realistic structured text/JSON instead of incompressible random bytes. */
      compressibleBench?: boolean;
      /** Benchmark only: force frames through the transferable ArrayBuffer UI bridge even if worker owns channels. */
      forceBridge?: boolean;
      compress: boolean;
      /** Transport mode ('lan-turbo' | 'local-bus' | 'blast-nack' | 'reliable-sctp'). */
      transport: ActiveTransportKind;
      /** Unencrypted HTTP Cut-Through Pipe URL when `transport === 'lan-turbo'`. */
      turboEndpoint?: string | null;
      /** Same-browser BroadcastChannel token when `transport === 'local-bus'`. */
      localBusToken?: string | null;
      /** Do not inherit seeded link chunk/lane values (used for isolated A/B benchmarks). */
      ignoreSeed?: boolean;
      /** Receiver-advertised credit window in raw bytes (Infinity when the peer has no credit support). */
      creditWindow: number;
      /** Sender RAM preload budget in bytes for caching small/medium files completely in RAM. */
      ramPreloadBudget?: number;
      /** Benchmark only: stop after this many milliseconds. */
      durationMs?: number;
      /** Benchmark only: pin the tuner to this configuration. */
      pinned?: Partial<TuneConfig> | null;
    }
  | {
      type: 'nack-in';
      transferId: string;
      receivedBlocks: number;
      totalBlocks: number;
      ranges: Array<[number, number]>;
      finalAudit: boolean;
    }
  | {
      type: 'bridge-stats';
      linkId: string;
      sentBytes: number;
      buffered: number[];
      openLanes: number;
      blastSentBytes?: number;
      blastBuffered?: number[];
      blastOpenLanes?: number;
    }
  | { type: 'bridge-ack'; linkId: string; bytes: number; paused: boolean; blast?: boolean }
  | { type: 'flow'; linkId: string; paused: boolean; blast?: boolean }
  | { type: 'user-pause'; transferId: string; paused: boolean }
  | { type: 'net'; linkId: string; rttMs: number; maxMessageSize: number }
  /** Seed future tuners on this link with a configuration measured by a speed test or joint hardware profile. */
  | { type: 'seed'; linkId: string; config: Partial<TuneConfig> }
  | { type: 'credit'; transferId: string; bytes: number }
  | { type: 'cancel'; transferId: string }
  | {
      type: 'recv-start';
      linkId: string;
      transferId: string;
      name: string;
      mime?: string;
      /** Infinity for benchmark sessions until `bench-stop` announces the final byte count. */
      size: number;
      compress: boolean;
      transport: ActiveTransportKind;
      turboEndpoint?: string | null;
      localBusToken?: string | null;
      saveHandle: FileSystemFileHandle | null;
      bench: boolean;
      preferredSink?: 'auto' | SinkKind;
      windowOverride?: number;
      ramArenaBudget?: number;
    }
  | { type: 'blast-eof-in'; transferId: string; totalBytes: number }
  | { type: 'bench-stop'; transferId: string; bytes: number; blast?: boolean }
  | { type: 'chunk-in'; linkId: string; data: ArrayBuffer }
  | { type: 'release'; transferId: string };

// ───────────────────────── Worker → Main thread ─────────────────────────

export type FromWorker =
  | { type: 'ready'; lz4: boolean; opfs: boolean; opfsSync: boolean; secure: boolean; lz4Error?: string }
  | { type: 'attached'; linkId: string; lane: string; channelKind: 'reliable' | 'blast' }
  | { type: 'analysis'; fileId: string; entropy: number; compress: boolean; sampleBytes: number }
  | {
      type: 'frame-out';
      linkId: string;
      transferId: string;
      data: ArrayBuffer;
      blast?: boolean;
      viaForceBridge?: boolean;
    }
  | {
      type: 'tune';
      linkId: string;
      highWatermark: number;
      lowWatermark: number;
      lanes: number;
      channels: number;
      schedule: SchedulePolicy;
      transport: ActiveTransportKind;
    }
  | {
      type: 'send-progress';
      transferId: string;
      rawBytes: number;
      wireBytes: number;
      creditedBytes: number;
      tuner: TunerSnapshot;
    }
  | { type: 'blast-eof-out'; transferId: string; totalBytes: number; senderHash: string }
  | {
      type: 'send-drained';
      transferId: string;
      rawBytes: number;
      wireBytes: number;
      elapsedMs: number;
      queueWaitMs: number;
      creditWaitMs: number;
      diskWaitMs: number;
      lz4Ms: number;
      retransmittedBlocks: number;
      hash: string;
      finalTuner: TunerSnapshot;
    }
  | { type: 'recv-ready'; transferId: string; window: number; sink: SinkKind }
  | {
      type: 'nack-out';
      transferId: string;
      receivedBlocks: number;
      totalBlocks: number;
      ranges: Array<[number, number]>;
      finalAudit: boolean;
    }
  | {
      type: 'recv-progress';
      transferId: string;
      rawBytes: number;
      wireBytes: number;
      persistedBytes: number;
      pendingWriteBytes: number;
      pendingWriteCount: number;
      writeMs: number;
      sink: SinkKind;
    }
  | { type: 'credit-out'; transferId: string; bytes: number }
  | {
      type: 'recv-complete';
      transferId: string;
      file: File | null;
      savedToHandle: boolean;
      hash: string;
      sink: SinkKind;
      writeMs: number;
      finalizeMs: number;
      maxPendingWriteBytes: number;
    }
  | {
      type: 'bench-done';
      transferId: string;
      bytes: number;
      wireBytes: number;
      elapsedMs: number;
      writeMs: number;
      finalizeMs: number;
      maxPendingWriteBytes: number;
      duplicateBlocks: number;
      sink: SinkKind;
      hash: string;
      complete: boolean;
    }
  | { type: 'transfer-error'; transferId: string; message: string }
  | { type: 'queue'; linkId: string; buffered: number[]; lanes: string[]; active: number; highWatermark: number };

export const formatBytes = (bytes: number, digits = 1): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : digits)} ${units[unit]}`;
};

export const randomId = (bytes = 8): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
