// Where the per-frame time actually goes on the pixel path.
//
// Two questions the plan leaves open. First, what validation and decode cost at
// 1080p and 4K — the guard walks chunks and re-inflates the IDAT to measure it,
// which is deliberate but not free, and its cost has to be known against the
// decode it protects. Second, whether that cost is worth worrying about at all
// next to the capture stage measured in H02 (avgScreenshotMs 67).
//
// Encoded fixtures come from real Chrome captures where they exist, because a
// synthetic PNG compresses differently and would flatter the inflate stage.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

import { decodePng } from '@hyperframes/engine';
import { PNG } from 'pngjs';

import { decodePngToRgba } from '../pixel/pngToRgba.mjs';

const HERE = resolve(import.meta.dirname, '..');
const SAMPLES = Number(process.env.NETSUFLOW_BENCH_SAMPLES ?? 30);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/// A PNG with photographic-ish noise, so it compresses like a real frame rather
/// than like a flat fill.
function synthesizePng(width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + stride);
    raw[rowStart] = y % 5;
    for (let x = 0; x < width; x += 1) {
      const i = rowStart + 1 + x * 4;
      let h = (x * 73856093) ^ (y * 19349663);
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
      raw[i] = (h >>> 3) & 0xff;
      raw[i + 1] = (h >>> 11) & 0xff;
      raw[i + 2] = (h >>> 19) & 0xff;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function realCapture() {
  const dir = join(HERE, 'reference');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => name.endsWith('.png'));
  return files.length > 0 ? readFileSync(join(dir, files[0])) : null;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { p50: at(0.5), p95: at(0.95), min: sorted[0], max: sorted[sorted.length - 1] };
}

function measure(label, fn) {
  // One untimed pass so JIT warm-up does not land in the first sample.
  fn();
  const samples = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { label, ...stats(samples) };
}

/// Isolates the guard's own work: everything decodePngToRgba does except the
/// decode itself. Mirrors the module's checks rather than importing them,
/// because they are deliberately not exported.
function guardOnly(bytes) {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes[25];
  // Chunk walk for IDAT and IEND.
  const parts = [];
  let pos = 8;
  let sawEnd = false;
  while (pos + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString('ascii', pos + 4, pos + 8);
    const dataEnd = pos + 8 + length;
    if (dataEnd + 4 > bytes.length) break;
    if (type === 'IDAT') parts.push(bytes.subarray(pos + 8, dataEnd));
    if (type === 'IEND') { sawEnd = true; break; }
    pos = dataEnd + 4;
  }
  // The re-inflate: the expensive half of the guard, and the one that catches a
  // truncated IDAT the decoder would have silently padded with zeroes.
  const inflated = inflateSync(Buffer.concat(parts), { maxOutputLength: 4096 * 4096 * 4 + 1024 });
  return inflated.length >= height * (1 + width * (colorType === 6 ? 4 : 3)) && sawEnd;
}

const cases = [];
const capture = realCapture();
if (capture) {
  cases.push({ name: '1080p real Chrome capture', bytes: capture });
} else {
  console.log('no reference captures found; using synthetic 1080p instead\n');
  cases.push({ name: '1080p synthetic', bytes: synthesizePng(1920, 1080) });
}
cases.push({ name: '4K synthetic', bytes: synthesizePng(3840, 2160) });

console.log(`pixel path benchmark, ${SAMPLES} samples per stage, Node ${process.version}\n`);

for (const testCase of cases) {
  const { bytes } = testCase;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const decodedMiB = ((width * height * 4) / (1024 * 1024)).toFixed(1);
  console.log(
    `${testCase.name}: ${width}x${height}, ${(bytes.length / 1024).toFixed(0)} KiB encoded, ${decodedMiB} MiB decoded`,
  );

  const rows = [
    measure('guard only (chunk walk + re-inflate)', () => guardOnly(bytes)),
    measure('engine decodePng only', () => decodePng(bytes)),
    measure('decodePngToRgba (guard + decode)', () => decodePngToRgba(bytes)),
    // Not on the hot path, and not proposed for it. Measured so the choice of
    // decoder is a decision with a number attached rather than a preference.
    measure('pngjs (reference only)', () => PNG.sync.read(bytes)),
  ];

  const width0 = Math.max(...rows.map((row) => row.label.length));
  for (const row of rows) {
    console.log(
      `  ${row.label.padEnd(width0)}  p50 ${row.p50.toFixed(2).padStart(8)} ms   p95 ${row.p95.toFixed(2).padStart(8)} ms`,
    );
  }
  console.log('');
}
