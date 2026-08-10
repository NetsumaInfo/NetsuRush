const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

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
