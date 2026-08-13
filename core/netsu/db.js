// @ts-check
// core/netsu/db.js
// Cycle de vie du conteneur .netsu v2 : ouverture, transactions, révision, scellage.
//
// Le fichier est une base SQLite qu'on modifie en place. Trois réglages portent la tenue en
// écriture continue, et ils doivent être posés DANS CET ORDRE à la création :
//   page_size  → avant la moindre écriture (après, il faudrait un VACUUM complet pour le changer) ;
//   WAL        → les lectures ne bloquent pas l'écriture, et un crash ne laisse pas un fichier à
//                moitié écrit ;
//   synchronous=NORMAL → pas de fsync à chaque commit ; sous WAL la durabilité reste assurée
//                jusqu'au dernier checkpoint, ce qui est le bon compromis pour un autosave.
//
// `rev` s'incrémente à chaque transaction d'écriture. C'est le compteur que les fenêtres (board
// détaché, panneau CEP) suivront pour ne recharger que ce qui a bougé, sur le patron de
// core/prefs.js — un renderer ne lit jamais le fichier directement, seul le core écrit.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SCHEMA_VERSION, META_KEYS, FORMAT, applySchema, migrate } = require('./schema');

// En-têtes reconnus. Le .netsu v1 était une archive ZIP : le sniff garantit qu'aucune archive déjà
// partagée ne devient illisible après ce changement de format.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const MAGIC_BYTES = 16;

// 8 Kio : les blobs (posters, clips) débordent moins qu'avec les 4 Kio par défaut, sans gonfler les
// tables courtes. Doit être posé avant la création des tables.
const PAGE_SIZE = 8192;
// Une écriture concurrente ne doit pas échouer instantanément : le core sérialise déjà ses accès,
// ce délai ne couvre que les chevauchements brefs (checkpoint en cours, scellage).
const BUSY_TIMEOUT_MS = 5000;

/**
 * Type de fichier, d'après ses premiers octets. Ne lève jamais : un fichier absent ou illisible
 * répond 'unknown', c'est à l'appelant de dire pourquoi il n'a pas pu l'ouvrir.
 * @param {string} filePath @returns {'sqlite'|'zip'|'unknown'}
 */
function sniff(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(MAGIC_BYTES);
    const read = fs.readSync(fd, head, 0, MAGIC_BYTES, 0);
    if (read >= SQLITE_MAGIC.length && head.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) return 'sqlite';
    if (read >= ZIP_MAGIC.length && head.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) return 'zip';
    return 'unknown';
  } catch (_) {
    return 'unknown';
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* fd déjà fermé */ } }
  }
}

/** @param {any} db @param {string} key @returns {string|null} */
function readMeta(db, key) {
  // Statement préparé À CHAQUE APPEL : un StatementSync mémorisé peut être finalisé par le GC entre
  // deux usages (« statement has been finalized »), piège déjà rencontré dans core/reference.js.
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? String(row.value) : null;
}

/** @param {any} db @param {string} key @param {string|number} value */
function writeMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

/** @param {any} db @param {string} appVersion */
function initMeta(db, appVersion) {
  writeMeta(db, META_KEYS.format, FORMAT);
  writeMeta(db, META_KEYS.schemaVersion, SCHEMA_VERSION);
  writeMeta(db, META_KEYS.docId, crypto.randomUUID());
  writeMeta(db, META_KEYS.appVersion, appVersion || '');
  writeMeta(db, META_KEYS.createdAt, Date.now());
  writeMeta(db, META_KEYS.rev, 0);
}

