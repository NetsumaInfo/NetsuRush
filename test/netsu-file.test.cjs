const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-netsu-'));
// NR_HOME doit être posé AVANT le require de core/config, que la façade tire en cascade.
process.env.NR_HOME = path.join(TMP, 'home');

const { openNetsu, sniff } = require('../core/netsu/db');
const { SCHEMA_VERSION, META_KEYS } = require('../core/netsu/schema');
const blobs = require('../core/netsu/blobs');
const netsu = require('../core/netsu');

const filePath = (name) => path.join(TMP, name);

/** Cache d'assets minimal : la même surface que core/reference.js, sans le reste du store. */
function makeRefStore(name) {
  const assetsDir = path.join(TMP, name);
  fs.mkdirSync(assetsDir, { recursive: true });
  return {
    assetsDir,
    saveAsset: (bytes, ext) => {
      const file = path.join(assetsDir, `${crypto.createHash('md5').update(bytes).digest('hex')}.${ext}`);
      fs.writeFileSync(file, bytes);
      return { ok: true, path: file };
    },
    fetchAsset: async () => null,
  };
}

/** Contenu pseudo-aléatoire mais REPRODUCTIBLE : un test qui échoue doit échouer pareil demain. */
function fill(bytes, seed) {
  const out = Buffer.allocUnsafe(bytes);
  let x = seed >>> 0;
  for (let i = 0; i < bytes; i += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
}

test('un conteneur neuf porte son schéma, son identité et une révision à zéro', () => {
  const file = filePath('fresh.netsu');
  const handle = openNetsu(file, { appVersion: '3.1.2' });
  try {
    assert.equal(Number(handle.getMeta(META_KEYS.schemaVersion)), SCHEMA_VERSION);
    assert.equal(handle.getMeta(META_KEYS.format), 'netsu');
    assert.ok(handle.getMeta(META_KEYS.docId), 'un doc_id stable est posé à la création');
    assert.equal(handle.rev(), 0);
    // Le page_size doit être posé AVANT la création des tables, sinon il reste au défaut.
    assert.equal(handle.db.prepare('PRAGMA page_size').get().page_size, 8192);
    assert.equal(String(handle.db.prepare('PRAGMA journal_mode').get().journal_mode), 'wal');
  } finally {
    handle.close();
  }
  assert.equal(sniff(file), 'sqlite');
});

test('la révision monte à chaque écriture, jamais à la lecture', () => {
  const handle = openNetsu(filePath('rev.netsu'));
  try {
    const before = handle.rev();
    handle.db.prepare('SELECT count(*) AS n FROM docs').get(); // lecture pure
    assert.equal(handle.rev(), before);

    const first = handle.tx((db) => {
      db.prepare('INSERT INTO docs (id, type, title, is_primary, updated_at) VALUES (?,?,?,1,?)')
        .run('d1', 'board', 'Board', Date.now());
    });
    assert.equal(first.rev, before + 1);
    assert.equal(handle.rev(), before + 1);
  } finally {
    handle.close();
  }
});

test('une transaction qui échoue ne laisse ni donnée ni révision derrière elle', () => {
  const handle = openNetsu(filePath('rollback.netsu'));
  try {
    const before = handle.rev();
    assert.throws(() => handle.tx((db) => {
      db.prepare('INSERT INTO docs (id, type, title, is_primary, updated_at) VALUES (?,?,?,1,?)')
        .run('d1', 'board', 'Board', Date.now());
      throw new Error('boom');
    }), /boom/);
    assert.equal(handle.rev(), before);
    assert.equal(handle.db.prepare('SELECT count(*) AS n FROM docs').get().n, 0);
  } finally {
    handle.close();
  }
});

test('un blob tranché revient octet pour octet', () => {
  const handle = openNetsu(filePath('chunks.netsu'));
  try {
    // > 2 tranches : le recollage doit gérer les bords, pas seulement un aller-retour trivial.
    const payload = fill(blobs.CHUNK_BYTES * 2 + 12345, 42);
    const sha = handle.tx((db) => blobs.putBuffer(db, payload, 'bin')).result;

    const info = blobs.blobInfo(handle.db, sha);
    assert.equal(info.size, payload.length);
    assert.equal(info.chunked, true);
    assert.equal(handle.db.prepare('SELECT count(*) AS n FROM blob_chunks WHERE sha = ?').get(sha).n, 3);
    assert.ok(blobs.getBuffer(handle.db, sha).equals(payload));
  } finally {
    handle.close();
  }
});

test('readRange rend la bonne tranche, y compris à cheval sur deux morceaux', () => {
  const handle = openNetsu(filePath('range.netsu'));
  try {
    const payload = fill(blobs.CHUNK_BYTES * 2 + 5000, 7);
    const sha = handle.tx((db) => blobs.putBuffer(db, payload, 'bin')).result;

    // Bornes INCLUSIVES, comme l'en-tête HTTP Range servi par core/media-server.js.
    const start = blobs.CHUNK_BYTES - 100;
    const end = blobs.CHUNK_BYTES + 99;
    const slice = blobs.readRange(handle.db, sha, start, end);
    assert.equal(slice.length, 200);
    assert.ok(slice.equals(payload.subarray(start, end + 1)));

    // Une fin au-delà du blob est ramenée à la dernière position, pas une erreur.
    const tail = blobs.readRange(handle.db, sha, payload.length - 10, payload.length + 1000);
    assert.ok(tail.equals(payload.subarray(payload.length - 10)));
  } finally {
    handle.close();
  }
});

test('deux fois le même contenu ne sont stockés qu’une fois', () => {
  const handle = openNetsu(filePath('dedup.netsu'));
  try {
    const payload = fill(1024, 3);
    const a = handle.tx((db) => blobs.putBuffer(db, payload, 'png')).result;
    const b = handle.tx((db) => blobs.putBuffer(db, Buffer.from(payload), 'png')).result;
    assert.equal(a, b);
    assert.equal(handle.db.prepare('SELECT count(*) AS n FROM blobs').get().n, 1);
  } finally {
    handle.close();
  }
});

test('un fichier disque est rangé en flux et ressort identique', () => {
  const source = filePath('source.bin');
  const payload = fill(blobs.CHUNK_BYTES + 777, 11);
  fs.writeFileSync(source, payload);

  const handle = openNetsu(filePath('file.netsu'));
  try {
    const { sha, size } = handle.tx((db) => blobs.putFile(db, source, 'bin')).result;
    assert.equal(size, payload.length);
    assert.equal(sha, crypto.createHash('sha256').update(payload).digest('hex'));

    const out = filePath('out.bin');
    assert.equal(blobs.extractTo(handle.db, sha, out), true);
    assert.ok(fs.readFileSync(out).equals(payload));
  } finally {
    handle.close();
  }
});

test('supprimer un document emporte ses items (pas d’orphelins)', () => {
  const handle = openNetsu(filePath('cascade.netsu'));
  try {
    handle.tx((db) => {
      db.prepare('INSERT INTO docs (id, type, title, is_primary, updated_at) VALUES (?,?,?,1,?)')
        .run('d1', 'board', 'Board', Date.now());
      db.prepare('INSERT INTO board_items (doc_id, id, data, z, updated_at) VALUES (?,?,?,?,?)')
        .run('d1', 'i1', '{}', 0, Date.now());
    });
    handle.tx((db) => db.prepare('DELETE FROM docs WHERE id = ?').run('d1'));
    assert.equal(handle.db.prepare('SELECT count(*) AS n FROM board_items').get().n, 0);
  } finally {
    handle.close();
  }
});

test('sceller produit un fichier autonome et relisible', () => {
  const live = openNetsu(filePath('live.netsu'));
  let sha;
  try {
    sha = live.tx((db) => {
      db.prepare('INSERT INTO docs (id, type, title, is_primary, updated_at) VALUES (?,?,?,1,?)')
        .run('d1', 'board', 'Mon board', Date.now());
      return blobs.putBuffer(db, fill(4096, 5), 'png');
    }).result;
    live.seal(filePath('sealed.netsu'));
  } finally {
    live.close();
  }

  // Un fichier tout juste scellé n'a AUCUN journal à côté : il se copie et s'envoie tel quel.
  // (Le rouvrir en réactive un, c'est le prix du mode WAL — d'où la vérification faite ici.)
  assert.equal(fs.existsSync(filePath('sealed.netsu-wal')), false);
  assert.equal(fs.existsSync(filePath('sealed.netsu-shm')), false);

  const sealed = openNetsu(filePath('sealed.netsu'), { create: false });
  try {
    assert.equal(sealed.db.prepare('SELECT title FROM docs WHERE id = ?').get('d1').title, 'Mon board');
    assert.ok(blobs.getBuffer(sealed.db, sha).equals(fill(4096, 5)));
  } finally {
    sealed.close();
  }
});

test('sniff distingue une archive v1 d’un conteneur v2', () => {
  const zip = filePath('old.netsu');
  fs.writeFileSync(zip, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]));
  assert.equal(sniff(zip), 'zip');
  assert.equal(sniff(filePath('inexistant.netsu')), 'unknown');

  // Ouvrir une archive v1 comme une base doit échouer EXPLICITEMENT, pas rendre une base vide.
  assert.throws(() => openNetsu(zip), /v1/);
});

