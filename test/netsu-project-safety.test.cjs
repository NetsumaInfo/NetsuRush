// Ce qu'un enregistrement n'a PAS le droit de faire : effacer des octets que le board peut encore
// réclamer, et laisser un fichier partagé raconter la machine de son expéditeur.
//
// Les quatre promesses verrouillées ici sont celles qui coûtaient des pixels :
//   1. le média d'avant un upscale est rangé et gardé comme n'importe quel média du projet ;
//   2. ce que retient l'historique d'annulation survit au ménage de fin d'enregistrement ;
//   3. un projet ne garde pas les octets embarqués qu'il vient de recopier auprès de lui ;
//   4. un fichier PARTAGÉ n'emporte ni chemin absolu, ni média mort.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sessions = require('../core/netsu/session');
const sidecar = require('../core/netsu/sidecar');
const relocate = require('../core/netsu/relocate');
const { openNetsu } = require('../core/netsu/db');
const { saveBoardProject, readBoardProject } = require('../core/netsu/project');
const { writeBoardDoc, readBoardDoc } = require('../core/netsu/board');

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netsu-safety-'));
  const assetsDir = path.join(root, 'assets');
  const projectsDir = path.join(root, 'projects');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  const refStore = {
    assetsDir,
    isAppAsset: (p) => path.resolve(String(p || '')).toLowerCase().startsWith(assetsDir.toLowerCase() + path.sep),
    fetchAsset: async () => ({ ok: false }),
  };
  return { root, assetsDir, projectsDir, refStore };
}

function writeFile(dir, name, bytes) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, Buffer.from(bytes));
  return target;
}

const image = (id, ref, extra) => ({
  id, kind: 'image', ref, x: 0, y: 0, w: 100, h: 100, z: 0, title: id, ...extra,
});

