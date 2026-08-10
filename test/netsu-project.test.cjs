// Le .netsu comme document de travail : écriture incrémentale + dossier compagnon.
//
// Ce qui est verrouillé ici, ce sont les trois promesses qui distinguent un PROJET d'un partage :
// réenregistrer sans rien changer n'écrit rien, un rush de l'utilisateur n'est jamais recopié, et
// un média sans domicile suit le fichier au lieu de rester dans un magasin global.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sessions = require('../core/netsu/session');
const sidecar = require('../core/netsu/sidecar');
const { saveBoardProject, readBoardProject } = require('../core/netsu/project');

/** Espace de travail jetable : un dossier de « magasin d'assets » et un dossier de projets. */
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netsu-project-'));
  const assetsDir = path.join(root, 'assets');
  const projectsDir = path.join(root, 'projects');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  // Magasin d'assets de l'app : c'est `isAppAsset` qui décide ce qui doit déménager auprès du fichier.
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

const note = (id, x) => ({ id, kind: 'text', x, y: 0, w: 100, h: 40, z: 0, text: 'salut' });

test('réenregistrer sans rien changer n’écrit aucune ligne', async () => {
  const { projectsDir, refStore } = workspace();
  const file = path.join(projectsDir, 'projet.netsu');
  const session = sessions.openSession(file, { create: true });
  try {
    const scene = { name: 'Projet', items: [note('a', 0), note('b', 50)], view: null };

    const first = await saveBoardProject({ session, refStore, scene });
    assert.equal(first.ok, true);
    assert.equal(first.counts.items, 2);
    assert.equal(first.counts.changed, 2);

    // Deuxième passage à contenu identique : c'est LA promesse du format, un Ctrl+S ne doit pas
    // réécrire un document que rien n'a modifié.
    const second = await saveBoardProject({ session, refStore, scene });
    assert.equal(second.counts.changed, 0);
    assert.equal(second.counts.removed, 0);

    // Un seul item déplacé → une seule ligne écrite.
    const moved = { ...scene, items: [note('a', 0), note('b', 120)] };
    const third = await saveBoardProject({ session, refStore, scene: moved });
    assert.equal(third.counts.changed, 1);

    // Item retiré → sa ligne disparaît (un board « nettoyé » ne doit pas garder ses items).
    const shorter = { ...scene, items: [note('a', 0)] };
    const fourth = await saveBoardProject({ session, refStore, scene: shorter });
    assert.equal(fourth.counts.removed, 1);
    assert.equal(readBoardProject({ session, refStore }).scene.items.length, 1);
  } finally {
    sessions.closeSession(file);
  }
});

test('un rush de l’utilisateur est référencé, jamais recopié', async () => {
  const { root, projectsDir, refStore } = workspace();
  const rush = writeFile(root, 'A001.mov', 'des octets de rush');
  const file = path.join(projectsDir, 'projet.netsu');
  const session = sessions.openSession(file, { create: true });
  try {
    const scene = { name: 'Projet', items: [{ id: 'v1', kind: 'video', ref: rush, x: 0, y: 0, w: 320, h: 180, z: 0 }] };
    const res = await saveBoardProject({ session, refStore, scene });
    assert.equal(res.ok, true);
    assert.equal(res.counts.adopted, 0);
    // Rien dans le dossier compagnon : le fichier de l'utilisateur reste chez lui.
    assert.equal(fs.existsSync(sidecar.sidecarDirFor(file)), false);

    // Relu, l'item retrouve son chemin d'origine.
    const read = readBoardProject({ session, refStore });
    assert.equal(path.resolve(read.scene.items[0].ref), path.resolve(rush));

    // Le média est déjà connu : le second enregistrement ne réécrit rien.
    const again = await saveBoardProject({ session, refStore, scene });
    assert.equal(again.counts.changed, 0);
  } finally {
    sessions.closeSession(file);
  }
});

