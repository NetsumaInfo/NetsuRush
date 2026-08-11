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
  assert.match(source, /nr\.reference\?\.storagePath\(\)/);
  assert.match(source, /nr\.openPath\(storagePath\)/);
  assert.match(sceneCard, /home\.openProjectLocation/);
});

test('file-backed projects use the same favorite and trash overlays as internal projects', () => {
  const projectCard = source.slice(source.indexOf('function ProjectCard'), source.indexOf('// ---------- Composant principal'));
  assert.match(projectCard, /isFavorite/);
  assert.match(projectCard, /onToggleFavorite/);
  assert.match(projectCard, /actions\.addFavorite/);
  assert.match(projectCard, /<Star[^>]*fill=\{isFavorite/);
  assert.match(projectCard, /<Trash2 className="size-3\.5"/);
  assert.doesNotMatch(projectCard, /<X[\s>]/);
  assert.match(source, /projectFavoriteKey\(entry\.path\)/);
});

test('the saved-project trash overlay asks before removing the recent entry', () => {
  const projectCard = source.slice(source.indexOf('function ProjectCard'), source.indexOf('// ---------- Composant principal'));
  assert.match(projectCard, /<DropdownMenu>/);
  assert.match(projectCard, /aria-label=\{t\("home\.deleteOptions"\)\}/);
  assert.match(projectCard, /<DropdownMenuItem[^]*onForget\(\)[^]*home\.forgetProject/);
  assert.doesNotMatch(projectCard, /<button[^>]*aria-label=\{t\("home\.forgetProject"\)\}[^>]*onClick=\{onForget\}/);
});

test('saved projects offer permanent deletion behind a destructive confirmation', () => {
  const projectCard = source.slice(source.indexOf('function ProjectCard'), source.indexOf('// ---------- Composant principal'));
  assert.match(projectCard, /home\.deleteProject/);
  assert.match(projectCard, /home\.deleteProjectTitle/);
  assert.match(projectCard, /home\.deleteProjectWarning/);
  assert.match(projectCard, /<ConfirmDialog/);
  assert.match(projectCard, /onConfirm=\{onDelete\}/);
  assert.match(projectCard, /<DropdownMenuSeparator\s*\/>/);
});

test('dropping a netsu opens it as a project before media ingestion', () => {
  assert.match(source, /\.name\.toLowerCase\(\)\.endsWith\("\.netsu"\)/);
  assert.match(source, /nr\.pathsForFiles\(\[projectFile\]\)/);
  assert.match(source, /onOpenRecent\(projectPath\)/);
  assert.ok(source.indexOf('.endsWith(".netsu")') < source.indexOf('f.type.startsWith("image/")'));
});

// `dragDropEnabled` reste à false : le drag-drop Tauri ne se déclenche jamais, et un board déposé
// qui n'aboutit pas doit se voir — l'accueil n'a aucune barre d'outils pour porter la notice.
test('the home drop path stays on the DOM event and reports a failed project open', () => {
  assert.doesNotMatch(source, /onDragDropEvent/);
  assert.match(source, /logError\("board:home"/);
  assert.match(source, /setNotice\(\{ kind: "error", text: t\("notice\.dropProjectFailed"/);
  assert.match(source, /const notice = useBoard\(\(s\) => s\.notice\)/);
});

test('the home exposes one netsu project opener and no archive import action', () => {
  const home = source.slice(source.indexOf('// ---------- Composant principal ----------'));
  assert.equal((home.match(/onClick=\{onOpenProject\}/g) || []).length, 1);
  assert.doesNotMatch(home, /onImport/);
  assert.doesNotMatch(home, /home\.importNetsu/);
  assert.doesNotMatch(home, /home\.importBoard/);
});
