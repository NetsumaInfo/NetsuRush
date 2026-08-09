// Le Carnet comme document .netsu : « Enregistrer sous… », médias dans le dossier compagnon,
// et le déménagement qui ne laisse pas deux copies derrière lui.
//
// Ce qui est verrouillé ici : le carnet GARDE son id (sinon ses pages, ses mentions et ses
// sous-pages désignent un carnet disparu), la corbeille suit, les médias deviennent relatifs, et le
// carnet d'origine quitte NR_HOME — c'est la décision « fichier seul », et sans test elle se défait
// à la première refonte.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'netsu-nb-home-'));
process.env.NR_HOME = home; // recents.json ne doit pas atterrir dans le vrai NR_HOME

const { createNotebookStore } = require('../core/notebook');
const sidecar = require('../core/netsu/sidecar');
const sessions = require('../core/netsu/session');

/** Magasin neuf sur un dossier de données jetable + un dossier de projets. */
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netsu-nb-'));
  const store = createNotebookStore(root);
  const projectsDir = path.join(root, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  return { root, store, projectsDir, assetsDir: path.join(root, 'notebook', 'assets') };
}

const MEDIA = { prefix: 'http://127.0.0.1:8730/media?p=', suffix: '&tk=x' };
const mediaUrl = (abs) => `${MEDIA.prefix}${encodeURIComponent(abs)}${MEDIA.suffix}`;

test('« enregistrer sous » déménage le carnet : même id, corbeille comprise, plus rien dans NR_HOME', () => {
  const { store, projectsDir } = workspace();
  const nb = store.saveNotebook({ title: 'Mon carnet' });
  store.savePage({ notebookId: nb.id, id: 'p1', title: 'Page une', blocks: [{ type: 'paragraph' }], orderIdx: 1 });
  store.savePage({ notebookId: nb.id, id: 'p2', title: 'Poubelle', blocks: [], orderIdx: 2 });
  store.deletePage('p2'); // corbeille (suppression douce)

  const dest = path.join(projectsDir, 'carnet.netsu');
  const res = store.saveProjectAs({ notebookId: nb.id, destPath: dest, url: MEDIA });
  try {
    assert.equal(res.ok, true);
    assert.equal(res.notebookId, nb.id, 'le carnet garde son id en déménageant');
    assert.equal(fs.existsSync(dest), true);

    // Le carnet répond maintenant depuis le FICHIER, et une seule fois dans la liste.
    assert.equal(store.listNotebooks().filter((n) => n.id === nb.id).length, 1);
    assert.equal(store.projectOf(nb.id).path, dest);
    assert.equal(store.loadNotebook(nb.id).pages.length, 1); // p2 est à la corbeille
    assert.equal(store.trashList(nb.id).length, 1, 'la corbeille suit le déménagement');
    assert.equal(store.loadPage('p1').page.title, 'Page une');
  } finally {
    store.closeAllProjects();
  }

  // Le document est parti de NR_HOME : deux copies du même carnet divergeraient dès la frappe.
  const reopened = createNotebookStore(path.dirname(path.dirname(dest)));
  assert.equal(reopened.listNotebooks().some((n) => n.id === nb.id), false);
});

test('la frappe écrit dans le fichier, pas dans NR_HOME', () => {
  const { store, projectsDir } = workspace();
  const nb = store.saveNotebook({ title: 'Carnet' });
  store.savePage({ notebookId: nb.id, id: 'p1', title: 'Avant', blocks: [], orderIdx: 1 });
  const dest = path.join(projectsDir, 'carnet.netsu');
  store.saveProjectAs({ notebookId: nb.id, destPath: dest, url: MEDIA });
  try {
    store.savePage({ notebookId: nb.id, id: 'p1', title: 'Après', blocks: [{ type: 'paragraph' }], orderIdx: 1 });
    store.closeProject(dest);

    // Relu depuis le fichier seul : la modification y est bien.
    const fresh = createNotebookStore(fs.mkdtempSync(path.join(os.tmpdir(), 'netsu-nb-other-')));
    const opened = fresh.openProject(dest, MEDIA);
    assert.equal(opened.ok, true);
    assert.equal(fresh.loadPage('p1').page.title, 'Après');
    fresh.closeAllProjects();
  } finally {
    store.closeAllProjects();
  }
});

