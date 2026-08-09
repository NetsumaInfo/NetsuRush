// @ts-check
// Taille et purge de la base SQLite partagée `~/.netsurush/netsurush.db` (cache de plans, embeddings
// de recherche, transcriptions) + des index FAISS voisins.
//
// C'est le plus gros consommateur SILENCIEUX de l'app : un rush de 1000 plans y laisse ~50-70 Mo
// (embedding 4,6 Ko + vignette JPEG en BLOB 20-50 Ko par plan), et rien ne l'a jamais mesuré ni purgé.
//
// Accès en Node via node:sqlite — même patron que core/voice.js:186 qui lit déjà cette base. La base
// est en WAL + busy_timeout (cf. python/detect.py:95), donc l'accès concurrent avec les daemons python
// est sûr. Pas de sidecar, pas de dépendance au venv : le panneau Stockage reste utilisable même sans
// environnement python installé.
//
// Contrairement aux caches de fichiers, ces tables portent `file_path` EN CLAIR → l'attribution par
// rush est directe, sans index latéral.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { t } = require('./i18n');

// Chemin calqué sur python/detect.py:88 (`~/.netsurush/netsurush.db`), qui reste la source unique.
// La base NE SUIT PAS le dossier de cache relocalisable : python la référence en dur.
const DB_PATH = path.join(os.homedir(), '.netsurush', 'netsurush.db');
const DB_DIR = path.dirname(DB_PATH);

// Carte pilotée par données : chaque opération est tentée table par table et un échec (table absente,
// schéma plus ancien) est ignoré, jamais fatal. `size` est une expression SQL en octets ; 0 pour les
// tables satellites, minuscules, qu'on supprime avec leurs parentes pour ne pas laisser d'orphelins.
//
// `columns` = colonnes BLOB comptées et purgées SÉPARÉMENT de leur ligne : les vignettes pèsent plus
// lourd que les vecteurs (6,6 Ko contre 4,6 Ko par plan) alors qu'elles ne coûtent qu'un ffmpeg à
// refaire. Les mélanger dans un seul poste « Index de recherche » laissait croire que vider ce poste
// coûtait des heures de GPU dans tous les cas, et interdisait de récupérer les 130 Mo faciles.
//
// `frame_embeddings_v1.thumb` n'est plus ÉCRITE : les vignettes de plan viennent du cache partagé
// (core/thumbs.js), commun au découpage et à la recherche. Ce qu'on compte ici est donc ce qu'une
// ancienne indexation a laissé — récupérable une fois pour toutes — plus les recadrages de VISAGES
// (`face_embeddings_v2.thumb`), eux toujours vivants : un cadre de visage n'est pas une frame, rien
// d'autre ne le porte, et `nrsearch/faces.py#_refresh_small_thumbs` sait le refaire sans GPU.
//
// EXCLUS volontairement : characters_v1 / character_samples_v1 (roster de personnages nommés, saisi par
// l'utilisateur → donnée, pas cache).
const LEN = (col) => `IFNULL(LENGTH(${col}),0)`;
const NOT_NULL = (col) => `SUM(CASE WHEN ${col} IS NOT NULL THEN 1 ELSE 0 END)`;
const THUMB_COLUMN = [{ kind: 'indexThumbs', column: 'thumb' }];
const TABLES = [
  { table: 'scene_cache_v4', kind: 'scenes', size: `${LEN('scenes_json')}+${LEN('options_json')}` },
  { table: 'scene_cache_v3', kind: 'scenes', size: LEN('scenes_json') },
  { table: 'frame_embeddings_v1', kind: 'embeddings', size: LEN('embedding'), columns: THUMB_COLUMN },
  { table: 'index_runs_v1', kind: 'embeddings', size: '0' },
  { table: 'face_embeddings_v2', kind: 'faces', size: LEN('embedding'), columns: THUMB_COLUMN },
  { table: 'face_labels_v1', kind: 'faces', size: '0' },
  { table: 'transcript_cache_v1', kind: 'transcripts', size: LEN('result_json') },
  { table: 'silence_cache_v1', kind: 'transcripts', size: LEN('result_json') },
  { table: 'filler_cache_v1', kind: 'transcripts', size: LEN('result_json') },
];

/** Types de cache servis par ce module (sous-ensemble de CACHE_KINDS). */
const DB_KINDS = ['scenes', 'embeddings', 'indexThumbs', 'faces', 'transcripts'];

/** Ceux d'entre eux qui relèvent des APERÇUS et non des analyses : leur contenu est une image que
 *  ffmpeg refait en quelques secondes, sans modèle ni GPU. Rangés avec les embeddings, ils héritaient
 *  de l'avertissement « des heures de GPU » alors qu'ils sont exactement ce qu'on vide en premier. */
const REUSABLE_DB_KINDS = new Set(['indexThumbs']);

