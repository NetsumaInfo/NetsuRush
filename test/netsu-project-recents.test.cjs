const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'netsu-recents-'));
process.env.NR_HOME = home;
const { createReferenceStore } = require('../core/reference');
const netsu = require('../core/netsu');

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
