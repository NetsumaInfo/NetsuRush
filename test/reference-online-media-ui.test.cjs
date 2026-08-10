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
