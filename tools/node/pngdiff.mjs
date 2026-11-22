// Pixel comparison of two PNG screenshots (picture-identity
// check). Plain Node, no dependencies: decodes 8-bit RGB / RGBA PNGs
// (non-interlaced — what Chrome writes).
//
//   node tools/node/pngdiff.mjs a.png b.png [diff.png]
//
// Prints one line: identical bytes / pixels, the largest per-channel
// difference (0–255), how many pixels differ, how many differ by more than
// 2, and the bounding box of the differing pixels. With a third argument it
// writes a diff image: differing pixels in red (brightness ∝ difference,
// at least 64) over a dimmed copy of `a`.
// Exit status: 0 = max difference ≤ 2, 1 = larger, 2 = unreadable input.
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

function decode(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  let off = 8;
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace !== 0) throw new Error(`${file}: unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const ch = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = cur[x * ch];
      out[o + 1] = cur[x * ch + 1];
      out[o + 2] = cur[x * ch + 2];
      out[o + 3] = ch === 4 ? cur[x * ch + 3] : 255;
    }
    prev.set(cur);
  }
  return { w, h, px: out };
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(kind, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(kind, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encode(w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const [fa, fb, fd] = process.argv.slice(2);
let A, B;
try {
  if (readFileSync(fa).equals(readFileSync(fb))) {
    console.log(`identical bytes  ${fa} ${fb}`);
    process.exit(0);
  }
  A = decode(fa);
  B = decode(fb);
} catch (e) {
  console.log(`error: ${e.message}`);
  process.exit(2);
}
if (A.w !== B.w || A.h !== B.h) {
  console.log(`size differs: ${A.w}x${A.h} vs ${B.w}x${B.h}`);
  process.exit(1);
}
let max = 0, n = 0, n2 = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
const rgb = fd ? new Uint8Array(A.w * A.h * 3) : null;
for (let i = 0, p = 0; i < A.px.length; i += 4, p++) {
  const d = Math.max(Math.abs(A.px[i] - B.px[i]), Math.abs(A.px[i + 1] - B.px[i + 1]), Math.abs(A.px[i + 2] - B.px[i + 2]), Math.abs(A.px[i + 3] - B.px[i + 3]));
  if (rgb) {
    const g = (A.px[i] + A.px[i + 1] + A.px[i + 2]) / 9;
    rgb[p * 3] = d ? Math.min(255, 64 + d * 8) : g;
    rgb[p * 3 + 1] = d ? 0 : g;
    rgb[p * 3 + 2] = d ? 0 : g;
  }
  if (!d) continue;
  n++;
  if (d > 2) n2++;
  if (d > max) max = d;
  const x = p % A.w, y = (p / A.w) | 0;
  if (x < x0) x0 = x;
  if (x > x1) x1 = x;
  if (y < y0) y0 = y;
  if (y > y1) y1 = y;
}
if (rgb) writeFileSync(fd, encode(A.w, A.h, rgb));
console.log(n === 0 ? `identical pixels  ${fa} ${fb}` : `max ${max}  differing ${n} px (${((100 * n) / (A.w * A.h)).toFixed(3)} %), >2: ${n2} px  box x ${x0}-${x1} y ${y0}-${y1}`);
process.exit(max <= 2 ? 0 : 1);
