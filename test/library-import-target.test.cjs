// Destination d'un import de bibliothèque. Un rush lâché SUR un dossier doit s'y ranger : sans
// destination explicite, tout retombait à la racine « Importés » et le geste semblait sans effet.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLibraryStore } = require('../core/library');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-lib-'));
  // Sondes muettes : le test porte sur le RANGEMENT, pas sur les métadonnées.
  return { dir, store: createLibraryStore(dir, {}) };
}

// Fichiers factices : la bibliothèque n'indexe que des chemins, elle ne lit jamais les octets.
function media(dir, ...names) {
  return names.map((n) => {
    const p = path.join(dir, n);
    fs.writeFileSync(p, '');
    return p;
  });
}

test('des fichiers importés dans un dossier y restent', async () => {
  const { dir, store } = tmpStore();
  const folder = store.saveFolder({ name: 'Anime' });
  assert.equal(folder.ok, true);
  const files = media(dir, 'a.mp4', 'b.mp4');

  assert.equal((await store.addPaths(files, folder.id)).added, 2);
  const items = store.listItems();
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.folderId === folder.id));
});

// Un dossier peut disparaître entre le début du glisser et le dépôt (suppression dans une autre
// fenêtre) : le rush doit atterrir à la racine, jamais dans un dossier fantôme invisible.
test('un dossier inconnu retombe sur la racine', async () => {
  const { dir, store } = tmpStore();
  await store.addPaths(media(dir, 'c.mp4'), 'dossier-mort');
  assert.equal(store.listItems()[0].folderId, null);
});

test('sans destination, un import va à la racine', async () => {
  const { dir, store } = tmpStore();
  await store.addPaths(media(dir, 'd.mp4'));
  assert.equal(store.listItems()[0].folderId, null);
});

test("un dossier déposé sur un dossier devient son enfant, avec son arborescence", async () => {
  const { dir, store } = tmpStore();
  const parent = store.saveFolder({ name: 'Projets' });
  const root = path.join(dir, 'Saison 1');
  fs.mkdirSync(path.join(root, 'OP'), { recursive: true });
  media(root, path.join('OP', 'op.mp4'));

  assert.equal((await store.addDir(root, parent.id)).added, 1);
  const folders = store.listFolders();
  const saison = folders.find((f) => f.name === 'Saison 1');
  const op = folders.find((f) => f.name === 'OP');
  assert.equal(saison.parentId, parent.id);
  assert.equal(op.parentId, saison.id);
  assert.equal(store.listItems()[0].folderId, op.id);
});
