import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HEADER_SIZE,
  HeaderStatus,
  MAGIC,
  MAX_BODY_LENGTH,
  MAX_METADATA_LENGTH,
  MessageReader,
  MessageType,
  MetadataStatus,
  VERSION,
  bytesPerPixel,
  decodeFrameMetadata,
  decodeHeader,
  encodeHeader,
  encodeMessage,
} from '../protocol.mjs';

test('header round trips', () => {
  const encoded = encodeHeader({
    type: MessageType.FRAME_OK,
    flags: 0xdeadbeef,
    requestId: 0x01020304,
    metadataLength: 1234,
    bodyLength: 987654,
  });
  assert.equal(encoded.length, HEADER_SIZE);

  const { status, header } = decodeHeader(encoded);
  assert.equal(status, HeaderStatus.OK);
  assert.equal(header.magic, MAGIC);
  assert.equal(header.version, VERSION);
  assert.equal(header.type, MessageType.FRAME_OK);
  assert.equal(header.flags, 0xdeadbeef);
  assert.equal(header.requestId, 0x01020304);
  assert.equal(header.metadataLength, 1234);
  assert.equal(header.bodyLength, 987654);
});

test('magic is the ASCII tag in network byte order', () => {
  const encoded = encodeHeader({ type: MessageType.PING });
  assert.equal(encoded.subarray(0, 4).toString('ascii'), 'NFX1');
});

test('truncated headers are refused', () => {
  const encoded = encodeHeader({ type: MessageType.PING });
  for (let size = 0; size < HEADER_SIZE; size += 1) {
    assert.equal(decodeHeader(encoded.subarray(0, size)).status, HeaderStatus.TRUNCATED);
  }
  assert.equal(decodeHeader(null).status, HeaderStatus.TRUNCATED);
});

test('bad magic, version and message type are refused', () => {
  const badMagic = encodeHeader({ type: MessageType.PING, magic: 0xdeadbeef });
  assert.equal(decodeHeader(badMagic).status, HeaderStatus.BAD_MAGIC);

  const badVersion = encodeHeader({ type: MessageType.PING, version: VERSION + 1 });
  assert.equal(decodeHeader(badVersion).status, HeaderStatus.UNSUPPORTED_VERSION);

  for (const type of [0, 12, 4242, 65535]) {
    assert.equal(decodeHeader(encodeHeader({ type })).status, HeaderStatus.UNKNOWN_TYPE);
  }
});

test('lengths above the maximum are refused', () => {
  const bigMetadata = encodeHeader({
    type: MessageType.FRAME_OK,
    metadataLength: MAX_METADATA_LENGTH + 1,
  });
  assert.equal(decodeHeader(bigMetadata).status, HeaderStatus.METADATA_TOO_LARGE);

  const bigBody = encodeHeader({ type: MessageType.FRAME_OK, bodyLength: MAX_BODY_LENGTH + 1 });
  assert.equal(decodeHeader(bigBody).status, HeaderStatus.BODY_TOO_LARGE);
});

test('bytes per pixel matches the native table', () => {
  assert.equal(bytesPerPixel('RGBA8'), 4);
  assert.equal(bytesPerPixel('RGBA32F'), 16);
  assert.equal(bytesPerPixel('BGRA8'), 0);
  assert.equal(bytesPerPixel(''), 0);
});

test('frame metadata validation mirrors the native rules', () => {
  const valid = JSON.stringify({
    width: 1920,
    height: 1080,
    stride: 1920 * 4,
    frame: 24,
    pixelFormat: 'RGBA8',
    alphaMode: 'straight',
  });
  assert.equal(decodeFrameMetadata(valid, 1920 * 4 * 1080).status, MetadataStatus.OK);
  assert.equal(
    decodeFrameMetadata(valid, 1920 * 4 * 1080 - 1).status,
    MetadataStatus.BODY_LENGTH_MISMATCH,
  );

  const shortStride = JSON.stringify({
    width: 100,
    height: 10,
    stride: 399,
    frame: 0,
    pixelFormat: 'RGBA8',
    alphaMode: 'straight',
  });
  assert.equal(decodeFrameMetadata(shortStride, 3990).status, MetadataStatus.STRIDE_TOO_SMALL);

  const badFormat = JSON.stringify({
    width: 4,
    height: 4,
    stride: 16,
    frame: 0,
    pixelFormat: 'BGRA8',
    alphaMode: 'straight',
  });
  assert.equal(
    decodeFrameMetadata(badFormat, 64).status,
    MetadataStatus.UNSUPPORTED_PIXEL_FORMAT,
  );

  const badAlpha = JSON.stringify({
    width: 4,
    height: 4,
    stride: 16,
    frame: 0,
    pixelFormat: 'RGBA8',
    alphaMode: 'associated',
  });
  assert.equal(decodeFrameMetadata(badAlpha, 64).status, MetadataStatus.UNSUPPORTED_ALPHA_MODE);

  for (const document of ['', '{', '[]', 'null', '{"width":4}']) {
    assert.notEqual(decodeFrameMetadata(document, 64).status, MetadataStatus.OK);
  }
});

test('reader assembles messages split across chunks', () => {
  const message = encodeMessage({
    type: MessageType.FRAME_OK,
    requestId: 9,
    metadata: { width: 2, height: 2, stride: 8, frame: 3, pixelFormat: 'RGBA8', alphaMode: 'straight' },
    body: Buffer.alloc(16, 7),
  });

  const reader = new MessageReader();
  const collected = [];
  for (let i = 0; i < message.length; i += 3) {
    reader.push(Buffer.from(message.subarray(i, Math.min(i + 3, message.length))));
    collected.push(...reader.drain());
  }

  assert.equal(collected.length, 1);
  assert.equal(collected[0].header.requestId, 9);
  assert.equal(collected[0].metadata.width, 2);
  assert.equal(collected[0].body.length, 16);
  assert.equal(collected[0].body[0], 7);
});

test('reader yields several concatenated messages', () => {
  const first = encodeMessage({ type: MessageType.PING, requestId: 1 });
  const second = encodeMessage({ type: MessageType.PONG, requestId: 2 });
  const reader = new MessageReader();
  reader.push(Buffer.concat([first, second]));
  const messages = [...reader.drain()];
  assert.equal(messages.length, 2);
  assert.equal(messages[0].header.type, MessageType.PING);
  assert.equal(messages[1].header.type, MessageType.PONG);
});

test('reader throws on a protocol violation instead of guessing', () => {
  const reader = new MessageReader();
  reader.push(encodeHeader({ type: MessageType.PING, magic: 0x11223344 }));
  assert.throws(() => [...reader.drain()], /protocol violation/);
});
