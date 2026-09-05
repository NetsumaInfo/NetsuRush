// The guard in front of the engine's PNG decoder.
//
// `decodePng` is a good decoder for input we produced and a poor validator for
// input we must distrust: it calls `inflateSync` with no `maxOutputLength`,
// allocates from IHDR dimensions it never range-checks, and does not verify
// chunk CRCs. Nothing here is a defect in its intended use. It does mean the
// bounds have to live in front of it, and these tests are what say they do.
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import test from 'node:test';

import { PixelError, decodePngToRgba, DEFAULT_PIXEL_LIMITS } from '../pixel/pngToRgba.mjs';

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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/// Builds a PNG with whatever header we ask for, so the guard can be tested
/// against declarations no real encoder would produce.
function makePng({
  width = 4,
  height = 4,
  bitDepth = 8,
  colorType = 6,
  interlace = 0,
  pixels = null,
  idat = null,
} = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;

  let body = idat;
  if (!body) {
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
    const stride = width * channels * (bitDepth / 8);
    const raw = Buffer.alloc(height * (1 + stride));
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * (1 + stride);
      raw[rowStart] = 0;
      for (let x = 0; x < stride; x += 1) {
        raw[rowStart + 1 + x] = pixels ? pixels[y * stride + x] : (x + y) & 0xff;
      }
    }
    body = deflateSync(raw);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', body),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('it decodes a well-formed RGBA image', () => {
  const pixels = Buffer.alloc(2 * 2 * 4);
  pixels.set([255, 0, 0, 255], 0);
  pixels.set([0, 255, 0, 128], 4);
  pixels.set([0, 0, 255, 0], 8);
  pixels.set([16, 32, 48, 255], 12);

  const result = decodePngToRgba(makePng({ width: 2, height: 2, pixels }), {
    expectedWidth: 2,
    expectedHeight: 2,
  });

  assert.equal(result.width, 2);
  assert.equal(result.height, 2);
  assert.equal(result.stride, 8);
  assert.equal(result.pixels.length, 16);
  assert.deepEqual([...result.pixels.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...result.pixels.subarray(4, 8)], [0, 255, 0, 128]);
});

test('an RGB image gains an opaque alpha channel', () => {
  const result = decodePngToRgba(makePng({ width: 2, height: 1, colorType: 2 }));
  assert.equal(result.pixels.length, 8);
  assert.equal(result.pixels[3], 255);
  assert.equal(result.pixels[7], 255);
});

function refuses(code, buffer, options) {
  assert.throws(
    () => decodePngToRgba(buffer, options),
    (error) => {
      assert.ok(error instanceof PixelError, `expected a PixelError, got ${error}`);
      assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
      return true;
    },
  );
}

test('it refuses anything that is not a PNG', () => {
  refuses('PIXEL_NOT_PNG', Buffer.from('not a png at all, really'));
  refuses('PIXEL_NOT_PNG', Buffer.alloc(4));
  refuses('PIXEL_INVALID_INPUT', 'a string');
  refuses('PIXEL_INVALID_INPUT', null);
});

test('it refuses an oversized encoded buffer before decoding it', () => {
  // The point is the order: the limit is applied to the encoded bytes, so a
  // compression bomb never reaches inflate.
  const png = makePng({ width: 4, height: 4 });
  refuses('PIXEL_ENCODED_TOO_LARGE', png, { maxEncodedBytes: png.length - 1 });
});

test('it refuses dimensions outside the supported range', () => {
  // decodePng would call Buffer.allocUnsafe(height * stride) on these.
  refuses('PIXEL_DIMENSIONS', makePng({ width: 0, height: 4 }));
  refuses('PIXEL_DIMENSIONS', makePng({ width: 4, height: 0 }));
  refuses('PIXEL_DIMENSIONS', makePng({ width: 20000, height: 4 }));
  refuses('PIXEL_DIMENSIONS', makePng({ width: 4, height: 20000 }));
});

test('it refuses a declared pixel count that would exhaust memory', () => {
  // 16384 x 16384 RGBA is 1 GiB. Each dimension is individually legal, so only
  // the area check catches it, and it has to happen before any allocation.
  refuses('PIXEL_TOO_MANY_PIXELS', makePng({ width: 16384, height: 16384, idat: deflateSync(Buffer.alloc(16)) }));
});

test('it refuses a size the caller did not ask for', () => {
  // A service returning a different frame size than requested is either broken
  // or hostile; either way its pixels must not reach the output buffer.
  refuses('PIXEL_SIZE_MISMATCH', makePng({ width: 4, height: 4 }), {
    expectedWidth: 8,
    expectedHeight: 4,
  });
});

