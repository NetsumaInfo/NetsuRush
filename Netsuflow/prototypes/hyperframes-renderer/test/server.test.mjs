// Protocol-level tests for the bridge server, with a deterministic stub engine.
//
// No browser here: `npm test` stays fast, and the wire behaviour under test —
// authentication, framing, validation order, error mapping, session reuse,
// serialization — is independent of which engine renders. The real engine
// behind the same server is exercised by tools/bridge-e2e.mjs and the C++
// harness, where the pixels themselves are the assertion.
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import test from 'node:test';

import {
  MessageReader,
  MessageType,
  encodeMessage,
} from '../../fake-renderer/protocol.mjs';
import { makeDiagnosticFrame } from '../../fake-renderer/diagnosticFrame.mjs';
import { startBridgeServer } from '../server.mjs';

const WIDTH = 32;
const HEIGHT = 16;

function stubBinding(overrides = {}) {
  return {
    projectRoot: 'C:\\unused\\stub',
    compositionId: 'stub',
    sourceRevision: 'rev-0',
    width: WIDTH,
    height: HEIGHT,
    fps: { num: 30, den: 1 },
    ...overrides,
  };
}

/// The common adapter contract, minimally: open -> session with renderFrame and
/// close. Frames are the same diagnostic pattern the C++ side generates, so the
/// happy-path test asserts real pixel equality without a browser.
function stubEngine({ failOpen = false, failFrame = null, journal = { opens: 0, closes: 0, frames: [] } } = {}) {
  return {
    journal,
    async open(binding) {
      journal.opens += 1;
      if (failOpen) {
        const error = new Error('stub open failure');
        error.code = 'SESSION_START_FAILED';
        error.retryable = true;
        throw error;
      }
      return {
        async renderFrame({ frame, deadlineMs }) {
          journal.frames.push({ frame, deadlineMs });
          if (failFrame) {
            const error = new Error(failFrame.message ?? 'stub frame failure');
            error.code = failFrame.code;
            error.retryable = failFrame.retryable === true;
            throw error;
          }
          return {
            width: binding.width,
            height: binding.height,
            stride: binding.width * 4,
            pixelFormat: 'RGBA8',
            alphaMode: 'straight',
            pixels: makeDiagnosticFrame({ width: binding.width, height: binding.height, frame }),
          };
        },
        async close() {
          journal.closes += 1;
        },
      };
    },
  };
}

/// Speaks the wire protocol like the C++ client: one socket, sequential
/// requests, framed reads. Returns every message received.
function protocolClient(port) {
  const socket = connect({ host: '127.0.0.1', port });
  socket.setNoDelay(true);
  const reader = new MessageReader();
  const inbox = [];
  const waiters = [];
  let ended = false;

  socket.on('data', (chunk) => {
    reader.push(chunk);
    for (const message of reader.drain()) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else inbox.push(message);
    }
  });
  const finish = () => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('connection closed'));
  };
  socket.on('close', finish);
  socket.on('error', finish);

  return {
    send(message) {
      socket.write(encodeMessage(message));
    },
    next() {
      if (inbox.length > 0) return Promise.resolve(inbox.shift());
      if (ended) return Promise.reject(new Error('connection closed'));
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    closed: new Promise((resolve) => socket.on('close', resolve)),
    destroy: () => socket.destroy(),
  };
}

async function hello(client, token, requestId = 1) {
  client.send({ type: MessageType.HELLO, requestId, metadata: { token, client: 'test', instanceId: 't' } });
  return client.next();
}

function frameRequest(overrides = {}) {
  return {
    binding: 'stub',
    sourceRevision: 'rev-0',
    frame: 0,
    width: WIDTH,
    height: HEIGHT,
    renderScalePpm: 1_000_000,
    pixelFormat: 'RGBA8',
    alphaMode: 'straight',
    quality: 'preview',
    deadlineMs: 5000,
    ...overrides,
  };
}

test('the server refuses to start without an engine or bindings', async () => {
  await assert.rejects(() => startBridgeServer({}), /engine with open/);
  await assert.rejects(
    () => startBridgeServer({ engine: stubEngine(), bindings: {} }),
    /at least one binding/,
  );
});

