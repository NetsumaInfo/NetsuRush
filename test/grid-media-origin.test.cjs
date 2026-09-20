const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');

function load(file, globals = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('exports', 'URL', ...Object.keys(globals), js)(exports, URL, ...Object.values(globals));
  return exports;
}

// A fake loopback: `answers` maps an origin to its /healthz body. `networkMs` is what the timing
// entry reports (null: no entry), `wallMs` what the main thread saw pass meanwhile.
function probeWith({ answers, networkMs = 2, wallMs = networkMs ?? 2 }) {
  let now = 0;
  const asked = [];
  const entries = new Map();
  const mod = load('src/lib/gridMediaOrigin.ts', {
    performance: { now: () => now, getEntriesByName: (name) => (entries.has(name) ? [entries.get(name)] : []) },
    fetch: async (url) => {
      asked.push(url);
      now += wallMs;
      if (networkMs !== null) entries.set(url, { duration: networkMs });
      const origin = new URL(url).origin;
      if (!(origin in answers)) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => answers[origin] };
    },
  });
  return { verified: mod.verifiedGridMediaOrigin, asked };
}

test('grid media move to the other loopback name, keeping the port', () => {
  const { gridMediaOrigin } = load('src/lib/gridMediaOrigin.ts');
  assert.equal(gridMediaOrigin('http://127.0.0.1:8731'), 'http://localhost:8731');
  assert.equal(gridMediaOrigin('http://localhost:8730'), 'http://127.0.0.1:8730');
  // A host with no sibling keeps its origin rather than pointing somewhere the core does not listen.
  assert.equal(gridMediaOrigin('http://[::1]:8730'), 'http://[::1]:8730');
});

test('the sibling is used only once it answers quickly as this very core', async () => {
  const core = { app: 'netsurush', port: 8731, channels: 400 };
  const ok = probeWith({ answers: { 'http://localhost:8731': core } });
  assert.equal(await ok.verified('http://127.0.0.1:8731'), 'http://localhost:8731');
  // The probe goes to the unauthenticated beacon: no token leaves with it.
  assert.equal(ok.asked.length, 1);
  assert.match(ok.asked[0], /^http:\/\/localhost:8731\/healthz\?probe=\d+$/);

  const stranger = probeWith({ answers: { 'http://localhost:8731': { ok: true } } });
  assert.equal(await stranger.verified('http://127.0.0.1:8731'), null);

  const otherInstance = probeWith({ answers: { 'http://localhost:8731': { ...core, port: 8730 } } });
  assert.equal(await otherInstance.verified('http://127.0.0.1:8731'), null);

  // Windows answering ::1 before 127.0.0.1 shows up as a slow connect: not worth a pool.
  const slow = probeWith({ answers: { 'http://localhost:8731': core }, networkMs: 400 });
  assert.equal(await slow.verified('http://127.0.0.1:8731'), null);

  // A long first render delays the wall clock, not the network: the timing entry decides.
  const busyThread = probeWith({ answers: { 'http://localhost:8731': core }, networkMs: 3, wallMs: 900 });
  assert.equal(await busyThread.verified('http://127.0.0.1:8731'), 'http://localhost:8731');

  // No timing entry (buffer full): the wall clock is the fallback.
  const noEntry = probeWith({ answers: { 'http://localhost:8731': core }, networkMs: null, wallMs: 900 });
  assert.equal(await noEntry.verified('http://127.0.0.1:8731'), null);

  const nothing = probeWith({ answers: {} });
  assert.equal(await nothing.verified('http://127.0.0.1:8731'), null);

  const garbage = probeWith({ answers: {} });
  assert.equal(await garbage.verified('not a url'), null);

  const noSibling = probeWith({ answers: {} });
  assert.equal(await noSibling.verified('http://[::1]:8731'), null);
  assert.deepEqual(noSibling.asked, []);
});

test('the core media guard admits both loopback names', () => {
  process.env.NR_CORE_TOKEN = '';
  const { mediaGuard } = require('../core/media-server');
  for (const host of ['127.0.0.1:8730', 'localhost:8730']) {
    let status = null;
    const res = { writeHead: (code) => { status = code; return { end() {} }; } };
    const blocked = mediaGuard({ headers: { host } }, res, new URL(`http://${host}/media?p=x`));
    assert.equal(blocked, false, host);
    assert.equal(status, null, host);
  }
});

test('only the non-Tauri grid path changes host; the asset protocol still comes first', () => {
  const client = fs.readFileSync(path.join(root, 'src', 'lib', 'coreClient.ts'), 'utf8');
  assert.match(client, /assetUrl: \(p\) => assetSrc\(p\) \?\? `\$\{gridMediaBase\(\)\}\/media\?p=/);
  // Never probed under Tauri, and a verdict for an address the client has since left is ignored.
  assert.match(client, /if \(!isTauri && typeof window !== "undefined"\) \{\s*const probeGridMedia = async/);
  // After `load`, so the first render is not what the probe times.
  assert.match(client, /window\.addEventListener\("load", \(\) => void probeGridMedia\(\), \{ once: true \}\)/);
  assert.match(client, /return gridMedia && gridMedia\.base === BASE \? gridMedia\.origin : BASE;/);
  // The main player and every other media route stay on the control-plane origin.
  assert.match(client, /mediaUrl: \(p\) => `\$\{BASE\}\/media\?p=/);
});
