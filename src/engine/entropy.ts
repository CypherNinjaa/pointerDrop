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

const PRECOMPRESSED_EXTENSIONS = new Set([
  'mkv', 'mp4', 'm4v', 'mov', 'webm', 'avi', 'ts', 'm2ts', 'flv', 'wmv', '3gp',
  'mp3', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'flac', 'alac', 'wma',
  'jpg', 'jpeg', 'png', 'webp', 'avif', 'heic', 'heif', 'gif', 'jxl',
  'zip', 'rar', '7z', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst', 'lz4', 'br',
  'apk', 'ipa', 'dmg', 'iso', 'whl', 'jar', 'deb', 'rpm', 'woff2', 'woff',
]);

function isPrecompressedMediaOrArchive(blob: Blob): boolean {
  const mime = (blob.type || '').toLowerCase();
  if (
    (mime.startsWith('video/') || mime.startsWith('audio/') || mime.startsWith('image/')) &&
    !mime.includes('svg') &&
    !mime.includes('bmp') &&
    !mime.includes('wav') &&
    !mime.includes('tiff') &&
    !mime.includes('x-icon')
  ) {
    return true;
  }
  const name = typeof (blob as File).name === 'string' ? (blob as File).name.toLowerCase() : '';
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx !== -1) {
    const ext = name.slice(dotIdx + 1);
    if (PRECOMPRESSED_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

/**
 * Stratified multi-offset Shannon entropy probe:
 *  - Container formats (MKV, MP4, MOV, PDF, ZIP) often begin with sparse zero-padded
 *    headers (H ~ 4.5-5.2) followed by high-entropy compressed streams (H ~ 7.98).
 *  - For files > 256 KB, we sample 3 regions (head, 50% midpoint, and 75% interior)
 *    and take the maximum interior entropy so pre-compressed media/archives bypass
 *    WASM LZ4 immediately with zero CPU overhead.
 */
export async function analyzeBlob(blob: Blob): Promise<EntropyVerdict> {
  const size = blob.size;
  if (size === 0) return { entropy: 0, compress: false, sampleBytes: 0 };

  const precompressed = isPrecompressedMediaOrArchive(blob);

  if (size <= ENTROPY_SAMPLE_BYTES * 4) {
    const sample = new Uint8Array(await blob.slice(0, Math.min(size, ENTROPY_SAMPLE_BYTES)).arrayBuffer());
    const entropy = shannonEntropy(sample);
    const compress = !precompressed && sample.length >= 512 && entropy < ENTROPY_THRESHOLD;
    return { entropy: precompressed ? Math.max(entropy, 7.92) : entropy, compress, sampleBytes: sample.length };
  }

  // Sample 3 stratified windows: head (0..24 KB), middle (50%..+24 KB), and 75% (75%..+16 KB).
  const w1 = 24 * 1024;
  const w2 = 24 * 1024;
  const w3 = 16 * 1024;
  const midOffset = Math.floor(size * 0.5);
  const tailOffset = Math.floor(size * 0.75);

  const [buf1, buf2, buf3] = await Promise.all([
    blob.slice(0, w1).arrayBuffer(),
    blob.slice(midOffset, midOffset + w2).arrayBuffer(),
    blob.slice(tailOffset, tailOffset + w3).arrayBuffer(),
  ]);

  const h1 = shannonEntropy(new Uint8Array(buf1));
  const h2 = shannonEntropy(new Uint8Array(buf2));
  const h3 = shannonEntropy(new Uint8Array(buf3));

  // Interior samples (h2, h3) represent the true payload bulk; use max(h1, h2, h3).
  const entropy = Math.max(h1, h2, h3);
  const totalSampled = buf1.byteLength + buf2.byteLength + buf3.byteLength;
  const compress = !precompressed && entropy < ENTROPY_THRESHOLD;
  return { entropy, compress, sampleBytes: totalSampled };
}