test('it refuses formats the decoder does not actually support', () => {
  refuses('PIXEL_UNSUPPORTED_FORMAT', makePng({ colorType: 3 })); // palette
  refuses('PIXEL_UNSUPPORTED_FORMAT', makePng({ colorType: 0 })); // grayscale
  refuses('PIXEL_UNSUPPORTED_FORMAT', makePng({ colorType: 4 })); // grayscale + alpha
  refuses('PIXEL_UNSUPPORTED_FORMAT', makePng({ bitDepth: 16 }));
  refuses('PIXEL_UNSUPPORTED_FORMAT', makePng({ interlace: 1 }));
});

test('it refuses a truncated or corrupt payload instead of returning blank pixels', () => {
  // decodePng fills missing bytes with 0, so a truncated IDAT silently becomes
  // a black image. Returning that as a frame would be worse than failing.
  const png = makePng({ width: 8, height: 8 });
  // Cut into the image data. The decoder itself detects this one, which is a
  // clean refusal and the honest code for it: the decode did fail.
  refuses('PIXEL_DECODE_FAILED', png.subarray(0, Math.floor(png.length / 2)));
  // A stream whose IDAT still inflates but which never reaches IEND gets past
  // the decoder, so the guard is what catches it.
  refuses('PIXEL_TRUNCATED', png.subarray(0, png.length - 12));
  refuses('PIXEL_DECODE_FAILED', Buffer.concat([
    png.subarray(0, 40),
    Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    png.subarray(44),
  ]));
});

test('it refuses a header with no IHDR', () => {
  const png = makePng();
  const broken = Buffer.from(png);
  broken.write('IHDX', 12, 'ascii');
  refuses('PIXEL_DECODE_FAILED', broken);
});

test('the defaults are the ones the bridge already enforces', () => {
  // The protocol caps a frame dimension at 16384; the decoder must not accept
  // what the wire would refuse.
  assert.equal(DEFAULT_PIXEL_LIMITS.maxDimension, 16384);
  assert.ok(DEFAULT_PIXEL_LIMITS.maxPixels <= 4096 * 4096);
  assert.ok(DEFAULT_PIXEL_LIMITS.maxEncodedBytes <= 256 * 1024 * 1024);
});

test('a decoded frame reports a tightly packed stride', () => {
  const result = decodePngToRgba(makePng({ width: 7, height: 3 }));
  assert.equal(result.stride, 7 * 4);
  assert.equal(result.pixels.length, 7 * 3 * 4);
});

test('a complete zlib stream declaring more rows than it carries is refused', () => {
  // The case that justifies the expensive half of the guard, and the reason it
  // must not be traded away for the 107 ms it costs at 4K.
  //
  // This PNG is not truncated: its deflate stream is valid and terminates
  // cleanly, so `inflateSync` succeeds and the decoder is happy. It simply
  // declares 64 rows and carries 8. Measured against the pinned engine, the
  // decoder returns a full-size image whose remaining 56 rows are
  // **uninitialized memory** — it allocates with `Buffer.allocUnsafe` and never
  // writes the rows the stream did not describe. Not zeroes: observed leaking a
  // recognizable byte pattern from a previously freed buffer.
  //
  // So without this check the pixel path would hand a Resolve render, and
  // whoever sees that render, 87% of a frame made of whatever was in that
  // memory. The re-inflate is the only thing that catches it: the deflate
  // stream is well-formed, IEND is present, and the decoded length matches
  // exactly what the header asked for.
  const rows = 8;
  const width = 64;
  const height = 64;
  const stride = width * 4;
  const short = Buffer.alloc(rows * (1 + stride));
  refuses('PIXEL_TRUNCATED', makePng({ width, height, idat: deflateSync(short) }));
});

test('pixels arrive as a Buffer, over the decoder`s own memory', () => {
  // The engine returns a bare Uint8Array, so every consumer that wants a Buffer
  // would call `Buffer.from(pixels)` and copy the whole frame — 8.3 MiB at
  // 1080p, on the per-frame path. Normalizing once, as a view, removes that.
  const result = decodePngToRgba(makePng({ width: 8, height: 4 }));
  assert.ok(Buffer.isBuffer(result.pixels));
  // A view, not a copy: writing through it reaches the same bytes.
  assert.equal(result.pixels.byteLength, result.pixels.buffer.byteLength - result.pixels.byteOffset);
});
