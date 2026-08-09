// @ts-check
// Index LATÉRAL des fichiers de cache : la seule façon de savoir à quel rush appartient une entrée.
//
// Vignettes, proxies et WAV sont nommés par un md5 à sens unique (`md5(chemin|temps|hauteur).jpg`) et
// ne portent aucune métadonnée → sans cet index, « vider le cache de ce projet » est structurellement
// impossible : on ne peut que tout effacer. On enregistre donc une ligne à CHAQUE écriture de cache,
// qui relie le fichier produit à son média source. Tout Paramètres › Stockage en découle (arbre par
// projet/rush, purge ciblée, quotas LRU, purge par âge).
//
// Deux contraintes de conception :
//  - L'écriture doit être QUASI GRATUITE. Une préchauffe de rush génère des centaines de vignettes ;
//    un INSERT synchrone par vignette plomberait le chemin chaud. On tamponne en mémoire et on écrit
//    par lots dans une seule transaction, en fire-and-forget.
//  - L'index ne doit JAMAIS casser la production du cache. Toute erreur est avalée : un index perdu
//    dégrade l'UI de stockage, il ne doit pas empêcher un aperçu de s'afficher.
//
// Calque de core/library.js : SQLite via node:sqlite (garanti — scripts/fetch-node.ps1 fige un Node
// ≥ 22.13, où le module ne demande plus de drapeau), repli JSON-file, MÊME API publique.

const path = require('path');
const fs = require('fs');

// Délai de regroupement des écritures. Assez court pour que l'UI voie l'index à jour presque
// aussitôt, assez long pour agréger une rafale de préchauffe en une seule transaction.
const FLUSH_MS = 300;

const DDL = [
  'CREATE TABLE IF NOT EXISTS cache_entries_v1 ('
    + 'file TEXT PRIMARY KEY, kind TEXT NOT NULL, source TEXT, '
    + 'bytes INTEGER NOT NULL, created INTEGER NOT NULL, used INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS cache_entries_v1_kind ON cache_entries_v1(kind)',
  'CREATE INDEX IF NOT EXISTS cache_entries_v1_source ON cache_entries_v1(source)',
  'CREATE INDEX IF NOT EXISTS cache_entries_v1_used ON cache_entries_v1(used)',
];

const UPSERT =
  'INSERT INTO cache_entries_v1 (file, kind, source, bytes, created, used) VALUES (?, ?, ?, ?, ?, ?) '
  + 'ON CONFLICT(file) DO UPDATE SET kind = excluded.kind, source = excluded.source, '
  + 'bytes = excluded.bytes, used = excluded.used';

/** @typedef {{ file: string, kind: string, source: string|null, bytes: number, created: number, used: number }} CacheRow */

