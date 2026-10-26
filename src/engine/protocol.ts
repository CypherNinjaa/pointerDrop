/**
 * Shared wire + thread protocol definitions for AirDrop-LAN-Warp.
 *
 * Wire format of every payload frame on the 4 unordered data channels:
 *
 *   ┌──────────────────────────────┬──────────────────────────────────────┐
 *   │ Float64 BE byte offset (8 B) │ payload (raw slice or LZ4 block)     │
 *   └──────────────────────────────┴──────────────────────────────────────┘
 *
 * Only one transfer is active per direction per peer link, so the offset is
 * sufficient to place the bytes; per-transfer parameters (size, compression)
 * travel on the ordered control channel before the first frame is sent.
 */

export const CHANNEL_COUNT = 4;
export const FRAME_HEADER_BYTES = 8;

/** Aggregate SCTP send-buffer level at which disk reads are suspended (8 MB across 4 channels). */
export const HIGH_WATERMARK = 8 * 1024 * 1024;
/** Per-channel `bufferedAmountLowThreshold` (512 KB per channel = 2 MB aggregate resume). */
export const LOW_WATERMARK = 512 * 1024;

export const ENTROPY_SAMPLE_BYTES = 64 * 1024;
export const ENTROPY_THRESHOLD = 7.2;

export const MIN_CHUNK = 16 * 1024;
export const DEGRADED_CHUNK = 64 * 1024;
export const DEFAULT_CHUNK = 64 * 1024;
export const MAX_CHUNK = 128 * 1024;

/** RTT above which the link is treated as ultra-high-latency (e.g. satellite / overloaded relay). */
export const DEGRADED_RTT_MS = 380;
export const DEGRADED_CHANNELS = 4;

export type IceRoute = 'host' | 'srflx' | 'relay' | 'unknown';

// ───────────────────────── Control channel (ordered, JSON) ─────────────────────────

export interface FileOfferMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
  lastModified: number;
  compressed: boolean;
  entropy: number;
}

export type ControlMessage =
  | { t: 'hello'; name: string; deviceKind: 'desktop' | 'mobile' | 'extension' }
  | { t: 'offer'; file: FileOfferMeta }
  | { t: 'accept'; id: string }
  | { t: 'decline'; id: string }
  | { t: 'pause'; id: string }
  | { t: 'resume'; id: string }
  | { t: 'cancel'; id: string; reason: string }
  | { t: 'complete'; id: string }
  | { t: 'failed'; id: string; reason: string }
  | { t: 'ping'; ts: number }
  | { t: 'pong'; ts: number };

// ───────────────────────── Main thread → Worker ─────────────────────────

export type ToWorker =
  | { type: 'init' }
  | { type: 'attach-channels'; linkId: string; channels: RTCDataChannel[] }
  | { type: 'detach'; linkId: string }
  | { type: 'analyze'; fileId: string; file: File }
  | {
      type: 'send-start';
      linkId: string;
      transferId: string;
      file: File;
      compress: boolean;
      chunkSize: number;
    }
  | { type: 'flow'; linkId: string; paused: boolean }
  | { type: 'bridge-ack'; linkId: string; bytes: number; paused: boolean }
  | { type: 'user-pause'; transferId: string; paused: boolean }
  | { type: 'net'; linkId: string; rttMs: number; chunkSize: number }
  | { type: 'cancel'; transferId: string }
  | {
      type: 'recv-start';
      linkId: string;
      transferId: string;
      name: string;
      size: number;
      compress: boolean;
      saveHandle: FileSystemFileHandle | null;
    }
  | { type: 'chunk-in'; linkId: string; data: ArrayBuffer }
  | { type: 'release'; transferId: string };

// ───────────────────────── Worker → Main thread ─────────────────────────

export type FromWorker =
  | { type: 'ready'; lz4: boolean; opfs: boolean; lz4Error?: string }
  | { type: 'attached'; linkId: string }
  | { type: 'analysis'; fileId: string; entropy: number; compress: boolean; sampleBytes: number }
  | { type: 'frame-out'; linkId: string; transferId: string; data: ArrayBuffer }
  | {
      type: 'send-progress';
      transferId: string;
      rawBytes: number;
      wireBytes: number;
      chunkSize: number;
      channels: number;
    }
  | { type: 'send-drained'; transferId: string }
  | { type: 'recv-ready'; transferId: string }
  | { type: 'recv-progress'; transferId: string; rawBytes: number; wireBytes: number }
  | { type: 'recv-complete'; transferId: string; file: File | null; savedToHandle: boolean }
  | { type: 'transfer-error'; transferId: string; message: string }
  | { type: 'queue'; linkId: string; buffered: number[]; active: number };

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
