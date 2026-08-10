const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createReferenceStore } = require('../core/reference');

test('generic HTML5 video pages support linked and downloaded media', async (t) => {
  let mediaRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/files/12831/embed') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<video controls><source src="/Video/Full008/sample.mp4" type="video/mp4"></video>');
      return;
    }
    if (req.url === '/Video/Full008/sample.mp4') {
      mediaRequests += 1;
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(Buffer.from('video bytes'));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.notEqual(typeof address, 'string');
  const port = address.port;
  const page = `http://127.0.0.1:${port}/files/12831/embed`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-online-'));
  const store = createReferenceStore(root);

  const linked = await store.resolveMedia(page, { download: false });
  assert.deepEqual(linked, {
    ok: true,
    url: `http://127.0.0.1:${port}/Video/Full008/sample.mp4`,
    kind: 'video',
  });
  assert.equal(mediaRequests, 0, 'linked playback must not copy the video');

  const local = await store.resolveMedia(page, { download: true });
  assert.equal(local.ok, true);
  assert.equal(local.kind, 'video');
  assert.equal(fs.readFileSync(local.path, 'utf8'), 'video bytes');
  assert.equal(mediaRequests, 1);
});
