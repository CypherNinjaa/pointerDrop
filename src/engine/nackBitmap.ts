import { MIN_CHUNK } from './protocol';

export const BLOCK_BYTES = MIN_CHUNK; // 16 KiB atomic block unit
export type MissingRange = [startBlock: number, count: number];

/**
 * Compact, zero-GC bitset tracking 16 KiB block arrival across unordered /
 * unreliable (`maxRetransmits: 0`) channels.
 *
 *  • A 4.8 GB file = ~314,573 blocks = 38.4 KB of Uint32Array memory.
 *  • `markBlock(i)` is idempotent: returns `true` on first arrival (0 → 1) and
 *    `false` on duplicate arrival so duplicate retransmissions are never hashed
 *    or written twice.
 *  • `findMissingRanges` scans 32 blocks per CPU instruction (`word === 0xFFFFFFFF`),
 *    auditing a multi-GB file in < 0.2 ms.
 */
export class BlockBitmap {
  private words: Uint32Array;
  private _totalBlocks: number;
  private _receivedBlocks = 0;
  private _highestBlock = -1;
  private _duplicateBlocks = 0;

  constructor(fileSizeBytes: number) {
    this._totalBlocks =
      Number.isFinite(fileSizeBytes) && fileSizeBytes > 0 ? Math.ceil(fileSizeBytes / BLOCK_BYTES) : 0;
    const initialWords = Math.max(64, Math.ceil(this._totalBlocks / 32));
    this.words = new Uint32Array(initialWords);
  }

  get totalBlocks(): number {
    return this._totalBlocks;
  }

  get receivedBlocks(): number {
    return this._receivedBlocks;
  }

  get highestBlock(): number {
    return this._highestBlock;
  }

  get duplicateBlocks(): number {
    return this._duplicateBlocks;
  }

  get isComplete(): boolean {
    return this._totalBlocks > 0 && this._receivedBlocks >= this._totalBlocks;
  }

  /** Sets definitive total byte size (used when a time-bounded benchmark announces final byte count). */
  setFinalByteSize(bytes: number): void {
    this._totalBlocks = Math.max(0, Math.ceil(bytes / BLOCK_BYTES));
    this.ensureWordCapacity(Math.ceil(this._totalBlocks / 32));
  }

  private ensureWordCapacity(minWords: number): void {
    if (minWords <= this.words.length) return;
    let nextLen = this.words.length;
    while (nextLen < minWords) nextLen *= 2;
    const grown = new Uint32Array(nextLen);
    grown.set(this.words);
    this.words = grown;
  }

  hasBlock(blockIdx: number): boolean {
    const w = blockIdx >>> 5;
    if (w >= this.words.length) return false;
    return (this.words[w] & (1 << (blockIdx & 31))) !== 0;
  }

  /** Marks `blockIdx` as received. Returns `true` ONLY if this block was NOT previously received. */
  markBlock(blockIdx: number): boolean {
    const w = blockIdx >>> 5;
    if (w >= this.words.length) this.ensureWordCapacity(w + 1);
    const mask = 1 << (blockIdx & 31);
    const prev = this.words[w];
    if ((prev & mask) !== 0) {
      this._duplicateBlocks++;
      return false;
    }
    this.words[w] = prev | mask;
    this._receivedBlocks++;
    if (blockIdx > this._highestBlock) this._highestBlock = blockIdx;
    return true;
  }

  /**
   * Scans `[fromBlock, endBlockExclusive)` for missing blocks (`bit === 0`) and returns
   * run-length encoded `[startBlock, count]` intervals, plus the cursor to resume from.
   */
  findMissingRanges(
    fromBlock: number,
    endBlockExclusive: number,
    maxRanges = 96,
  ): { ranges: MissingRange[]; nextScanBlock: number } {
    const limit =
      this._totalBlocks > 0 ? Math.min(endBlockExclusive, this._totalBlocks) : Math.max(0, endBlockExclusive);
    const ranges: MissingRange[] = [];
    if (fromBlock >= limit) return { ranges, nextScanBlock: limit };

    let b = Math.max(0, fromBlock);
    let runStart = -1;

    while (b < limit) {
      const w = b >>> 5;
      const bit = b & 31;
      const word = w < this.words.length ? this.words[w] : 0;

      // Fast path: aligned 32-block word is 100% received
      if (bit === 0 && b + 32 <= limit && word === 0xffffffff) {
        if (runStart !== -1) {
          ranges.push([runStart, b - runStart]);
          runStart = -1;
          if (ranges.length >= maxRanges) return { ranges, nextScanBlock: b };
        }
        b += 32;
        continue;
      }

      // Fast path: aligned 32-block word is 100% missing
      if (bit === 0 && b + 32 <= limit && word === 0) {
        if (runStart === -1) runStart = b;
        b += 32;
        continue;
      }

      const present = (word & (1 << bit)) !== 0;
      if (!present) {
        if (runStart === -1) runStart = b;
      } else if (runStart !== -1) {
        ranges.push([runStart, b - runStart]);
        runStart = -1;
        if (ranges.length >= maxRanges) return { ranges, nextScanBlock: b + 1 };
      }
      b++;
    }

    if (runStart !== -1) {
      ranges.push([runStart, limit - runStart]);
    }
    return { ranges, nextScanBlock: limit };
  }
}

const STRIPE_BLOCKS = 128; // 128 × 16 KiB = 2 MiB contiguous write stripe
const STRIPE_BYTES = STRIPE_BLOCKS * BLOCK_BYTES;

interface StripeEntry {
  stripeIndex: number;
  buf: Uint8Array;
  present: Uint32Array; // 4 × 32-bit words = 128 block bits
  filledBlocks: number;
  expectedBlocks: number;
  expectedByteLen: number;
  touchedAt: number;
}

