// Generates the fixture's local image asset.
//
// Hand-rolled so the bytes are reproducible from this source alone: an image
// pulled off the internet or produced by a graphics tool would make "the
// reference frames changed" ambiguous between our fixture and the toolchain.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = 64;
const H = 64;

// A pattern with hard edges, an exact mid-grey, and a transparent quadrant, so
// scaling, colour handling, and alpha are all visible in one asset.
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y += 1) {
  const rowStart = y * (1 + W * 4);
  raw[rowStart] = 0; // filter type: None, so the bytes stay inspectable
  for (let x = 0; x < W; x += 1) {
    const o = rowStart + 1 + x * 4;
    const left = x < W / 2;
    const top = y < H / 2;
    if (top && left) {
      raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 0; raw[o + 3] = 255;
    } else if (top && !left) {
      raw[o] = 0; raw[o + 1] = 255; raw[o + 2] = 0; raw[o + 3] = 255;
    } else if (!top && left) {
      raw[o] = 128; raw[o + 1] = 128; raw[o + 2] = 128; raw[o + 3] = 255;
    } else {
      raw[o] = 0; raw[o + 1] = 0; raw[o + 2] = 255; raw[o + 3] = 0; // transparent
    }
  }
}

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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = process.argv[2];
writeFileSync(out, png);
process.stdout.write(`${out}  ${png.length} bytes  ${W}x${H} RGBA8\n`);
