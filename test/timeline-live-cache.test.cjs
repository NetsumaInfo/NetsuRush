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
  // No purge on open: a proxy is keyed by its RANGE, so a moved clip lands on a new key and the
  // untouched ones keep their files. The old destructive invalidation wiped them on every signature
  // move — constant on a timeline being edited in Resolve.
  assert.doesNotMatch(open, /invalidatePreviewRanges/);
  assert.match(open, /grid\.warmThumbs/);
  assert.doesNotMatch(open, /generateProxies|generateThumbs|Promise\.all/);
  assert.doesNotMatch(source, /refresh:\s*timelinesEpoch\s*>\s*0/);
  assert.match(source, /generateProxies/);
  assert.match(source, /openRequestRef/);
  assert.match(source, /if \(!isCurrent\(\)\) return/);
});

test('manual generation exposes queued work immediately instead of staying at zero', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'rushes', 'previewCache.ts'), 'utf8');
  assert.match(source, /started:\s*number/);
  // `started` counts what the run has CLAIMED, not what it has finished: the bar shows the queue
  // the instant the button is pressed instead of sitting at zero until the first encode lands.
  assert.match(source, /started:\s*claimed\.size/);
  assert.match(source, /claimed\.add\(key\)/);
  assert.match(source, /failed:\s*number/);
});

test('automatic thumbnail warming batches per file and is cancellable', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'rushes', 'previewCache.ts'), 'utf8');
  // One batch per FILE: the core keeps one current batch per file, so a grid spanning twenty
  // sources warms them all at once instead of queueing behind one another.
  assert.match(source, /const byFile = new Map<string, PreviewThumbRange\[\]>/);
  assert.match(source, /nr\.thumbsBatch\(path, group\.map/);
  // Each poll round only asks for what is STILL missing, and every poll is cancellable.
  assert.match(source, /const pending = \(\) => items\.filter\(\(it\) => !getThumb\(it\.path, it\.time\)\)/);
  assert.match(source, /warmPollsRef\.current\.add\(cancel\)/);
  assert.match(source, /warmPollsRef\.current\.forEach\(\(cancel\) => cancel\(\)\)/);
  // A round that brings nothing new slows the next one down, up to a ceiling; a round that makes
  // progress goes straight back to the short rhythm. A fixed interval re-sent the WHOLE missing list
  // every 1.5 s, which on a several-hundred-shot grid competed with the generation it waits for.
  assert.match(source, /delay = missing\.length < left \? WARM_THUMB_POLL_MS : Math\.min\(WARM_THUMB_POLL_MAX_MS, delay \* 2\)/);
  // A newer grid takes over: the stale run must not re-warm behind it.
  assert.match(source, /warmVersionRef\.current !== version/);
});

test('background snapshot refreshes are coalesced instead of stacking', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  assert.match(source, /snapshotBuildRef/);
  assert.match(source, /snapshotQueuedRef/);
});
