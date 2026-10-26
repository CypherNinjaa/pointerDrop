import { MIN_CHUNK } from './protocol';

/**
 * Order-independent streaming integrity verifier (`blk128`).
 *
 * Why a fixed 16 KB sub-block accumulator?
 *   1. Payload frames arrive out of order across 4+ unordered RTCDataChannels and
 *      multiple parallel SCTP lanes, so sequential streaming SHA-256 cannot run
 *      without re-reading the entire multi-GB file from disk at the end.
 *   2. The AdaptiveTuner dynamically changes chunk size mid-transfer across
 *      [16 KB, 32 KB, 64 KB, 128 KB, 256 KB] — every step is an exact multiple of
 *      16 KB (`MIN_CHUNK`), so every chunk boundary aligns to a 16 KB grid.
 *   3. Decomposing each chunk into 16 KB sub-blocks `(blockOffset, subBytes)` makes
 *      the set of hashed sub-blocks 100% invariant to dynamic chunk size changes
 *      AND invariant to arrival order.
 *   4. Combining each sub-block's 128-bit digest via modular 32-bit addition (`+`)
 *      is commutative (order-independent) while catching dropped blocks, duplicate
 *      blocks, out-of-place offsets, and single-bit payload corruptions.
 */
export class OrderIndependentHasher {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;
  private blockCount = 0;

  update(offset: number, bytes: Uint8Array): void {
    let pos = 0;
    while (pos < bytes.byteLength) {
      const len = Math.min(MIN_CHUNK, bytes.byteLength - pos);
      this.updateSubBlock(offset + pos, bytes.subarray(pos, pos + len));
      pos += len;
    }
  }

  private updateSubBlock(subOffset: number, slice: Uint8Array): void {
    const loOff = subOffset >>> 0;
    const hiOff = Math.floor(subOffset / 0x1_0000_0000) >>> 0;
    const len = slice.byteLength;

    let h0 = (0x243f6a88 ^ loOff ^ len) >>> 0;
    let h1 = (0x85a308d3 ^ hiOff ^ (len << 7)) >>> 0;
    let h2 = (0x13198a2e ^ loOff) >>> 0;
    let h3 = (0x03707344 ^ hiOff) >>> 0;

    // Process 4 bytes at a time via unaligned-safe little-endian reads when aligned,
    // or byte-wise fallback on tail bytes.
    const view = new DataView(slice.buffer, slice.byteOffset, len);
    const limit4 = len & ~3;
    for (let i = 0; i < limit4; i += 4) {
      const w = view.getUint32(i, true);
      h0 = Math.imul(h0 ^ w, 0x9e3779b1) >>> 0;
      h1 = Math.imul(h1 ^ ((w << 13) | (w >>> 19)), 0x85ebca77) >>> 0;
      h2 = (h2 + Math.imul(w ^ i, 0xc2b2ae3d)) >>> 0;
      h3 = (h3 ^ Math.imul(w + h0, 0x27d4eb2f)) >>> 0;
    }
    for (let i = limit4; i < len; i++) {
      const b = slice[i];
      h0 = Math.imul(h0 ^ b, 0x01000193) >>> 0;
      h1 = Math.imul(h1 ^ (b << 8), 0x85ebca77) >>> 0;
    }

    // Final avalanche (Murmur3 fmix32) per lane before commutative modular addition.
    h0 = fmix32(h0 ^ len);
    h1 = fmix32(h1 ^ h0);
    h2 = fmix32(h2 ^ h1);
    h3 = fmix32(h3 ^ h2);

    this.s0 = (this.s0 + h0) >>> 0;
    this.s1 = (this.s1 + h1) >>> 0;
    this.s2 = (this.s2 + h2) >>> 0;
    this.s3 = (this.s3 + h3) >>> 0;
    this.blockCount++;
  }

  digestHex(): string {
    const c = fmix32(this.blockCount);
    return (
      hex32((this.s0 ^ c) >>> 0) +
      hex32((this.s1 + c) >>> 0) +
      hex32((this.s2 ^ ((c << 16) | (c >>> 16))) >>> 0) +
      hex32(this.s3 >>> 0)
    );
  }
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hex32(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}
