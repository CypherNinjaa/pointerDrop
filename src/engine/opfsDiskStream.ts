/**
 * 3-Tier High-Speed Receiver Memory + Zero-Double-Copy Disk Engine.
 *
 *   Tier 1 — `ram-arena` (RAM Turbo Sink):
 *     Files within the scanned `ramArenaBudget` (up to 1 GiB on 16 GB desktops,
 *     640 MiB on 8 GB laptops, 192 MiB on mobile) stream directly into pre-sized
 *     16 MiB RAM slabs (`Uint8Array.set` at > 5 GB/s, 0 ms I/O wait), then flush
 *     sequentially to disk/download in a single sweep upon completion.
 *
 *   Tier 2 — `direct-handle` (Direct OS FileSystemFileHandle + 2 MiB RAM Coalescer):
 *     For multi-GB files when `showSaveFilePicker` is granted, streams directly
 *     into the user's chosen OS file via a 16 MiB RAM WriteCoalescer — completely
 *     bypassing browser OPFS quota ("Receiver disk quota exceeded" eliminated) and
 *     eliminating the 2× post-transfer OPFS→disk copy.
 *
 *   Tier 3 — `opfs-sync` / `opfs-writable` (Coalesced OPFS Random-Access Stream):
 *     For multi-GB files on browsers without `showSaveFilePicker` (mobile Chrome,
 *     Safari, Firefox), coalesces random 16–64 KiB packets in RAM into sequential
 *     2 MiB OPFS writes.
 */

import { BLOCK_BYTES, WriteCoalescer } from './nackBitmap';
import { formatBytes, type SinkKind } from './protocol';

const INBOX_DIR = 'warp-inbox';
const RAM_SLAB_BYTES = 16 * 1024 * 1024; // 16 MiB contiguous RAM slabs

export type { SinkKind };

export interface DiskSink {
  readonly kind: SinkKind;
  /** True when write() completes synchronously (no promise chaining needed). */
  readonly synchronous: boolean;
  /** True when bytes were already written directly to `saveHandle` (no post-finalize copy needed). */
  readonly wroteDirectlyToHandle?: boolean;
  write(offset: number, bytes: Uint8Array): void | Promise<void>;
  finalize(): Promise<File>;
  abort(): Promise<void>;
}

type SyncHandle = {
  write(buffer: BufferSource, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
};

type SyncCapableFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<SyncHandle>;
};

async function inboxDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(INBOX_DIR, { create: true });
}

export function opfsSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function';
}

/** Probes whether OPFS + FileSystemSyncAccessHandle actually work in this Worker context. */
export async function probeOpfsCapability(): Promise<{ opfs: boolean; opfsSync: boolean }> {
  if (!opfsSupported()) return { opfs: false, opfsSync: false };
  const probeName = '__warp_probe__.tmp';
  try {
    const dir = await inboxDir();
    const fh = (await dir.getFileHandle(probeName, { create: true })) as SyncCapableFileHandle;
    let opfsSync = false;
    if (typeof fh.createSyncAccessHandle === 'function') {
      try {
        const sh = await fh.createSyncAccessHandle();
        sh.close();
        opfsSync = true;
      } catch {
        opfsSync = false;
      }
    }
    await dir.removeEntry(probeName).catch(() => undefined);
    return { opfs: true, opfsSync };
  } catch {
    return { opfs: false, opfsSync: false };
  }
}

/** Removes leftover partial files from previous sessions (called once at worker boot). */
export async function purgeInbox(keep: Set<string> = new Set()): Promise<void> {
  if (!opfsSupported()) return;
  try {
    const dir = await inboxDir();
    const names: string[] = [];
    const iterable = (dir as unknown as { keys(): AsyncIterable<string> }).keys();
    for await (const name of iterable) names.push(name);
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => dir.removeEntry(n).catch(() => undefined)));
  } catch {
    // OPFS can be unavailable in private windows; nothing to purge.
  }
}

export async function removeInboxFile(name: string): Promise<void> {
  if (!opfsSupported()) return;
  try {
    const dir = await inboxDir();
    await dir.removeEntry(name);
  } catch {
    // Already gone.
  }
}

