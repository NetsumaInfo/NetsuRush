// Minimal PNG encoder for straight RGBA8, used to hand a decoded frame to a
// browser. The pixel path itself never encodes — it decodes PNG to RGBA and
// keeps RGBA — so this exists only at the edge where a preview needs an
// <img> source.
//
// Filter type 0 on every row: the frames are wide and the encode sits on an
// interactive path, so the cost of trying five filters per row buys nothing a
// preview can see.

import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of typed) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, typed, trailer]);
}

/**
 * @param {Buffer} pixels  tightly packed straight RGBA8, width*height*4 bytes
 */
export function encodePng(pixels, width, height) {
  const stride = width * 4;
  if (pixels.length < stride * height) {
    throw new Error(`expected ${stride * height} bytes for ${width}x${height}, got ${pixels.length}`);
  }
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + stride)] = 0;
    pixels.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // colour type: RGBA
  header[10] = 0;  // deflate
  header[11] = 0;  // adaptive filtering
  header[12] = 0;  // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
