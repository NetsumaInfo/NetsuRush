// The editor HTTP routes, as a contract rather than as a habit.
//
// `/api/save` used to answer the state minus its `html`. Nothing in the editor
// noticed, because the editor already holds the source it just sent. The
// NetsuRush panel does not: it adopts the reply as its state, so it ended up
// holding a composition with two declared variables and no source, and the
// preview vanished with no error anywhere. A reply that reads as the state has
// to be the state.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startEditorServer } from '../editorServer.mjs';

const PAGE = `<!doctype html><html data-composition-id="c" data-composition-duration="2"
 data-composition-variables='[{"id":"tint","type":"color","default":"#ff0000"}]'>
<body></body></html>`;

/// The editor server is pure plumbing over the callbacks it is handed, so the
/// state it reports is whatever this stub says — which is the point: the test
/// is about the shape of the reply, not about rendering.
function stubOptions(saved) {
  const status = () => ({
    width: 1080,
    height: 1920,
    fps: 30,
    durationFrames: 60,
    variables: [{ id: 'tint', type: 'color', label: 'Tint', default: '#ff0000' }],
    requested: [{ width: 1080, height: 1920, source: 'data-width' }],
  });
  return {
    spoolFile: saved.file,
    status,
    onSave: async (html) => { saved.html = html; return status(); },
    onSend: async () => ({ width: 1080, height: 1920, revision: 'abc' }),
    onBake: async () => ({}),
    onBakeClear: async () => ({ frames: 0, bytes: 0, generations: 0 }),
    bakeProgress: () => ({
      running: false, done: 0, total: 0, error: null,
      frames: 0, bytes: 0, generations: 0, limit: 0, store: true,
    }),
    bakeDirectory: 'bake',
    exportFormats: [],
    exportDefaults: { directory: '', name: '' },
    onExport: async () => ({}),
    exportProgress: () => ({ running: false, done: 0, total: 0, error: null, output: '' }),
    onExportCancel: async () => ({}),
  };
}

async function withEditor(run) {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'nf-routes-'));
  const file = join(dir, 'index.html');
  writeFileSync(file, PAGE, 'utf8');
  const saved = { file, html: PAGE };
  const server = await startEditorServer(stubOptions(saved));
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await run({ base, saved });
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// One server for both assertions, deliberately. Two sequential servers land on
// the same preferred port, and undici keeps a pooled connection to it: the
// second test then reuses a socket whose server is gone and fails as "fetch
// failed". That is an artifact of the test harness, not of the routes.
test('the editor routes answer the shapes their callers depend on', async () => {
  await withEditor(async ({ base, saved }) => {
    const state = await (await fetch(`${base}/api/state`)).json();
    const stored = await (await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: PAGE, vars: {} }),
    })).json();

    assert.deepEqual(
      Object.keys(stored).sort(),
      Object.keys(state).sort(),
      'a save reply that omits a state field silently empties its caller',
    );
    assert.equal(stored.html, PAGE);

    // An empty composition is refused rather than stored: accepting one would
    // leave the binding pointing at a source that renders nothing.
    const refused = await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: '   ', vars: {} }),
    });
    assert.equal(refused.status, 400);
    assert.equal(saved.html, PAGE, 'the refused save must not have overwritten anything');
  });
});