/** Tier 1: Zero-I/O-Wait Pre-Slotted RAM Arena (`16 MiB` slabs). */
class RamArenaSink implements DiskSink {
  readonly kind = 'ram-arena' as const;
  readonly synchronous = true;
  readonly wroteDirectlyToHandle: boolean;
  private slabs: Array<Uint8Array<ArrayBuffer> | undefined> = [];
  private maxWrittenEnd = 0;

  constructor(
    private readonly name: string,
    private readonly mime: string,
    private readonly expectedSize: number,
    private readonly saveHandle: FileSystemFileHandle | null,
    private readonly maxBudgetBytes = 1024 * 1024 * 1024,
  ) {
    this.wroteDirectlyToHandle = saveHandle !== null;
    if (Number.isFinite(expectedSize) && expectedSize > 0) {
      const slabCount = Math.ceil(expectedSize / RAM_SLAB_BYTES);
      this.slabs = new Array(slabCount);
    }
  }

  write(offset: number, bytes: Uint8Array): void {
    let remaining = bytes.byteLength;
    let srcPos = 0;
    let curOffset = offset;
    const isBenchUnbounded = !Number.isFinite(this.expectedSize);
    const maxBenchSlabs = Math.max(2, Math.floor(this.maxBudgetBytes / RAM_SLAB_BYTES));

    while (remaining > 0) {
      const rawSlabIdx = Math.floor(curOffset / RAM_SLAB_BYTES);
      const slabIdx = isBenchUnbounded ? rawSlabIdx % maxBenchSlabs : rawSlabIdx;
      const slabOffset = curOffset - rawSlabIdx * RAM_SLAB_BYTES;
      let slab = this.slabs[slabIdx];
      if (!slab) {
        const slabSize =
          Number.isFinite(this.expectedSize) && this.expectedSize > 0
            ? Math.min(RAM_SLAB_BYTES, Math.max(slabOffset + remaining, this.expectedSize - slabIdx * RAM_SLAB_BYTES))
            : RAM_SLAB_BYTES;
        slab = new Uint8Array(new ArrayBuffer(Math.max(1, slabSize)));
        this.slabs[slabIdx] = slab;
      }
      const copyLen = Math.min(remaining, slab.byteLength - slabOffset);
      slab.set(bytes.subarray(srcPos, srcPos + copyLen), slabOffset);
      srcPos += copyLen;
      curOffset += copyLen;
      remaining -= copyLen;
    }

    if (curOffset > this.maxWrittenEnd) this.maxWrittenEnd = curOffset;
  }

  async finalize(): Promise<File> {
    if (!Number.isFinite(this.expectedSize) && !this.saveHandle) {
      // Unbounded benchmark run — discard slabs immediately without building an oversized Blob
      this.slabs = [];
      return new File([], this.name, { type: this.mime });
    }
    const finalSize = Number.isFinite(this.expectedSize) && this.expectedSize >= 0 ? this.expectedSize : this.maxWrittenEnd;
    const parts: BlobPart[] = [];
    let remaining = finalSize;

    for (let i = 0; i < this.slabs.length && remaining > 0; i++) {
      const take = Math.min(RAM_SLAB_BYTES, remaining);
      const slab = this.slabs[i] ?? new Uint8Array(new ArrayBuffer(take));
      parts.push(slab.byteLength === take ? slab : (slab.subarray(0, take) as BlobPart));
      remaining -= take;
    }

    if (this.saveHandle) {
      const writable = await this.saveHandle.createWritable({ keepExistingData: false });
      for (const part of parts) {
        await writable.write(part as BufferSource);
      }
      await writable.close();
      this.slabs = [];
      return new File([], this.name, { type: this.mime });
    }

    const file = new File(parts, this.name, { type: this.mime });
    this.slabs = [];
    return file;
  }

  async abort(): Promise<void> {
    this.slabs = [];
  }
}

/** Tier 2: Direct OS `FileSystemFileHandle` Sink with 16 MiB RAM WriteCoalescer (bypasses OPFS quota & double-copy). */
class DirectHandleSink implements DiskSink {
  readonly kind = 'direct-handle' as const;
  readonly synchronous = false;
  readonly wroteDirectlyToHandle = true;
  private readonly coalescer: WriteCoalescer;

