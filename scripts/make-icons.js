// Generates the PWA / home-screen icons as PNGs with no dependencies (zlib only).
// Usage: npm run icons
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'icons');

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const RED = hex('#e8323c'), GREEN = hex('#2bb24c'), YELLOW = hex('#ffc61a'), BLUE = hex('#1f7ae8');
const WHITE = [255, 255, 255], INK = hex('#2a2346');
const BG_TOP = hex('#a24ff0'), BG_BOT = hex('#6a32d8');

function roundedBox(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Shades one point of the icon in unit coordinates (0..1). `full` = full-bleed (maskable).
function shade(x, y, full) {
  const bg = BG_TOP.map((c, i) => c + (BG_BOT[i] - c) * y);
  if (!full && !roundedBox(x, y, 0, 0, 1, 1, 0.22)) return null;
  const m = 0.2, s = 1 - 2 * m;
  if (!roundedBox(x, y, m - 0.012, m - 0.012, 1 - m + 0.012, 1 - m + 0.012, 0.075)) {
    const shadow = roundedBox(x, y - 0.02, m, m, 1 - m, 1 - m, 0.07);
    return shadow ? bg.map((c) => c * 0.75) : bg;
  }
  if (!roundedBox(x, y, m, m, 1 - m, 1 - m, 0.065)) return INK;
  const u = (x - m) / s, v = (y - m) / s;
  const lo = 0.4, hi = 0.6;
  if (u > lo && u < hi && v > lo && v < hi) {
    const dx = u - 0.5, dy = v - 0.5;
    if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? RED : YELLOW;
    return dy < 0 ? GREEN : BLUE;
  }
  const inLaneU = u > lo && u < hi, inLaneV = v > lo && v < hi;
  if (inLaneU || inLaneV) {
    if (inLaneV && u < lo && u > 0.08 && Math.abs(v - 0.5) < 0.065) return RED;
    if (inLaneV && u > hi && u < 0.92 && Math.abs(v - 0.5) < 0.065) return YELLOW;
    if (inLaneU && v < lo && v > 0.08 && Math.abs(u - 0.5) < 0.065) return GREEN;
    if (inLaneU && v > hi && v < 0.92 && Math.abs(u - 0.5) < 0.065) return BLUE;
    return WHITE;
  }
  const quad = u < 0.5 ? (v < 0.5 ? RED : BLUE) : (v < 0.5 ? GREEN : YELLOW);
  const qu = u < 0.5 ? u / lo : (u - hi) / (1 - hi);
  const qv = v < 0.5 ? v / lo : (v - hi) / (1 - hi);
  if (roundedBox(qu, qv, 0.2, 0.2, 0.8, 0.8, 0.12)) {
    const d = (qu - 0.5) ** 2 + (qv - 0.5) ** 2;
    return d < 0.17 ** 2 ? quad.map((c) => c * 0.85 + 255 * 0.15) : WHITE;
  }
  return quad;
}

function render(size, full) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((pxi + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, full);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const o = (py * size + pxi) * 4;
      if (a) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; }
      px[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return px;
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
  ['favicon-32.png', 32, false],
];
for (const [name, size, full] of targets) {
  writeFileSync(join(OUT, name), png(size, render(size, full)));
  console.log('wrote', name);
}
