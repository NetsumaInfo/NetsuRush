const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const mediaIdent = require('../core/mediaIdent');

// Même fixture que test/test_media_identity.py : les deux implémentations doivent produire CETTE
// chaîne, sinon Node et python cessent de reconnaître le même fichier.
const FIXTURE = Buffer.from('netsurush-identity-fixture\n'.repeat(64), 'utf8');
const FIXTURE_SIG = 's1:1728:ebef112b00d41fa039d5b60d';

function workdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-media-ident-'));
  return dir;
}

function write(dir, name, blob) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, blob);
  return p;
}

function identDb(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE media_ident_v1(file_path TEXT PRIMARY KEY, path_key TEXT, sig TEXT, size INTEGER, mtime REAL, seen_at REAL)');
  for (const r of rows) {
    db.prepare('INSERT INTO media_ident_v1 VALUES (?,?,?,?,?,?)')
      .run(r.path, mediaIdent.pathKey(r.path), r.sig ?? null, r.size ?? 0, r.mtime ?? 0, 0);
  }
  return db;
}

test('signature matches the python implementation byte for byte', () => {
  const dir = workdir();
  try {
    const file = write(dir, 'a.mp4', FIXTURE);
    const sig = mediaIdent.signature(file);
    assert.equal(sig.size, FIXTURE.length);
    assert.equal(sig.sig, FIXTURE_SIG);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a copy shares the signature, an edit does not', () => {
  const dir = workdir();
  try {
    const a = write(dir, 'a.mp4', FIXTURE);
    const copy = write(dir, 'copy.mp4', FIXTURE);
    const edited = write(dir, 'edited.mp4', Buffer.concat([FIXTURE, Buffer.from('x')]));
    assert.equal(mediaIdent.signature(a).sig, mediaIdent.signature(copy).sig);
    assert.notEqual(mediaIdent.signature(a).sig, mediaIdent.signature(edited).sig);
    assert.equal(mediaIdent.signature(path.join(dir, 'nope.mp4')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file of unknown size is never hashed against the table', () => {
  const dir = workdir();
  try {
    const mine = write(dir, 'mine.mp4', FIXTURE);
    // Une seule entrée, d'une AUTRE taille : aucun jumeau possible, la recherche s'arrête avant
    // de lire le moindre octet (c'est ce qui rend une grille de rushs neufs gratuite).
    const db = identDb([{ path: path.join(dir, 'other.mp4'), sig: 's1:99:deadbeef', size: 99 }]);
    assert.deepEqual(mediaIdent.twinPaths(db, mine), []);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('twins are found by signature, and by path spelling alone', () => {
  const dir = workdir();
  try {
    const mine = write(dir, 'mine.mp4', FIXTURE);
    const twin = write(dir, 'twin.mp4', FIXTURE);
    const decoy = write(dir, 'decoy.mp4', Buffer.concat([FIXTURE, Buffer.from('tail')]));
    const db = identDb([
      { path: twin, sig: FIXTURE_SIG, size: FIXTURE.length },
      { path: decoy, sig: 's1:1732:0000', size: FIXTURE.length },
    ]);
    assert.deepEqual(mediaIdent.twinPaths(db, mine), [twin]);
    db.close();

    // Même fichier, écrit avec l'autre séparateur : reconnu sans aucun hachage.
    const spelled = identDb([{ path: twin.replace(/\\/g, '/'), sig: null, size: 0 }]);
    const found = mediaIdent.twinPaths(spelled, twin);
    assert.equal(found.length, process.platform === 'win32' || twin.includes('/') ? 1 : 0);
    spelled.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a touched file keeps its cache, a rewritten one does not', () => {
  const dir = workdir();
  try {
    const file = write(dir, 'a.mp4', FIXTURE);
    const cachedMtime = fs.statSync(file).mtimeMs / 1000;
    const db = identDb([{ path: file, sig: FIXTURE_SIG, size: FIXTURE.length, mtime: cachedMtime }]);

    fs.utimesSync(file, 20_000_000, 20_000_000); // copie / restauration : les octets n'ont pas bougé
    assert.equal(mediaIdent.sameBytesAsCached(db, file, cachedMtime), true);

    fs.writeFileSync(file, Buffer.concat([FIXTURE, Buffer.from('re-encoded')]));
    assert.equal(mediaIdent.sameBytesAsCached(db, file, cachedMtime), false);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without a witness the old staleness rule stands', () => {
  const dir = workdir();
  try {
    const file = write(dir, 'a.mp4', FIXTURE);
    const db = identDb([]);
    assert.equal(mediaIdent.sameBytesAsCached(db, file, fs.statSync(file).mtimeMs / 1000), false);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
