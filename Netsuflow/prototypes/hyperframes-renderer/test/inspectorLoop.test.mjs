// The Inspector loop, server-side: paste code, read its declared variables,
// change one, get different pixels. This is what the redesigned OpenFX node
// drives; here the plugin is played by a raw protocol client so the whole
// exchange is pinned without a host.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MessageType } from '../../fake-renderer/protocol.mjs';
import { fnv1a64Hex, startBridgeServer } from '../server.mjs';
import { protocolClient, hello } from './helpers.mjs';

const US = '';

const PAGE_A = `<!doctype html><html data-composition-id="c" data-composition-duration="2"
 data-composition-variables='[{"id":"accent","type":"enum","label":"Accent","default":"green","options":[{"value":"green"},{"value":"blue"}]},{"id":"size","type":"number","label":"Size","default":12,"min":2,"max":32}]'>
<body></body></html>`;
const PAGE_B = PAGE_A.replace('"default":"green"', '"default":"blue"');

/// An engine stub whose pixels encode which props the session was opened with,
/// so a variables change is visible in the bytes rather than inferred.
function propsEchoEngine(log) {
  return {
    probe: async () => ({ engine: 'stub', defaultCapturePath: 'alpha' }),
    open: async (binding) => {
      log.push({ opened: binding.id, props: binding.props ?? null });
      // The trailing bytes, because every props object shares its first four.
      const stamp = Buffer.from(JSON.stringify(binding.props ?? {})).subarray(-4);
      return {
        renderFrame: async ({ frame }) => {
          const pixels = Buffer.alloc(binding.width * binding.height * 4);
          stamp.copy(pixels, 0);
          pixels[4] = frame & 0xff;
          return {
            width: binding.width,
            height: binding.height,
            stride: binding.width * 4,
            pixelFormat: 'RGBA8',
            alphaMode: 'straight',
            pixels,
          };
        },
        close: async () => log.push({ closed: binding.id }),
      };
    },
  };
}

function frameRequest(overrides) {
  return {
    binding: 'paste',
    sourceRevision: '',
    frame: 0,
    width: 8,
    height: 8,
    renderScalePpm: 1_000_000,
    pixelFormat: 'RGBA8',
    alphaMode: 'straight',
    quality: 'preview',
    deadlineMs: 2000,
    ...overrides,
  };
}

