const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'reference', 'useBoardIngest.ts'), 'utf8');

test('online ingestion passes the global linked/download choice to the generic resolver', () => {
  assert.match(source, /resolveMedia\(url,\s*\{\s*download:\s*useBoard\.getState\(\)\.prefs\.autoDownloadOnline,?\s*\}\)/);
  assert.match(source, /res\.path\s*\?\?\s*res\.url/);
});

test('YouTube downloads only in automatic mode and AMVNews stays generic', () => {
  assert.match(source, /if\s*\(yt\s*&&\s*!prefs\.autoDownloadOnline\)/);
  assert.match(source, /if\s*\(yt\s*&&\s*prefs\.autoDownloadOnline\)/);
  assert.doesNotMatch(source, /amvnews/i);
});

test('every remote image and video keeps the user-entered source URL', () => {
  assert.match(source, /place\("image",\s*url,\s*url,\s*nat,\s*undefined,\s*at,\s*\{\s*sourceUrl\s*\}\)/);
  assert.match(source, /place\("video",\s*url,\s*url,\s*nat,\s*undefined,\s*at,\s*\{\s*sourceUrl\s*\}\)/);
  assert.match(source, /place\(res\.kind,\s*res\.path,\s*src,\s*nat,\s*undefined,\s*at,\s*\{\s*sourceUrl\s*\}\)/);
  assert.match(source, /addRemoteMedia\(gif,\s*"image",\s*at,\s*text\)/);
});
