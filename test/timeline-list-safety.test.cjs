const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('timeline target reads the live-or-cached timeline channel without a renderer status gate', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'components', 'export', 'ExportTimelineTarget.tsx'), 'utf8');
  // Le sélecteur charge la liste dès qu'il est utilisable, et JAMAIS derrière l'état `connected` du
  // Media Pool : l'API Resolve répond alors que ce drapeau est encore faux.
  assert.match(source, /useTimelineList\(!disabled\)/);
  assert.doesNotMatch(source, /useTimelineList\([^)]*connected[^)]*\)/);
});

test('timeline list keeps valid data when a transient live read fails', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'components', 'rushes', 'useTimelineList.ts'), 'utf8');
  assert.match(source, /if \([^\n]*r\.ok\) \{[\s\S]*?setTimelines\(r\.timelines \|\| \[\]\);[\s\S]*?setCurrent\(r\.current \?\? null\);[\s\S]*?\}/);
  assert.doesNotMatch(source, /if \(!r\.ok\)[^{\n]*setTimelines\(\[\]\)/);
  assert.match(source, /\[enabled, adobe\.active, timelinesEpoch, project, openTimeline\]/);
  assert.match(source, /snapshotState\.project === requestProject/);
});

test('an open Resolve timeline is always represented in the returned list', () => {
  const source = fs.readFileSync(path.join(root, 'core', 'timeline.js'), 'utf8');
  assert.match(source, /if \(curName && !timelines\.some\(\(timeline\) => timeline\.name === curName\)\)/);
});
