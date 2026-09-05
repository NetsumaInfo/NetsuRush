// Deterministic fake renderer for T03.
//
// It answers the bridge protocol with the same diagnostic frames the plugin can
// generate locally, and it can misbehave on demand: delays, truncation, wrong
// sizes, bad framing, authentication failure, abrupt disconnects. No Remotion,
// no browser, no npm dependencies beyond Node's own built-ins.
//
// It listens on 127.0.0.1 only, never on 0.0.0.0.

import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeDiagnosticFrame } from './diagnosticFrame.mjs';
import { HEADER_SIZE, MessageReader, MessageType, encodeHeader, encodeMessage } from './protocol.mjs';

const PROTOCOL_VERSION = 1;

/// Every fault the T03 matrix needs. All default to off.
export const DEFAULT_FAULTS = {
  rejectAuth: false,
  delayBeforeHeaderMs: 0,
  delayAfterHeaderMs: 0,
  disconnectAfterHeader: false,
  disconnectBeforeResponse: false,
  truncateBody: false,
  declareOversizedBody: false,
  wrongDimensions: false,
  wrongStride: false,
  wrongFrame: false,
  wrongRequestId: false,
  badMagic: false,
  badVersion: false,
  unknownType: false,
  malformedMetadata: false,
  respondWithError: false,
  neverRespond: false,
  // A revision long enough to exceed the client's revision cap but still a legal
  // JSON string: the frame must survive, with the field bounded.
  longRevision: false,
  // A revision beyond the client's per-string parse limit: the whole document is
  // illegal and the frame must be refused cleanly.
  absurdRevision: false,
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeSessionDescriptor(path, descriptor) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(descriptor), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function frameResponse(request, frame, faults) {
  const width = faults.wrongDimensions ? request.width + 1 : request.width;
  const height = request.height;
  const stride = faults.wrongStride ? request.width * 4 - 1 : request.width * 4;
  const metadata = {
    width,
    height,
    stride,
    frame: faults.wrongFrame ? request.frame + 1 : request.frame,
    pixelFormat: 'RGBA8',
    alphaMode: 'straight',
    // The revision field is advisory and unvalidated by the schema, which makes
    // it the natural place for a service to push an oversized string at the
    // client's allocator.
    revision: faults.absurdRevision
      ? 'r'.repeat(60000)
      : faults.longRevision
        ? 'r'.repeat(4096)
        : 'fake-0',
  };
  return { metadata, body: frame };
}

/**
 * Starts the fake renderer.
 *
 * @returns {Promise<{port:number, token:string, sessionFile:string, close:()=>Promise<void>,
 *                    stats:{connections:number, frames:number}}>}
 */
export async function startFakeRenderer(options = {}) {
  const faults = { ...DEFAULT_FAULTS, ...(options.faults ?? {}) };
  // Bounded frame cache. It exists so a cache hit can be measured separately
  // from frame generation, which is the distinction docs/10's latency targets
  // are drawn around. Insertion order eviction is enough for a fixture.
  const cacheSize = options.cacheSize ?? 8;
  const frameCache = new Map();
  const token = options.token ?? randomBytes(32).toString('hex');
  const instanceId = options.instanceId ?? randomBytes(8).toString('hex');
  const sessionFile =
    options.sessionFile ??
    join(tmpdir(), `netsuflow-fake-${process.pid}-${randomBytes(4).toString('hex')}`, 'session.json');

  const stats = { connections: 0, frames: 0, helloRejected: 0, cacheHits: 0, cacheMisses: 0 };
  const sockets = new Set();

  const cachedFrame = (width, height, frame) => {
    if (cacheSize <= 0) return makeDiagnosticFrame({ width, height, frame });
    const key = `${width}x${height}@${frame}`;
    const hit = frameCache.get(key);
    if (hit !== undefined) {
      stats.cacheHits += 1;
      return hit;
    }
    stats.cacheMisses += 1;
    const pixels = makeDiagnosticFrame({ width, height, frame });
    if (pixels !== null) {
      if (frameCache.size >= cacheSize) frameCache.delete(frameCache.keys().next().value);
      frameCache.set(key, pixels);
    }
    return pixels;
  };

  const server = createServer((socket) => {
    stats.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // A hostile or crashing client must not take the service down.
    socket.on('error', () => socket.destroy());
    socket.setNoDelay(true);

    let authenticated = false;
    const reader = new MessageReader();

    const send = (buffer) => {
      if (!socket.destroyed) socket.write(buffer);
    };

    const handle = async ({ header, metadata }) => {
      if (header.type === MessageType.HELLO) {
        const suppliedToken = metadata?.token;
        if (faults.rejectAuth || suppliedToken !== token) {
          stats.helloRejected += 1;
          send(
            encodeMessage({
              type: MessageType.ERROR,
              requestId: header.requestId,
              metadata: { code: 'unauthenticated', retryable: false },
            }),
          );
          socket.end();
          return;
        }
        authenticated = true;
        send(
          encodeMessage({
            type: MessageType.HELLO_OK,
            requestId: header.requestId,
            metadata: { protocolVersion: PROTOCOL_VERSION, serviceInstance: instanceId },
          }),
        );
        return;
      }

      if (!authenticated) {
        send(
          encodeMessage({
            type: MessageType.ERROR,
            requestId: header.requestId,
            metadata: { code: 'unauthenticated', retryable: false },
          }),
        );
        socket.end();
        return;
      }

      if (header.type === MessageType.PING) {
        send(encodeMessage({ type: MessageType.PONG, requestId: header.requestId }));
        return;
      }

      if (header.type === MessageType.CANCEL) return;

      if (header.type !== MessageType.FRAME) {
        send(
          encodeMessage({
            type: MessageType.ERROR,
            requestId: header.requestId,
            metadata: { code: 'unsupported', retryable: false },
          }),
        );
        return;
      }

      const request = metadata ?? {};
      if (faults.neverRespond) return;
      if (faults.respondWithError) {
        send(
          encodeMessage({
            type: MessageType.ERROR,
            requestId: header.requestId,
            metadata: { code: 'render-failed', retryable: true },
          }),
        );
        return;
      }

      const frame = cachedFrame(request.width, request.height, request.frame);
      if (frame === null || frame === undefined) {
        send(
          encodeMessage({
            type: MessageType.ERROR,
            requestId: header.requestId,
            metadata: { code: 'bad-request', retryable: false },
          }),
        );
        return;
      }

      if (faults.delayBeforeHeaderMs > 0) await delay(faults.delayBeforeHeaderMs);
      if (faults.disconnectBeforeResponse) {
        socket.destroy();
        return;
      }

      const { metadata: responseMetadata, body } = frameResponse(request, frame, faults);
      const metadataBuffer = faults.malformedMetadata
        ? Buffer.from('{"width":', 'utf8')
        : Buffer.from(JSON.stringify(responseMetadata), 'utf8');

      const declaredBodyLength = faults.declareOversizedBody ? body.length + 4096 : body.length;
      const responseHeader = encodeHeader({
        magic: faults.badMagic ? 0xdeadbeef : undefined,
        version: faults.badVersion ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION,
        type: faults.unknownType ? 4242 : MessageType.FRAME_OK,
        requestId: faults.wrongRequestId ? header.requestId + 1 : header.requestId,
        metadataLength: metadataBuffer.length,
        bodyLength: declaredBodyLength,
      });

      send(responseHeader);
      if (faults.disconnectAfterHeader) {
        socket.destroy();
        return;
      }
      if (faults.delayAfterHeaderMs > 0) await delay(faults.delayAfterHeaderMs);

      send(metadataBuffer);
      const payload = faults.truncateBody ? body.subarray(0, Math.floor(body.length / 2)) : body;
      send(payload);
      stats.frames += 1;
    };

    socket.on('data', (chunk) => {
      reader.push(chunk);
      let messages;
      try {
        messages = [...reader.drain()];
      } catch {
        socket.destroy();
        return;
      }
      // Sequential await chain: the fake service answers one request at a time so
      // fault timing stays deterministic.
      void messages.reduce(
        (previous, message) => previous.then(() => handle(message)).catch(() => socket.destroy()),
        Promise.resolve(),
      );
    });
  });

  server.on('error', () => {});

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: options.port ?? 0 }, resolve);
  });

  const { port } = server.address();
  const descriptor = {
    protocolVersion: PROTOCOL_VERSION,
    instanceId,
    pid: process.pid,
    port,
    token,
    startedAt: new Date().toISOString(),
  };
  writeSessionDescriptor(sessionFile, descriptor);

  const close = async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise((resolve) => server.close(resolve));
    try {
      rmSync(dirname(sessionFile), { recursive: true, force: true });
    } catch {
      // A leftover temporary directory is not worth failing a test run over.
    }
  };

  return { port, token, instanceId, sessionFile, stats, close, HEADER_SIZE };
}

// Manual use: node server.mjs [--session <path>] [--fault <name>]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const readArg = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const faultName = readArg('--fault');
  const faults = faultName ? { [faultName]: true } : {};
  const server = await startFakeRenderer({ sessionFile: readArg('--session'), faults });
  process.stdout.write(
    `${JSON.stringify({ port: server.port, sessionFile: server.sessionFile })}\n`,
  );
  process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
}