test('un média sans domicile déménage dans le dossier compagnon, en chemin relatif', async () => {
  const { assetsDir, projectsDir, refStore } = workspace();
  const pasted = writeFile(assetsDir, 'deadbeefdeadbeef.png', 'image collée');
  const file = path.join(projectsDir, 'projet.netsu');
  const session = sessions.openSession(file, { create: true });
  const item = { id: 'i1', kind: 'image', title: 'Aurore boréale', ref: pasted, x: 0, y: 0, w: 100, h: 100, z: 0 };
  try {
    const res = await saveBoardProject({ session, refStore, scene: { name: 'Projet', items: [item] } });
    assert.equal(res.counts.adopted, 1);
    // Rangé par type et nommé d'après l'item : le dossier doit se lire dans l'explorateur.
    const companion = path.join(sidecar.sidecarDirFor(file), 'images', 'aurore-boreale-deadbeefdead.png');
    assert.equal(fs.existsSync(companion), true);

    // Le token stocké est RELATIF : c'est ce qui permet de déplacer le couple fichier + dossier.
    const stored = session.handle.db.prepare('SELECT data FROM board_items WHERE id = ?').get('i1');
    assert.equal(JSON.parse(stored.data).ref, 'sidecar:images/aurore-boreale-deadbeefdead.png');

    assert.equal(path.resolve(readBoardProject({ session, refStore }).scene.items[0].ref), path.resolve(companion));
  } finally {
    sessions.closeSession(file);
  }
});

test('un localisateur compagnon introuvable survit à l’ouverture et à l’autosave sans ménage', async () => {
  const { root, assetsDir, projectsDir, refStore } = workspace();
  const first = writeFile(assetsDir, '1111111111111111.png', 'première image');
  const second = writeFile(assetsDir, '2222222222222222.png', 'deuxième image');
  const file = path.join(projectsDir, 'projet.netsu');
  const session = sessions.openSession(file, { create: true });
  const image = (id, ref) => ({ id, kind: 'image', ref, x: 0, y: 0, w: 10, h: 10, z: 0 });
  try {
    await saveBoardProject({ session, refStore, scene: { name: 'P', items: [image('a', first), image('b', second)] } });
    const storedBefore = JSON.parse(session.handle.db.prepare('SELECT data FROM board_items WHERE id = ?').get('a').data);
    const missingPath = sidecar.resolveSidecar(file, storedBefore.ref);
    fs.renameSync(missingPath, path.join(root, path.basename(missingPath)));

    const protectedFile = path.join(sidecar.sidecarDirFor(file), 'images', 'protected-deadbeefdead.png');
    fs.writeFileSync(protectedFile, 'must survive an unresolved save');
    const opened = readBoardProject({ session, refStore }).scene;
    const missing = opened.items.find((item) => item.id === 'a');
    assert.equal(missing.ref, '');
    assert.equal(missing.missing.locator, storedBefore.ref);

    const saved = await saveBoardProject({ session, refStore, scene: opened });
    const storedAfter = JSON.parse(session.handle.db.prepare('SELECT data FROM board_items WHERE id = ?').get('a').data);
    assert.equal(storedAfter.ref, storedBefore.ref);
    assert.equal(saved.counts.unresolved, 1);
    assert.equal(fs.existsSync(protectedFile), true);
  } finally {
    sessions.closeSession(file);
  }
});

