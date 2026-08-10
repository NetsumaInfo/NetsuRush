const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'reference', 'ReferenceHome.tsx'), 'utf8');

test('NetsuBoard home renders projects only inside one Recent section', () => {
  assert.doesNotMatch(source, /t\("home\.projects"\)/);
  assert.equal((source.match(/t\("home\.recent"\)/g) || []).length, 1);
  const recentSection = source.slice(source.indexOf('{t("home.recent")}'));
  assert.match(recentSection, /projects\.map\(\(entry\)\s*=>/);
  assert.match(recentSection, /<ProjectCard/);
});

test('file-backed source scenes are filtered from internal recents', () => {
  assert.match(source, /projectSceneIds/);
  assert.match(source, /!projectSceneIds\.has\(s\.id\)/);
});
