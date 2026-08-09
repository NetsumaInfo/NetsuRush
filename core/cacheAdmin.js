// @ts-check
// Orchestrateur de Paramètres › Stockage : mesurer, présenter en arbre (projet → rush → type) et
// purger de façon CIBLÉE. Le déplacement du dossier de cache et la réindexation vivent dans
// core/cacheMove.js (même module logique, découpé pour rester lisible).
//
// Deux sources de vérité, réunies ici :
//  - les caches de FICHIERS (vignettes/proxies/voix/upscale-test/roto) → l'index latéral (cacheIndex),
//    seul capable de relier un nom md5 à son rush ;
//  - les caches de BASE (plans/embeddings/transcriptions) → cacheDb, qui a `file_path` en clair.
//
// SÉCURITÉ : tout chemin reçu du renderer est revalidé ici avant suppression — il doit se résoudre à
// l'intérieur d'une racine de cache connue. Même principe que la whitelist de core/optimize.js:199,
// adapté à des fichiers plutôt qu'à des noms de dossiers Resolve.

const path = require('path');
const fs = require('fs');
const { t } = require('./i18n');
const {
  VOICE_DIR, UPSCALE_TEST_DIR, ROTO_DIR, DEFAULT_THUMB_DIR, DEFAULT_PROXY_DIR,
  getThumbDir, getProxyDir, getCacheRoot, fsp, yieldLoop,
} = require('./config');
const { dirSize, diskInfo } = require('./optimize');
const cacheDb = require('./cacheDb');
const models = require('./models');
const thumbs = require('./thumbs');
const { thumbKeyVariants } = require('./thumbPresets');
const proxy = require('./proxy');

/** Types dont les entrées sont des FICHIERS sur disque (le reste vit dans netsurush.db). */
const FILE_KINDS = ['thumb', 'proxy', 'voice', 'upscaleTest', 'roto'];
const FILE_KIND_SET = new Set(FILE_KINDS);
const SESSION_KIND_SET = new Set(['voice', 'upscaleTest', 'roto']);

/** Racine de chaque type de cache de fichiers, à l'instant T (les dossiers vignettes/proxies sont
 *  relocalisables → toujours via les getters). */
function roots() {
  return [
    { kind: 'thumb', dir: getThumbDir() },
    { kind: 'proxy', dir: getProxyDir() },
    { kind: 'voice', dir: VOICE_DIR },
    { kind: 'upscaleTest', dir: UPSCALE_TEST_DIR },
    { kind: 'roto', dir: ROTO_DIR },
  ];
}

/** Dossiers où une suppression est autorisée. Inclut TOUJOURS les emplacements par défaut : après un
 *  changement de dossier avec « laisser sur place », l'ancien dossier doit rester nettoyable. */
function allowedRoots() {
  return [...roots().map((r) => r.dir), DEFAULT_THUMB_DIR, DEFAULT_PROXY_DIR];
}

/** Vrai si `p` est bien à l'intérieur d'une racine de cache. Barrière anti-« chemin arbitraire venu du
 *  renderer » : on compare des chemins RÉSOLUS (`..` neutralisés) avec un séparateur final pour éviter
 *  qu'un dossier voisin de préfixe commun passe (`…/thumbs-perso` vs `…/thumbs`). */
function insideCache(p) {
  let target;
  try { target = path.resolve(String(p || '')); } catch (_) { return false; }
  if (!target) return false;
  return allowedRoots().some((root) => {
    const r = path.resolve(root);
    if (target === r) return false;               // la racine elle-même n'est pas une entrée
    return target.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  });
}

