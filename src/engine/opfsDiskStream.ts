/**
 * Zero-RAM disk streaming.
 *
 * Worker side (receiver):
 *   Every incoming chunk is written straight to an Origin Private File System
 *   file through a FileSystemSyncAccessHandle with random-access positioning:
 *       handle.write(bytes, { at: byteOffset })
 *   so chunks arriving out of order over the unordered channels land exactly
 *   where they belong and nothing accumulates in the JS heap — 20 GB is fine.
 *
 *   Browsers without sync access handles fall back to an async OPFS writable
 *   (positioned writes bounded by explicit application-level receiver credits),
 *   and only for small files under a strict memory budget to an in-memory sink.
 */

import { formatBytes, type SinkKind } from './protocol';

const INBOX_DIR = 'warp-inbox';

export type { SinkKind };

export interface DiskSink {
  readonly kind: SinkKind;
  /** True when write() completes synchronously (no promise chaining needed). */
  readonly synchronous: boolean;
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

class OpfsSyncSink implements DiskSink {
  readonly kind = 'opfs-sync' as const;
  readonly synchronous = true;
  constructor(
    private readonly fileHandle: FileSystemFileHandle,
    private readonly handle: SyncHandle,
    private readonly name: string,
  ) {}

  write(offset: number, bytes: Uint8Array): void {
    let written = 0;
    while (written < bytes.byteLength) {
      written += this.handle.write(bytes.subarray(written), { at: offset + written });
    }
  }

  async finalize(): Promise<File> {
    this.handle.flush();
    this.handle.close();
    return this.fileHandle.getFile();
  }

  async abort(): Promise<void> {
    try {
      this.handle.close();
    } catch {
      // Already closed.
    }
    await removeInboxFile(this.name);
  }
}

class OpfsWritableSink implements DiskSink {
  readonly kind = 'opfs-writable' as const;
  readonly synchronous = false;
  constructor(
    private readonly fileHandle: FileSystemFileHandle,
    private readonly writable: FileSystemWritableFileStream,
    private readonly name: string,
  ) {}

  write(offset: number, bytes: Uint8Array): Promise<void> {
    // The caller may reuse/free `bytes` (e.g. a WASM memory view), so copy for the async write.
    return this.writable.write({ type: 'write', position: offset, data: bytes.slice() });
  }

  async finalize(): Promise<File> {
    await this.writable.close();
    return this.fileHandle.getFile();
  }

  async abort(): Promise<void> {
    try {
      await this.writable.abort();
    } catch {
      // Already closed.
    }
    await removeInboxFile(this.name);
  }
}

/** Bounded in-memory sink used only for small files when OPFS is unavailable. */
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
}

export async function openDiskSink(
  transferId: string,
  displayName: string,
  size: number,
  options: OpenDiskSinkOptions = {},
): Promise<DiskSink> {
  const { mime = 'application/octet-stream', preferredSink = 'auto', maxMemoryBytes = 384 * 1024 * 1024 } = options;

  if (preferredSink === 'discard') {
    return new DiscardSink();
  }

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
        return new OpfsSyncSink(fileHandle, handle, name);
      }
      if (preferredSink === 'opfs-sync') {
        await dir.removeEntry(name).catch(() => undefined);
        throw new Error('OPFS FileSystemSyncAccessHandle is not supported on this browser');
      }
      if (typeof fileHandle.createWritable === 'function') {
        const writable = await fileHandle.createWritable({ keepExistingData: false });
        return new OpfsWritableSink(fileHandle, writable, name);
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
      ? 'browser storage is restricted (e.g. private/incognito mode)'
      : 'page was opened over plain HTTP instead of HTTPS/localhost';
    throw new Error(
      `OPFS disk streaming unavailable (${why}). Refusing to buffer ${formatBytes(size)} in RAM (safe cap ${formatBytes(maxMemoryBytes)}). Use HTTPS or select a save file on a supported desktop browser.`,
    );
  }

  return new MemorySink(displayName, mime);
}

/** Streams a finished file into a user-chosen destination (disk → disk, constant memory). */
export async function streamToHandle(file: File, handle: FileSystemFileHandle): Promise<void> {
  const writable = await handle.createWritable({ keepExistingData: false });
  await file.stream().pipeTo(writable);
}

// ───────────────────────────── UI-thread helpers ─────────────────────────────

export const canPickSaveLocation = (): boolean =>
  typeof window !== 'undefined' && typeof (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';

export type SaveTarget = { kind: 'handle'; handle: FileSystemFileHandle } | { kind: 'download' } | { kind: 'cancelled' };

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
