// `folderTarget` : le profil range ses fichiers dans un sous-dossier de la destination choisie à
// l'export. Le sous-dossier est CRÉÉ (ffmpeg échouerait sur un chemin inexistant), le nom est
// assaini comme un nom de fichier, et une destination imposée par l'appelant n'est jamais déplacée.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyFolderTarget } = require('../core/export');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nr-folder-'));
}

test('un lot part dans le sous-dossier, qui est créé', () => {
  const dir = tmpdir();
  const out = applyFolderTarget({ folderTarget: 'Coupes' }, { dir });
  assert.strictEqual(out.dir, path.join(dir, 'Coupes'));
  assert.ok(fs.statSync(out.dir).isDirectory(), 'le dossier doit exister');
});

test('une sortie unique garde son nom, dans le sous-dossier', () => {
  const dir = tmpdir();
  const savePath = path.join(dir, 'plan_001.mp4');
  const out = applyFolderTarget({ folderTarget: 'Coupes' }, { savePath });
  assert.strictEqual(out.savePath, path.join(dir, 'Coupes', 'plan_001.mp4'));
  assert.ok(fs.existsSync(path.join(dir, 'Coupes')));
});

test('un nom qui remonterait hors de la destination est assaini', () => {
  const dir = tmpdir();
  for (const evil of ['../ailleurs', '..\\ailleurs', 'a/b', 'a\\b']) {
    const out = applyFolderTarget({ folderTarget: evil }, { dir });
    assert.ok(out.dir.startsWith(dir + path.sep), `${evil} sort de la destination : ${out.dir}`);
    assert.strictEqual(path.dirname(out.dir), dir, `${evil} doit rester à un niveau`);
  }
});

test('un nom fait uniquement de points ne range rien', () => {
  const dir = tmpdir();
  for (const dots of ['.', '..', '...']) {
    assert.deepStrictEqual(applyFolderTarget({ folderTarget: dots }, { dir }), {}, dots);
  }
});

test('sans rangement demandé, la destination est intacte', () => {
  const dir = tmpdir();
  assert.deepStrictEqual(applyFolderTarget({}, { dir }), {});
  assert.deepStrictEqual(applyFolderTarget({ folderTarget: null }, { dir }), {});
  assert.deepStrictEqual(applyFolderTarget({ folderTarget: '   ' }, { dir }), {});
});

test('des destinations imposées (archivage d\'une collection) ne sont jamais déplacées', () => {
  const dir = tmpdir();
  const savePaths = [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')];
  assert.deepStrictEqual(applyFolderTarget({ folderTarget: 'Coupes' }, { savePaths }), {});
  assert.ok(!fs.existsSync(path.join(dir, 'Coupes')), 'aucun dossier ne doit être créé');
});

test('sans destination du tout, rien à ranger', () => {
  assert.deepStrictEqual(applyFolderTarget({ folderTarget: 'Coupes' }, {}), {});
});
