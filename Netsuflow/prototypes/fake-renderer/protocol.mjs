// JavaScript mirror of openfx/src/Protocol.hpp.
//
// Kept deliberately literal so a divergence between the two implementations
// shows up as a failing test rather than as a mysterious runtime mismatch.

export const MAGIC = 0x4e465831; // "NFX1"
export const VERSION = 1;
export const HEADER_SIZE = 24;
export const MAX_METADATA_LENGTH = 64 * 1024;
export const MAX_BODY_LENGTH = 256 * 1024 * 1024;
export const MAX_DIMENSION = 16384;

export const MessageType = {
  HELLO: 1,
  HELLO_OK: 2,
  DESCRIBE: 3,
  DESCRIBE_OK: 4,
  FRAME: 5,
  FRAME_OK: 6,
  CANCEL: 7,
  INVALIDATE: 8,
  PING: 9,
  PONG: 10,
  ERROR: 11,
};

const KNOWN_TYPES = new Set(Object.values(MessageType));

export function isKnownMessageType(type) {
  return KNOWN_TYPES.has(type);
}

export function bytesPerPixel(pixelFormat) {
  if (pixelFormat === 'RGBA8') return 4;
  if (pixelFormat === 'RGBA32F') return 16;
  return 0;
}

export function encodeHeader({
  magic = MAGIC,
  version = VERSION,
  type,
  flags = 0,
  requestId = 0,
  metadataLength = 0,
  bodyLength = 0,
}) {
  const header = Buffer.allocUnsafe(HEADER_SIZE);
  header.writeUInt32BE(magic >>> 0, 0);
  header.writeUInt16BE(version, 4);
  header.writeUInt16BE(type, 6);
  header.writeUInt32BE(flags >>> 0, 8);
  header.writeUInt32BE(requestId >>> 0, 12);
  header.writeUInt32BE(metadataLength >>> 0, 16);
  header.writeUInt32BE(bodyLength >>> 0, 20);
  return header;
}

export const HeaderStatus = {
  OK: 'Ok',
  TRUNCATED: 'Truncated',
  BAD_MAGIC: 'BadMagic',
  UNSUPPORTED_VERSION: 'UnsupportedVersion',
  UNKNOWN_TYPE: 'UnknownType',
  METADATA_TOO_LARGE: 'MetadataTooLarge',
  BODY_TOO_LARGE: 'BodyTooLarge',
};

export function decodeHeader(buffer) {
  if (!buffer || buffer.length < HEADER_SIZE) {
    return { status: HeaderStatus.TRUNCATED };
  }
  const header = {
    magic: buffer.readUInt32BE(0),
    version: buffer.readUInt16BE(4),
    type: buffer.readUInt16BE(6),
    flags: buffer.readUInt32BE(8),
    requestId: buffer.readUInt32BE(12),
    metadataLength: buffer.readUInt32BE(16),
    bodyLength: buffer.readUInt32BE(20),
  };
  if (header.magic !== MAGIC) return { status: HeaderStatus.BAD_MAGIC };
  if (header.version !== VERSION) return { status: HeaderStatus.UNSUPPORTED_VERSION };
  if (!isKnownMessageType(header.type)) return { status: HeaderStatus.UNKNOWN_TYPE };
  if (header.metadataLength > MAX_METADATA_LENGTH) {
    return { status: HeaderStatus.METADATA_TOO_LARGE };
  }
  if (header.bodyLength > MAX_BODY_LENGTH) return { status: HeaderStatus.BODY_TOO_LARGE };
  return { status: HeaderStatus.OK, header };
}

export function encodeMessage({ type, requestId = 0, flags = 0, metadata = null, body = null }) {
  const metadataBuffer =
    metadata === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(metadata), 'utf8');
  const bodyBuffer = body === null ? Buffer.alloc(0) : body;
  const header = encodeHeader({
    type,
    flags,
    requestId,
    metadataLength: metadataBuffer.length,
    bodyLength: bodyBuffer.length,
  });
  return Buffer.concat([header, metadataBuffer, bodyBuffer]);
}

export const MetadataStatus = {
  OK: 'Ok',
  MALFORMED: 'Malformed',
  MISSING_FIELD: 'MissingField',
  UNSUPPORTED_PIXEL_FORMAT: 'UnsupportedPixelFormat',
  UNSUPPORTED_ALPHA_MODE: 'UnsupportedAlphaMode',
  DIMENSION_OUT_OF_RANGE: 'DimensionOutOfRange',
  STRIDE_TOO_SMALL: 'StrideTooSmall',
  BODY_LENGTH_MISMATCH: 'BodyLengthMismatch',
};

