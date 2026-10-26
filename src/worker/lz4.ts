/**
 * Hand-written loader + glue for the LZ4 block compressor compiled to WebAssembly
 * (lz4_flex via wasm-bindgen, vendored as ./lz4.wasm, MIT licensed).
 *
 * Writing the glue ourselves lets the module instantiate inside a Web Worker and
 * an MV3 extension page (CSP 'wasm-unsafe-eval') without any bundler plugins, and
 * lets us avoid the extra copies made by the stock bindings:
 *   • compressFrame() writes the compressed block straight into a fresh frame
 *     buffer after a reserved header area (one copy out of WASM memory).
 *   • decompressInto() hands the caller a view of WASM memory so the result can
 *     be written to disk before the scratch allocation is freed (zero extra copies).
 *
 * Block format: [u32 LE uncompressed length] + [LZ4 block] (lz4_flex "prepend size").
 * Every chunk is an independent block, so chunks can be decoded in any order —
 * a requirement for the unordered data channels.
 */

interface Lz4Exports {
  memory: WebAssembly.Memory;
  compress(retptr: number, ptr: number, len: number): void;
  decompress(retptr: number, ptr: number, len: number): void;
  __wbindgen_add_to_stack_pointer(delta: number): number;
  __wbindgen_malloc(size: number): number;
  __wbindgen_free(ptr: number, size: number): void;
}

export interface Lz4Codec {
  compressFrame(input: Uint8Array, headerBytes: number): ArrayBuffer;
  decompressInto(input: Uint8Array, sink: (view: Uint8Array) => void): number;
  compress(input: Uint8Array): Uint8Array;
  decompress(input: Uint8Array): Uint8Array;
}

export function createLz4Codec(instance: WebAssembly.Instance, heap: unknown[]): Lz4Codec {
  const wasm = instance.exports as unknown as Lz4Exports;
  let u8: Uint8Array | null = null;
  let i32: Int32Array | null = null;
  const mem8 = () => (u8 && u8.buffer === wasm.memory.buffer ? u8 : (u8 = new Uint8Array(wasm.memory.buffer)));
  const mem32 = () => (i32 && i32.buffer === wasm.memory.buffer ? i32 : (i32 = new Int32Array(wasm.memory.buffer)));

  const passBytes = (input: Uint8Array): number => {
    const ptr = wasm.__wbindgen_malloc(input.length);
    mem8().set(input, ptr);
    return ptr;
  };

  /** Runs `op`, then gives `use` a view of the returned [ptr,len] before freeing it. */
  const call = <T>(op: 'compress' | 'decompress', input: Uint8Array, use: (view: Uint8Array) => T): T => {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      const ptr = passBytes(input);
      wasm[op](retptr, ptr, input.length);
      const words = mem32();
      const r0 = words[retptr / 4 + 0];
      const r1 = words[retptr / 4 + 1];
      if (op === 'decompress') {
        const r2 = words[retptr / 4 + 2];
        const r3 = words[retptr / 4 + 3];
        if (r3) {
          const err = heap[r2];
          heap[r2] = undefined;
          throw new Error(`LZ4 decompress failed: ${String(err)}`);
        }
      }
      try {
        return use(mem8().subarray(r0, r0 + r1));
      } finally {
        wasm.__wbindgen_free(r0, r1);
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  };

  return {
    compressFrame(input, headerBytes) {
      return call('compress', input, (view) => {
        const frame = new ArrayBuffer(headerBytes + view.length);
        new Uint8Array(frame, headerBytes).set(view);
        return frame;
      });
    },
    decompressInto(input, sink) {
      return call('decompress', input, (view) => {
        sink(view);
        return view.length;
      });
    },
    compress(input) {
      return call('compress', input, (view) => view.slice());
    },
    decompress(input) {
      return call('decompress', input, (view) => view.slice());
    },
  };
}

/** Builds the import object expected by the wasm-bindgen module. */
export function lz4Imports(getMemory: () => WebAssembly.Memory, heap: unknown[]): WebAssembly.Imports {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  return {
    './lz4_wasm_bg.js': {
      __wbindgen_string_new(ptr: number, len: number): number {
        const text = decoder.decode(new Uint8Array(getMemory().buffer).subarray(ptr, ptr + len));
        heap.push(text);
        return heap.length - 1;
      },
    },
  };
}

export async function instantiateLz4(source: Response | ArrayBuffer | Uint8Array): Promise<Lz4Codec> {
  const heap: unknown[] = [];
  let memory: WebAssembly.Memory | null = null;
  const imports = lz4Imports(() => {
    if (!memory) throw new Error('LZ4 memory not ready');
    return memory;
  }, heap);

  let instance: WebAssembly.Instance;
  if (source instanceof Response) {
    const fallback = source.clone();
    try {
      ({ instance } = await WebAssembly.instantiateStreaming(source, imports));
    } catch {
      // Some static hosts serve .wasm without application/wasm; fall back to buffered compile.
      ({ instance } = await WebAssembly.instantiate(await fallback.arrayBuffer(), imports));
    }
  } else {
    ({ instance } = await WebAssembly.instantiate(source as BufferSource, imports));
  }
  memory = (instance.exports as unknown as Lz4Exports).memory;
  return createLz4Codec(instance, heap);
}
