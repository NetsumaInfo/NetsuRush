const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'rushes', 'TimelineLiveView.tsx'),
  'utf8',
);

test('Timeline Live right player reuses the exact card proxy request', () => {
  const playCut = source.slice(source.indexOf('async function playCut'), source.indexOf('const selCount'));
  assert.match(playCut, /grid\.getProxy\(c\.path, c\.in, c\.out, "high"\)/);
  assert.doesNotMatch(playCut, /requireVideo|nextProxyToken/);
});

test('shared Timeline Live proxy requests coalesce while generation is in flight', () => {
  const grid = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'rushes', 'useShotGrid.ts'),
    'utf8',
  );
  assert.match(grid, /proxyPendingRef = useRef<Map<string, Promise<string \| null>>>/);
  assert.match(grid, /const pending = proxyPendingRef\.current\.get\(k\);\s*if \(pending\) return pending;/);
  assert.match(grid, /proxyPendingRef\.current\.set\(k, request\)/);
});

test('Timeline Live double click opens the player without pinning playback inside the card', () => {
  const card = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'rushes', 'ShotCard.tsx'),
    'utf8',
  );
  assert.match(card, /onDoubleClick=\{onPlay\}/);
  assert.match(source, /play=\{grid\.gridPlay\}/);
  assert.doesNotMatch(source, /play=\{[^}]*playingId/);
});

test('collection cards also reserve inline playback for hover or autoplay', () => {
  const collection = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'collections', 'CollectionDetail.tsx'),
    'utf8',
  );
  assert.match(collection, /play=\{grid\.gridPlay\}/);
  assert.doesNotMatch(collection, /trimShot|setTrimShot|TrimDialog/);
  assert.doesNotMatch(collection, /playingId|setPlayingId/);
});

test('Timeline Live activates its first cut when a timeline opens', () => {
  assert.match(source, /if \(!activeCutId \|\| !visibleCuts\.some\(\(cut\) => cut\.id === activeCutId\)\)/);
  assert.match(source, /void playCut\(first\)/);
});

test('Timeline Live exposes the effective export timeline target in the top toolbar', () => {
  const occurrences = source.match(/<ExportTimelineTarget\b/g) || [];
  assert.equal(occurrences.length, 2, 'toolbar and export panel must edit the same profile target');
});
