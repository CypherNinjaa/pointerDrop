import { ENTROPY_SAMPLE_BYTES, ENTROPY_THRESHOLD } from './protocol';

/**
 * Shannon entropy in bits per byte:  H(X) = -Σ P(x) · log2 P(x)
 *
 * 0.0 → a single repeated byte, 8.0 → uniformly random bytes.
 * Plain text / source code typically lands between 4.0 and 5.5, uncompressed
 * binaries around 5–6.5, while zip/mp4/jpeg/encrypted payloads sit above 7.5.
 */
export function shannonEntropy(bytes: Uint8Array): number {
  const n = bytes.length;
  if (n === 0) return 0;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < n; i++) histogram[bytes[i]]++;
  let entropy = 0;
  for (let symbol = 0; symbol < 256; symbol++) {
    const count = histogram[symbol];
    if (count === 0) continue;
    const p = count / n;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export interface EntropyVerdict {
  entropy: number;
  compress: boolean;
  sampleBytes: number;
}

/** Sample the first 64 KB of a file and decide whether LZ4 is worth running. */
export async function analyzeBlob(blob: Blob): Promise<EntropyVerdict> {
  const sample = new Uint8Array(await blob.slice(0, ENTROPY_SAMPLE_BYTES).arrayBuffer());
  const entropy = shannonEntropy(sample);
  // Tiny files gain nothing from compression and the 4-byte LZ4 size prefix costs more than it saves.
  const compress = sample.length >= 512 && entropy < ENTROPY_THRESHOLD;
  return { entropy, compress, sampleBytes: sample.length };
}