  constructor(
    private readonly fileHandle: FileSystemFileHandle,
    private readonly writable: FileSystemWritableFileStream,
    size: number,
  ) {
    this.coalescer = new WriteCoalescer(
      size,
      (offset, slice) => this.writable.write({ type: 'write', position: offset, data: slice.slice() }),
      12, // 24 MiB RAM coalescing window
    );
  }

  write(offset: number, bytes: Uint8Array): void | Promise<void> {
    if (offset % BLOCK_BYTES !== 0) {
      return this.writable.write({ type: 'write', position: offset, data: bytes.slice() });
    }
    const promises: Promise<void>[] = [];
    let pos = 0;
    while (pos < bytes.byteLength) {
      const len = Math.min(BLOCK_BYTES, bytes.byteLength - pos);
      const blockIdx = (offset + pos) / BLOCK_BYTES;
      const r = this.coalescer.writeBlock(blockIdx, bytes.subarray(pos, pos + len));
      if (r) promises.push(r);
      pos += len;
    }
    if (promises.length === 0) return;
    if (promises.length === 1) return promises[0];
    return Promise.all(promises).then(() => undefined);
  }

  async finalize(): Promise<File> {
    await this.coalescer.flushAll();
    await this.writable.close();
    return this.fileHandle.getFile().catch(() => new File([], this.fileHandle.name));
  }

  async abort(): Promise<void> {
    this.coalescer.clear();
    try {
      await this.writable.abort();
    } catch {
      // Already closed.
    }
  }
}

/** Tier 3a: Synchronous OPFS `FileSystemSyncAccessHandle` backed by 2 MiB RAM WriteCoalescer. */
class OpfsSyncSink implements DiskSink {
  readonly kind = 'opfs-sync' as const;
  readonly synchronous = true;
  private readonly coalescer: WriteCoalescer;

  constructor(
    private readonly fileHandle: FileSystemFileHandle,
    private readonly handle: SyncHandle,
    private readonly name: string,
    size: number,
  ) {
    this.coalescer = new WriteCoalescer(
      size,
      (offset, slice) => {
        let written = 0;
        while (written < slice.byteLength) {
          written += this.handle.write(slice.subarray(written), { at: offset + written });
        }
      },
      8, // 16 MiB RAM coalescing window
    );
  }

  write(offset: number, bytes: Uint8Array): void {
    if (offset % BLOCK_BYTES !== 0) {
      let written = 0;
      while (written < bytes.byteLength) {
        written += this.handle.write(bytes.subarray(written), { at: offset + written });
      }
      return;
    }
    let pos = 0;
    while (pos < bytes.byteLength) {
      const len = Math.min(BLOCK_BYTES, bytes.byteLength - pos);
      const blockIdx = (offset + pos) / BLOCK_BYTES;
      void this.coalescer.writeBlock(blockIdx, bytes.subarray(pos, pos + len));
      pos += len;
    }
  }

  async finalize(): Promise<File> {
    await this.coalescer.flushAll();
    this.handle.flush();
    this.handle.close();
    return this.fileHandle.getFile();
  }

  async abort(): Promise<void> {
    this.coalescer.clear();
    try {
      this.handle.close();
    } catch {
      // Already closed.
    }
    await removeInboxFile(this.name);
  }
}

/** Tier 3b: Async OPFS `FileSystemWritableFileStream` backed by 2 MiB RAM WriteCoalescer. */
class OpfsWritableSink implements DiskSink {
  readonly kind = 'opfs-writable' as const;
  readonly synchronous = false;
  private readonly coalescer: WriteCoalescer;

  constructor(
    private readonly fileHandle: FileSystemFileHandle,
    private readonly writable: FileSystemWritableFileStream,
    private readonly name: string,
    size: number,
  ) {
    this.coalescer = new WriteCoalescer(
      size,
      (offset, slice) => this.writable.write({ type: 'write', position: offset, data: slice.slice() }),
      8,
    );
  }

