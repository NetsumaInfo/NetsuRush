// The project server is the boundary between a user's project directory and a
// browser. Everything it serves, someone else authored.
//
// The engine ships its own createFileServer and it was rejected in H01 for two
// measured failures: it binds every interface, and one encoded-separator form
// escapes the served root on Windows. Those two failures are named regression
// cases below, so this server cannot quietly acquire them.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { startProjectServer } from '../projectServer.mjs';

let sandbox;
let root;
let server;

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'nf-projectserver-'));
  root = join(sandbox, 'project');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<html><body>INSIDE-THE-ROOT</body></html>');
  writeFileSync(join(root, 'styles.css'), 'body{color:red}');
  writeFileSync(join(root, 'assets', 'blob.bin'), Buffer.from('0123456789'));
  writeFileSync(join(root, 'assets', 'font.woff2'), Buffer.alloc(16));
  // Lives outside the served root. No request may ever return it.
  writeFileSync(join(sandbox, 'SECRET.txt'), 'ESCAPED-THE-ROOT');

  server = await startProjectServer({ root });
});

after(async () => {
  if (server) await server.close();
  rmSync(sandbox, { recursive: true, force: true });
});

/// Fetches a raw path against the server's origin, bypassing URL normalisation
/// that a helpful client would otherwise apply. Traversal attempts have to
/// reach the server exactly as written.
async function raw(path, init) {
  return fetch(`${server.origin}${path}`, init);
}

test('the served URL carries a per-run token and no trailing slash', () => {
  assert.match(server.token, /^[0-9a-f]{32}$/);
  assert.equal(server.url, `${server.origin}/${server.token}`);
  // The engine builds its navigation URL as `${serverUrl}/index.html`. A
  // trailing slash here produced `//index.html`, whose leading slash made
  // resolve() treat it as absolute and land outside the root: a silent 404 that
  // cost a full 45 s readiness timeout to diagnose.
  assert.ok(!server.url.endsWith('/'));
});

test('the URL the engine actually builds serves the entry point', async () => {
  const res = await fetch(`${server.url}/index.html`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /INSIDE-THE-ROOT/);
});

test('a doubled separator does not escape the root', async () => {
  for (const path of [`/${server.token}//index.html`, `/${server.token}///styles.css`]) {
    const res = await raw(path);
    assert.equal(res.status, 200, `${path} should resolve inside the root`);
  }
});

test('it serves the project root', async () => {
  const res = await fetch(`${server.url}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /INSIDE-THE-ROOT/);
});

test('it refuses a request with no token, a wrong token, or another run\'s token', async () => {
  for (const path of ['/index.html', '/wrongtoken/index.html', `/${'a'.repeat(32)}/index.html`]) {
    const res = await raw(path);
    assert.equal(res.status, 404, `${path} must not be served`);
  }
});

test('no encoded separator escapes the served root', async () => {
  // The last entry is the exact form that defeated the engine's own file
  // server: it survives URL normalisation and is then treated as a separator by
  // path.join on Windows.
  const attempts = [
    '/../SECRET.txt',
    '/..%2fSECRET.txt',
    '/%2e%2e/SECRET.txt',
    '/....//SECRET.txt',
    '/..\\SECRET.txt',
    '/%2e%2e%5cSECRET.txt',
    '/%2e%2e%2fSECRET.txt',
    '/..%5cSECRET.txt',
    '/%252e%252e%255cSECRET.txt',
    '/assets/../../SECRET.txt',
    '/assets/%2e%2e%5c%2e%2e%5cSECRET.txt',
  ];

  for (const attempt of attempts) {
    const res = await raw(`/${server.token}${attempt}`);
    const body = await res.text();
    assert.ok(
      !body.includes('ESCAPED-THE-ROOT'),
      `${attempt} returned a file from outside the served root`,
    );
    assert.equal(res.status, 404, `${attempt} should be a plain 404`);
  }
});

test('a symlink cannot lead out of the root', async (t) => {
  const link = join(root, 'escape-link.txt');
  try {
    symlinkSync(join(sandbox, 'SECRET.txt'), link, 'file');
  } catch {
    // Unprivileged symlink creation is off by default on Windows. Skipping is
    // honest; silently passing would not be.
    t.skip('symlink creation not permitted in this environment');
    return;
  }
  const res = await raw(`/${server.token}/escape-link.txt`);
  const body = await res.text();
  assert.ok(!body.includes('ESCAPED-THE-ROOT'));
  assert.equal(res.status, 404);
});

test('it answers only on loopback', async () => {
  const external = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!external) return;

  await assert.rejects(
    fetch(`http://${external.address}:${server.port}/${server.token}/index.html`, {
      signal: AbortSignal.timeout(3000),
    }),
    'the project directory must not be reachable from the network',
  );
});

