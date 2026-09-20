const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { listenIpv6Loopback } = require('../core/ipv6Loopback');

const get = (options) => new Promise((resolve, reject) => {
  http.get(options, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
});

test('connections on [::1] reach the same server and its guards', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.headers.host && req.headers.host.startsWith('evil.') ? 403 : 200).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const { listener, error } = await listenIpv6Loopback(server, port);
  if (error && error.code === 'EADDRNOTAVAIL') {
    server.close();
    t.skip('IPv6 loopback is disabled on this machine');
    return;
  }
  try {
    assert.equal(error, null);
    assert.equal(await get({ host: '::1', port, path: '/' }), 200);
    // The HTTP server's own checks still apply to sockets that arrived through ::1.
    assert.equal(await get({ host: '::1', port, path: '/', headers: { host: 'evil.example' } }), 403);

    // Another program already on [::1]:port is reported, never thrown.
    const second = await listenIpv6Loopback(server, port);
    assert.equal(second.listener, null);
    assert.equal(second.error.code, 'EADDRINUSE');
  } finally {
    listener.close();
    server.close();
  }
});

test('the core opens the IPv6 socket once listening, and closes it on shutdown', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'server.js'), 'utf8');
  const onListening = source.slice(source.indexOf('function onListening()'), source.indexOf('server.on("listening"'));
  assert.match(onListening, /listenIpv6Loopback\(server, activePort\)/);
  assert.match(source, /try \{ ipv6Listener\?\.close\(\); \} catch \{\}/);
  // The IPv4 listener is untouched: the Tauri shell picks its port by binding 127.0.0.1.
  assert.match(source, /const HOST = "127\.0\.0\.1";/);
});