test('describe reports the pasted composition variables in wire order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nf-inspector-'));
  writeFileSync(join(dir, 'index.html'), PAGE_A, 'utf8');
  const server = await startBridgeServer({
    engine: propsEchoEngine([]),
    bindings: {
      paste: {
        projectRoot: dir,
        compositionId: 'c',
        sourceRevision: fnv1a64Hex(PAGE_A),
        spoolFile: join(dir, 'index.html'),
        width: 8,
        height: 8,
        fps: { num: 24, den: 1 },
      },
    },
  });
  const client = protocolClient(server.port);
  try {
    await hello(client, server.token);
    client.send({ type: MessageType.DESCRIBE, requestId: 5, metadata: { binding: 'paste' } });
    const reply = await client.next();
    assert.equal(reply.header.type, MessageType.DESCRIBE_OK);
    assert.equal(reply.metadata.varCount, 2);
    assert.equal(
      reply.metadata.var0,
      // Fields 8 and 9 (option labels, unit) are new; the old plugin's parser
      // stops at field 8 and never sees them.
      ['accent', 'enum', 'Accent', 'green', '', '', '', 'green,blue', 'green,blue', ''].join(US),
    );
    // The step is computed when the author declares none — (32-2)/100 — because
    // a slider without a step is a slider the Inspector cannot drag.
    assert.equal(reply.metadata.var1, ['size', 'number', 'Size', '12', '2', '32', '0.3', '', '', ''].join(US));
  } finally {
    client.destroy();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a node override is reshaped to what the declaration promised', async () => {
  // The node's Double slot sends 24 for a "16px" variable and its RGB slot
  // sends #ff0000 for an rgba(...) one. The composition expects "24px" and an
  // alpha; the service restores both from the declaration before they land.
  const page = `<!doctype html><html data-composition-id="c" data-composition-duration="2"
 data-composition-variables='[{"id":"pad","type":"number","default":"16px"},{"id":"tint","type":"color","default":"rgba(90,103,242,0.5)"}]'>
<body></body></html>`;
  const dir = mkdtempSync(join(tmpdir(), 'nf-inspector-'));
  writeFileSync(join(dir, 'index.html'), page, 'utf8');
  const log = [];
  const server = await startBridgeServer({
    engine: propsEchoEngine(log),
    bindings: {
      paste: {
        projectRoot: dir,
        compositionId: 'c',
        sourceRevision: fnv1a64Hex(page),
        spoolFile: join(dir, 'index.html'),
        width: 8,
        height: 8,
        fps: { num: 24, den: 1 },
      },
    },
  });
  const client = protocolClient(server.port);
  try {
    await hello(client, server.token);
    client.send({
      type: MessageType.FRAME,
      requestId: 7,
      metadata: {
        ...frameRequest({ sourceRevision: fnv1a64Hex(page) }),
        varCount: 2,
        var0: 'pad' + US + '24',
        var1: 'tint' + US + '#ff0000',
      },
    });
    const reply = await client.next();
    assert.equal(reply.header.type, MessageType.FRAME_OK);
    const opened = log.find((entry) => entry.opened);
    assert.deepEqual(opened.props, { pad: '24px', tint: 'rgba(255, 0, 0, 0.5)' });
  } finally {
    client.destroy();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a variables change rebuilds the session and changes the pixels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nf-inspector-'));
  writeFileSync(join(dir, 'index.html'), PAGE_A, 'utf8');
  const log = [];
  const server = await startBridgeServer({
    engine: propsEchoEngine(log),
    bindings: {
      paste: {
        projectRoot: dir,
        compositionId: 'c',
        sourceRevision: fnv1a64Hex(PAGE_A),
        spoolFile: join(dir, 'index.html'),
        width: 8,
        height: 8,
        fps: { num: 24, den: 1 },
      },
    },
  });
  const client = protocolClient(server.port);
  try {
    await hello(client, server.token);

    client.send({
      type: MessageType.FRAME,
      requestId: 20,
      metadata: frameRequest({ varCount: 1, var0: `accent${US}"green"` }),
    });
    const first = await client.next();
    assert.equal(first.header.type, MessageType.FRAME_OK);

    client.send({
      type: MessageType.FRAME,
      requestId: 21,
      metadata: frameRequest({ varCount: 1, var0: `accent${US}"blue"` }),
    });
    const second = await client.next();
    assert.equal(second.header.type, MessageType.FRAME_OK);

    assert.notDeepEqual(first.body.subarray(0, 4), second.body.subarray(0, 4));
    assert.deepEqual(
      log.filter((entry) => entry.opened).map((entry) => entry.props),
      [{ accent: 'green' }, { accent: 'blue' }],
    );
    // The first session was actually closed, not leaked beside the second.
    assert.equal(log.filter((entry) => entry.closed).length, 1);

    // Same variables again: no third session.
    client.send({
      type: MessageType.FRAME,
      requestId: 22,
      metadata: frameRequest({ frame: 1, varCount: 1, var0: `accent${US}"blue"` }),
    });
    const third = await client.next();
    assert.equal(third.header.type, MessageType.FRAME_OK);
    assert.equal(log.filter((entry) => entry.opened).length, 2);
  } finally {
    client.destroy();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a spooled revision mismatch adopts the new file instead of refusing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nf-inspector-'));
  const spoolFile = join(dir, 'index.html');
  writeFileSync(spoolFile, PAGE_A, 'utf8');
  const server = await startBridgeServer({
    engine: propsEchoEngine([]),
    bindings: {
      paste: {
        projectRoot: dir,
        compositionId: 'c',
        sourceRevision: fnv1a64Hex(PAGE_A),
        spoolFile,
        width: 8,
        height: 8,
        fps: { num: 24, den: 1 },
      },
    },
  });
  const client = protocolClient(server.port);
  try {
    await hello(client, server.token);

    // The plugin pastes new code: it writes the spool, then asks for a frame
    // carrying the new content hash. The old service-side revision no longer
    // matches, and that mismatch is the signal to re-read the file.
    writeFileSync(spoolFile, PAGE_B, 'utf8');
    client.send({
      type: MessageType.FRAME,
      requestId: 30,
      metadata: frameRequest({ sourceRevision: fnv1a64Hex(PAGE_B) }),
    });
    const adopted = await client.next();
    assert.equal(adopted.header.type, MessageType.FRAME_OK);
    assert.equal(adopted.metadata.revision, fnv1a64Hex(PAGE_B));

    // A hash that matches neither the old revision nor the file is still
    // refused: adoption is verification, not trust.
    client.send({
      type: MessageType.FRAME,
      requestId: 31,
      metadata: frameRequest({ sourceRevision: 'f'.repeat(16) }),
    });
    const refused = await client.next();
    assert.equal(refused.header.type, MessageType.ERROR);
    assert.equal(refused.metadata.code, 'stale-revision');
  } finally {
    client.destroy();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