test('aller-retour complet : une image posée sur le board revient utilisable', async () => {
  const source = filePath('photo.png');
  const bytes = fill(9000, 21);
  fs.writeFileSync(source, bytes);

  const scene = {
    name: 'Board de test',
    view: { tx: 12, ty: 34, scale: 2 },
    items: [
      // `src` et `loading` sont transitoires : ils ne doivent PAS ressortir du fichier.
      { id: 'a', kind: 'image', ref: source, x: 0, y: 0, w: 100, h: 80, src: 'http://transitoire', loading: true },
      { id: 'b', kind: 'text', text: 'une note', x: 10, y: 10, w: 200, h: 60 },
      { id: 'c', kind: 'youtube', ref: 'dQw4w9WgXcQ', x: 0, y: 0, w: 320, h: 180 },
    ],
  };

  const dest = filePath('roundtrip.netsu');
  const written = await netsu.exportBoard(makeRefStore('assets-out'), scene, dest, { level: 'preview' });
  assert.equal(written.ok, true, written.error);
  assert.equal(sniff(dest), 'sqlite');
  // Aucun `.part` ne survit à un export réussi.
  assert.equal(fs.existsSync(`${dest}.part`), false);

  const read = netsu.importBoard(makeRefStore('assets-in'), dest);
  assert.equal(read.ok, true, read.error);
  assert.equal(read.scene.name, 'Board de test');
  assert.deepEqual(read.scene.view, { tx: 12, ty: 34, scale: 2 });
  assert.equal(read.scene.items.length, 3);

  const image = read.scene.items.find((i) => i.id === 'a');
  assert.ok(fs.existsSync(image.ref), 'l’image est ressortie sur le disque');
  assert.ok(fs.readFileSync(image.ref).equals(bytes), 'octet pour octet');
  assert.equal(image.src, undefined, 'l’URL d’affichage n’est pas persistée');
  assert.equal(image.loading, undefined, 'le placeholder de téléchargement non plus');

  // Une note garde son texte ; un lien YouTube reste un lien, jamais un média embarqué.
  assert.equal(read.scene.items.find((i) => i.id === 'b').text, 'une note');
  assert.equal(read.scene.items.find((i) => i.id === 'c').ref, 'dQw4w9WgXcQ');
});