test('content types come from an explicit table', async () => {
  const cases = [
    ['index.html', /text\/html/],
    ['styles.css', /text\/css/],
    ['assets/font.woff2', /font\/woff2/],
    // An unknown extension must never be guessed into something executable.
    ['assets/blob.bin', /application\/octet-stream/],
  ];
  for (const [path, expected] of cases) {
    const res = await raw(`/${server.token}/${path}`);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), expected, path);
  }
});

test('it serves byte ranges and rejects unsatisfiable ones', async () => {
  const path = `/${server.token}/assets/blob.bin`;

  const partial = await raw(path, { headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await partial.text(), '2345');

  const suffix = await raw(path, { headers: { Range: 'bytes=-3' } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), '789');

  const openEnded = await raw(path, { headers: { Range: 'bytes=7-' } });
  assert.equal(openEnded.status, 206);
  assert.equal(await openEnded.text(), '789');

  const unsatisfiable = await raw(path, { headers: { Range: 'bytes=50-60' } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */10');
});

test('a missing asset is a plain 404', async () => {
  const res = await raw(`/${server.token}/assets/nope.png`);
  assert.equal(res.status, 404);
});

test('a directory is not listed', async () => {
  const res = await raw(`/${server.token}/assets/`);
  assert.equal(res.status, 404);
  assert.ok(!(await res.text()).includes('blob.bin'), 'directory contents must not leak');
});

test('only GET and HEAD are answered', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const res = await raw(`/${server.token}/index.html`, { method });
    assert.equal(res.status, 405, method);
  }
  const head = await raw(`/${server.token}/index.html`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '', 'HEAD must not carry a body');
});

test('an absurd URL is refused before any filesystem work', async () => {
  const res = await raw(`/${server.token}/${'a'.repeat(9000)}.png`);
  assert.equal(res.status, 414);
});

test('a file larger than the limit is refused rather than buffered', async () => {
  const small = await startProjectServer({ root, maxFileBytes: 4 });
  try {
    const res = await fetch(`${small.url}/index.html`);
    assert.equal(res.status, 413);
  } finally {
    await small.close();
  }
});

test('responses forbid caching and sniffing', async () => {
  const res = await fetch(`${server.url}/index.html`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('cache-control'), /no-store/);
});

test('close releases the port', async () => {
  const temporary = await startProjectServer({ root });
  const { port, url } = temporary;
  assert.equal((await fetch(`${url}/index.html`)).status, 200);
  await temporary.close();

  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) }),
    'the port must be free after close()',
  );
});

test('script injection reaches index.html and nothing else', async () => {
  // The one sound idea borrowed from the engine's file server: it is the
  // candidate mechanism for the later frame-control shim.
  const injected = await startProjectServer({
    root,
    headScripts: ['<script>window.__nfHead = 1;</script>'],
    bodyScripts: ['<script>window.__nfBody = 1;</script>'],
  });
  try {
    const html = await (await fetch(`${injected.url}/index.html`)).text();
    assert.match(html, /__nfHead/);
    assert.match(html, /__nfBody/);
    assert.ok(html.indexOf('__nfHead') < html.indexOf('INSIDE-THE-ROOT'));
    assert.ok(html.indexOf('__nfBody') > html.indexOf('INSIDE-THE-ROOT'));

    const css = await (await fetch(`${injected.url}/styles.css`)).text();
    assert.equal(css, 'body{color:red}', 'only index.html may be rewritten');
  } finally {
    await injected.close();
  }
});