test('les localisateurs des frames manquantes survivent à leur index', async () => {
  const { root, assetsDir, projectsDir, refStore } = workspace();
  const frames = [
    writeFile(assetsDir, '3333333333333333.jpg', 'frame une'),
    writeFile(assetsDir, '4444444444444444.jpg', 'frame deux'),
  ];
  const file = path.join(projectsDir, 'sequence.netsu');
  const session = sessions.openSession(file, { create: true });
  try {
    await saveBoardProject({
      session,
      refStore,
      scene: { name: 'P', items: [{ id: 'seq', kind: 'sequence', ref: frames[0], frames, x: 0, y: 0, w: 10, h: 10, z: 0 }] },
    });
    const storedBefore = JSON.parse(session.handle.db.prepare('SELECT data FROM board_items WHERE id = ?').get('seq').data);
    const missingPath = sidecar.resolveSidecar(file, storedBefore.frames[0]);
    fs.renameSync(missingPath, path.join(root, path.basename(missingPath)));

    const opened = readBoardProject({ session, refStore }).scene;
    const sequence = opened.items[0];
    assert.equal(sequence.frames[0], '');
    assert.equal(sequence.missing.frameLocators[0], storedBefore.frames[0]);
    assert.equal(sequence.missing.frameLocators[1], null);

    await saveBoardProject({ session, refStore, scene: opened });
    const storedAfter = JSON.parse(session.handle.db.prepare('SELECT data FROM board_items WHERE id = ?').get('seq').data);
    assert.deepEqual(storedAfter.frames, storedBefore.frames);
  } finally {
    sessions.closeSession(file);
  }
});

test('déplacer le projet avec son dossier compagnon ne casse aucun média', async () => {
  const { assetsDir, projectsDir, refStore } = workspace();
  const pasted = writeFile(assetsDir, 'cafecafecafecafe.png', 'image collée');
  const file = path.join(projectsDir, 'projet.netsu');
  const session = sessions.openSession(file, { create: true });
  try {
    await saveBoardProject({
      session,
      refStore,
      scene: { name: 'Projet', items: [{ id: 'i1', kind: 'image', ref: pasted, x: 0, y: 0, w: 10, h: 10, z: 0 }] },
    });
  } finally {
    sessions.closeSession(file); // referme pour copier un fichier au repos
  }

  const movedDir = path.join(projectsDir, 'ailleurs');
  fs.mkdirSync(movedDir, { recursive: true });
  const movedFile = path.join(movedDir, 'projet.netsu');
  fs.copyFileSync(file, movedFile);
  fs.cpSync(sidecar.sidecarDirFor(file), sidecar.sidecarDirFor(movedFile), { recursive: true });

  const moved = sessions.openSession(movedFile, { create: false });
  try {
    const read = readBoardProject({ session: moved, refStore });
    assert.equal(read.ok, true);
    // Résolu depuis le NOUVEL emplacement, et le fichier est bien là.
    assert.equal(read.scene.items[0].ref.startsWith(sidecar.sidecarDirFor(movedFile)), true);
    assert.equal(fs.existsSync(read.scene.items[0].ref), true);
  } finally {
    sessions.closeSession(movedFile);
  }
});

test('un média retiré du board libère ses octets, mais un board vidé d’un coup ne purge rien', async () => {
  const { assetsDir, projectsDir, refStore } = workspace();
  const kept = writeFile(assetsDir, 'aaaaaaaaaaaaaaaa.png', 'gardée');
  const dropped = writeFile(assetsDir, 'bbbbbbbbbbbbbbbb.png', 'retirée');
  const file = path.join(projectsDir, 'projet.netsu');
  const session = sessions.openSession(file, { create: true });
  const img = (id, ref) => ({ id, kind: 'image', ref, x: 0, y: 0, w: 10, h: 10, z: 0 });
  try {
    await saveBoardProject({ session, refStore, scene: { name: 'P', items: [img('a', kept), img('b', dropped)] } });
    const images = path.join(sidecar.sidecarDirFor(file), 'images');
    assert.equal(fs.readdirSync(images).length, 2);

    await saveBoardProject({ session, refStore, scene: { name: 'P', items: [img('a', kept)] } });
    assert.deepEqual(fs.readdirSync(images), ['media-aaaaaaaaaaaa.png']);

    // Un enregistrement qui vide TOUT est presque toujours un board pas encore chargé : les lignes
    // partent (elles se réécriront), les octets restent. Sans cette garde, un autosave malheureux
    // effacerait des médias que rien ne peut reconstruire.
    await saveBoardProject({ session, refStore, scene: { name: 'P', items: [] } });
    assert.deepEqual(fs.readdirSync(images), ['media-aaaaaaaaaaaa.png']);
  } finally {
    sessions.closeSession(file);
  }
});