function createCacheAdmin({ cacheIndex, broadcast }) {
  /** Vue d'ensemble : poids par type, total, disque, base, modèles. */
  async function overview() {
    cacheIndex.pruneMissing?.();
    const idx = cacheIndex.stats();
    const db = cacheDb.sizes();
    const dbi = cacheDb.dbInfo();
    const faiss = cacheDb.faissInfo();

    const kinds = [];
    for (const r of roots()) {
      const s = idx.byKind[r.kind];
      kinds.push({
        kind: r.kind,
        lifecycle: SESSION_KIND_SET.has(r.kind) ? 'session' : 'reusable',
        dir: r.dir,
        bytes: s ? s.bytes : 0,
        files: s ? s.files : 0,
        // Poids réel du dossier : révèle ce que l'index ignore encore (caches d'avant l'index, ou
        // reliquats). L'écart index/disque est ce que « Réindexer » va rattraper.
        onDisk: await dirSize(r.dir, 3),
      });
    }
    for (const k of cacheDb.DB_KINDS) {
      const s = db.byKind[k];
      kinds.push({
        kind: k,
        lifecycle: cacheDb.REUSABLE_DB_KINDS.has(k) ? 'reusable' : 'durable',
        dir: dbi.path, bytes: s ? s.bytes : 0, files: s ? s.rows : 0, onDisk: null,
      });
    }

    const total = kinds.reduce((s, k) => s + k.bytes, 0);
    // Poids RÉEL sur disque, index compris ou non. Décisif au premier lancement : l'index ne connaît
    // que ce qui a été écrit depuis son introduction, donc `total` peut être à 0 alors que le disque
    // porte des Go de caches. Sans ça, l'UI annoncerait « aucun cache » à un utilisateur qui en a.
    const totalOnDisk = kinds.reduce((s, k) => s + (k.onDisk || 0), 0);
    let mdl = { totalBytes: 0, byTask: /** @type {Record<string, number>} */ ({}) };
    try { const m = models.diskUsage(); mdl = { totalBytes: m.totalBytes, byTask: m.byTask }; } catch (_) {}

    return {
      ok: true,
      kinds,
      total,
      totalOnDisk,
      root: getCacheRoot(),
      defaults: { thumb: DEFAULT_THUMB_DIR, proxy: DEFAULT_PROXY_DIR },
      disk: await diskInfo(getThumbDir()),
      db: { path: dbi.path, bytes: dbi.bytes, available: dbi.available },
      faiss: { bytes: faiss.bytes, files: faiss.files.length },
      models: mdl,
      indexBackend: cacheIndex.backend,
    };
  }

  /**
   * Arbre projet → rush. Le « projet » est le dossier parent du média : c'est le seul regroupement
   * disponible pour un cache généré hors Resolve (fichiers locaux, board, recherche).
   * Les entrées sans source connue tombent dans un groupe « non attribué » purgeable en bloc.
   */
  function tree() {
    /** @type {Map<string, { source: string, name: string, bytes: number, byKind: Record<string, number> }>} */
    const rushes = new Map();
    const add = (source, byKind, bytes) => {
      let e = rushes.get(source);
      if (!e) e = { source, name: path.basename(source), bytes: 0, byKind: {} }, rushes.set(source, e);
      e.bytes += bytes;
      for (const [k, v] of Object.entries(byKind)) e.byKind[k] = (e.byKind[k] || 0) + v;
    };

    let unattributed = { bytes: 0, files: 0, byKind: /** @type {Record<string, number>} */ ({}) };
    // L'arbre « par projet » sert à décider quoi conserver APRÈS la session. Les fichiers Roto,
    // tests et WAV disparaissent déjà à la fermeture : les y afficher ajouterait du bruit et ferait
    // croire qu'il faut les gérer manuellement.
    for (const row of cacheIndex.all()) {
      if (SESSION_KIND_SET.has(row.kind)) continue;
      if (!row.source) {
        unattributed.bytes += row.bytes;
        unattributed.files += 1;
        unattributed.byKind[row.kind] = (unattributed.byKind[row.kind] || 0) + row.bytes;
        continue;
      }
      add(row.source, { [row.kind]: row.bytes }, row.bytes);
    }
    for (const e of cacheDb.sizes().bySource) add(e.source, e.byKind, e.bytes);

    /** @type {Map<string, { folder: string, bytes: number, rushes: any[] }>} */
    const folders = new Map();
    for (const r of rushes.values()) {
      const folder = path.dirname(r.source);
      let f = folders.get(folder);
      if (!f) { f = { folder, bytes: 0, rushes: [] }; folders.set(folder, f); }
      f.bytes += r.bytes;
      f.rushes.push(r);
    }
    const list = [...folders.values()].sort((a, b) => b.bytes - a.bytes);
    for (const f of list) f.rushes.sort((a, b) => b.bytes - a.bytes);
    return { ok: true, folders: list, unattributed };
  }

  /** Supprime une liste de fichiers de cache, après revalidation de chacun. Renvoie les octets libérés. */
  async function rmFiles(files) {
    let freed = 0;
    let n = 0;
    const gone = [];
    const skipped = [];
    for (const f of files) {
      if (!insideCache(f)) { skipped.push(f); continue; }
      try {
        const st = await fsp.stat(f);
        const sz = st.isDirectory() ? await dirSize(f, 8) : st.size;
        await fsp.rm(f, { recursive: true, force: true });
        freed += sz;
        n++;
        gone.push(f);
      } catch (_) { skipped.push(f); }
      if (n % 200 === 0) await yieldLoop();
    }
    cacheIndex.forget(gone);
    thumbs.thumbRamForget(gone);
    proxy.proxyForget(gone);
    return { freed, files: n, skipped: skipped.length, gone };
  }

  /** Supprime uniquement les vignettes/proxies d'anciennes plages de timeline. Les chemins reçus ne
   * sont jamais supprimés directement : ils servent à recalculer des noms de cache sous nos racines. */
  async function purgePreviewRanges(ranges) {
    const clean = (Array.isArray(ranges) ? ranges : []).map((range) => ({
      path: path.resolve(String(range && range.path || '')),
      start: Number(range && range.start),
      end: Number(range && range.end),
    })).filter((range) => range.path && Number.isFinite(range.start) && Number.isFinite(range.end));
    if (!clean.length) return { ok: true, freed: 0, files: 0, skipped: 0 };

    const wanted = [];
    // Vignettes actuelles + anciennes (avant la borne à 40 % des plans courts), dans toutes les
    // variantes possibles : une timeline modifiée ne laisse aucun jpeg/webp orphelin. Les variantes
    // viennent de `thumbPresets` (source unique des crans) et couvrent AUSSI le modèle précédent
    // {hauteur, qualité} : son suffixe de clé a une autre forme, il ne se reconstruit pas en passant
    // d'anciens réglages aux fonctions courantes — sans cette couverture, toute vignette écrite avant
    // les crans devient un orphelin que plus rien ne sait nommer.
    const variants = thumbKeyVariants();
    for (const range of clean) {
      const span = range.end - range.start;
      const times = new Set([
        range.start + (span > 0 ? Math.min(0.15, span * 0.4) : 0.15),
        range.start + 0.15,
      ].map((time) => Number(time.toFixed(6))));
      for (const time of times) for (const variant of variants) {
        wanted.push(path.join(getThumbDir(), `${thumbs.thumbKeyFromSuffix(range.path, time, variant.suffix)}.${variant.ext}`));
      }
    }

    // Les proxies sont versionnés (codec/moteur/réglages/hauteur). Le sidecar est donc la seule façon
    // sûre de retrouver toutes les variantes de la plage sans connaître les réglages historiques.
    let names = [];
    try { names = await fsp.readdir(getProxyDir()); } catch (_) {}
    for (const name of names.filter((entry) => entry.endsWith('.nrproxy.json'))) {
      const metaFile = path.join(getProxyDir(), name);
      try {
        const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
        const source = path.resolve(String(meta && meta.source || ''));
        const start = Number(meta && meta.start);
        const metaEnd = Number(meta && meta.end);
        const match = clean.some((range) => source === range.path
          && Math.abs(start - range.start) < 0.005
          && (!Number.isFinite(metaEnd) || Math.abs(metaEnd - range.end) < 0.005));
        if (match) {
          wanted.push(metaFile);
          if (meta.file) wanted.push(path.resolve(String(meta.file)));
        }
      } catch (_) { /* sidecar illisible : la purge globale reste disponible */ }
    }
    const result = await rmFiles([...new Set(wanted)]);
    if (broadcast) broadcast('cache:changed', { freed: result.freed, files: result.files, rows: 0 });
    return { ok: true, freed: result.freed, files: result.files, skipped: result.skipped };
  }

  /** Vide un type de cache de fichiers EN ENTIER (y compris ce que l'index ignore). */
  async function clearKindWhole(kind) {
    if (kind === 'thumb') { const r = await thumbs.cleanThumbs(); return { freed: r.bytes, files: r.files, skipped: r.skipped }; }
    if (kind === 'proxy') { const r = await proxy.cleanProxies(); return { freed: r.bytes, files: r.files, skipped: r.skipped }; }
    const root = roots().find((r) => r.kind === kind);
    if (!root) return { freed: 0, files: 0, skipped: 0 };
    let entries = [];
    try { entries = await fsp.readdir(root.dir); } catch (_) { return { freed: 0, files: 0, skipped: 0 }; }
    return rmFiles(entries.map((e) => path.join(root.dir, e)));
  }

  /**
   * Purge. Trois portées, combinables :
   *  - `sources` : ces rushs seulement (le cas d'usage central : nettoyer un projet fini) ;
   *  - `kinds` sans `sources` : ce type en entier ;
   *  - `unattributed` : les entrées dont la source est inconnue.
   * @param {{ kinds?: string[], sources?: string[], unattributed?: boolean }} [opts]
   */
  async function clear(opts = {}) {
    const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : null;
    const kindSet = kinds ? new Set(kinds) : null;
    const sources = (Array.isArray(opts.sources) ? opts.sources : []).filter(Boolean).map((s) => path.resolve(String(s)));
    let freed = 0;
    let files = 0;
    let rows = 0;
    let skipped = 0;

    if (sources.length) {
      const want = new Set(sources);
      const hit = cacheIndex.all().filter((r) => r.source && want.has(r.source) && (!kindSet || kindSet.has(r.kind)));
      const r = await rmFiles(hit.map((e) => e.file));
      freed += r.freed; files += r.files; skipped += r.skipped;
      const dbKindSet = new Set(cacheDb.DB_KINDS);
      const dbKinds = (kinds || cacheDb.DB_KINDS).filter((k) => dbKindSet.has(k));
      if (dbKinds.length) rows += (cacheDb.purgeFiles(sources, dbKinds).rows) || 0;
    } else if (opts.unattributed) {
      const hit = cacheIndex.all().filter((r) => !r.source && (!kindSet || kindSet.has(r.kind)));
      const r = await rmFiles(hit.map((e) => e.file));
      freed += r.freed; files += r.files; skipped += r.skipped;
    } else if (kinds) {
      for (const k of kinds) {
        if (FILE_KIND_SET.has(k)) {
          const r = await clearKindWhole(k);
          freed += r.freed; files += r.files; skipped += r.skipped;
        }
      }
      const dbKindSet = new Set(cacheDb.DB_KINDS);
      const dbKinds = kinds.filter((k) => dbKindSet.has(k));
      if (dbKinds.length) rows += (cacheDb.purgeKinds(dbKinds).rows) || 0;
    } else {
    return { ok: false, error: t('targetMissing') };
    }

    if (broadcast) broadcast('cache:changed', { freed, files, rows });
    return { ok: true, freed, files, rows, skipped };
  }

  /** Médias indexés dont le fichier a disparu. Rapport seul : un disque externe débranché ne doit pas
   *  déclencher une purge (cf. la même prudence dans core/library.js:389). */
  function missing() {
    const out = new Map();
    for (const e of cacheDb.missingSources()) out.set(e.source, { source: e.source, bytes: e.bytes });
    for (const e of cacheIndex.bySource()) {
      if (!e.source) continue;
      try { if (fs.existsSync(e.source)) continue; } catch (_) {}
      const p = out.get(e.source);
      if (p) p.bytes += e.bytes;
      else out.set(e.source, { source: e.source, bytes: e.bytes });
    }
    return { ok: true, sources: [...out.values()].sort((a, b) => b.bytes - a.bytes) };
  }

  function vacuum() {
    return cacheDb.vacuum();
  }

  return { overview, tree, clear, purgePreviewRanges, missing, vacuum, roots, insideCache, rmFiles, FILE_KINDS };
}

module.exports = { createCacheAdmin, insideCache, FILE_KINDS, roots };
