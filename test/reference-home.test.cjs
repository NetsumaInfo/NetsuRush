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

test('recent project cards reveal their netsu file from a context menu', () => {
  assert.match(source, /ContextMenuTrigger/);
  assert.match(source, /nr\.revealPath\(entry\.path\)/);
  assert.match(source, /nr\.openPath\(folder\)/);
  assert.match(source, /t\("home\.openProjectLocation"\)/);
});

test('file-backed and internal projects share thumbnail, modified label, and right-click open behavior', () => {
  const sceneCard = source.slice(source.indexOf('function SceneCard'), source.indexOf('// Carte d\'un projet'));
  const projectCard = source.slice(source.indexOf('function ProjectCard'), source.indexOf('// ---------- Composant principal'));
  assert.match(projectCard, /<ProjectThumb path=\{entry\.path\}/);
  assert.match(projectCard, /relDate\(entry\.modifiedAt\s*\?\?\s*entry\.openedAt\)/);
  assert.doesNotMatch(projectCard, /<p[^>]*>\{entry\.missing\s*\?[^:]+:\s*folder\}<\/p>/);
  assert.match(sceneCard, /ContextMenuItem[^]*home\.openProjectFile/);
  assert.match(sceneCard, /nr\.reference\?\.storagePath\(\)/);
  assert.match(sceneCard, /nr\.openPath\(storagePath\)/);
  assert.match(sceneCard, /home\.openProjectLocation/);
});

test('dropping a netsu opens it as a project before media ingestion', () => {
  assert.match(source, /\.name\.toLowerCase\(\)\.endsWith\("\.netsu"\)/);
  assert.match(source, /nr\.pathsForFiles\(\[projectFile\]\)/);
  assert.match(source, /onOpenRecent\(projectPath\)/);
  assert.ok(source.indexOf('.endsWith(".netsu")') < source.indexOf('f.type.startsWith("image/")'));
});