test('un lien distant reste un lien : un projet ne recopie pas ce qui se retélécharge', async () => {
  const { projectsDir, refStore } = workspace();
  const file = path.join(projectsDir, 'projet.netsu');
  const session = sessions.openSession(file, { create: true });
  const url = 'https://exemple.test/image.png';
  try {
    await saveBoardProject({
      session,
      refStore,
      scene: { name: 'P', items: [{ id: 'w', kind: 'image', ref: url, x: 0, y: 0, w: 10, h: 10, z: 0 }] },
    });
    assert.equal(readBoardProject({ session, refStore }).scene.items[0].ref, url);
    assert.equal(fs.existsSync(sidecar.sidecarDirFor(file)), false);
  } finally {
    sessions.closeSession(file);
  }
});

test('un projet renommé retrouve son média dans un unique dossier compagnon voisin', async () => {
  const { assetsDir, projectsDir, refStore } = workspace();
  const pasted = writeFile(assetsDir, '5555555555555555.png', 'image à relocaliser');
  const original = path.join(projectsDir, 'original.netsu');
  const first = sessions.openSession(original, { create: true });
  try {
    await saveBoardProject({
      session: first,
      refStore,
      scene: { name: 'P', items: [{ id: 'i', kind: 'image', ref: pasted, x: 0, y: 0, w: 10, h: 10, z: 0 }] },
    });
  } finally {
    sessions.closeSession(original);
  }

  const renamed = path.join(projectsDir, 'renamed.netsu');
  fs.renameSync(original, renamed);
  const reopened = sessions.openSession(renamed, { create: false });
  try {
    const item = readBoardProject({ session: reopened, refStore }).scene.items[0];
    assert.equal(item.missing, undefined);
    assert.equal(fs.existsSync(item.ref), true);
    assert.equal(item.ref.startsWith(sidecar.sidecarDirFor(original)), true);
  } finally {
    sessions.closeSession(renamed);
  }
});

test('deux dossiers compagnons candidats restent volontairement ambigus', async () => {
  const { assetsDir, projectsDir, refStore } = workspace();
  const pasted = writeFile(assetsDir, '6666666666666666.png', 'image ambiguë');
  const original = path.join(projectsDir, 'original.netsu');
  const first = sessions.openSession(original, { create: true });
  try {
    await saveBoardProject({
      session: first,
      refStore,
      scene: { name: 'P', items: [{ id: 'i', kind: 'image', ref: pasted, x: 0, y: 0, w: 10, h: 10, z: 0 }] },
    });
  } finally {
    sessions.closeSession(original);
  }

  fs.cpSync(sidecar.sidecarDirFor(original), path.join(projectsDir, 'duplicate.medias'), { recursive: true });
  const renamed = path.join(projectsDir, 'renamed.netsu');
  fs.renameSync(original, renamed);
  const reopened = sessions.openSession(renamed, { create: false });
  try {
    const item = readBoardProject({ session: reopened, refStore }).scene.items[0];
    assert.equal(item.ref, '');
    assert.match(item.missing.locator, /^sidecar:/);
  } finally {
    sessions.closeSession(renamed);
  }
});