  write(offset: number, bytes: Uint8Array): void | Promise<void> {
    if (offset % BLOCK_BYTES !== 0) {
      return this.writable.write({ type: 'write', position: offset, data: bytes.slice() });
    }
    const promises: Promise<void>[] = [];
    let pos = 0;
    while (pos < bytes.byteLength) {
      const len = Math.min(BLOCK_BYTES, bytes.byteLength - pos);
      const blockIdx = (offset + pos) / BLOCK_BYTES;
      const r = this.coalescer.writeBlock(blockIdx, bytes.subarray(pos, pos + len));
      if (r) promises.push(r);
      pos += len;
    }
    if (promises.length === 0) return;
    if (promises.length === 1) return promises[0];
    return Promise.all(promises).then(() => undefined);
  }

  async finalize(): Promise<File> {
    await this.coalescer.flushAll();
    await this.writable.close();
    return this.fileHandle.getFile();
  }

  async abort(): Promise<void> {
    this.coalescer.clear();
    try {
      await this.writable.abort();
    } catch {
      // Already closed.
    }
    await removeInboxFile(this.name);
  }
}

/** Bounded fallback in-memory sink used only when OPFS & Direct Handle are unavailable. */
class MemorySink implements DiskSink {
  readonly kind = 'memory' as const;
  readonly synchronous = true;
  private parts: Array<{ offset: number; bytes: Uint8Array }> = [];
  constructor(
    private readonly name: string,
    private readonly mime: string,
  ) {}

  write(offset: number, bytes: Uint8Array): void {
    this.parts.push({ offset, bytes: bytes.slice() });
  }

  async finalize(): Promise<File> {
    this.parts.sort((a, b) => a.offset - b.offset);
    const file = new File(
      this.parts.map((p) => p.bytes as BlobPart),
      this.name,
      { type: this.mime },
    );
    this.parts = [];
    return file;
  }

  async abort(): Promise<void> {
    this.parts = [];
  }
}

/** Benchmark sink: counts bytes and discards them, so a speed test measures the network path only. */
export class DiscardSink implements DiskSink {
  readonly kind = 'discard' as const;
  readonly synchronous = true;
  write(): void {
    // Intentionally discarded.
  }
  async finalize(): Promise<File> {
    return new File([], 'benchmark.bin');
  }
  async abort(): Promise<void> {
    // Nothing to release.
  }
}

export interface OpenDiskSinkOptions {
  mime?: string;
  preferredSink?: 'auto' | SinkKind;
  maxMemoryBytes?: number;
  ramArenaBudget?: number;
  saveHandle?: FileSystemFileHandle | null;
}