/** @param {any} db @param {boolean} fresh */
function prepareDatabase(db, fresh) {
  if (fresh) {
    db.exec(`PRAGMA page_size = ${PAGE_SIZE}`); // AVANT toute écriture, sinon sans effet
    // Un board perd des médias autant qu'il en gagne : sans ça, les pages libérées par un blob
    // supprimé restent réservées et le fichier ne rétrécit plus jamais. INCREMENTAL plutôt que FULL
    // pour que la restitution se fasse quand on le demande (après un ménage), pas à chaque commit.
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

/**
 * Ouvre (ou crée) un conteneur .netsu.
 * @param {string} filePath
 * @param {{ create?: boolean, appVersion?: string }} [opts]
 */
function openNetsu(filePath, opts) {
  const options = opts || {};
  const create = options.create !== false;
  const exists = fs.existsSync(filePath);
  if (!exists && !create) throw new Error(`fichier .netsu introuvable : ${filePath}`);
  if (exists) {
    const kind = sniff(filePath);
    if (kind === 'zip') throw new Error(`.netsu au format v1 (archive) : ${filePath}`);
    if (kind !== 'sqlite') throw new Error(`fichier .netsu illisible : ${filePath}`);
  }

  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  const db = new DatabaseSync(filePath);
  prepareDatabase(db, !exists);
  applySchema(db);
  const known = Number(readMeta(db, META_KEYS.schemaVersion) || 0);
  if (!known) initMeta(db, options.appVersion || '');
  else migrate(db, known);
  writeMeta(db, META_KEYS.schemaVersion, SCHEMA_VERSION);

  return makeHandle(db, filePath);
}

/** @param {any} db @param {string} filePath */
function makeHandle(db, filePath) {
  const rev = () => Number(readMeta(db, META_KEYS.rev) || 0);

  /**
   * Une transaction = une action utilisateur. Le compteur de révision ne bouge qu'ici : une lecture
   * ne doit jamais faire croire aux autres fenêtres que le document a changé.
   * @template T @param {(db: any) => T} fn @returns {{ rev: number, result: T }}
   */
  /**
   * Écriture SANS révision. Une même action utilisateur peut demander des centaines de commits —
   * les tranches d'un média de plusieurs Go —, et faire croire aux autres fenêtres à des centaines
   * de changements de document les ferait recharger en boucle. `tx` reste la voie normale.
   * @template T @param {(db: any) => T} fn @returns {{ result: T }}
   */
  const write = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(db);
      db.exec('COMMIT');
      return { result };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* transaction déjà défaite */ }
      throw e;
    }
  };

  const tx = (fn) => {
    let next = rev();
    const { result } = write((d) => {
      const out = fn(d);
      next = rev() + 1;
      writeMeta(d, META_KEYS.rev, next);
      return out;
    });
    return { rev: next, result };
  };

  /** Rend au système les pages libérées par un ménage (sans effet si auto_vacuum n'est pas posé). */
  const reclaim = () => {
    try { db.exec('PRAGMA incremental_vacuum'); } catch (_) { /* base sans auto_vacuum : rien à rendre */ }
  };

  /** Replie le journal WAL dans le fichier principal (sinon le `-wal` grossit sans fin). */
  const checkpoint = () => { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); };

  /**
   * Écrit une copie COMPACTE et autonome à `destPath` : c'est l'opération « sceller » du partage,
   * et c'est aussi celle des instantanés de version. On passe par VACUUM INTO plutôt que par
   * l'API backup de node:sqlite, dont la présence varie selon la version de Node — ici le runtime
   * est celui fourni avec l'app, mais un VACUUM INTO tient sur toutes les versions et compacte en
   * plus l'espace libéré. Jamais de `VACUUM` nu : il verrouillerait la base ouverte.
   * @param {string} destPath
   */
  const seal = (destPath) => {
    checkpoint();
    const dest = path.resolve(destPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { force: true }); // VACUUM INTO refuse d'écraser
    db.prepare('VACUUM INTO ?').run(dest);
    return dest;
  };

  const close = () => {
    try { checkpoint(); } catch (_) { /* base déjà fermée ou verrouillée : rien à replier */ }
    db.close();
  };

  return {
    db,
    path: filePath,
    rev,
    tx,
    write,
    reclaim,
    checkpoint,
    seal,
    close,
    getMeta: (key) => readMeta(db, key),
    setMeta: (key, value) => writeMeta(db, key, value),
  };
}

module.exports = { openNetsu, sniff, PAGE_SIZE, SQLITE_MAGIC, ZIP_MAGIC };