test('un rush déplacé sous la racine netsu est reconnu par taille et empreinte de tête', async () => {
  const { root, projectsDir, refStore } = workspace();
  const rush = writeFile(root, 'A001.mov', Buffer.alloc(1024, 7));
  const file = path.join(projectsDir, 'projet.netsu');
  const first = sessions.openSession(file, { create: true });
  try {
    await saveBoardProject({
      session: first,
      refStore,
      scene: { name: 'P', items: [{ id: 'v', kind: 'video', ref: rush, x: 0, y: 0, w: 10, h: 10, z: 0 }] },
    });
  } finally {
    sessions.closeSession(file);
  }

  const movedDir = path.join(projectsDir, 'media');
  fs.mkdirSync(movedDir, { recursive: true });
  const moved = path.join(movedDir, path.basename(rush));
  fs.renameSync(rush, moved);
  const reopened = sessions.openSession(file, { create: false });
  try {
    const item = readBoardProject({ session: reopened, refStore }).scene.items[0];
    assert.equal(path.resolve(item.ref), path.resolve(moved));
    assert.equal(item.missing, undefined);
  } finally {
    sessions.closeSession(file);
  }
});

test('un token compagnon ne peut pas désigner un fichier hors du dossier', () => {
  // Un .netsu reçu d'un tiers ne doit pas pouvoir pointer ailleurs sur la machine.
  const file = 'C:/projets/p.netsu';
  assert.equal(sidecar.resolveSidecar(file, 'sidecar:../../windows/system32/notepad.exe'), '');
  assert.equal(sidecar.resolveSidecar(file, 'sidecar:images/../../secret.png'), '');
  assert.notEqual(sidecar.resolveSidecar(file, 'sidecar:images/photo.png'), '');
});

test('chaque séquence tient dans son dossier, ses frames dans l’ordre', async () => {
  const { assetsDir, projectsDir, refStore } = workspace();
  const frames = ['1111111111111111', '2222222222222222', '3333333333333333']
    .map((name, i) => writeFile(assetsDir, `${name}.jpg`, `frame ${i}`));
  const other = writeFile(assetsDir, '4444444444444444.jpg', 'autre séquence');
  const file = path.join(projectsDir, 'projet.netsu');
  const session = sessions.openSession(file, { create: true });
  const seq = (id, title, refs) => ({ id, kind: 'sequence', title, ref: '', frames: refs, x: 0, y: 0, w: 10, h: 10, z: 0 });
  try {
    await saveBoardProject({
      session,
      refStore,
      // Deux séquences au MÊME titre : sans dossiers distincts elles mélangeraient leurs frames, et
      // retirer l'une emporterait les frames de l'autre.
      scene: { name: 'P', items: [seq('s1', 'Cell Games', frames), seq('s2', 'Cell Games', [other])] },
    });

    const root = path.join(sidecar.sidecarDirFor(file), 'sequences');
    assert.deepEqual(fs.readdirSync(root).sort(), ['cell-games', 'cell-games-2']);
    // Le rang préfixe le nom : l'explorateur affiche la séquence dans l'ordre du board.
    assert.deepEqual(fs.readdirSync(path.join(root, 'cell-games')), [
      '0001-111111111111.jpg', '0002-222222222222.jpg', '0003-333333333333.jpg',
    ]);
    assert.deepEqual(fs.readdirSync(path.join(root, 'cell-games-2')), ['0001-444444444444.jpg']);

    // Séquence retirée du board : ses octets ET son dossier partent.
    await saveBoardProject({ session, refStore, scene: { name: 'P', items: [seq('s1', 'Cell Games', frames)] } });
    assert.deepEqual(fs.readdirSync(root), ['cell-games']);
  } finally {
    sessions.closeSession(file);
  }
});