/// Mirror of decodeFrameMetadata(), used to check the plugin's own requests and
/// to keep the two validators honest about the same rules.
export function decodeFrameMetadata(document, bodyLength) {
  let parsed;
  try {
    parsed = JSON.parse(document);
  } catch {
    return { status: MetadataStatus.MALFORMED };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: MetadataStatus.MALFORMED };
  }

  const { width, height, stride, frame, pixelFormat, alphaMode } = parsed;
  const integers = [width, height, stride, frame];
  if (
    integers.some((value) => !Number.isInteger(value) || value < 0) ||
    typeof pixelFormat !== 'string' ||
    typeof alphaMode !== 'string'
  ) {
    return { status: MetadataStatus.MISSING_FIELD };
  }

  const bpp = bytesPerPixel(pixelFormat);
  if (bpp === 0) return { status: MetadataStatus.UNSUPPORTED_PIXEL_FORMAT };
  if (alphaMode !== 'straight' && alphaMode !== 'premultiplied') {
    return { status: MetadataStatus.UNSUPPORTED_ALPHA_MODE };
  }
  if (width === 0 || height === 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    return { status: MetadataStatus.DIMENSION_OUT_OF_RANGE };
  }
  if (stride < width * bpp) return { status: MetadataStatus.STRIDE_TOO_SMALL };
  if (stride * height !== bodyLength) return { status: MetadataStatus.BODY_LENGTH_MISMATCH };

  return {
    status: MetadataStatus.OK,
    metadata: {
      width,
      height,
      stride,
      frame,
      pixelFormat,
      alphaMode,
      revision: typeof parsed.revision === 'string' ? parsed.revision : '',
    },
  };
}

/// Incremental framing reader. Returns complete messages as they arrive and
/// reports the first protocol violation instead of guessing.
///
/// Chunks are held in a list and copied exactly once, when a whole message is
/// available. The obvious implementation — concatenating each arriving chunk
/// onto an accumulator — is quadratic in the message size, because every chunk
/// recopies everything received so far. That is invisible on the small messages
/// the fake renderer's tests use and ruinous on a real frame: measured, a 4K
/// RGBA body (33 MiB, ~520 chunks) took **1,455 ms** to reassemble, against
/// 0.3 ms for the same cached frame through the C++ client. It looked like a
/// slow cache and was a slow reader.
export class MessageReader {
  constructor({ maxMetadataLength = MAX_METADATA_LENGTH, maxBodyLength = MAX_BODY_LENGTH } = {}) {
    this.chunks = [];
    this.length = 0;
    this.maxMetadataLength = maxMetadataLength;
    this.maxBodyLength = maxBodyLength;
  }

  push(chunk) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /// Makes the first `count` bytes readable from `this.chunks[0]`.
  ///
  /// Only ever used for the 24-byte header, so the coalescing here touches a
  /// handful of bytes rather than a frame.
  #coalesce(count) {
    while (this.chunks[0].length < count) {
      const merged = Buffer.concat([this.chunks[0], this.chunks[1]]);
      this.chunks.splice(0, 2, merged);
    }
  }

  /// Removes and returns exactly `count` bytes, as one contiguous buffer.
  #take(count) {
    const parts = [];
    let taken = 0;
    while (taken < count) {
      const head = this.chunks[0];
      const want = count - taken;
      if (head.length <= want) {
        parts.push(head);
        taken += head.length;
        this.chunks.shift();
      } else {
        parts.push(head.subarray(0, want));
        this.chunks[0] = head.subarray(want);
        taken = count;
      }
    }
    this.length -= count;
    // One allocation, one pass over the message.
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, count);
  }

  /// Yields { header, metadata, body } objects; throws on a protocol violation.
  *drain() {
    for (;;) {
      if (this.length < HEADER_SIZE) return;
      this.#coalesce(HEADER_SIZE);
      const { status, header } = decodeHeader(this.chunks[0]);
      if (status !== HeaderStatus.OK) throw new Error(`protocol violation: ${status}`);
      const total = HEADER_SIZE + header.metadataLength + header.bodyLength;
      if (this.length < total) return;

      const message = this.#take(total);
      const metadataBytes = message.subarray(HEADER_SIZE, HEADER_SIZE + header.metadataLength);
      const body = message.subarray(HEADER_SIZE + header.metadataLength, total);

      let metadata = null;
      if (metadataBytes.length > 0) {
        try {
          metadata = JSON.parse(metadataBytes.toString('utf8'));
        } catch {
          throw new Error('protocol violation: malformed metadata');
        }
      }
      // `body` is a view into `message`, which the caller now owns outright:
      // nothing else references it, so no copy is needed to keep it valid.
      yield { header, metadata, body };
    }
  }
}