test('un média disparu revient en placeholder relocalisable, sans perdre l’item', async () => {
  const source = filePath('volatile.png');
  fs.writeFileSync(source, fill(2048, 31));
  const scene = { name: 'x', items: [{ id: 'a', kind: 'image', ref: source, x: 0, y: 0, w: 10, h: 10 }] };

  const dest = filePath('missing.netsu');
  // Niveau « Lien » : rien n'est embarqué, seul le chemin est mémorisé.
  const written = await netsu.exportBoard(makeRefStore('assets-miss'), scene, dest, { level: 'link' });
  assert.equal(written.ok, true, written.error);
  fs.rmSync(source, { force: true });

  const read = netsu.importBoard(makeRefStore('assets-miss2'), dest);
  assert.equal(read.ok, true, read.error);
  const item = read.scene.items[0];
  assert.equal(item.ref, '');
  assert.equal(item.missing.name, 'volatile.png');
  assert.equal(item.missing.kind, 'image');
});

test('une archive .netsu v1 (ZIP) reste importable', () => {
  const { zipStore } = require('../core/netsu/legacyZip');
  const bytes = fill(1500, 77);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const board = {
    format: 'netsu', version: 1, type: 'board', name: 'Ancien board', view: null,
    items: [{ id: 'a', kind: 'image', ref: `asset:${sha}`, x: 0, y: 0, w: 10, h: 10 }],
  };
  const manifest = { format: 'netsu', version: 1, type: 'board', mode: 'light', refs: [], counts: { items: 1 } };
  const zip = zipStore([
    { name: 'board.json', data: Buffer.from(JSON.stringify(board)) },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: `assets/${sha}.png`, data: bytes },
  ]);
  const dest = filePath('v1.netsu');
  fs.writeFileSync(dest, zip);

  const read = netsu.importBoard(makeRefStore('assets-v1'), dest);
  assert.equal(read.ok, true, read.error);
  assert.equal(read.scene.name, 'Ancien board');
  assert.ok(fs.readFileSync(read.scene.items[0].ref).equals(bytes));
});

test('le poids estimé est rendu pour les 4 niveaux', async () => {
  const source = filePath('weigh.png');
  fs.writeFileSync(source, fill(50_000, 9));
  const scene = { name: 'x', items: [{ id: 'a', kind: 'image', ref: source, x: 0, y: 0, w: 10, h: 10 }] };
  const out = await netsu.weigh(scene, { level: 'preview' });
  assert.equal(out.ok, true);
  assert.equal(out.level, 'preview');
  assert.equal(out.total, out.perLevel.preview);
  // Une image : « Lien » ne garde qu'un poster, les niveaux embarqués gardent le fichier.
  assert.ok(out.perLevel.link < out.perLevel.full);
  assert.equal(out.items[0].id, 'a');
});
