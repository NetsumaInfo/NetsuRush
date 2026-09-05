// Independent confirmation that the decode is right, not just consistent.
//
// Everything else in this suite checks the guard in front of the engine's
// `decodePng`. None of it can catch the engine's decoder being wrong, because
// the expected pixels come from the same place as the actual ones. So a second,
// unrelated implementation decodes the same bytes and the two must agree.
//
// pngjs (MIT, zero dependencies, pinned exactly) shares no code with the
// engine: different filter reconstruction, different inflate call, different
// authors. Where the risk actually lives is the per-row filters — None, Sub,
// Up, Average and Paeth are five separate reconstruction paths, four of them
// referring to already-reconstructed neighbours, and Chrome's encoder picks
// them per row. A decoder can be perfect on filter 0 and wrong on filter 4.
//
// This runs on fixtures only. pngjs is never on the hot path: the live decode
// stays the engine's, which is what the capture path was measured with.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import test from 'node:test';

import { PNG } from 'pngjs';

import { decodePngToRgba } from '../pixel/pngToRgba.mjs';

const here = dirname(fileURLToPath(import.meta.url));

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

/// Deterministic pseudo-random content. Real image data, not a flat fill:
/// a constant image reconstructs identically under every filter, so it would
/// prove nothing about the filters.
function contentByte(x, y, channel) {
  let h = (x * 73856093) ^ (y * 19349663) ^ (channel * 83492791);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return (h ^ (h >>> 15)) & 0xff;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/// Encodes a PNG applying `filterFor(row)` to each row, so every reconstruction
/// path in a decoder gets exercised on the same source image.
function encodePng({ width, height, channels, filterFor }) {
  const bpp = channels;
  const stride = width * channels;

  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < channels; c += 1) {
        row[x * channels + c] = contentByte(x, y, c);
      }
    }
    rows.push(row);
  }

  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const filter = filterFor(y);
    const current = rows[y];
    const previous = y > 0 ? rows[y - 1] : Buffer.alloc(stride);
    const out = raw.subarray(y * (1 + stride) + 1, (y + 1) * (1 + stride));
    raw[y * (1 + stride)] = filter;

    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? current[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;
      let value;
      switch (filter) {
        case 1: value = current[i] - left; break;
        case 2: value = current[i] - up; break;
        case 3: value = current[i] - ((left + up) >> 1); break;
        case 4: value = current[i] - paeth(left, up, upLeft); break;
        default: value = current[i];
      }
      out[i] = value & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/// pngjs always yields RGBA; RGB sources come back with alpha 255, which is
/// exactly what our decoder promises too.
function decodeWithPngjs(bytes) {
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, pixels: Buffer.from(png.data) };
}

function firstDifference(a, b) {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i += 1) {
    if (a[i] !== b[i]) {
      const pixel = Math.floor(i / 4);
      return `byte ${i} (pixel ${pixel}, channel ${i % 4}): ours ${a[i]}, pngjs ${b[i]}`;
    }
  }
  return `lengths differ: ours ${a.length}, pngjs ${b.length}`;
}

for (const channels of [4, 3]) {
  const label = channels === 4 ? 'RGBA' : 'RGB';

  test(`every PNG row filter decodes identically to pngjs (${label})`, () => {
    // One image per filter, so a failure names which reconstruction path is
    // wrong instead of just "the image differs".
    for (let filter = 0; filter <= 4; filter += 1) {
      const bytes = encodePng({ width: 61, height: 37, channels, filterFor: () => filter });
      const ours = decodePngToRgba(bytes);
      const theirs = decodeWithPngjs(bytes);

      assert.equal(ours.width, theirs.width, `filter ${filter} width`);
      assert.equal(ours.height, theirs.height, `filter ${filter} height`);
      assert.ok(
        ours.pixels.equals(theirs.pixels),
        `filter ${filter} (${label}): ${firstDifference(ours.pixels, theirs.pixels)}`,
      );
    }
  });

  test(`mixed per-row filters decode identically to pngjs (${label})`, () => {
    // What a real encoder produces: a different filter chosen per row, so each
    // row reconstructs against a neighbour built by a different path.
    const bytes = encodePng({
      width: 64,
      height: 64,
      channels,
      filterFor: (row) => (row * 7 + 3) % 5,
    });
    const ours = decodePngToRgba(bytes);
    const theirs = decodeWithPngjs(bytes);
    assert.ok(
      ours.pixels.equals(theirs.pixels),
      `${label}: ${firstDifference(ours.pixels, theirs.pixels)}`,
    );
  });
}

test('a 1-pixel image decodes identically to pngjs', () => {
  // The filters all reference neighbours that do not exist here, so every
  // decoder's edge handling is the only thing being compared.
  for (let filter = 0; filter <= 4; filter += 1) {
    const bytes = encodePng({ width: 1, height: 1, channels: 4, filterFor: () => filter });
    const ours = decodePngToRgba(bytes);
    const theirs = decodeWithPngjs(bytes);
    assert.ok(ours.pixels.equals(theirs.pixels), `filter ${filter}`);
  }
});

test('real captured frames decode identically to pngjs', (t) => {
  // The synthetic cases above choose their own filters. These are whatever
  // Chrome's encoder actually emitted, which is the input that matters.
  const referenceDir = join(here, '..', 'reference');
  if (!existsSync(referenceDir)) {
    t.skip('no reference captures present; run tools/reference-capture.mjs');
    return;
  }
  const files = readdirSync(referenceDir).filter((name) => name.endsWith('.png'));
  if (files.length === 0) {
    t.skip('no reference captures present; run tools/reference-capture.mjs');
    return;
  }

  for (const name of files) {
    const bytes = readFileSync(join(referenceDir, name));
    const ours = decodePngToRgba(bytes);
    const theirs = decodeWithPngjs(bytes);
    assert.equal(ours.width, theirs.width, name);
    assert.equal(ours.height, theirs.height, name);
    assert.ok(ours.pixels.equals(theirs.pixels), `${name}: ${firstDifference(ours.pixels, theirs.pixels)}`);
  }
});
