const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// Un `<video>` de WebView2 ne lit ni HLS ni 4K AV1 : la sélection de format est ce qui garde le
// flux relayé jouable, elle fait donc partie du contrat de ce module.
test('the relayed format stays progressive, H.264 first and capped at 1080p', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'ytstream.js'), 'utf8');
  const format = source.slice(source.indexOf('const FORMAT'), source.indexOf('const RESOLVE_TIMEOUT_MS'));
  const candidates = format.match(/"[^"]*\[[^"]*"/g) || [];
  assert.ok(candidates.length >= 3);
  for (const candidate of candidates) assert.match(candidate, /protocol\^=https/);
  assert.match(candidates[0], /vcodec\^=avc1/);
  assert.doesNotMatch(format, /height<=(?!1080)/);
});

// Le repli progressif peut encore rendre un manifeste : YouTube ne sert certains formats qu'en HLS.
test('a manifest URL counts as a resolve failure, not a playable stream', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('https://manifest.googlevideo.com/api/manifest/hls_playlist/x/index.m3u8\n'));
      child.emit('close', 0);
    });
    return child;
  };
  delete require.cache[require.resolve('../core/ytstream')];
  const { resolveStream } = require('../core/ytstream');
  try {
    const resolved = await resolveStream('hFldDZZcrQo');
    assert.equal(resolved.ok, false);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[require.resolve('../core/ytstream')];
  }
});

test('YouTube relay logs the yt-dlp failure before returning 502', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const originalError = console.error;
  const errors = [];
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stderr.emit('data', Buffer.from("No module named 'yt_dlp'"));
      child.emit('close', 1);
    });
    return child;
  };
  console.error = (...args) => errors.push(args.join(' '));
  delete require.cache[require.resolve('../core/ytstream')];
  const { serveYoutube } = require('../core/ytstream');
  const response = {
    status: 0,
    body: '',
    writeHead(code) { this.status = code; return this; },
    end(body = '') { this.body = String(body); },
  };
  try {
    await serveYoutube({ headers: {} }, response, 'hFldDZZcrQo');
    assert.equal(response.status, 502);
    assert.equal(response.body, 'resolve failed');
    assert.match(errors.join('\n'), /ytstream.*No module named 'yt_dlp'/i);
  } finally {
    childProcess.spawn = originalSpawn;
    console.error = originalError;
    delete require.cache[require.resolve('../core/ytstream')];
  }
});
