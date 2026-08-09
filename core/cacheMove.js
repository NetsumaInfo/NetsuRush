// @ts-check
// Deux opérations longues de Paramètres › Stockage, sorties de cacheAdmin pour garder des fichiers
// courts : changer le dossier de cache (avec migration optionnelle) et réindexer l'existant.
//
// Réindexation : l'index latéral ne connaît que ce qui a été écrit APRÈS son introduction. Sans
// rattrapage, tout le cache déjà sur disque tomberait dans « non attribué ». On recoupe donc les
// fichiers orphelins avec les rushs connus de netsurush.db (qui, elle, porte `file_path` en clair) en
// REJOUANT les fonctions de hachage d'origine — c'est le seul moyen d'inverser un md5 à sens unique.

const path = require('path');
const crypto = require('crypto');
const { getThumbDir, getProxyDir, setCacheDir, saveConfig, CONFIG, fsp, yieldLoop } = require('./config');
const cacheDb = require('./cacheDb');
const { t } = require('./i18n');

/** Recalcule la clé d'une vignette. DOIT rester synchrone avec thumbs.js:thumbKey — une divergence ne
 *  casse rien (le rattrapage échoue simplement, l'entrée reste « non attribuée »). */
const thumbKeyOf = (filePath, time) =>
  crypto.createHash('md5').update(`${filePath}|${Number(time).toFixed(2)}|320`).digest('hex');

function createCacheMove({ cacheIndex, broadcast }) {
  const emit = (phase, done, total) => {
    if (!broadcast) return;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    broadcast('cache:progress', { phase, done, total, pct });
  };

  /**
   * Réindexe les fichiers de cache présents sur disque mais absents de l'index.
   *
   * Les vignettes sont réattribuables : on rejoue `md5(chemin|temps|320)` pour chaque plan connu de la
   * base (scene_cache_v4/v3 donne les temps de chaque rush) et on compare aux noms de fichiers présents.
   * Les proxies ne le sont PAS (la clé contient start/end/codec/hauteur — l'espace est trop large pour
   * être rejoué) : ils sont indexés SANS source et restent purgeables en bloc via « non attribué ».
   */
  async function reindex() {
    const known = new Map();   // nom de fichier attendu → média source
    try {
      const db = cacheDb.sizes();
      const sources = db.bySource.map((e) => e.source);
      emit('scan', 0, sources.length);
      let i = 0;
      for (const src of sources) {
        for (const t of await sceneTimes(src)) known.set(`${thumbKeyOf(src, t)}.jpg`, src);
        emit('scan', ++i, sources.length);
        await yieldLoop();
      }
    } catch (_) {}

    const { roots } = require('./cacheAdmin');
    // UN seul scan de l'index plutôt qu'un `has()` par fichier : sur un cache de dizaines de milliers
    // de vignettes, la requête par entrée transformerait la réindexation en plusieurs minutes.
    const indexed = new Set(cacheIndex.all().map((r) => r.file));
    let added = 0;
    let attributed = 0;
    const dirs = roots();
    let d = 0;
    for (const r of dirs) {
      let entries = [];
      try { entries = await fsp.readdir(r.dir, { withFileTypes: true }); } catch (_) { emit('index', ++d, dirs.length); continue; }
      for (const e of entries) {
        const full = path.join(r.dir, e.name);
        if (indexed.has(full)) continue;
        let bytes = 0;
        try {
          const st = await fsp.stat(full);
          // Le roto-cache est un DOSSIER par session ; les autres types sont des fichiers plats.
          bytes = st.isDirectory() ? await dirBytes(full) : st.size;
        } catch (_) { continue; }
        const source = r.kind === 'thumb' ? (known.get(e.name) || null) : null;
        if (source) attributed++;
        cacheIndex.record({ kind: r.kind, file: full, source, bytes });
        added++;
        if (added % 200 === 0) await yieldLoop();
      }
      emit('index', ++d, dirs.length);
    }
    cacheIndex.flush();
    return { ok: true, added, attributed };
  }

  /** Temps (secondes) de chaque plan d'un rush, lus dans le cache de plans — l'entrée du rejeu de clé. */
  async function sceneTimes(src) {
    /** @type {number[]} */
    const out = [];
    try {
      const rows = cacheDb.scenesOf(src);
      for (const r of rows) for (const s of r) out.push(s);
    } catch (_) {}
    return out;
  }

  async function dirBytes(root) {
    const { dirSize } = require('./optimize');
    try { return await dirSize(root, 4); } catch (_) { return 0; }
  }

  /**
   * Change le dossier de cache (vignettes + proxies uniquement).
   *
   * L'ordre compte : on BASCULE le dossier AVANT de copier. Les nouvelles écritures atterrissent alors
   * dans le nouveau dossier et l'ancien devient statique — l'ordre inverse laisserait orphelins tous
   * les fichiers écrits pendant la copie.
   *
   * @param {{ dir?: string|null, migrate?: 'move'|'leave' }} opts
   */
  async function setDir(opts = {}) {
    const target = opts.dir ? path.resolve(String(opts.dir)) : null;
    if (target) {
      try {
        const st = await fsp.stat(target);
        if (!st.isDirectory()) return { ok: false, error: t('targetNotFolder') };
      } catch (_) { return { ok: false, error: t('folderMissing') }; }
      try { await fsp.access(target, require('fs').constants.W_OK); } catch (_) { return { ok: false, error: t('readOnlyFolder') }; }
    }

    const from = { thumb: getThumbDir(), proxy: getProxyDir() };
    const to = setCacheDir(target);                     // bascule d'abord
    saveConfig({ cache: { ...(CONFIG.cache || {}), dir: target } });

    if (opts.migrate !== 'move' || (from.thumb === to.thumb && from.proxy === to.proxy)) {
      return { ok: true, dirs: to, moved: 0 };
    }

    /** @type {Array<[string, string]>} */
    const pairs = [];
    for (const kind of /** @type {const} */ (['thumb', 'proxy'])) {
      let entries = [];
      try { entries = await fsp.readdir(from[kind]); } catch (_) { continue; }
      for (const name of entries) pairs.push([path.join(from[kind], name), path.join(to[kind], name)]);
    }

    let moved = 0;
    /** @type {Array<[string, string]>} */
    const done = [];
    emit('move', 0, pairs.length);
    for (const [src, dst] of pairs) {
      try {
        // rename d'abord : instantané sur le même volume. Copie + suppression sinon (autre disque).
        try {
          await fsp.rename(src, dst);
        } catch (_) {
          await fsp.copyFile(src, dst);
          await fsp.rm(src, { force: true });
        }
        done.push([src, dst]);
        moved++;
      } catch (_) {}
      if (moved % 25 === 0) { emit('move', moved, pairs.length); await yieldLoop(); }
    }
    cacheIndex.move(done);
    emit('move', pairs.length, pairs.length);
    return { ok: true, dirs: to, moved, total: pairs.length };
  }

  return { reindex, setDir };
}

module.exports = { createCacheMove };
