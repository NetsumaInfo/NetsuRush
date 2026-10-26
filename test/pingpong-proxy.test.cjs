const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pingpongPlan, pingpongInput, pingpongGraph } = require('../core/proxy');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// The `reverse` filter keeps the whole range decoded in memory: the height drops as the range grows,
// and a range that fits no tier is refused instead of being attempted.
test('a ping-pong range is encoded at the tallest tier its frames fit in', () => {
  assert.equal(pingpongPlan(4, 720).height, 720);
  assert.equal(pingpongPlan(4, 1080).height, 720);
  assert.equal(pingpongPlan(4, 300).height, 360);
  assert.ok(pingpongPlan(30, 720).height < 720);
  assert.equal(pingpongPlan(45, 720).height, 360);
});

test('a range too long to reverse in memory is refused', () => {
  assert.equal(pingpongPlan(600, 720), null);
  assert.equal(pingpongPlan(0, 720), null);
  assert.equal(pingpongPlan(Number.NaN, 720), null);
});

// ffmpeg reads what this function returns: a renderer must not be able to point it at an arbitrary URL.
test('ffmpeg only reads a local file or the core YouTube relay', () => {
  assert.equal(pingpongInput('C:\\clips\\shot.mp4').key, 'C:\\clips\\shot.mp4');
  const relayed = pingpongInput('http://127.0.0.1:47650/ytstream?id=dQw4w9WgXcQ&tk=secret');
  assert.equal(relayed.key, 'ytstream:dQw4w9WgXcQ');
  assert.equal(relayed.source, null);
  assert.equal(pingpongInput('https://example.com/video.mp4'), null);
  assert.equal(pingpongInput('http://127.0.0.1:47650/media?p=C:%5Csecret'), null);
  assert.equal(pingpongInput('http://evil.test/ytstream?id=dQw4w9WgXcQ'), null);
  assert.equal(pingpongInput(''), null);
});

test('the file runs the range forwards, then backwards without repeating the turn-around frame', () => {
  const graph = pingpongGraph(480);
  assert.match(graph, /scale=-2:480/);
  assert.match(graph, /reverse,trim=start_frame=1/);
  assert.match(graph, /concat=n=2:v=1:a=0\[v\]$/);
});

// An older core ignores `pingpong` and answers with a forward proxy: the board must not loop that as
// if it were the reversal.
test('the board only plays a file the core marked as a ping-pong', () => {
  assert.match(read('core/rpc.js'), /opts\?\.pingpong \? proxy\.pingpongSegment\(opts\)/);
  assert.match(read('src/components/reference/BoardItem.tsx'), /r\.ok && r\.pingpong && r\.path/);
});
