// Task 6 end to end: the real engine behind the real wire.
//
// Starts the bridge server in front of a real HyperFrames session on the
// diagnostic fixture — a composition that paints, per frame, exactly the pixels
// openfx/src/DiagnosticFrame.cpp computes. Then requests frames through the
// bridge protocol and compares the bytes against the JavaScript mirror of that
// generator, and finally runs the C++ BridgeClientHarness, which compares
// against the C++ generator. Two independent implementations of the expected
// image, on either side of the wire, agreeing byte for byte.
//
// Not part of `npm test`: it starts a real Chrome and, when built, a C++
// process.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  MessageReader,
  MessageType,
  encodeMessage,
} from '../../fake-renderer/protocol.mjs';
import { makeDiagnosticFrame } from '../../fake-renderer/diagnosticFrame.mjs';
import { HyperFramesEngine } from '../hyperframesEngine.mjs';
import { buildRuntimeManifest } from '../runtimeManifest.mjs';
import { startBridgeServer } from '../server.mjs';

const HERE = resolve(import.meta.dirname, '..');
const CHROME = join(
  HERE,
  '.browser',
  'chrome-headless-shell',
  'win64-152.0.7977.54',
  'chrome-headless-shell-win64',
  'chrome-headless-shell.exe',
);
const HARNESS = resolve(
  HERE, '..', '..', 'openfx', 'build', 'Release', 'BridgeClientHarness.exe',
);

const WIDTH = 320;
const HEIGHT = 180;

const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`ok    ${name}${detail ? `  ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
    console.log(`FAIL  ${name}  ${error?.message ?? error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function protocolClient(port) {
  const socket = connect({ host: '127.0.0.1', port });
  socket.setNoDelay(true);
  const reader = new MessageReader();
  const inbox = [];
  const waiters = [];
  socket.on('data', (chunk) => {
    reader.push(chunk);
    for (const message of reader.drain()) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else inbox.push(message);
    }
  });
  const fail = () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('connection closed'));
  };
  socket.on('close', fail);
  socket.on('error', fail);
  return {
    send: (message) => socket.write(encodeMessage(message)),
    next: () =>
      inbox.length > 0
        ? Promise.resolve(inbox.shift())
        : new Promise((resolvePromise, reject) => waiters.push({ resolve: resolvePromise, reject })),
    destroy: () => socket.destroy(),
  };
}

function frameRequest(frame, overrides = {}) {
  return {
    binding: 'harness',
    sourceRevision: 'rev-0',
    frame,
    width: WIDTH,
    height: HEIGHT,
    renderScalePpm: 1_000_000,
    pixelFormat: 'RGBA8',
    alphaMode: 'straight',
    quality: 'final',
    deadlineMs: 5000,
    ...overrides,
  };
}

const engine = new HyperFramesEngine({
  chromePath: CHROME,
  enginePackageVersion: buildRuntimeManifest().engine.resolvedVersion,
});

console.log('bridge end-to-end: real engine behind the bridge protocol\n');

const warmStarted = process.hrtime.bigint();
const server = await startBridgeServer({
  engine,
  bindings: {
    harness: {
      projectRoot: join(HERE, 'fixture-diagnostic'),
      compositionId: 'netsuflow-diagnostic',
      sourceRevision: 'rev-0',
      width: WIDTH,
      height: HEIGHT,
      fps: { num: 30, den: 1 },
    },
  },
});
await server.warm('harness');
const warmMs = Number(process.hrtime.bigint() - warmStarted) / 1e6;
console.log(`server on 127.0.0.1:${server.port}, session warm in ${Math.round(warmMs)} ms\n`);

let requestId = 0;
const client = protocolClient(server.port);
client.send({
  type: MessageType.HELLO,
  requestId: ++requestId,
  metadata: { token: server.token, client: 'bridge-e2e', instanceId: 'e2e' },
});
const helloOk = await client.next();
assert(helloOk.header.type === MessageType.HELLO_OK, 'HELLO was refused');

async function requestFrame(frame, overrides) {
  client.send({ type: MessageType.FRAME, requestId: ++requestId, metadata: frameRequest(frame, overrides) });
  return client.next();
}

await check('a known frame crosses the wire byte-identical to the C++ pattern mirror', async () => {
  const response = await requestFrame(7);
  assert(response.header.type === MessageType.FRAME_OK, `got ${response.header.type}: ${response.metadata?.detail ?? ''}`);
  assert(response.metadata.width === WIDTH && response.metadata.height === HEIGHT, 'wrong dimensions');
  assert(response.metadata.stride === WIDTH * 4, 'stride is not tight');
  const expected = makeDiagnosticFrame({ width: WIDTH, height: HEIGHT, frame: 7 });
  assert(response.body.equals(expected), 'pixels differ from the diagnostic generator');
  return `${response.body.length} bytes`;
});

await check('out-of-order and repeated frames stay byte-exact', async () => {
  const frames = [299, 0, 150, 7, 7, 42];
  for (const frame of frames) {
    const response = await requestFrame(frame);
    assert(response.header.type === MessageType.FRAME_OK, `frame ${frame} failed`);
    const expected = makeDiagnosticFrame({ width: WIDTH, height: HEIGHT, frame });
    assert(response.body.equals(expected), `frame ${frame} differs from the generator`);
  }
  return `${frames.length} requests`;
});

await check('a stale source revision is refused, not answered', async () => {
  const response = await requestFrame(0, { sourceRevision: 'rev-9' });
  assert(response.header.type === MessageType.ERROR, 'expected an error');
  assert(response.metadata.code === 'stale-revision', `got ${response.metadata.code}`);
  return response.metadata.code;
});

client.destroy();

// The C++ harness: the exact client the OpenFX plugin uses, comparing against
// the C++ DiagnosticFrame generator. This is the half of the proof no
// JavaScript test can provide.
if (existsSync(HARNESS)) {
  const runs = [
    ['frame', `${WIDTH}`, `${HEIGHT}`, '7'],
    ['repeat', `${WIDTH}`, `${HEIGHT}`, '7', '20'],
    ['sequence', `${WIDTH}`, `${HEIGHT}`, '30'],
    ['soak', `${WIDTH}`, `${HEIGHT}`, '40'],
    ['reconnect', `${WIDTH}`, `${HEIGHT}`, '3'],
    ['abort', `${WIDTH}`, `${HEIGHT}`, '5'],
    // 64x64 mismatches the 320x180 binding: the pass condition is an explicit
    // service error, which proves the refusal path through the C++ client too.
    ['expect-error', '64', '64', '0'],
  ];
  for (const args of runs) {
    await check(`C++ harness: ${args.join(' ')}`, async () => {
      // Asynchronous on purpose: the bridge server lives in THIS process, and a
      // synchronous spawn would block the event loop the server answers from —
      // the harness would then time out waiting for a HELLO_OK that can never
      // be sent. Measured, not hypothetical.
      let run;
      try {
        run = await promisify(execFile)(HARNESS, [server.sessionFile, ...args], {
          encoding: 'utf8',
          timeout: 120_000,
        });
      } catch (error) {
        const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().replace(/\s+/g, ' ');
        throw new Error(`exit ${error.code}: ${output}`);
      }
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().replace(/\s+/g, ' ');
      return output.length > 160 ? `${output.slice(0, 160)}…` : output;
    });
  }
} else {
  console.log(`skip  C++ harness (not built at ${HARNESS})`);
}

await server.close();

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length} checks, ${failed.length} failures  ${failed.length === 0 ? 'PASS' : 'FAIL'}`);
process.exit(failed.length === 0 ? 0 : 1);