/**
 * Coalesces out-of-order 16 KiB blocks in RAM into sequential 2 MiB disk writes.
 *
 * Cuts OS filesystem syscalls by up to 128× and eliminates random-seek SSD/HDD
 * thrashing across multi-channel / Blast-UDP streams while bounding RAM strictly
 * to `maxOpenStripes × 2 MiB` (default 16 MiB).
 */
export class WriteCoalescer {
  private readonly stripes = new Map<number, StripeEntry>();
  private readonly freePool: Uint8Array[] = [];
  private touchSeq = 0;

  constructor(
    private readonly fileSize: number,
    private readonly flushRun: (offset: number, bytes: Uint8Array) => void | Promise<void>,
    private readonly maxOpenStripes = 8,
  ) {}

  writeBlock(blockIdx: number, bytes: Uint8Array): void | Promise<void> {
    const stripeIndex = Math.floor(blockIdx / STRIPE_BLOCKS);
    const slot = blockIdx - stripeIndex * STRIPE_BLOCKS;
    let entry = this.stripes.get(stripeIndex);
    const pendingFlushes: Promise<void>[] = [];

    if (!entry) {
      if (this.stripes.size >= this.maxOpenStripes) {
        const evicted = this.evictOldestStripe();
        if (evicted) pendingFlushes.push(evicted);
      }
      entry = this.allocateStripe(stripeIndex);
      this.stripes.set(stripeIndex, entry);
    }

    entry.touchedAt = ++this.touchSeq;
    const dstOffset = slot * BLOCK_BYTES;
    entry.buf.set(bytes, dstOffset);

    const w = slot >>> 5;
    const mask = 1 << (slot & 31);
    if ((entry.present[w] & mask) === 0) {
      entry.present[w] |= mask;
      entry.filledBlocks++;
    }

    if (entry.filledBlocks >= entry.expectedBlocks) {
      this.stripes.delete(stripeIndex);
      const fullSlice = entry.buf.subarray(0, entry.expectedByteLen);
      const res = this.flushRun(stripeIndex * STRIPE_BYTES, fullSlice);
      if (res) {
        const bufToRecycle = entry.buf;
        pendingFlushes.push(
          res.then(() => {
            if (this.freePool.length < this.maxOpenStripes) this.freePool.push(bufToRecycle);
          }),
        );
      } else {
        if (this.freePool.length < this.maxOpenStripes) this.freePool.push(entry.buf);
      }
    }

    if (pendingFlushes.length === 0) return;
    if (pendingFlushes.length === 1) return pendingFlushes[0];
    return Promise.all(pendingFlushes).then(() => undefined);
  }

  async flushAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    const sorted = [...this.stripes.values()].sort((a, b) => a.stripeIndex - b.stripeIndex);
    this.stripes.clear();
    for (const entry of sorted) {
      const p = this.flushPartialStripe(entry);
      if (p) promises.push(p);
    }
    if (promises.length > 0) await Promise.all(promises);
    this.freePool.length = 0;
  }

  clear(): void {
    this.stripes.clear();
    this.freePool.length = 0;
  }

  private allocateStripe(stripeIndex: number): StripeEntry {
    const stripeStart = stripeIndex * STRIPE_BYTES;
    const remaining = Number.isFinite(this.fileSize)
      ? Math.max(0, Math.min(STRIPE_BYTES, this.fileSize - stripeStart))
      : STRIPE_BYTES;
    const expectedBlocks = Math.max(1, Math.ceil(remaining / BLOCK_BYTES));
    const buf = this.freePool.pop() ?? new Uint8Array(STRIPE_BYTES);
    return {
      stripeIndex,
      buf,
      present: new Uint32Array(4),
      filledBlocks: 0,
      expectedBlocks,
      expectedByteLen: remaining > 0 ? remaining : STRIPE_BYTES,
      touchedAt: 0,
    };
  }

  private evictOldestStripe(): Promise<void> | void {
    let oldest: StripeEntry | null = null;
    for (const entry of this.stripes.values()) {
      if (!oldest || entry.touchedAt < oldest.touchedAt) oldest = entry;
    }
    if (!oldest) return;
    this.stripes.delete(oldest.stripeIndex);
    return this.flushPartialStripe(oldest);
  }

  private flushPartialStripe(entry: StripeEntry): Promise<void> | void {
    const promises: Promise<void>[] = [];
    const baseOffset = entry.stripeIndex * STRIPE_BYTES;
    let runStartSlot = -1;

    for (let slot = 0; slot <= STRIPE_BLOCKS; slot++) {
      const has =
        slot < STRIPE_BLOCKS && (entry.present[slot >>> 5] & (1 << (slot & 31))) !== 0;
      if (has) {
        if (runStartSlot === -1) runStartSlot = slot;
      } else if (runStartSlot !== -1) {
        const byteStart = runStartSlot * BLOCK_BYTES;
        const byteEnd = Math.min(entry.expectedByteLen, slot * BLOCK_BYTES);
        if (byteEnd > byteStart) {
          // Copy slice when flushing async so `entry.buf` can be safely reused
          const view = entry.buf.subarray(byteStart, byteEnd);
          const r = this.flushRun(baseOffset + byteStart, view);
          if (r) promises.push(r);
        }
        runStartSlot = -1;
      }
    }
    if (promises.length === 0) {
      if (this.freePool.length < this.maxOpenStripes) this.freePool.push(entry.buf);
      return;
    }
    const bufToRecycle = entry.buf;
    return Promise.all(promises).then(() => {
      if (this.freePool.length < this.maxOpenStripes) this.freePool.push(bufToRecycle);
    });
  }
}
