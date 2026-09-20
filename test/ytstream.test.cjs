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

// yt-dlp runs JavaScript to solve YouTube's player challenge and only enables `deno` by default.
// Nothing here ships deno, so without this flag the extraction falls back to a client yt-dlp has
// already deprecated and loses formats — silently, since the call passes `--no-warnings`.
test('the YouTube resolve hands yt-dlp the bundled node as its JS runtime', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  let captured = null;
  childProcess.spawn = (_bin, args) => {
    captured = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('https://rr5---sn-example.googlevideo.com/videoplayback?itag=22\n'));
      child.emit('close', 0);
    });
    return child;
  };
  delete require.cache[require.resolve('../core/ytstream')];
  const { resolveStream } = require('../core/ytstream');
  try {
    const resolved = await resolveStream('hFldDZZcrQo');
    assert.equal(resolved.ok, true);
    const flag = captured.indexOf('--js-runtimes');
    assert.ok(flag >= 0, 'no --js-runtimes in the yt-dlp arguments');
    // `node:<path>`: yt-dlp splits on the FIRST colon, so a Windows drive letter stays in the path.
    assert.match(captured[flag + 1], /^node:.+node(\.exe)?$/i);
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

// YouTube refuse une part croissante de vidéos à un appelant sans session. La seconde passe lit les
// cookies d'un navigateur : elle doit rester RÉSERVÉE à ce refus-là. L'élargir à tout échec ferait
// ouvrir le trousseau de l'utilisateur pour une vidéo simplement privée ou supprimée.
test('only a bot check earns a second pass with browser cookies', () => {
  const { needsCookies } = require('../core/ytstream');
  for (const message of [
    "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser",
    'ERROR: HTTP Error 429: Too Many Requests',
    'ERROR: [youtube] abc: Sign in to confirm your age',
  ]) assert.equal(needsCookies(message), true, message);

  for (const message of [
    'ERROR: [youtube] abc: Private video',
    'ERROR: [youtube] abc: Video unavailable',
    'ERROR: unable to download video data: HTTP Error 403',
    '',
  ]) assert.equal(needsCookies(message), false, message);
});