export async function openDiskSink(
  transferId: string,
  displayName: string,
  size: number,
  options: OpenDiskSinkOptions = {},
): Promise<DiskSink> {
  const {
    mime = 'application/octet-stream',
    preferredSink = 'auto',
    maxMemoryBytes = 384 * 1024 * 1024,
    ramArenaBudget = 384 * 1024 * 1024,
    saveHandle = null,
  } = options;

  if (preferredSink === 'discard') {
    return new DiscardSink();
  }

  // Tier 1: RAM Turbo Arena when file fits safely in scanned RAM Arena budget (or explicitly benchmarked)!
  if (
    preferredSink === 'ram-arena' ||
    (preferredSink === 'auto' && Number.isFinite(size) && size > 0 && size <= ramArenaBudget)
  ) {
    if (Number.isFinite(size) && size > Math.max(ramArenaBudget, maxMemoryBytes)) {
      if (preferredSink === 'ram-arena') {
        throw new Error(`File size exceeds safe RAM Arena limit (${formatBytes(ramArenaBudget)})`);
      }
    } else {
      return new RamArenaSink(displayName, mime, size, saveHandle, Math.max(64 * 1024 * 1024, ramArenaBudget));
    }
  }

  // Tier 2: Direct OS FileSystemFileHandle (writes straight to user's chosen drive/folder, zero OPFS quota!)
  if (
    saveHandle &&
    (preferredSink === 'auto' || preferredSink === 'direct-handle') &&
    typeof saveHandle.createWritable === 'function'
  ) {
    try {
      const writable = await saveHandle.createWritable({ keepExistingData: false });
      return new DirectHandleSink(saveHandle, writable, size);
    } catch (err) {
      if (preferredSink === 'direct-handle') throw err;
      console.warn('[warp] Direct FileSystemFileHandle writable failed in worker, falling back to OPFS', err);
    }
  }

  // Tier 3: Coalesced OPFS (`SyncAccessHandle` or `WritableFileStream`)
  if (preferredSink !== 'memory' && opfsSupported()) {
    const name = `${transferId}.part`;
    try {
      const dir = await inboxDir();
      const fileHandle = (await dir.getFileHandle(name, { create: true })) as SyncCapableFileHandle;
      if (
        (preferredSink === 'auto' || preferredSink === 'opfs-sync') &&
        typeof fileHandle.createSyncAccessHandle === 'function'
      ) {
        const handle = await fileHandle.createSyncAccessHandle();
        handle.truncate(0);
        return new OpfsSyncSink(fileHandle, handle, name, size);
      }
      if (preferredSink === 'opfs-sync') {
        await dir.removeEntry(name).catch(() => undefined);
        throw new Error('OPFS FileSystemSyncAccessHandle is not supported on this browser');
      }
      if (typeof fileHandle.createWritable === 'function') {
        const writable = await fileHandle.createWritable({ keepExistingData: false });
        return new OpfsWritableSink(fileHandle, writable, name, size);
      }
    } catch (error) {
      if (preferredSink === 'opfs-sync' || preferredSink === 'opfs-writable') {
        throw error;
      }
      console.warn('[warp] OPFS unavailable, checking memory sink budget', error);
    }
  } else if (preferredSink === 'opfs-sync' || preferredSink === 'opfs-writable') {
    const secure = typeof self !== 'undefined' && (self as unknown as { isSecureContext?: boolean }).isSecureContext;
    throw new Error(
      secure
        ? `Requested ${preferredSink} is unavailable in this browser/mode`
        : `OPFS requires HTTPS or localhost (current origin is insecure HTTP)`,
    );
  }

  if (Number.isFinite(size) && size > maxMemoryBytes) {
    const secure = typeof self !== 'undefined' && (self as unknown as { isSecureContext?: boolean }).isSecureContext;
    const why = secure
      ? 'browser OPFS storage is full or restricted'
      : 'page was opened over plain HTTP instead of HTTPS/localhost';
    throw new Error(
      `Disk streaming unavailable (${why}). Refusing to buffer ${formatBytes(size)} in RAM (safe cap ${formatBytes(maxMemoryBytes)}). Choose a save location with free disk space or use HTTPS.`,
    );
  }

  return new MemorySink(displayName, mime);
}

/** Streams a finished file into a user-chosen destination when DirectHandleSink was not used in-worker. */
export async function streamToHandle(file: File, handle: FileSystemFileHandle): Promise<void> {
  const writable = await handle.createWritable({ keepExistingData: false });
  await file.stream().pipeTo(writable);
}

// ───────────────────────────── UI-thread helpers ─────────────────────────────

export const canPickSaveLocation = (): boolean =>
  typeof window !== 'undefined' &&
  typeof (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';

export type SaveTarget =
  | { kind: 'handle'; handle: FileSystemFileHandle }
  | { kind: 'download' }
  | { kind: 'cancelled' };

/** Must be called from a user gesture (the Accept button). */
export async function chooseSaveTarget(suggestedName: string): Promise<SaveTarget> {
  if (!canPickSaveLocation()) return { kind: 'download' };
  try {
    const handle = await window.showSaveFilePicker({ suggestedName });
    return { kind: 'handle', handle };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return { kind: 'cancelled' };
    return { kind: 'download' };
  }
}

export function triggerDownload(file: File, name: string): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

export async function hasQuotaFor(bytes: number): Promise<{ ok: boolean; available: number | null }> {
  if (!navigator.storage?.estimate) return { ok: true, available: null };
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    const available = quota - usage;
    return { ok: available > bytes * 1.02, available };
  } catch {
    return { ok: true, available: null };
  }
}
