// Generates the PNG app/extension icons (no external deps): a deep-space tile
// with concentric radar rings in Cupertino Cyan and a Signal Lime core.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public/icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function shade(nx, ny) {
  // nx, ny in [-1, 1]
  const r = Math.hypot(nx, ny);
  // Rounded-square mask (superellipse)
  const se = Math.pow(Math.abs(nx), 5) + Math.pow(Math.abs(ny), 5);
  if (se > 1) return [0, 0, 0, 0];
  let col = [5 + 18 * (1 - r), 5 + 18 * (1 - r), 8 + 30 * (1 - r)];
  const ring = (radius, width, rgb, alpha) => {
    const d = Math.abs(r - radius);
    if (d < width) {
      const a = alpha * (1 - d / width);
      col = col.map((c, i) => c * (1 - a) + rgb[i] * a);
    }
  };
  ring(0.78, 0.07, [10, 132, 255], 0.55);
  ring(0.56, 0.08, [10, 132, 255], 0.8);
  ring(0.34, 0.09, [100, 210, 255], 0.95);
  if (r < 0.16) {
    const a = Math.min(1, (0.16 - r) / 0.04);
    col = col.map((c, i) => c * (1 - a) + [48, 209, 88][i] * a);
  }
  return [...col.map((c) => Math.max(0, Math.min(255, Math.round(c)))), 255];
}

function png(size) {
  const ss = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const nx = ((x + (sx + 0.5) / ss) / size) * 2 - 1;
          const ny = ((y + (sy + 0.5) / ss) / size) * 2 - 1;
          const [r, g, b, a] = shade(nx, ny);
          acc[0] += r * a;
          acc[1] += g * a;
          acc[2] += b * a;
          acc[3] += a;
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const alpha = acc[3] / (ss * ss);
      raw[o] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      raw[o + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      raw[o + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      raw[o + 3] = Math.round(alpha);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128, 192, 512]) {
  writeFileSync(resolve(outDir, `icon-${size}.png`), png(size));
}
console.log('icons written to', outDir);