test('a frame crosses the wire byte-identical, with the fake renderer metadata shape', async () => {
  const engine = stubEngine();
  const server = await startBridgeServer({ engine, bindings: { stub: stubBinding() } });
  const client = protocolClient(server.port);
  try {
    const helloOk = await hello(client, server.token);
    assert.equal(helloOk.header.type, MessageType.HELLO_OK);
    assert.equal(helloOk.metadata.protocolVersion, 1);
    assert.equal(typeof helloOk.metadata.serviceInstance, 'string');

    client.send({ type: MessageType.FRAME, requestId: 7, metadata: frameRequest({ frame: 42 }) });
    const response = await client.next();
    assert.equal(response.header.type, MessageType.FRAME_OK);
    assert.equal(response.header.requestId, 7);
    // Exactly the fields the fake renderer sends, so the client cannot tell
    // which service answered.
    assert.deepEqual(Object.keys(response.metadata).sort(), [
      'alphaMode', 'frame', 'height', 'pixelFormat', 'revision', 'stride', 'width',
    ]);
    assert.equal(response.metadata.frame, 42);
    assert.equal(response.metadata.revision, 'rev-0');
    assert.equal(response.metadata.stride, WIDTH * 4);
    assert.deepEqual(response.body, makeDiagnosticFrame({ width: WIDTH, height: HEIGHT, frame: 42 }));
  } finally {
    client.destroy();
    await server.close();
  }
});

test('one binding is one session, reused across connections and requests', async () => {
  const engine = stubEngine();
  const server = await startBridgeServer({ engine, bindings: { stub: stubBinding() } });
  try {
    for (const frame of [0, 1, 2]) {
      const client = protocolClient(server.port);
      await hello(client, server.token);
      client.send({ type: MessageType.FRAME, requestId: frame, metadata: frameRequest({ frame }) });
      const response = await client.next();
      assert.equal(response.header.type, MessageType.FRAME_OK);
      client.destroy();
    }
    assert.equal(engine.journal.opens, 1);
    assert.deepEqual(engine.journal.frames.map((entry) => entry.frame), [0, 1, 2]);
  } finally {
    await server.close();
  }
  assert.equal(engine.journal.closes, 1);
});

test('the T01 case: 21 requests for one frame cost one render', async () => {
  // T01 measured Resolve issuing 21 render calls for a single frame, some 23 ms
  // apart. At the H02 capture rate that is 2.4 s of browser work for 117 ms of
  // result, and it is the reason the cache exists at all.
  const engine = stubEngine();
  const server = await startBridgeServer({ engine, bindings: { stub: stubBinding() } });
  const client = protocolClient(server.port);
  try {
    await hello(client, server.token);
    const bodies = [];
    for (let i = 0; i < 21; i += 1) {
      client.send({ type: MessageType.FRAME, requestId: i, metadata: frameRequest({ frame: 7 }) });
      const response = await client.next();
      assert.equal(response.header.type, MessageType.FRAME_OK, `request ${i}`);
      bodies.push(response.body);
    }

    assert.equal(engine.journal.frames.length, 1, '21 requests, one render');
    assert.equal(server.schedulerStats.cacheHits, 20);
    // Every answer is the correct frame, not merely a fast one.
    const expected = makeDiagnosticFrame({ width: WIDTH, height: HEIGHT, frame: 7 });
    for (const body of bodies) assert.deepEqual(body, expected);
  } finally {
    client.destroy();
    await server.close();
  }
});

test('invalidating a binding forces the next frame to be rendered again', async () => {
  const engine = stubEngine();
  const server = await startBridgeServer({ engine, bindings: { stub: stubBinding() } });
  const client = protocolClient(server.port);
  try {
    await hello(client, server.token);
    client.send({ type: MessageType.FRAME, requestId: 1, metadata: frameRequest({ frame: 3 }) });
    await client.next();
    assert.equal(engine.journal.frames.length, 1);

    const { dropped } = server.invalidate('stub');
    assert.equal(dropped, 1);

    client.send({ type: MessageType.FRAME, requestId: 2, metadata: frameRequest({ frame: 3 }) });
    const response = await client.next();
    assert.equal(response.header.type, MessageType.FRAME_OK);
    assert.equal(engine.journal.frames.length, 2, 'the cached frame must not survive invalidation');
  } finally {
    client.destroy();
    await server.close();
  }
});

