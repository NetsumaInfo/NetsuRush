const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'netsu-recents-'));
process.env.NR_HOME = home;
const { createReferenceStore } = require('../core/reference');
const netsu = require('../core/netsu');
const recents = require('../core/netsu/recents');

test.after(() => netsu.closeAllProjects());

test('Save As removes the internal source only after saving and remembers its identity', async () => {
  const refStore = createReferenceStore(home);
  const source = refStore.saveScene({ name: 'Projet', items: [], view: null });
  const destPath = path.join(home, 'Projet.netsu');
  const result = await netsu.saveProjectAs(refStore, {
    scene: { name: 'Projet', items: [], view: null },
    destPath,
    sourceSceneId: source.id,
  });
  assert.equal(result.ok, true);
  assert.equal(refStore.loadScene(source.id), null);
  assert.equal(netsu.recentProjects('board').length, 1);
  assert.equal(netsu.recentProjects('board')[0].sourceSceneId, source.id);
  const opened = await netsu.openProject(refStore, destPath);
  assert.equal(opened.readonly, false);
  assert.equal(netsu.recentProjects('board')[0].sourceSceneId, source.id);
});

test('failed Save As leaves the internal source untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netsu-recents-fail-'));
  const refStore = createReferenceStore(root);
  const source = refStore.saveScene({ name: 'À garder', items: [], view: null });
  const result = await netsu.saveProjectAs(refStore, {
    scene: { name: 'À garder', items: [], view: null },
    destPath: '',
    sourceSceneId: source.id,
  });
  assert.equal(result.ok, false);
  assert.notEqual(refStore.loadScene(source.id), null);
});

test('legacy Save As identity is recovered from content without hiding an unrelated same-title scene', async () => {
  const refStore = createReferenceStore(home);
  const legacy = refStore.saveScene({
    name: 'Legacy',
    items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'newer' }],
    view: null,
  });
  const unrelated = refStore.saveScene({
    name: 'Legacy',
    items: [{ id: 'x' }, { id: 'y' }, { id: 'z' }],
    view: null,
  });
  const destPath = path.join(home, 'Legacy.netsu');
  const saved = await netsu.saveProjectAs(refStore, {
    scene: { name: 'Legacy', items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], view: null },
    destPath,
  });
  assert.equal(saved.ok, true);

  const absolute = path.resolve(destPath);
  const before = recents.list('board').find((entry) => entry.path === absolute);
  assert.ok(before, JSON.stringify(recents.list('board')));
  assert.equal(before.sourceSceneId, undefined);

  const entry = netsu.recentProjects(refStore, 'board').find((item) => item.path === absolute);
  assert.equal(entry.sourceSceneId, legacy.id);
  assert.notEqual(entry.sourceSceneId, unrelated.id);
  assert.equal(entry.openedAt, before.openedAt);
  assert.ok(entry.modifiedAt > 0);

  const persisted = recents.list('board').find((item) => item.path === absolute);
  assert.equal(persisted.sourceSceneId, legacy.id);
  assert.equal(persisted.openedAt, before.openedAt);

  const preview = netsu.previewProject(refStore, destPath);
  assert.equal(preview.ok, true);
  assert.equal(preview.scene.items.length, 3);
  assert.equal(recents.list('board').find((item) => item.path === absolute).openedAt, before.openedAt);
});

test('deleting a saved project removes its netsu file, journals, companion media, and recent entry', () => {
  const projectPath = path.join(home, 'À supprimer.netsu');
  const mediaDir = path.join(home, 'À supprimer.medias');
  const externalRush = path.join(home, 'rush-externe.mov');
  fs.writeFileSync(projectPath, 'project');
  fs.writeFileSync(`${projectPath}-wal`, 'wal');
  fs.writeFileSync(`${projectPath}-shm`, 'shm');
  fs.mkdirSync(path.join(mediaDir, 'videos'), { recursive: true });
  fs.writeFileSync(path.join(mediaDir, 'videos', 'clip.mp4'), 'media');
  fs.writeFileSync(externalRush, 'rush');
  recents.remember({ path: projectPath, title: 'À supprimer', type: 'board' });

  const result = netsu.deleteProject(projectPath);

  assert.equal(result.ok, true, result.error);
  assert.equal(fs.existsSync(projectPath), false);
  assert.equal(fs.existsSync(`${projectPath}-wal`), false);
  assert.equal(fs.existsSync(`${projectPath}-shm`), false);
  assert.equal(fs.existsSync(mediaDir), false);
  assert.equal(fs.existsSync(externalRush), true, 'external source media must never be deleted');
  assert.equal(recents.list('board').some((entry) => entry.path === path.resolve(projectPath)), false);
});

test('the board deletion channel refuses non-board netsu documents', () => {
  const notebookPath = path.join(home, 'Carnet.netsu');
  const mediaDir = path.join(home, 'Carnet.medias');
  fs.writeFileSync(notebookPath, 'notebook');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, 'page.png'), 'media');
  recents.remember({ path: notebookPath, title: 'Carnet', type: 'notebook' });

  const result = netsu.deleteProject(notebookPath);

  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(notebookPath), true);
  assert.equal(fs.existsSync(mediaDir), true);
});

test('board recents display the netsu filename instead of a stale stored scene title', () => {
  const projectPath = path.join(home, 'Nom du fichier.netsu');
  fs.writeFileSync(projectPath, 'project');
  recents.remember({ path: projectPath, title: 'Sans titre', type: 'board' });

  const entry = recents.list('board').find((item) => item.path === path.resolve(projectPath));

  assert.equal(entry.title, 'Nom du fichier');
});
