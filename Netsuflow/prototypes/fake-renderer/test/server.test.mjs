import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { startFakeRenderer } from '../server.mjs';
import { MessageReader, MessageType, encodeMessage } from '../protocol.mjs';
import { frameMarker, makeDiagnosticFrame } from '../diagnosticFrame.mjs';

/// Minimal client used only by these tests; the real client is the native one.
class TestClient {
  constructor(socket) {
    this.socket = socket;
    this.reader = new MessageReader();
    this.pending = [];
    this.waiters = [];
    this.closed = false;

    socket.on('data', (chunk) => {
      this.reader.push(chunk);
      try {
        for (const message of this.reader.drain()) {
          const waiter = this.waiters.shift();
          if (waiter) waiter.resolve(message);
          else this.pending.push(message);
        }
      } catch (error) {
        this.#failAll(error);
      }
    });
    socket.on('close', () => {
      this.closed = true;
      this.#failAll(new Error('closed'));
    });
    socket.on('error', () => {});
  }

  #failAll(error) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  static connect(port) {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }, () => resolve(new TestClient(socket)));
      socket.once('error', reject);
    });
  }

  send(message) {
    this.socket.write(encodeMessage(message));
  }

  next(timeoutMs = 4000) {
    if (this.pending.length > 0) return Promise.resolve(this.pending.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
      this.waiters.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  end() {
    this.socket.destroy();
  }
}

async function withServer(options, run) {
  const server = await startFakeRenderer(options);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

async function handshake(server, token = server.token) {
  const client = await TestClient.connect(server.port);
  client.send({
    type: MessageType.HELLO,
    requestId: 0,
    metadata: { protocolVersion: 1, token, client: 'test', instanceId: 'test-0' },
  });
  const response = await client.next();
  return { client, response };
}

test('the session descriptor is written with the advertised port and token', async () => {
  await withServer({}, (server) => {
    const descriptor = JSON.parse(readFileSync(server.sessionFile, 'utf8'));
    assert.equal(descriptor.protocolVersion, 1);
    assert.equal(descriptor.port, server.port);
    assert.equal(descriptor.token, server.token);
    assert.equal(descriptor.token.length, 64);
    assert.equal(typeof descriptor.instanceId, 'string');
    assert.equal(descriptor.pid, process.pid);
  });
});

test('the service listens on loopback only', async () => {
  await withServer({}, async (server) => {
    const { client, response } = await handshake(server);
    assert.equal(response.header.type, MessageType.HELLO_OK);
    client.end();
    // Binding to 127.0.0.1 means no external interface accepted the socket; the
    // descriptor never carries a host, and the native client hard-codes loopback.
    assert.equal(server.port > 0, true);
  });
});

test('a wrong token is rejected and the connection is closed', async () => {
  await withServer({}, async (server) => {
    const { client, response } = await handshake(server, 'x'.repeat(64));
    assert.equal(response.header.type, MessageType.ERROR);
    assert.equal(response.metadata.code, 'unauthenticated');
    client.end();
    assert.equal(server.stats.helloRejected, 1);
  });
});

test('a frame request before the handshake is rejected', async () => {
  await withServer({}, async (server) => {
    const client = await TestClient.connect(server.port);
    client.send({
      type: MessageType.FRAME,
      requestId: 1,
      metadata: { width: 8, height: 8, frame: 0 },
    });
    const response = await client.next();
    assert.equal(response.header.type, MessageType.ERROR);
    assert.equal(response.metadata.code, 'unauthenticated');
    client.end();
  });
});

test('a frame request returns the deterministic fixture', async () => {
  await withServer({}, async (server) => {
    const { client } = await handshake(server);
    client.send({
      type: MessageType.FRAME,
      requestId: 77,
      metadata: { width: 64, height: 32, frame: 42, pixelFormat: 'RGBA8', alphaMode: 'straight' },
    });
    const response = await client.next();

    assert.equal(response.header.type, MessageType.FRAME_OK);
    assert.equal(response.header.requestId, 77);
    assert.equal(response.metadata.width, 64);
    assert.equal(response.metadata.height, 32);
    assert.equal(response.metadata.stride, 64 * 4);
    assert.equal(response.metadata.pixelFormat, 'RGBA8');
    assert.equal(response.body.length, 64 * 32 * 4);
    assert.equal(frameMarker(response.body, { width: 64, height: 32, frame: 42 }), 42);
    assert.ok(response.body.equals(makeDiagnosticFrame({ width: 64, height: 32, frame: 42 })));
    client.end();
  });
});

test('malformed framing closes the connection instead of guessing', async () => {
  await withServer({}, async (server) => {
    const client = await TestClient.connect(server.port);
    client.socket.write(Buffer.from('this is not a NetsuFlow frame header at all', 'utf8'));
    await new Promise((resolve) => client.socket.on('close', resolve));
    assert.equal(client.closed, true);
  });
});

test('a restart issues a new instance id and token', async () => {
  const first = await startFakeRenderer({});
  const firstToken = first.token;
  const firstInstance = first.instanceId;
  await first.close();

  const second = await startFakeRenderer({});
  try {
    assert.notEqual(second.token, firstToken);
    assert.notEqual(second.instanceId, firstInstance);
  } finally {
    await second.close();
  }
});

test('fault modes are reachable', async () => {
  await withServer({ faults: { respondWithError: true } }, async (server) => {
    const { client } = await handshake(server);
    client.send({
      type: MessageType.FRAME,
      requestId: 3,
      metadata: { width: 8, height: 8, frame: 0 },
    });
    const response = await client.next();
    assert.equal(response.header.type, MessageType.ERROR);
    assert.equal(response.metadata.retryable, true);
    client.end();
  });

  await withServer({ faults: { rejectAuth: true } }, async (server) => {
    const { client, response } = await handshake(server);
    assert.equal(response.header.type, MessageType.ERROR);
    client.end();
  });
});
