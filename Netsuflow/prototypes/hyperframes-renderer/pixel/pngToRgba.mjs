// Bounded PNG decode: everything the engine's decoder does not check.
//
// `decodePng` from @hyperframes/engine is used for the decode itself — it is
// zlib-only, needs no dependency, and targets exactly Chrome's screenshot
// output. What it does not do is defend against a buffer it should not trust:
// it inflates with no `maxOutputLength`, calls `Buffer.allocUnsafe(height *
// stride)` on IHDR dimensions nothing range-checked, does not verify chunk
// CRCs, and fills a truncated IDAT with zeroes rather than failing.
//
// So the header is parsed and range-checked here first, and the result is
// length-checked afterwards. A decoder for input we produced is not a validator
// for input we must distrust, and the two jobs stay separate.
import { inflateSync } from 'node:zlib';

import { decodePng } from '@hyperframes/engine';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const DEFAULT_PIXEL_LIMITS = Object.freeze({
  // Matches the bridge protocol's kMaxDimension: the decoder must not accept a
  // frame the wire would refuse to carry.
  maxDimension: 16384,
  // 4K RGBA is 33 MiB decoded. Beyond this a frame is not a preview of
  // anything, and the allocation is the attack.
  maxPixels: 4096 * 4096,
  maxEncodedBytes: 64 * 1024 * 1024,
});

export class PixelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PixelError';
    this.code = code;
    this.details = details;
  }
}

/// Reads IHDR without trusting anything after it. Returns the declared header
/// only; whether the rest of the file agrees is the decoder's problem, and
/// whether the numbers are sane is this module's.
function readHeader(buffer) {
  // Signature first, and on as few bytes as it needs. "This is not a PNG" is a
  // more useful answer than "this is too short" whenever both are true, and
  // ordering the checks the other way round reported the wrong one.
  if (buffer.length < PNG_SIGNATURE.length || buffer.subarray(0, 8).compare(PNG_SIGNATURE) !== 0) {
    throw new PixelError('PIXEL_NOT_PNG', 'buffer does not start with the PNG signature');
  }
  // signature(8) + length(4) + "IHDR"(4) + data(13)
  if (buffer.length < 29) {
    throw new PixelError('PIXEL_TRUNCATED', 'buffer is too short to contain a PNG header');
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new PixelError('PIXEL_DECODE_FAILED', 'first chunk is not IHDR');
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28],
  };
}

/**
 * Decodes a PNG to tightly packed straight-alpha RGBA8.
 *
 * `expectedWidth`/`expectedHeight`, when given, are enforced before the decode:
 * a service that returns a different size than the one requested is either
 * broken or hostile, and either way its pixels must not reach an output buffer
 * sized for something else.
 */