test('two bindings on one composition do not share cached frames', async () => {
  // Same composition, same frame, different source revision. A cache keyed on
  // anything less than the full identity would serve the first binding's pixels
  // for the second, which is the failure the key exists to prevent.
  const engine = stubEngine();
  const server = await startBridgeServer({
    engine,
    bindings: {
      stub: stubBinding(),
      other: stubBinding({ sourceRevision: 'rev-9' }),
    },
  });
  const client = protocolClient(server.port);
  try {
    await hello(client, server.token);
    client.send({ type: MessageType.FRAME, requestId: 1, metadata: frameRequest({ frame: 4 }) });
    await client.next();
    client.send({
      type: MessageType.FRAME,
      requestId: 2,
      metadata: frameRequest({ binding: 'other', sourceRevision: 'rev-9', frame: 4 }),
    });
    const response = await client.next();
    assert.equal(response.header.type, MessageType.FRAME_OK);
    assert.equal(response.metadata.revision, 'rev-9');
    assert.equal(engine.journal.frames.length, 2);
    assert.equal(server.schedulerStats.cacheHits, 0);
  } finally {
    client.destroy();
    await server.close();
  }
});

test('the request deadline reaches the engine', async () => {
  const engine = stubEngine();
  const server = await startBridgeServer({ engine, bindings: { stub: stubBinding() } });
  const client = protocolClient(server.port);
  try {
    await hello(client, server.token);
    client.send({ type: MessageType.FRAME, requestId: 1, metadata: frameRequest({ deadlineMs: 1234 }) });
    await client.next();
    assert.equal(engine.journal.frames[0].deadlineMs, 1234);
  } finally {
    client.destroy();
    await server.close();
  }
});

test('a wrong token is refused and the connection ends', async () => {
  const server = await startBridgeServer({ engine: stubEngine(), bindings: { stub: stubBinding() } });
  const client = protocolClient(server.port);
  try {
    const response = await hello(client, 'not-the-token');
    assert.equal(response.header.type, MessageType.ERROR);
    assert.equal(response.metadata.code, 'unauthenticated');
    assert.equal(response.metadata.retryable, false);
    await client.closed;
    assert.equal(server.stats.helloRejected, 1);
  } finally {
    client.destroy();
    await server.close();
  }
});

test('a frame before HELLO is refused', async () => {
  const server = await startBridgeServer({ engine: stubEngine(), bindings: { stub: stubBinding() } });
  const client = protocolClient(server.port);
  try {
    client.send({ type: MessageType.FRAME, requestId: 5, metadata: frameRequest() });
    const response = await client.next();
    assert.equal(response.header.type, MessageType.ERROR);
    assert.equal(response.metadata.code, 'unauthenticated');
    await client.closed;
  } finally {
    client.destroy();
    await server.close();
  }
});

test('invalid requests are refused explicitly, before any engine work', async () => {
  const engine = stubEngine();
  const server = await startBridgeServer({ engine, bindings: { stub: stubBinding() } });
  const client = protocolClient(server.port);
  try {
    await hello(client, server.token);

    const cases = [
      [frameRequest({ binding: 'missing' }), 'unknown-binding'],
      [frameRequest({ pixelFormat: 'RGBA32F' }), 'unsupported'],
      [frameRequest({ alphaMode: 'premultiplied' }), 'unsupported'],
      [frameRequest({ renderScalePpm: 500_000 }), 'unsupported'],
      [frameRequest({ width: WIDTH + 8 }), 'bad-request'],
      [frameRequest({ sourceRevision: 'rev-9' }), 'stale-revision'],
    ];
    for (const [request, expectedCode] of cases) {
      client.send({ type: MessageType.FRAME, requestId: 9, metadata: request });
      const response = await client.next();
      assert.equal(response.header.type, MessageType.ERROR, expectedCode);
      assert.equal(response.metadata.code, expectedCode);
      assert.equal(response.metadata.retryable, false);
    }
    // None of those refusals may have touched the engine.
    assert.equal(engine.journal.opens, 0);
  } finally {
    client.destroy();
    await server.close();
  }
});