// --- Backend SQLite ----------------------------------------------------------------------------
// StatementSync NEUF à chaque appel (jamais mémorisé) : un statement conservé peut être finalisé par
// le GC → « statement has been finalized » à l'écriture suivante (cf. library.js:52).
function sqliteBackend(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  // WAL : l'UI de stockage lit pendant que la préchauffe écrit, sans se bloquer mutuellement.
  try { db.exec('PRAGMA journal_mode=WAL'); db.exec('PRAGMA synchronous=NORMAL'); } catch (_) {}
  for (const sql of DDL) db.exec(sql);

  /** @param {CacheRow[]} rows @param {Array<[string, number]>} touches */
  function commit(rows, touches) {
    db.exec('BEGIN');
    try {
      for (const r of rows) db.prepare(UPSERT).run(r.file, r.kind, r.source, r.bytes, r.created, r.used);
      for (const [file, used] of touches) db.prepare('UPDATE cache_entries_v1 SET used = ? WHERE file = ?').run(used, file);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }

  return {
    commit,
    all: () => /** @type {any[]} */ (db.prepare('SELECT file, kind, source, bytes, created, used FROM cache_entries_v1').all()),
    byKind: (kind) => /** @type {any[]} */ (db.prepare('SELECT file, kind, source, bytes, created, used FROM cache_entries_v1 WHERE kind = ? ORDER BY used ASC').all(kind)),
    del: (files) => {
      db.exec('BEGIN');
      try {
        for (const f of files) db.prepare('DELETE FROM cache_entries_v1 WHERE file = ?').run(f);
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw e;
      }
    },
    move: (pairs) => {
      db.exec('BEGIN');
      try {
        for (const [from, to] of pairs) db.prepare('UPDATE cache_entries_v1 SET file = ? WHERE file = ?').run(to, from);
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw e;
      }
    },
    close: () => { try { db.close(); } catch (_) {} },
  };
}

// --- Backend JSON (repli) ----------------------------------------------------------------------
// Uniquement pour un Node sans node:sqlite (dev hors bundle). Relit/réécrit tout le fichier : correct
// mais O(n) — acceptable car le bundle a toujours SQLite.
function jsonBackend(filePath) {
  const read = () => {
    try { return /** @type {Record<string, CacheRow>} */ (JSON.parse(fs.readFileSync(filePath, 'utf8'))); } catch (_) { return {}; }
  };
  const write = (obj) => {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, filePath); // rename atomique
  };
  return {
    commit: (rows, touches) => {
      const o = read();
      for (const r of rows) o[r.file] = { ...r, created: o[r.file] ? o[r.file].created : r.created };
      for (const [file, used] of touches) if (o[file]) o[file].used = used;
      write(o);
    },
    all: () => Object.values(read()),
    byKind: (kind) => Object.values(read()).filter((r) => r.kind === kind).sort((a, b) => a.used - b.used),
    del: (files) => {
      const o = read();
      for (const f of files) delete o[f];
      write(o);
    },
    move: (pairs) => {
      const o = read();
      for (const [from, to] of pairs) {
        if (!o[from]) continue;
        o[to] = { ...o[from], file: to };
        delete o[from];
      }
      write(o);
    },
    close: () => {},
  };
}

/**
 * @param {string} dataDir
 */