export function decodePngToRgba(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) && !ArrayBuffer.isView(buffer)) {
    throw new PixelError('PIXEL_INVALID_INPUT', 'expected a Buffer or typed array');
  }
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const limits = { ...DEFAULT_PIXEL_LIMITS, ...options };
  const { expectedWidth, expectedHeight } = options;

  // Before anything else, and specifically before inflate: a compression bomb
  // is only dangerous once it has been handed to zlib.
  if (bytes.length > limits.maxEncodedBytes) {
    throw new PixelError('PIXEL_ENCODED_TOO_LARGE', `encoded frame is ${bytes.length} bytes`, {
      limit: limits.maxEncodedBytes,
    });
  }

  const header = readHeader(bytes);

  if (
    !Number.isInteger(header.width) ||
    !Number.isInteger(header.height) ||
    header.width < 1 ||
    header.height < 1 ||
    header.width > limits.maxDimension ||
    header.height > limits.maxDimension
  ) {
    throw new PixelError('PIXEL_DIMENSIONS', `declared size ${header.width}x${header.height} is out of range`, {
      maxDimension: limits.maxDimension,
    });
  }

  // Each dimension can be individually legal while the product is not:
  // 16384 x 16384 RGBA is one gigabyte.
  if (header.width * header.height > limits.maxPixels) {
    throw new PixelError(
      'PIXEL_TOO_MANY_PIXELS',
      `declared ${header.width}x${header.height} exceeds the pixel budget`,
      { maxPixels: limits.maxPixels },
    );
  }

  if (expectedWidth !== undefined && expectedHeight !== undefined) {
    if (header.width !== expectedWidth || header.height !== expectedHeight) {
      throw new PixelError(
        'PIXEL_SIZE_MISMATCH',
        `expected ${expectedWidth}x${expectedHeight}, header declares ${header.width}x${header.height}`,
      );
    }
  }

  // Reject here rather than letting the decoder throw a message shaped for a
  // different caller. These are exactly the cases it cannot handle.
  if (header.bitDepth !== 8) {
    throw new PixelError('PIXEL_UNSUPPORTED_FORMAT', `bit depth ${header.bitDepth} is not supported`);
  }
  if (header.colorType !== 2 && header.colorType !== 6) {
    throw new PixelError('PIXEL_UNSUPPORTED_FORMAT', `colour type ${header.colorType} is not supported`);
  }
  if (header.interlace !== 0) {
    throw new PixelError('PIXEL_UNSUPPORTED_FORMAT', 'interlaced PNGs are not supported');
  }

  let decoded;
  try {
    decoded = decodePng(bytes);
  } catch (cause) {
    throw new PixelError('PIXEL_DECODE_FAILED', `decode failed: ${cause?.message ?? cause}`, { cause });
  }

  if (decoded.width !== header.width || decoded.height !== header.height) {
    throw new PixelError(
      'PIXEL_SIZE_MISMATCH',
      `decoder returned ${decoded.width}x${decoded.height} for a header declaring ${header.width}x${header.height}`,
    );
  }

  const expectedBytes = header.width * header.height * 4;
  if (decoded.data.length !== expectedBytes) {
    throw new PixelError('PIXEL_TRUNCATED', `decoded ${decoded.data.length} bytes, expected ${expectedBytes}`);
  }

  // The decoder pads a short IDAT with zeroes instead of failing, so a
  // truncated payload arrives here as a plausible, fully black image. Compare
  // against what the compressed stream could actually have produced.
  const declaredRowBytes = header.width * (header.colorType === 6 ? 4 : 3);
  const minimumIdat = header.height * (1 + declaredRowBytes);
  if (inflatedLengthIsShort(bytes, minimumIdat)) {
    throw new PixelError('PIXEL_TRUNCATED', 'compressed data is shorter than the declared image');
  }
  // A file that never reaches IEND was cut short somewhere, even if the IDAT it
  // does contain happens to inflate to a full image.
  if (!hasEndChunk(bytes)) {
    throw new PixelError('PIXEL_TRUNCATED', 'the stream has no IEND chunk');
  }

  return {
    width: decoded.width,
    height: decoded.height,
    stride: decoded.width * 4,
    pixelFormat: 'RGBA8',
    alphaMode: 'straight',
    // The engine returns a bare Uint8Array. Normalizing here, as a view over
    // the same memory, costs nothing and stops every consumer from paying for
    // its own `Buffer.from(...)` — which is a full-frame copy, 8.3 MiB at 1080p,
    // on a per-frame path.
    pixels: asBufferView(decoded.data),
  };
}

/// Wraps a typed array as a Buffer over the same bytes. No copy: `Buffer.from`
/// with a typed array argument would allocate and copy, `Buffer.from` with
/// (buffer, offset, length) does not.
function asBufferView(data) {
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/// True when the file's IDAT cannot possibly contain a full image.
///
/// Cheap and conservative: it re-inflates only to measure. A false negative is
/// acceptable here because the length check above already caught the common
/// case; a false positive would reject a valid frame, so the test is on the
/// inflated length alone.
function inflatedLengthIsShort(bytes, minimumIdat) {
  const idat = collectIdat(bytes);
  if (idat === null) return false;
  try {
    // Bounded, unlike the decoder's own call: a bomb cannot expand past the
    // largest image this module would accept anyway.
    const inflated = inflateSync(idat, { maxOutputLength: DEFAULT_PIXEL_LIMITS.maxPixels * 4 + 1024 });
    return inflated.length < minimumIdat;
  } catch {
    return true;
  }
}

/// Walks the chunk list looking for a complete IEND.
function hasEndChunk(bytes) {
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString('ascii', pos + 4, pos + 8);
    const next = pos + 8 + length + 4;
    if (next > bytes.length) return false;
    if (type === 'IEND') return true;
    pos = next;
  }
  return false;
}

/// Concatenates every IDAT chunk, or null if the structure is unreadable.
function collectIdat(bytes) {
  const parts = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) return parts.length > 0 ? Buffer.concat(parts) : null;
    if (type === 'IDAT') parts.push(bytes.subarray(dataStart, dataEnd));
    if (type === 'IEND') break;
    pos = dataEnd + 4;
  }
  return parts.length > 0 ? Buffer.concat(parts) : null;
}