test('un enregistrement qui ne change rien ne remue pas le dossier compagnon', async () => {
  const { assetsDir, projectsDir, refStore } = workspace();
  const pasted = writeFile(assetsDir, 'abcabcabcabcabca.png', 'image collée');
  const file = path.join(projectsDir, 'projet.netsu');
  const session = sessions.openSession(file, { create: true });
  const scene = (title) => ({
    name: 'P',
    items: [{ id: 'i1', kind: 'image', title, ref: pasted, x: 0, y: 0, w: 10, h: 10, z: 0 }],
  });
  try {
    const first = await saveBoardProject({ session, refStore, scene: scene('Photo') });
    const stored = readBoardProject({ session, refStore }).scene.items[0].ref;
    const before = fs.statSync(stored).mtimeMs;
    assert.equal(first.counts.adopted, 1);

    // Même contenu, même dossier : le fichier n'est ni recopié ni renommé. Un Ctrl+S ne doit pas
    // réécrire des médias, et l'item renommé ne fait pas clignoter le dossier ouvert à côté.
    await saveBoardProject({ session, refStore, scene: scene('Photo renommée') });
    assert.deepEqual(fs.readdirSync(path.join(sidecar.sidecarDirFor(file), 'images')), [path.basename(stored)]);
    assert.equal(fs.statSync(stored).mtimeMs, before);
  } finally {
    sessions.closeSession(file);
  }
});

test('un projet de l’ancienne disposition se range au premier enregistrement, sans recopie', async () => {
  const { assetsDir, projectsDir, refStore } = workspace();
  const pasted = writeFile(assetsDir, 'feedfeedfeedfeed.png', 'image collée');
  const file = path.join(projectsDir, 'projet.netsu');
  const session = sessions.openSession(file, { create: true });
  const item = { id: 'i1', kind: 'image', title: 'Poster', ref: pasted, x: 0, y: 0, w: 10, h: 10, z: 0 };
  try {
    // On fabrique l'ancienne disposition à la main : le fichier à plat, le token qui le désigne.
    const dir = sidecar.sidecarDirFor(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(pasted, path.join(dir, 'feedfeedfeedfeed.png'));
    const legacy = { ...item, ref: 'sidecar:feedfeedfeedfeed.png' };
    await saveBoardProject({ session, refStore, scene: { name: 'P', items: [legacy] } });

    // Déplacé (pas dupliqué) dans son dossier de type, et renommé d'après l'item.
    assert.deepEqual(fs.readdirSync(dir), ['images']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'images')), ['poster-feedfeedfeed.png']);
    const stored = session.handle.db.prepare('SELECT data FROM board_items WHERE id = ?').get('i1');
    assert.equal(JSON.parse(stored.data).ref, 'sidecar:images/poster-feedfeedfeed.png');
  } finally {
    sessions.closeSession(file);
  }
});

test('« Enregistrer sous… » emmène les médias compagnons au lieu de les laisser derrière', async () => {
  const { assetsDir, projectsDir, refStore } = workspace();
  const pasted = writeFile(assetsDir, 'ba5eba5eba5eba5e.png', 'image collée');
  const source = path.join(projectsDir, 'source.netsu');
  const first = sessions.openSession(source, { create: true });
  const item = { id: 'i1', kind: 'image', title: 'Poster', ref: pasted, x: 0, y: 0, w: 10, h: 10, z: 0 };
  let scene;
  try {
    await saveBoardProject({ session: first, refStore, scene: { name: 'P', items: [item] } });
    // Ce que le renderer garde en main après l'enregistrement : des chemins ABSOLUS vers le dossier
    // compagnon du fichier d'origine. C'est cette scène-là que « Enregistrer sous… » réécrit.
    scene = readBoardProject({ session: first, refStore }).scene;
  } finally {
    sessions.closeSession(source);
  }

  const dest = path.join(projectsDir, 'copie.netsu');
  const second = sessions.openSession(dest, { create: true });
  try {
    const res = await saveBoardProject({ session: second, refStore, scene });
    assert.equal(res.counts.adopted, 1);
    const moved = readBoardProject({ session: second, refStore }).scene.items[0].ref;
    assert.equal(moved.startsWith(sidecar.sidecarDirFor(dest)), true);
    assert.equal(fs.existsSync(moved), true);
    // Le projet d'origine garde les siens : la copie ne lui prend rien.
    assert.equal(fs.existsSync(path.join(sidecar.sidecarDirFor(source), 'images', 'poster-ba5eba5eba5e.png')), true);
  } finally {
    sessions.closeSession(dest);
  }
});
