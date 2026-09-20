const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const bootstrap = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

// Runs index.html's inline bootstrap against a fake page. `session` survives between runs, the way
// sessionStorage survives the app reloading itself inside the panel's iframe.
function boot(url, session = new Map()) {
  const location = new URL(url);
  const replaced = [];
  const window = {};
  vm.runInNewContext(bootstrap, {
    window,
    location,
    URLSearchParams,
    localStorage: { getItem: () => null },
    sessionStorage: { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, v) },
    history: { state: null, replaceState: (_s, _t, next) => replaced.push(next) },
    document: { documentElement: { setAttribute() {} } },
  });
  return { window, replaced, session };
}

test('the panel app reads the token, then strips it from its address', () => {
  const first = boot('http://127.0.0.1:8730/app/?core=http%3A%2F%2F127.0.0.1%3A8730&remote=1&host=ppro&tk=s3cret#x');
  assert.equal(first.window.__NR_TOKEN__, 's3cret');
  assert.equal(first.window.__NR_REMOTE__, true);
  assert.deepEqual(first.replaced, ['/app/?core=http%3A%2F%2F127.0.0.1%3A8730&remote=1&host=ppro#x']);

  // The app reloading itself (context menu, error screen) keeps the token for the session.
  const reload = boot('http://127.0.0.1:8730/app/?core=http%3A%2F%2F127.0.0.1%3A8730&remote=1&host=ppro', first.session);
  assert.equal(reload.window.__NR_TOKEN__, 's3cret');
  assert.deepEqual(reload.replaced, []);
});

test('an address without a token changes nothing (the Tauri window)', () => {
  const tauri = boot('http://tauri.localhost/');
  assert.equal(tauri.window.__NR_TOKEN__, undefined);
  assert.deepEqual(tauri.replaced, []);
});

test('the panel hands the token to its iframe and rebuilds it when the token moves', () => {
  const panel = fs.readFileSync(path.join(root, 'adobe-cep', 'js', 'panel.js'), 'utf8');
  assert.match(panel, /"&remote=1&host=" \+ APP \+ tkQuery\("&"\);/);
  // The attribute as written is compared, not the `src` property, which the engine resolves.
  assert.match(panel, /if \(el\.appFrame\.getAttribute\("src"\) !== url\) \{/);
});

// The two functions are lifted out of the panel and run against a fake network.
function panelProbe(responses) {
  const panel = fs.readFileSync(path.join(root, 'adobe-cep', 'js', 'panel.js'), 'utf8');
  const start = panel.indexOf('  function probe(');
  const end = panel.indexOf('  // ---- Statut core');
  assert.ok(start > 0 && end > start, 'probe block located');
  const context = {
    setTimeout, clearTimeout, Promise,
    fetch: async (url, init) => {
      const r = responses[url];
      if (!r) throw new TypeError('Failed to fetch');
      if (init.mode === 'no-cors') return { ok: false, type: 'opaque' };
      return { ok: r.status === 200, text: async () => r.body };
    },
  };
  vm.runInNewContext(panel.slice(start, end), context);
  return context;
}

test('a dev server is used only when it serves NetsuRush', async () => {
  const dev = 'http://localhost:1420/';
  const own = panelProbe({ [dev]: { status: 200, body: html } });
  assert.equal(await own.probe(dev, 1000, own.isNetsuRushPage), true);

  const other = panelProbe({ [dev]: { status: 200, body: '<!doctype html><title>other-tauri-app</title>' } });
  assert.equal(await other.probe(dev, 1000, other.isNetsuRushPage), false);
  assert.equal(await other.probe(dev, 1000), true, 'an opaque answer still proves a server, as before');

  const missing = panelProbe({ [dev]: { status: 404, body: '' } });
  assert.equal(await missing.probe(dev, 1000, missing.isNetsuRushPage), false);

  const down = panelProbe({});
  assert.equal(await down.probe(dev, 1000, down.isNetsuRushPage), false);
  assert.equal(await down.probe(dev, 1000), false);

  const source = fs.readFileSync(path.join(root, 'adobe-cep', 'js', 'panel.js'), 'utf8');
  assert.match(source, /probe\(DEV_URL \+ "\/", 1000, isNetsuRushPage\)/);
});