test('les médias déménagent dans le dossier compagnon et sont rangés en chemin relatif', () => {
  const { store, projectsDir, assetsDir } = workspace();
  const asset = store.saveAsset(Buffer.from('des octets d’image'), 'png');
  assert.equal(asset.ok, true);
  assert.equal(asset.path.startsWith(assetsDir), true);

  const nb = store.saveNotebook({ title: 'Carnet' });
  store.savePage({
    notebookId: nb.id,
    id: 'p1',
    title: 'Avec image',
    blocks: [{ type: 'image', props: { url: mediaUrl(asset.path) } }],
    orderIdx: 1,
  });

  const dest = path.join(projectsDir, 'carnet.netsu');
  assert.equal(store.saveProjectAs({ notebookId: nb.id, destPath: dest, url: MEDIA }).ok, true);
  try {
    const companion = path.join(sidecar.sidecarDirFor(dest), path.basename(asset.path));
    assert.equal(fs.existsSync(companion), true, 'le média est copié à côté du fichier');

    // Sur disque, un token — pas de chemin absolu, sinon le carnet perdrait ses images en déménageant.
    const session = sessions.getSession(dest);
    const stored = session.handle.db.prepare('SELECT data FROM page WHERE id = ?').get('p1');
    assert.match(String(stored.data), /netsu-asset:\/\//);
    assert.doesNotMatch(String(stored.data), /media\?p=/);

    // À la lecture, l'URL est reconstruite vers le dossier compagnon COURANT.
    const url = String(store.loadPage('p1').page.blocks[0].props.url);
    assert.equal(url.startsWith(MEDIA.prefix), true);
    assert.equal(decodeURIComponent(url.slice(MEDIA.prefix.length, url.indexOf('&tk='))), companion);
  } finally {
    store.closeAllProjects();
  }
});

test('déplacer le carnet avec son dossier compagnon ne casse aucune image', () => {
  const { store, projectsDir } = workspace();
  const asset = store.saveAsset(Buffer.from('octets'), 'png');
  const nb = store.saveNotebook({ title: 'Carnet' });
  store.savePage({
    notebookId: nb.id, id: 'p1', title: 'P',
    blocks: [{ type: 'image', props: { url: mediaUrl(asset.path) } }], orderIdx: 1,
  });
  const dest = path.join(projectsDir, 'carnet.netsu');
  store.saveProjectAs({ notebookId: nb.id, destPath: dest, url: MEDIA });
  store.closeAllProjects();

  const movedDir = path.join(projectsDir, 'ailleurs');
  fs.mkdirSync(movedDir, { recursive: true });
  const moved = path.join(movedDir, 'carnet.netsu');
  fs.copyFileSync(dest, moved);
  fs.cpSync(sidecar.sidecarDirFor(dest), sidecar.sidecarDirFor(moved), { recursive: true });

  const fresh = createNotebookStore(fs.mkdtempSync(path.join(os.tmpdir(), 'netsu-nb-moved-')));
  try {
    assert.equal(fresh.openProject(moved, MEDIA).ok, true);
    const url = String(fresh.loadPage('p1').page.blocks[0].props.url);
    const abs = decodeURIComponent(url.slice(MEDIA.prefix.length, url.indexOf('&tk=')));
    assert.equal(abs.startsWith(sidecar.sidecarDirFor(moved)), true);
    assert.equal(fs.existsSync(abs), true);
  } finally {
    fresh.closeAllProjects();
  }
});

test('un .netsu de board n’est pas un carnet : refusé, pas ouvert vide', async () => {
  const { store, projectsDir } = workspace();
  const boardFile = path.join(projectsDir, 'board.netsu');
  const { saveBoardProject } = require('../core/netsu/project');
  const session = sessions.openSession(boardFile, { create: true });
  await saveBoardProject({
    session,
    refStore: { assetsDir: projectsDir, isAppAsset: () => false },
    scene: { name: 'B', items: [] },
  });
  sessions.closeSession(boardFile);

  const res = store.openProject(boardFile, MEDIA);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /board/);
  store.closeAllProjects();
});