function createCacheIndex(dataDir) {
  const dir = path.join(dataDir, 'cache');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

  let backend;
  let kind;
  try {
    backend = sqliteBackend(path.join(dir, 'cache-index.db'));
    kind = 'sqlite';
  } catch (_) {
    backend = jsonBackend(path.join(dir, 'cache-index.json'));
    kind = 'json';
  }

  /** @type {Map<string, CacheRow>} */
  const pendingRows = new Map();
  /** @type {Map<string, number>} */
  const pendingTouch = new Map();
  /** @type {NodeJS.Timeout|null} */
  let timer = null;

  // Vide le tampon dans une seule transaction. Ne lève JAMAIS : l'index est un confort, pas une
  // dépendance du rendu. En cas d'échec le lot est perdu — `reindex()` sait le rattraper.
  function flush() {
    timer = null;
    if (!pendingRows.size && !pendingTouch.size) return;
    const rows = [...pendingRows.values()];
    const touches = /** @type {Array<[string, number]>} */ ([...pendingTouch.entries()]);
    pendingRows.clear();
    pendingTouch.clear();
    try { backend.commit(rows, touches); } catch (_) {}
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(flush, FLUSH_MS);
    // unref : ce timer ne doit pas retenir le process au moment de sortir.
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * Enregistre une entrée de cache fraîchement écrite. Appelé DEPUIS le chemin d'écriture des caches
   * (thumbs/proxy/ffmpeg/sidecars) → fire-and-forget, jamais await, jamais throw.
   * @param {{ kind: string, file: string, source?: string|null, bytes?: number }} e
   */
  function record(e) {
    try {
      if (!e || !e.file || !e.kind) return;
      const now = Date.now();
      let bytes = Number(e.bytes) || 0;
      if (!bytes) { try { bytes = fs.statSync(e.file).size; } catch (_) { return; } }
      pendingRows.set(e.file, {
        file: e.file,
        kind: e.kind,
        source: e.source ? path.resolve(e.source) : null,
        bytes,
        created: now,
        used: now,
      });
      pendingTouch.delete(e.file);
      schedule();
    } catch (_) {}
  }

  /** Marque une entrée comme utilisée (cache hit) → alimente la purge LRU. */
  function touch(file) {
    try {
      if (!file) return;
      const row = pendingRows.get(file);
      if (row) { row.used = Date.now(); return; }
      pendingTouch.set(file, Date.now());
      schedule();
    } catch (_) {}
  }

  /** Retire des lignes (après suppression réelle des fichiers). Immédiat : le chemin de purge doit
   *  être exact, pas différé. */
  function forget(files) {
    const list = (Array.isArray(files) ? files : []).filter(Boolean);
    if (!list.length) return;
    for (const f of list) { pendingRows.delete(f); pendingTouch.delete(f); }
    try { backend.del(list); } catch (_) {}
  }

  /** Réécrit les chemins après déplacement du dossier de cache. */
  function move(pairs) {
    const list = (Array.isArray(pairs) ? pairs : []).filter((p) => p && p[0] && p[1]);
    if (!list.length) return;
    flush();
    try { backend.move(list); } catch (_) {}
  }

  /** @returns {CacheRow[]} */
  function all() {
    flush();
    try { return backend.all(); } catch (_) { return []; }
  }

  /** Totaux par type de cache. */
  function stats() {
    /** @type {Record<string, { bytes: number, files: number }>} */
    const byKind = {};
    let total = 0;
    let files = 0;
    for (const r of all()) {
      const k = byKind[r.kind] || (byKind[r.kind] = { bytes: 0, files: 0 });
      k.bytes += r.bytes;
      k.files += 1;
      total += r.bytes;
      files += 1;
    }
    return { total, files, byKind };
  }

  /** Agrégat par média source — la base de l'arbre projet → rush. `source: null` = non attribué. */
  function bySource() {
    /** @type {Map<string, { source: string|null, bytes: number, files: number, byKind: Record<string, number> }>} */
    const map = new Map();
    for (const r of all()) {
      const key = r.source || '';
      let e = map.get(key);
      if (!e) { e = { source: r.source || null, bytes: 0, files: 0, byKind: {} }; map.set(key, e); }
      e.bytes += r.bytes;
      e.files += 1;
      e.byKind[r.kind] = (e.byKind[r.kind] || 0) + r.bytes;
    }
    return [...map.values()];
  }

  /** Entrées d'un type, les moins récemment utilisées d'abord (purge par quota). */
  function lru(kindName) {
    flush();
    try { return /** @type {CacheRow[]} */ (backend.byKind(kindName)); } catch (_) { return []; }
  }

  /** Entrées d'un type non touchées depuis `cutoff` (purge par âge). */
  function olderThan(kindName, cutoff) {
    return lru(kindName).filter((r) => r.used < cutoff);
  }

  /** Oublie les lignes dont le fichier a disparu hors de l'index (nettoyage de session, Storage
   * Sense, suppression manuelle). Sans ce passage, Paramètres › Stockage additionnerait des octets
   * fantômes et la LRU tenterait de purger éternellement les mêmes chemins. */
  function pruneMissing() {
    const missing = all().filter((row) => {
      try { return !fs.existsSync(row.file); } catch (_) { return true; }
    }).map((row) => row.file);
    forget(missing);
    return missing.length;
  }

  return { record, touch, forget, move, all, stats, bySource, lru, olderThan, pruneMissing, flush, backend: kind, close: () => { flush(); backend.close(); } };
}

// Singleton PARESSEUX pour les modules à import direct (thumbs/proxy/ffmpeg/sidecars) : ils écrivent
// dans les caches sans recevoir de deps injectées, et threader un paramètre à travers eux pour un
// simple enregistrement ne vaut pas le bruit. Créé au premier usage (ouvrir la base au require
// coûterait à tout process qui charge config). `createCacheIndex` reste exporté pour cacheAdmin.
/** @type {ReturnType<typeof createCacheIndex>|null} */
let singleton = null;
function cacheIndex() {
  if (!singleton) {
    const { DATA_DIR } = require('./config');
    singleton = createCacheIndex(DATA_DIR);
  }
  return singleton;
}

module.exports = { createCacheIndex, cacheIndex };