function open(readOnly = true) {
  if (!fs.existsSync(DB_PATH)) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    // `{}` et non `undefined` : node:sqlite refuse une option non-objet (« The "options" argument must
    // be an object ») — l'erreur était avalée par le catch et TOUTE purge répondait « base introuvable ».
    const db = new DatabaseSync(DB_PATH, readOnly ? { readOnly: true } : {});
    // busy_timeout : un daemon python peut écrire pendant qu'on lit → on attend au lieu d'échouer.
    try { db.exec('PRAGMA busy_timeout=15000'); } catch (_) {}
    return db;
  } catch (_) {
    return null;
  }
}

function fileBytes(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

/** Poids réel de la base : le fichier + son journal WAL (qui peut peser lourd à lui seul). */
function dbInfo() {
  const exists = fs.existsSync(DB_PATH);
  const bytes = fileBytes(DB_PATH) + fileBytes(`${DB_PATH}-wal`) + fileBytes(`${DB_PATH}-shm`);
  return { path: DB_PATH, exists, bytes, available: exists && !!open(true) };
}

/**
 * Index FAISS voisins (`faiss_<MODEL_TAG>.index` + `.json`, cf. python/nrsearch/store.py:39).
 * Changer de variante SigLIP change le MODEL_TAG → l'ancien index reste sur disque pour toujours.
 * On ne peut pas deviner le tag actif sans python : on liste tout, l'UI les présente ensemble.
 */
function faissInfo() {
  /** @type {{ path: string, bytes: number }[]} */
  const files = [];
  let entries = [];
  try { entries = fs.readdirSync(DB_DIR); } catch (_) { return { files, bytes: 0 }; }
  for (const f of entries) {
    if (!/^faiss_.*\.(index|json)$/.test(f)) continue;
    const p = path.join(DB_DIR, f);
    files.push({ path: p, bytes: fileBytes(p) });
  }
  return { files, bytes: files.reduce((s, f) => s + f.bytes, 0) };
}

/**
 * Tailles par type et par média source. Une seule ouverture, une requête agrégée par table.
 * @returns {{ byKind: Record<string, { bytes: number, rows: number }>, bySource: Array<{ source: string, bytes: number, byKind: Record<string, number> }>, total: number }}
 */
function sizes() {
  /** @type {Record<string, { bytes: number, rows: number }>} */
  const byKind = {};
  /** @type {Map<string, { source: string, bytes: number, byKind: Record<string, number> }>} */
  const srcMap = new Map();
  let total = 0;

  const db = open(true);
  if (!db) return { byKind, bySource: [], total };
  /** Impute des octets à un type, globalement et pour le média source. */
  const add = (kind, key, bytes, rows) => {
    if (!bytes && !rows) return;
    const k = byKind[kind] || (byKind[kind] = { bytes: 0, rows: 0 });
    k.bytes += bytes;
    k.rows += rows;
    total += bytes;
    if (!key) return;
    let e = srcMap.get(key);
    if (!e) { e = { source: key, bytes: 0, byKind: {} }; srcMap.set(key, e); }
    e.bytes += bytes;
    e.byKind[kind] = (e.byKind[kind] || 0) + bytes;
  };
  try {
    for (const t of TABLES) {
      const cols = t.columns || [];
      // Une seule passe par table : la ligne et chacune de ses colonnes détachées sont sommées ensemble.
      const extra = cols.map((c, i) => `SUM(${LEN(c.column)}) AS b${i}, ${NOT_NULL(c.column)} AS n${i}`);
      let rows;
      try {
        rows = /** @type {any[]} */ (
          db.prepare(`SELECT file_path AS f, COUNT(*) AS n, SUM(${t.size}) AS b${extra.length ? `, ${extra.join(', ')}` : ''} `
            + `FROM ${t.table} GROUP BY file_path`).all()
        );
      } catch (_) { continue; }   // table absente / schéma plus ancien → on saute
      for (const r of rows) {
        const key = String(r.f || '');
        add(t.kind, key, Number(r.b) || 0, Number(r.n) || 0);
        cols.forEach((c, i) => add(c.kind, key, Number(r[`b${i}`]) || 0, Number(r[`n${i}`]) || 0));
      }
    }
  } finally {
    try { db.close(); } catch (_) {}
  }
  return { byKind, bySource: [...srcMap.values()], total };
}

/**
 * Purge d'une table pour les types demandés. La ligne entière part quand SON type est visé ; sinon
 * seules les colonnes détachées visées sont remises à NULL (vider les vignettes ne doit pas emporter
 * les vecteurs, qui coûtent des heures de GPU à refaire).
 * @param {any} db @param {typeof TABLES[number]} table @param {Set<string>|null} want
 * @param {string} [source] limite à un média ; absent = toute la table
 */
function purgeTable(db, table, want, source) {
  const where = source ? ' WHERE file_path = ?' : '';
  const args = source ? [source] : [];
  const run = (sql) => {
    try {
      const r = /** @type {any} */ (db.prepare(sql).run(...args));
      return Number(r && r.changes) || 0;
    } catch (_) { return 0; }   // table absente / schéma plus ancien → on saute
  };
  if (!want || want.has(table.kind)) return run(`DELETE FROM ${table.table}${where}`);
  let rows = 0;
  for (const col of table.columns || []) {
    if (!want.has(col.kind)) continue;
    rows += run(`UPDATE ${table.table} SET ${col.column} = NULL${where}`);
  }
  return rows;
}

/**
 * Supprime les lignes des médias donnés, pour les types donnés. Réplique la forme déjà utilisée côté
 * python (nrsearch/index.py `DELETE ... WHERE file_path=?`, faces.py).
 *
 * Supprimer des embeddings laisse l'index FAISS périmé, mais store.py se répare seul (contrôle de
 * COUNT sous watermark → reconstruction) → rien à faire ici.
 *
 * @param {string[]} paths
 * @param {string[]} [kinds] types à purger (défaut : tous)
 */
function purgeFiles(paths, kinds) {
  const list = (Array.isArray(paths) ? paths : []).filter(Boolean).map(String);
  if (!list.length) return { ok: true, rows: 0 };
  const want = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
  const db = open(false);
  if (!db) return { ok: false, rows: 0, error: t('databaseMissing') };
  let rows = 0;
  try {
    db.exec('BEGIN');
    for (const table of TABLES) {
      for (const p of list) rows += purgeTable(db, table, want, p);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return { ok: false, rows: 0, error: String((e && e.message) || e) };
  } finally {
    try { db.close(); } catch (_) {}
  }
  return { ok: true, rows };
}

/**
 * Vide entièrement un type de cache (toutes ses tables, tous les médias).
 * @param {string[]} kinds
 */
function purgeKinds(kinds) {
  const want = new Set(Array.isArray(kinds) ? kinds : []);
  if (!want.size) return { ok: true, rows: 0 };
  const db = open(false);
  if (!db) return { ok: false, rows: 0, error: t('databaseMissing') };
  let rows = 0;
  try {
    db.exec('BEGIN');
    for (const table of TABLES) rows += purgeTable(db, table, want);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return { ok: false, rows: 0, error: String((e && e.message) || e) };
  } finally {
    try { db.close(); } catch (_) {}
  }
  return { ok: true, rows };
}

/**
 * Temps (secondes) de début de chaque plan d'un rush, lus dans le cache de plans. Sert UNIQUEMENT à la
 * réindexation : rejouer `md5(chemin|temps|320)` est le seul moyen de rattacher une vignette déjà sur
 * disque à son rush, le nom de fichier étant un hash à sens unique.
 * @param {string} source
 * @returns {number[][]} un tableau de temps par entrée de cache (modèles/seuils différents)
 */
function scenesOf(source) {
  const db = open(true);
  if (!db) return [];
  /** @type {number[][]} */
  const out = [];
  try {
    for (const table of ['scene_cache_v4', 'scene_cache_v3']) {
      /** @type {any[]} */
      let rows = [];
      try { rows = db.prepare(`SELECT scenes_json FROM ${table} WHERE file_path = ?`).all(source); }
      catch (_) { continue; }
      for (const r of rows) {
      try {
        const scenes = JSON.parse(String(r.scenes_json || '[]'));
        if (!Array.isArray(scenes)) continue;
        // thumbs.js appelle thumbnail(path, time) avec le DÉBUT du plan → c'est `start` qu'on rejoue.
        out.push(scenes.flatMap((s) => {
          const n = Number(s && s.start);
          return Number.isFinite(n) ? [n] : [];
        }));
      } catch (_) {}
      }
    }
  } catch (_) {
  } finally {
    try { db.close(); } catch (_) {}
  }
  return out;
}

/** Médias indexés dont le fichier n'existe plus sur disque (rush supprimé, disque externe débranché).
 *  ⚠️ Ne PURGE pas : un disque externe débranché ferait tout disparaître. On rapporte, l'utilisateur
 *  décide — même prudence que core/library.js:389. */
function missingSources() {
  const out = [];
  for (const e of sizes().bySource) {
    try { if (!fs.existsSync(e.source)) out.push(e); } catch (_) {}
  }
  return out;
}

/** Compacte la base après une grosse purge (l'espace libéré n'est rendu au disque qu'ici).
 *  VACUUM exige un verrou exclusif → échoue si un daemon python tient la base. */
function vacuum() {
  const before = fileBytes(DB_PATH);
  const db = open(false);
  if (!db) return { ok: false, error: t('databaseMissing') };
  try {
    db.exec('VACUUM');
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    try { db.close(); } catch (_) {}
  }
  return { ok: true, freed: Math.max(0, before - fileBytes(DB_PATH)) };
}

module.exports = { DB_PATH, DB_KINDS, REUSABLE_DB_KINDS, dbInfo, faissInfo, sizes, scenesOf, purgeFiles, purgeKinds, missingSources, vacuum };
