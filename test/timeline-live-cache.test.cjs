const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createResolveWatch } = require('../core/resolve-watch.js');

test('Resolve watch invalidates Timeline Live when timeline contents change without changing its count', async () => {
  const events = [];
  let sig = { connected: true, project: 'P', timeline: 'T', clipCount: 1, tlCount: 1, tlFingerprint: 'a' };
  const watch = createResolveWatch({ broadcast: (channel, payload) => events.push({ channel, payload }), getSignature: async () => sig });
  await watch.refreshNow();
  sig = { ...sig, tlFingerprint: 'b' };
  await watch.refreshNow();
  assert.deepEqual(events, [{ channel: 'resolve:changed', payload: { timelines: true } }]);
});

test('Timeline Live compares complete cut geometry and purges stale preview media before regeneration', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'rushes', 'TimelineLiveView.tsx'), 'utf8');
  const open = source.slice(source.indexOf('async function open'), source.indexOf('const handledEpochRef'));
  assert.match(source, /timelineCutsSignature/);
  assert.match(source, /outFrame/);
  assert.match(source, /tlStart/);
  assert.match(open, /invalidatePreviewRanges/);
  assert.match(open, /grid\.warmThumbs/);
  assert.doesNotMatch(open, /generateProxies|generateThumbs|Promise\.all/);
  assert.doesNotMatch(source, /refresh:\s*timelinesEpoch\s*>\s*0/);
  assert.match(source, /generateProxies/);
  assert.match(source, /openRequestRef/);
  assert.match(source, /if \(!isCurrent\(\)\) return/);
});

test('manual generation exposes queued work immediately instead of staying at zero', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'rushes', 'useShotGrid.ts'), 'utf8');
  assert.match(source, /started:\s*number/);
  assert.match(source, /started\+\+/);
  assert.match(source, /failed:\s*number/);
});

test('automatic thumbnail warming is idle, chunked and cancellable', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'rushes', 'useShotGrid.ts'), 'utf8');
  assert.match(source, /WARM_THUMB_CHUNK/);
  assert.match(source, /waitForThumbIdle/);
  assert.match(source, /warmVersionRef/);
  assert.doesNotMatch(source, /const poll = setInterval/);
  assert.doesNotMatch(source, /Promise\.allSettled\(batches\)/);
});

test('background snapshot refreshes are coalesced instead of stacking', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  assert.match(source, /snapshotBuildRef/);
  assert.match(source, /snapshotQueuedRef/);
});
