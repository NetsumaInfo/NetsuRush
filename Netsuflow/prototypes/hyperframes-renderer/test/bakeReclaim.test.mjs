// Does a parameter change give the disk back?
//
// It did not, and the numbers were not marginal. Measured on the real service
// with a 60-frame 1080x1920 composition: the first bake held 120 files and
// 949 MiB, and each subsequent parameter change added 60 files and 474 MiB
// while removing nothing — 1.9 GiB after three tweaks, none of it readable
// again. On a 15-second composition that is +7.2 GiB per tweak.
//
// This drives the same path with an 8x8 stub so the assertion is about the
// bookkeeping rather than about how long a browser takes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MessageType } from '../../fake-renderer/protocol.mjs';
import { fnv1a64Hex, startBridgeServer } from '../server.mjs';
import { protocolClient, hello } from './helpers.mjs';

const US = '';

const PAGE = `<!doctype html><html data-composition-id="c" data-composition-duration="2"
 data-composition-variables='[{"id":"tint","type":"color","default":"#ff0000"}]'>
<body></body></html>`;

function stubEngine() {
  return {
    probe: async () => ({ engine: 'stub', defaultCapturePath: 'alpha' }),
    open: async (binding) => ({
      renderFrame: async ({ frame }) => {
        const pixels = Buffer.alloc(binding.width * binding.height * 4, frame & 0xff);
        return {
          width: binding.width,
          height: binding.height,
          stride: binding.width * 4,
          pixelFormat: 'RGBA8',
          alphaMode: 'straight',
          pixels,
        };
      },
      close: async () => {},
    }),
  };
}

function frameRequest(overrides) {
  return {
    binding: 'paste',
    sourceRevision: fnv1a64Hex(PAGE),
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

async function withService(run) {
  const dir = mkdtempSync(join(tmpdir(), 'nf-reclaim-'));
  writeFileSync(join(dir, 'index.html'), PAGE, 'utf8');
  const bake = join(dir, 'bake');
  const server = await startBridgeServer({
    engine: stubEngine(),
    bakeDirectory: bake,
    bindings: {
      paste: {
        projectRoot: dir,
        compositionId: 'c',
        sourceRevision: fnv1a64Hex(PAGE),
        spoolFile: join(dir, 'index.html'),
        width: 8,
        height: 8,
        fps: { num: 24, den: 1 },
      },
    },
  });
  const client = protocolClient(server.port);
  const generations = () => readdirSync(bake).filter((name) => /^[0-9a-f]{16,64}$/.test(name));
  try {
    await hello(client, server.token);
    await run({ client, server, bake, generations });
  } finally {
    client.destroy();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/// Renders a few frames under one set of variable values.
async function renderUnder(client, requestId, vars) {
  const packed = {};
  const ids = Object.keys(vars);
  ids.forEach((id, index) => { packed[`var${index}`] = id + US + vars[id]; });
  for (let frame = 0; frame < 3; frame += 1) {
    client.send({
      type: MessageType.FRAME,
      requestId: requestId + frame,
      metadata: { ...frameRequest({ frame }), varCount: ids.length, ...packed },
    });
    const reply = await client.next();
    assert.equal(reply.header.type, MessageType.FRAME_OK, JSON.stringify(reply.metadata));
  }
}

test('a parameter change reclaims the frames the previous value baked', async () => {
  await withService(async ({ client, generations }) => {
    await renderUnder(client, 100, { tint: '#ff0000' });
    const first = generations();
    assert.equal(first.length, 1, 'one generation after the first value');

    await renderUnder(client, 200, { tint: '#00ff00' });
    const second = generations();
    // The point of the whole change: one generation, not two. Before this, the
    // first value's frames stayed on disk for good.
    assert.equal(second.length, 1, 'the superseded generation is gone');
    assert.notEqual(second[0], first[0], 'and it is a different generation');

    await renderUnder(client, 300, { tint: '#0000ff' });
    assert.equal(generations().length, 1, 'still one after a third value');
  });
});

test('reverting to a previous value never accumulates a generation', async () => {
  await withService(async ({ client, generations }) => {
    await renderUnder(client, 100, { tint: '#ff0000' });
    await renderUnder(client, 200, { tint: '#00ff00' });
    await renderUnder(client, 300, { tint: '#ff0000' });
    // At most one, and here exactly zero: the first value's key is still in
    // the scheduler's memory cache, so the revert is a memory hit and render()
    // — the only thing that writes to disk — never runs. The frame is still
    // served; it is just not re-baked. Strictly less disk, which is the
    // direction that matters.
    assert.ok(generations().length <= 1, `generations=${generations().length}`);
  });
});

test('a size change reclaims too, not only a variable change', async () => {
  // Width and height are part of the generation for the same reason a variable
  // is: the pixels differ. Trying formats used to cost a full bake each.
  await withService(async ({ client, generations }) => {
    await renderUnder(client, 100, { tint: '#ff0000' });
    assert.equal(generations().length, 1);
    client.send({
      type: MessageType.FRAME,
      requestId: 400,
      metadata: { ...frameRequest({ width: 16, height: 16 }), varCount: 1, var0: 'tint' + US + '#ff0000' },
    });
    assert.equal((await client.next()).header.type, MessageType.FRAME_OK);
    assert.equal(generations().length, 1);
  });
});

test('the previous run leftovers are reclaimed, and a matching one is kept', async () => {
  // Two different starting states, one property: after a restart the store
  // holds exactly what the live binding can still ask for.
  for (const changeAfterRestart of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'nf-reclaim-'));
    writeFileSync(join(dir, 'index.html'), PAGE, 'utf8');
    const bake = join(dir, 'bake');
    const bindings = () => ({
      paste: {
        projectRoot: dir,
        compositionId: 'c',
        sourceRevision: fnv1a64Hex(PAGE),
        spoolFile: join(dir, 'index.html'),
        width: 8,
        height: 8,
        fps: { num: 24, den: 1 },
      },
    });
    const generations = () => readdirSync(bake).filter((n) => /^[0-9a-f]{16,64}$/.test(n));

    let first = await startBridgeServer({
      engine: stubEngine(), bakeDirectory: bake, bindings: bindings(),
    });
    let client = protocolClient(first.port);
    await hello(client, first.token);
    await renderUnder(client, 100, { tint: '#ff0000' });
    await renderUnder(client, 200, { tint: '#00ff00' });
    const before = generations();
    client.destroy();
    await first.close();
    assert.equal(before.length, 1);

    const second = await startBridgeServer({
      engine: stubEngine(), bakeDirectory: bake, bindings: bindings(),
    });
    client = protocolClient(second.port);
    try {
      await hello(client, second.token);
      if (changeAfterRestart) {
        await renderUnder(client, 300, { tint: '#123456' });
        assert.equal(generations().length, 1, 'leftovers gone after a change');
        assert.notEqual(generations()[0], before[0]);
      } else {
        // Same values: the surviving generation is the one on disk, so the
        // bake a restart inherited is still a hit rather than a re-render.
        await renderUnder(client, 300, { tint: '#00ff00' });
        assert.deepEqual(generations(), before, 'an unchanged binding keeps its bake');
      }
    } finally {
      client.destroy();
      await second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
