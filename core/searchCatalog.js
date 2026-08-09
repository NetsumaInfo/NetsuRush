// @ts-check
// Lectures légères du catalogue NetsuSearch directement depuis SQLite.
// Le statut initial ne doit pas démarrer search.py : son import charge aussi les piles SigLIP,
// visages et OpenCV, alors que ces compteurs ne demandent aucun modèle.

const path = require('path');
const fs = require('fs');
const { DB_PATH } = require('./cacheDb');
const { DETECT_ENV } = require('./config');

// Tag lu À CHAQUE APPEL : la variante active est changeable en cours de session (Paramètres ›
// Modèles) et met à jour DETECT_ENV. Un const figé au require aurait continué de compter les plans
// de l'ancienne variante après la bascule.
// L'ID DE CATALOGUE prime sur le dossier — MÊME RÈGLE que python/nrsearch/config.py#MODEL_TAG, les
// deux doivent lire la même colonne `model`. Dériver le tag du dossier le faisait changer pour des
// poids identiques (repo `…-patch16-naflex` téléchargé dans `siglip2-so400m`).
function modelTag() {
  const source = DETECT_ENV.NETSURUSH_SIGLIP_MODEL
    || DETECT_ENV.NETSURUSH_SIGLIP_DIR
    || 'google/siglip2-so400m-patch16-naflex';
  return path.basename(String(source).replace(/[\\/]+$/, '')) || 'siglip2';
}

// SQLite plafonne le nombre de paramètres liés d'une requête : un Media Pool de plusieurs milliers de
// rushs se compte donc par tranches, agrégées en JS (les chemins sont distincts → sommes valides).
const PATH_CHUNK = 400;

/** @param {string[]} paths @returns {string[][]} */
function chunkPaths(paths) {
  const unique = [...new Set(paths.filter(Boolean))];
  const out = [];
  for (let i = 0; i < unique.length; i += PATH_CHUNK) out.push(unique.slice(i, i + PATH_CHUNK));
  return out;
}

/** @param {string[]} chunk */
function placeholders(chunk) { return chunk.map(() => '?').join(','); }