test('engine failures reach the wire as typed, retryable-aware errors', async () => {
  const engine = stubEngine({ failFrame: { code: 'FRAME_CAPTURE_FAILED', retryable: true, message: 'browser fell over' } });
  const server = await startBridgeServer({ engine, bindings: { stub: stubBinding() } });
  const client = protocolClient(server.port);
  try {
    await hello(client, server.token);
    client.send({ type: MessageType.FRAME, requestId: 3, metadata: frameRequest() });
    const response = await client.next();
    assert.equal(response.header.type, MessageType.ERROR);
    assert.equal(response.header.requestId, 3);
    assert.equal(response.metadata.code, 'render-failed');
    assert.equal(response.metadata.retryable, true);
    assert.match(response.metadata.detail, /FRAME_CAPTURE_FAILED/);
  } finally {
    client.destroy();
    await server.close();
  }
});

test('a failed session open is reported and the next request retries it', async () => {
  const journal = { opens: 0, closes: 0, frames: [] };
  let shouldFail = true;
  const inner = stubEngine({ journal });
  const engine = {
    journal,
    async open(binding) {
      if (shouldFail) {
        journal.opens += 1;
        const error = new Error('no browser today');
        error.code = 'SESSION_START_FAILED';
        error.retryable = true;
        throw error;
      }
      return inner.open(binding);
    },
  };
  const server = await startBridgeServer({ engine, bindings: { stub: stubBinding() } });
  const client = protocolClient(server.port);
  try {
    await hello(client, server.token);

    client.send({ type: MessageType.FRAME, requestId: 1, metadata: frameRequest() });
    const failure = await client.next();
    assert.equal(failure.header.type, MessageType.ERROR);
    assert.equal(failure.metadata.retryable, true);
    assert.match(failure.metadata.detail, /SESSION_START_FAILED/);

    shouldFail = false;
    client.send({ type: MessageType.FRAME, requestId: 2, metadata: frameRequest({ frame: 5 }) });
    const success = await client.next();
    assert.equal(success.header.type, MessageType.FRAME_OK);
    assert.equal(success.metadata.frame, 5);
  } finally {
    client.destroy();
    await server.close();
  }
});

test('the session descriptor matches the fake renderer contract and is removed on close', async () => {
  const server = await startBridgeServer({ engine: stubEngine(), bindings: { stub: stubBinding() } });
  const descriptor = JSON.parse(readFileSync(server.sessionFile, 'utf8'));
  assert.equal(descriptor.protocolVersion, 1);
  assert.equal(descriptor.port, server.port);
  assert.equal(descriptor.token, server.token);
  assert.equal(descriptor.pid, process.pid);
  await server.close();
  assert.equal(existsSync(dirname(server.sessionFile)), false);
});

test('unsupported message types get an explicit error, and PING answers PONG', async () => {
  const server = await startBridgeServer({ engine: stubEngine(), bindings: { stub: stubBinding() } });
  const client = protocolClient(server.port);
  try {
    await hello(client, server.token);

    client.send({ type: MessageType.PING, requestId: 11 });
    const pong = await client.next();
    assert.equal(pong.header.type, MessageType.PONG);
    assert.equal(pong.header.requestId, 11);

    client.send({ type: MessageType.INVALIDATE, requestId: 12 });
    const refusal = await client.next();
    assert.equal(refusal.header.type, MessageType.ERROR);
    assert.equal(refusal.metadata.code, 'unsupported');

    // DESCRIBE is supported since the Inspector grew composition variables:
    // an unknown binding is named, a known one answers DESCRIBE_OK.
    client.send({ type: MessageType.DESCRIBE, requestId: 13 });
    const unknown = await client.next();
    assert.equal(unknown.header.type, MessageType.ERROR);
    assert.equal(unknown.metadata.code, 'unknown-binding');

    client.send({ type: MessageType.DESCRIBE, requestId: 14, metadata: { binding: 'stub' } });
    const described = await client.next();
    assert.equal(described.header.type, MessageType.DESCRIBE_OK);
    assert.equal(described.metadata.binding, 'stub');
    assert.equal(typeof described.metadata.varCount, 'number');
  } finally {
    client.destroy();
    await server.close();
  }
});