/** Fichiers présents dans le dossier compagnon, en chemins relatifs. */
function companionFiles(netsuPath) {
  const dir = sidecar.sidecarDirFor(netsuPath);
  const out = [];
  const walk = (current, base) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = base ? path.join(base, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

test('le média d’avant un upscale est rangé auprès du projet, pas effacé par le ménage', async () => {
  const { assetsDir, projectsDir, refStore } = workspace();
  const file = path.join(projectsDir, 'upscale.netsu');
  const session = sessions.openSession(file, { create: true });
  try {
    const original = writeFile(assetsDir, 'plan.png', 'original');
    const upscaled = writeFile(assetsDir, 'plan-up.png', 'x2 x2 x2');
    const scene = {
      name: 'Upscale',
      items: [image('a', upscaled, { prevMedia: { kind: 'image', ref: original, src: 'http://127.0.0.1:1/media' } })],
      view: null,
    };

    const saved = await saveBoardProject({ session, refStore, scene });
    assert.equal(saved.ok, true);
    // Les DEUX versions vivent auprès du fichier : celle affichée et celle où l'on peut revenir.
    assert.equal(companionFiles(file).length, 2);

    const read = readBoardProject({ session, refStore });
    const item = read.scene.items[0];
    assert.ok(sidecar.isInSidecar(file, item.prevMedia.ref), 'le média d’avant doit être un fichier du projet');
    assert.equal(fs.readFileSync(item.prevMedia.ref, 'utf8'), 'original');
    // La `src` d'affichage ne se persiste pas : elle se recalcule au chargement.
    assert.equal(item.prevMedia.src, '');

    // Un deuxième enregistrement ne doit pas se mettre à effacer ce qu'il vient de ranger.
    await saveBoardProject({ session, refStore, scene: read.scene });
    assert.equal(fs.existsSync(item.prevMedia.ref), true);
  } finally {
    sessions.closeSession(file);
  }
});

test('un média retenu par l’historique d’annulation survit à la suppression de son item', async () => {
  const { assetsDir, projectsDir, refStore } = workspace();
  const file = path.join(projectsDir, 'undo.netsu');
  const session = sessions.openSession(file, { create: true });
  try {
    const pasted = writeFile(assetsDir, 'collee.png', 'octets collés');
    const withItem = { name: 'Undo', items: [image('a', pasted)], view: null };
    await saveBoardProject({ session, refStore, scene: withItem });
    const kept = path.join(sidecar.sidecarDirFor(file), companionFiles(file)[0]);
    assert.equal(fs.existsSync(kept), true);

    // Item supprimé, mais l'historique le tient encore : l'autosave qui suit ne doit pas emporter
    // ses octets, sinon le Ctrl+Z d'après rend une tuile vide.
    await saveBoardProject({ session, refStore, scene: { name: 'Undo', items: [], view: null, retain: [kept] } });
    assert.equal(fs.existsSync(kept), true);

    // Historique vidé (le board a dépassé la profondeur, ou une nouvelle scène a été chargée) :
    // là, plus personne ne réclame ces octets et ils partent. Le board garde un item — un document
    // vidé d'un coup est presque toujours un board pas encore chargé, et le ménage s'en abstient.
    const note = { id: 'n', kind: 'text', x: 0, y: 0, w: 100, h: 40, z: 0, text: 'reste' };
    await saveBoardProject({ session, refStore, scene: { name: 'Undo', items: [note], view: null, retain: [] } });
    assert.equal(fs.existsSync(kept), false);
  } finally {
    sessions.closeSession(file);
  }
});

test('un partage ouvert puis enregistré ne garde pas les octets qu’il vient de recopier', async () => {
  const { root, projectsDir, refStore } = workspace();
  const shared = path.join(projectsDir, 'recu.netsu');
  const source = writeFile(root, 'rush.png', 'des octets partagés');

  // Fabrication d'un fichier de partage qui EMBARQUE son média (niveau « fichier entier »).
  const writer = openNetsu(shared);
  await writeBoardDoc({
    handle: writer,
    refStore,
    scene: { name: 'Reçu', items: [image('a', source)], view: null },
    defaults: { level: 'full' },
  });
  assert.equal(writer.db.prepare('SELECT count(*) AS n FROM blobs').get().n, 1);
  writer.close();

  const session = sessions.openSession(shared, { create: false });
  try {
    const read = readBoardProject({ session, refStore });
    const saved = await saveBoardProject({ session, refStore, scene: read.scene });
    assert.equal(saved.ok, true);

    // Le média est désormais rangé auprès du fichier : garder EN PLUS ses octets dans le conteneur
    // ferait payer deux fois le même plan, pour toujours.
    assert.equal(companionFiles(shared).length, 1);
    assert.equal(session.handle.db.prepare('SELECT count(*) AS n FROM blobs').get().n, 0);
    assert.equal(session.handle.db.prepare('SELECT count(*) AS n FROM blob_chunks').get().n, 0);
    assert.ok(saved.counts.freed > 0, 'le ménage doit annoncer les octets rendus');

    const after = readBoardProject({ session, refStore });
    assert.equal(fs.readFileSync(after.scene.items[0].ref, 'utf8'), 'des octets partagés');
  } finally {
    sessions.closeSession(shared);
  }
});

test('un fichier partagé n’emporte ni chemin absolu ni média mort', async () => {
  const { root, projectsDir, refStore } = workspace();
  const dest = path.join(projectsDir, 'partage.netsu');
  const source = writeFile(root, 'rush-a-moi.png', 'contenu');
  const disparu = path.join(root, 'jamais-envoye.png');

  const handle = openNetsu(dest);
  try {
    await writeBoardDoc({
      handle,
      refStore,
      scene: {
        name: 'Partage',
        items: [
          image('a', source, { prevMedia: { kind: 'image', ref: disparu, src: 'x', sourceUrl: 'https://exemple.test/a.png' } }),
          image('b', source, { prevMedia: { kind: 'image', ref: disparu, src: 'x' } }),
        ],
        view: null,
      },
      defaults: { level: 'full' },
    });

    // La fiche du média d'origine reste (nom, taille, empreinte : de quoi relocaliser), mais son
    // chemin sur la machine de l'expéditeur n'a rien à faire dans un fichier qu'on envoie.
    const media = handle.db.prepare('SELECT path, name, size FROM media').all();
    assert.ok(media.length >= 1);
    for (const row of media) {
      assert.equal(String(row.path || ''), '');
      assert.equal(String(row.name), 'rush-a-moi.png');
      assert.ok(Number(row.size) > 0);
    }

    const items = readBoardDoc({ handle, refStore }).scene.items;
    const byId = Object.fromEntries(items.map((it) => [it.id, it]));
    // Le LIEN d'origine se partage (le destinataire peut le suivre) ; le chemin local, non.
    assert.deepEqual(byId.a.prevMedia, { sourceUrl: 'https://exemple.test/a.png' });
    assert.equal(byId.b.prevMedia, undefined);
  } finally {
    handle.close();
  }
});

test('la relocalisation en lot reconnaît par nom et taille, et refuse de deviner', () => {
  const { root } = workspace();
  const dossier = path.join(root, 'rushs');
  const sousDossier = path.join(dossier, 'copies');
  fs.mkdirSync(sousDossier, { recursive: true });
  writeFile(dossier, 'plan-a.mp4', 'aaaa');
  writeFile(dossier, 'plan-b.mp4', 'bb');
  // Deux fichiers homonymes de MÊME taille : la réponse serait un coup de dé, on n'en donne aucune.
  writeFile(dossier, 'ambigu.mp4', 'cccc');
  writeFile(sousDossier, 'ambigu.mp4', 'dddd');

  const res = relocate.matchIn(dossier, [
    { id: 'a', name: 'plan-a.mp4', size: 4 },
    { id: 'b', name: 'plan-b.mp4', size: 999 }, // taille qui ne correspond pas : pas le même média
    { id: 'c', name: 'ambigu.mp4', size: 4 },
    { id: 'd', name: 'absent.mp4', size: 10 },
  ]);

  assert.equal(res.ok, true);
  assert.deepEqual(res.found.map((f) => f.id), ['a']);
  assert.equal(path.basename(res.found[0].path), 'plan-a.mp4');
  assert.equal(relocate.matchIn(path.join(root, 'nulle-part'), [{ id: 'a', name: 'x', size: 1 }]).ok, false);
});
