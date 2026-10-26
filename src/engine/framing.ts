import { FRAME_HEADER_BYTES } from './protocol';

/**
 * Build a wire frame: [Float64 BE offset (8 B)] + [payload].
 * Float64 represents integers exactly up to 2^53 (9 PB), far past any file size.
 */
export function encodeFrame(offset: number, payload: Uint8Array): ArrayBuffer {
  const frame = new ArrayBuffer(FRAME_HEADER_BYTES + payload.byteLength);
  new DataView(frame).setFloat64(0, offset, false);
  new Uint8Array(frame, FRAME_HEADER_BYTES).set(payload);
  return frame;
}

export interface DecodedFrame {
  offset: number;
  payload: Uint8Array;
}

export function decodeFrame(frame: ArrayBuffer): DecodedFrame {
  if (frame.byteLength < FRAME_HEADER_BYTES) throw new RangeError(`Runt frame (${frame.byteLength} B)`);
  const offset = new DataView(frame).getFloat64(0, false);
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`Corrupt frame offset ${offset}`);
  return { offset, payload: new Uint8Array(frame, FRAME_HEADER_BYTES) };
}

/** Worst-case LZ4 block size for `n` input bytes (+4 B size prefix written by lz4_flex). */
export const lz4Bound = (n: number): number => n + Math.ceil(n / 255) + 16 + 4;

/**
 * Pick the largest power-of-two raw chunk that – after optional LZ4 expansion
 * and the 8-byte header – still fits inside the peer's SCTP max message size.
 */
export function negotiateChunkSize(maxMessageSize: number | null | undefined, compress: boolean, ceiling: number, floor: number): number {
  const limit = maxMessageSize && Number.isFinite(maxMessageSize) && maxMessageSize > 0 ? maxMessageSize : 64 * 1024;
  let chunk = ceiling;
  while (chunk > floor) {
    const wire = FRAME_HEADER_BYTES + (compress ? lz4Bound(chunk) : chunk);
    if (wire <= limit) break;
    chunk >>= 1;
  }
  return Math.max(floor, chunk);
}