/** @param {string} dbPath */
function createSearchCatalog(dbPath = DB_PATH) {
  function open() {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { db.exec('PRAGMA busy_timeout=15000'); } catch (_) {}
      return db;
    } catch (_) {
      return null;
    }
  }

  /**
   * Compteurs de l'index de plans. `filePaths` = portée (rushs des projets sélectionnés) ;
   * absent = index entier.
   * @param {string[]} [filePaths]
   */
  function status(filePaths) {
    const tag = modelTag();
    if (!fs.existsSync(dbPath)) return { clips: 0, frames: 0, model: tag, error: null };
    const db = open();
    if (!db) return null;
    try {
      let clips = 0, frames = 0;
      if (filePaths) {
        for (const chunk of chunkPaths(filePaths)) {
          const row = /** @type {any} */ (db.prepare(
            'SELECT COUNT(DISTINCT file_path) AS clips, COUNT(*) AS frames '
            + `FROM frame_embeddings_v1 WHERE model=? AND file_path IN (${placeholders(chunk)})`,
          ).get(tag, ...chunk));
          clips += Number(row?.clips) || 0;
          frames += Number(row?.frames) || 0;
        }
        return { clips, frames, model: tag, error: null };
      }
      const row = /** @type {any} */ (db.prepare(
        'SELECT COUNT(DISTINCT file_path) AS clips, COUNT(*) AS frames '
        + 'FROM frame_embeddings_v1 WHERE model=?',
      ).get(tag));
      return { clips: Number(row?.clips) || 0, frames: Number(row?.frames) || 0, model: tag, error: null };
    } catch (_) {
      return { clips: 0, frames: 0, model: tag, error: null };
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  /** @param {string[]} [filePaths] portée (rushs des projets sélectionnés) ; absent = index entier */
  function faceStatus(filePaths) {
    if (!fs.existsSync(dbPath)) return { faces: 0, clips: 0, anime: 0, real: 0, error: null };
    const db = open();
    if (!db) return null;
    try {
      let faces = 0, clips = 0;
      /** @type {Record<string, number>} */
      const counts = {};
      const chunks = filePaths ? chunkPaths(filePaths) : [null];
      for (const chunk of chunks) {
        const where = chunk ? ` WHERE file_path IN (${placeholders(chunk)})` : '';
        const args = chunk || [];
        const row = /** @type {any} */ (db.prepare(
          `SELECT COUNT(*) AS faces, COUNT(DISTINCT file_path) AS clips FROM face_embeddings_v2${where}`,
        ).get(...args));
        faces += Number(row?.faces) || 0;
        clips += Number(row?.clips) || 0;
        const domains = /** @type {any[]} */ (db.prepare(
          `SELECT domain, COUNT(*) AS count FROM face_embeddings_v2${where} GROUP BY domain`,
        ).all(...args));
        for (const r of domains) counts[String(r.domain)] = (counts[String(r.domain)] || 0) + (Number(r.count) || 0);
      }
      return {
        faces,
        clips,
        anime: counts.anime || 0,
        real: counts.real || 0,
        error: null,
      };
    } catch (_) {
      return { faces: 0, clips: 0, anime: 0, real: 0, error: null };
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  /**
   * Roster de personnages. `filePaths` = portée : on compte EN PLUS les plans étiquetés de chaque
   * perso à l'intérieur de la portée (`scopeShots`) → le renderer masque les personnages absents du
   * projet courant. null = portée inconnue (index entier) : rien n'est masqué.
   * @param {string[]} [filePaths]
   */
  function characters(filePaths) {
    if (!fs.existsSync(dbPath)) return { characters: [], error: null };
    const db = open();
    if (!db) return null;
    try {
      const chars = /** @type {any[]} */ (db.prepare(
        'SELECT id, name, notes, tags, color, avatar FROM characters_v1 ORDER BY name',
      ).all());
      const rows = /** @type {any[]} */ (db.prepare(
        'SELECT char_id, domain, COUNT(*) AS count FROM character_samples_v1 GROUP BY char_id, domain',
      ).all());
      /** @type {Map<number, number>} */
      const scopeShots = new Map();
      if (filePaths) {
        for (const chunk of chunkPaths(filePaths)) {
          const rows = /** @type {any[]} */ (db.prepare(
            `SELECT char_id, COUNT(DISTINCT file_path || '#' || scene_index) AS shots
             FROM face_labels_v1 WHERE file_path IN (${placeholders(chunk)}) GROUP BY char_id`,
          ).all(...chunk));
          for (const row of rows) {
            const id = Number(row.char_id);
            scopeShots.set(id, (scopeShots.get(id) || 0) + (Number(row.shots) || 0));
          }
        }
      }
      /** @type {Map<number, Record<string, number>>} */
      const counts = new Map();
      for (const row of rows) {
        const id = Number(row.char_id);
        const byDomain = counts.get(id) || {};
        byDomain[String(row.domain)] = Number(row.count) || 0;
        counts.set(id, byDomain);
      }
      return {
        characters: chars.map((c) => {
          const samples = counts.get(Number(c.id)) || {};
          let tags = [];
          try { tags = JSON.parse(String(c.tags || '[]')); } catch (_) {}
          const avatar = c.avatar ? `data:image/jpeg;base64,${Buffer.from(c.avatar).toString('base64')}` : null;
          return {
            id: Number(c.id), name: String(c.name || ''), notes: String(c.notes || ''),
            tags: Array.isArray(tags) ? tags : [], color: String(c.color || ''), avatar,
            samples: { anime: samples.anime || 0, real: samples.real || 0 },
            total: Object.values(samples).reduce((sum, n) => sum + n, 0),
            scopeShots: filePaths ? (scopeShots.get(Number(c.id)) || 0) : null,
          };
        }),
        error: null,
      };
    } catch (_) {
      return { characters: [], error: null };
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  /**
   * Plans indexés PAR VARIANTE de modèle (`frame_embeddings_v1.model` = tag du modèle). Sert à dire
   * à l'utilisateur ce qu'une variante a déjà, et donc ce qu'une bascule lui coûtera en ré-indexation.
   * @returns {Record<string, { clips: number, frames: number }>}
   */
  function indexedByModel() {
    if (!fs.existsSync(dbPath)) return {};
    const db = open();
    if (!db) return {};
    try {
      const rows = /** @type {any[]} */ (db.prepare(
        'SELECT model, COUNT(DISTINCT file_path) AS clips, COUNT(*) AS frames '
        + 'FROM frame_embeddings_v1 GROUP BY model',
      ).all());
      /** @type {Record<string, { clips: number, frames: number }>} */
      const out = {};
      for (const row of rows) {
        out[String(row.model)] = { clips: Number(row.clips) || 0, frames: Number(row.frames) || 0 };
      }
      return out;
    } catch (_) {
      return {};
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  return { status, faceStatus, characters, indexedByModel };
}

module.exports = { modelTag, createSearchCatalog };
