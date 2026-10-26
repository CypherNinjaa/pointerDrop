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
 *   When the user chose a destination with showSaveFilePicker(), the finished
 *   OPFS file is streamed into that handle (disk → disk) and the OPFS copy is
 *   removed. Otherwise the disk-backed OPFS File is handed to the UI thread,
 *   which triggers a regular download anchor (OPFS Virtual Accumulation Sink).
 *
 *   Browsers without sync access handles fall back to an async OPFS writable
 *   (positioned writes), and as a last resort to an in-memory sparse sink.
 */

const INBOX_DIR = 'warp-inbox';

export type SinkKind = 'opfs-sync' | 'opfs-writable' | 'memory';

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

/** Sparse in-memory sink used only where OPFS is entirely unavailable. */
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

export async function openDiskSink(transferId: string, displayName: string, _size: number, mime = 'application/octet-stream'): Promise<DiskSink> {
  if (opfsSupported()) {
    const name = `${transferId}.part`;
    try {
      const dir = await inboxDir();
      const fileHandle = (await dir.getFileHandle(name, { create: true })) as SyncCapableFileHandle;
      if (typeof fileHandle.createSyncAccessHandle === 'function') {
        const handle = await fileHandle.createSyncAccessHandle();
        handle.truncate(0); // Reset any stale file immediately without blocking on multi-GB zero-fill.
        return new OpfsSyncSink(fileHandle, handle, name);
      }
      if (typeof fileHandle.createWritable === 'function') {
        const writable = await fileHandle.createWritable({ keepExistingData: false });
        return new OpfsWritableSink(fileHandle, writable, name);
      }
    } catch (error) {
      console.warn('[warp] OPFS unavailable, falling back to memory sink', error);
    }
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
    // SecurityError (e.g. cross-origin iframe) → automatic download fallback.
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
  // Give the browser time to start reading the disk-backed blob before revoking.
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
