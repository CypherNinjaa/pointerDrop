import { FRAME_HEADER_BYTES } from './protocol';

/**
 * Write the 8-byte Float64 Big-Endian offset header.
 *
 * Sign encoding for per-frame LZ4 flag:
 *  - Raw (uncompressed) frames store `offset >= 0` directly.
 *  - LZ4-compressed frames store `-(offset + 1) < 0` (exact integer in IEEE 754
 *    Float64 up to 2^53 = 9 PB). This lets the sender dynamically bypass LZ4 on
 *    any incompressible chunk without changing the 8-byte header size.
 */
export function writeFrameHeader(frame: ArrayBuffer, offset: number, compressed = false): void {
  new DataView(frame).setFloat64(0, compressed ? -(offset + 1) : offset, false);
}

/**
 * Build a wire frame: [Float64 BE offset (8 B)] + [payload].
 * Float64 represents integers exactly up to 2^53 (9 PB), far past any file size.
 */
export function encodeFrame(offset: number, payload: Uint8Array, compressed = false): ArrayBuffer {
  const frame = new ArrayBuffer(FRAME_HEADER_BYTES + payload.byteLength);
  writeFrameHeader(frame, offset, compressed);
  new Uint8Array(frame, FRAME_HEADER_BYTES).set(payload);
  return frame;
}

export interface DecodedFrame {
  offset: number;
  compressed: boolean;
  payload: Uint8Array;
}

export function decodeFrame(frame: ArrayBuffer): DecodedFrame {
  if (frame.byteLength < FRAME_HEADER_BYTES) throw new RangeError(`Runt frame (${frame.byteLength} B)`);
  const raw = new DataView(frame).getFloat64(0, false);
  if (!Number.isInteger(raw)) throw new RangeError(`Corrupt frame offset ${raw}`);
  const compressed = raw < 0;
  const offset = compressed ? -raw - 1 : raw + 0;
  return { offset, compressed, payload: new Uint8Array(frame, FRAME_HEADER_BYTES) };
}

/** Worst-case LZ4 block size for `n` input bytes (+4 B size prefix written by lz4_flex). */
export const lz4Bound = (n: number): number => n + Math.ceil(n / 255) + 16 + 4;

/**
 * Pick the largest power-of-two raw chunk that fits inside the peer's SCTP
 * `maxMessageSize`. Because incompressible chunks automatically fall back to
 * raw uncompressed frames via the header sign bit, we never need to halve the
 * chunk size when `compress` is enabled.
 */
export function negotiateChunkSize(
  maxMessageSize: number | null | undefined,
  _compress: boolean,
  ceiling: number,
  floor: number,
): number {
  const limit = maxMessageSize && Number.isFinite(maxMessageSize) && maxMessageSize > 0 ? maxMessageSize : 64 * 1024;
  let chunk = ceiling;
  while (chunk > floor) {
    if (FRAME_HEADER_BYTES + chunk <= limit) break;
    chunk >>= 1;
  }
  return Math.max(floor, chunk);
}
