// @ts-check
// core/adobeCache.js
// Caches Adobe SUR DISQUE (Premiere Pro / After Effects) : localiser, peser, purger.
//
// Pourquoi un module à part de core/optimize.js : les caches Resolve se trouvent par l'API de
// scripting (liste des volumes Media Storage) alors que les caches Adobe se trouvent par le SYSTÈME DE
// FICHIERS — media cache partagé dans %APPDATA%\Adobe\Common, dossier de cache disque AE déclaré dans
// son fichier de préférences, fichiers de prévisualisation Premiere posés À CÔTÉ du projet. Rien de
// tout ça ne passe par le panneau CEP, donc ça marche application FERMÉE — ce qui est justement la
// seule situation où purger le media cache est sûr (l'ouvrir en pleine écriture corrompt la base).
//
// Les mesures (`dirSize`) et l'espace disque (`diskInfo`) viennent de core/optimize.js : même problème
// ici et là, une seule implémentation.
//
// SÉCURITÉ : tout chemin venu du renderer est revalidé contre les racines RECALCULÉES côté core avant
// la moindre suppression (cf. `insideAdobeRoots`). Même barrière que core/cacheAdmin.js:54.

const path = require("path");
const fs = require("fs");
const { dirSize, diskInfo } = require("./optimize");
const { yieldLoop } = require("./config");

const fsp = fs.promises;

/** Profondeur de mesure : les caches Adobe sont plats ou quasi (un niveau de sous-dossiers). */
const MEASURE_DEPTH = 4;
/** Le dossier de cache disque AE porte toujours ce marqueur, quel que soit l'emplacement choisi. */
const AE_DISK_CACHE_RE = /disk cache.*\.noindex$/i;
/** Profondeur de recherche du cache disque AE sous une base candidate. */
const AE_SEARCH_DEPTH = 4;
/** Tranches d'ancienneté proposées au nettoyage. */
const AGE_BUCKETS = [7, 30, 90];
const DAY_MS = 86_400_000;

/**
 * @typedef {object} AdobeCacheRoot
 * @property {string} id            identifiant stable (sert de clé i18n côté renderer)
 * @property {string} kind          'mediaCache' | 'mediaCacheDb' | 'peak' | 'diskCache' | 'autoSave' | 'previews'
 * @property {string} dir
 * @property {boolean} shared       partagé avec les autres applications Adobe (purge = les deux)
 * @property {boolean} regenerable  se reconstruit tout seul (vrai pour tout sauf les auto-saves)
 * @property {number|null} size     octets, rempli par `measure`
 */

/** @param {NodeJS.ProcessEnv} [env] */
function appData(env) {
  const e = env || process.env;
  return e.APPDATA || null;
}

/** @param {NodeJS.ProcessEnv} [env] */
function userProfile(env) {
  const e = env || process.env;
  return e.USERPROFILE || e.HOME || null;
}

/** @param {string} dir @param {string} id @param {string} kind @param {object} [opts] */
function root(dir, id, kind, opts) {
  const o = opts || {};
  return {
    id,
    kind,
    dir,
    shared: o.shared === true,
    regenerable: o.regenerable !== false,
    size: /** @type {number|null} */ (null),
  };
}

/** Caches du dossier Common : partagés par Premiere, After Effects, Media Encoder et Audition.
 *  @param {NodeJS.ProcessEnv} [env] */
function commonRoots(env) {
  const base = appData(env);
  if (!base) return [];
  const common = path.join(base, "Adobe", "Common");
  return [
    root(path.join(common, "Media Cache Files"), "mediaCacheFiles", "mediaCache", { shared: true }),
    root(path.join(common, "Media Cache"), "mediaCacheDb", "mediaCacheDb", { shared: true }),
    root(path.join(common, "Peak Files"), "peakFiles", "peak", { shared: true }),
  ];
}

/** Dossiers de version d'une application Adobe sous une base (`…\Adobe\After Effects\24.0`).
 *  @param {string} base @returns {Promise<string[]>} */
async function versionDirs(base) {
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(base, e.name));
}

/** Chemin du cache disque déclaré dans les préférences AE. Le fichier est du texte lisible : on y
 *  cherche la valeur entre guillemets de la clé de dossier de cache. La clé exacte varie d'une
 *  version à l'autre → on matche sur « Disk Cache » + « Folder », pas sur un libellé figé.
 *  Renvoie null si les prefs sont illisibles : on ne DEVINE pas un dossier qu'on va proposer d'effacer.
 *  @param {NodeJS.ProcessEnv} [env] @returns {Promise<string|null>} */
async function aeDeclaredCacheDir(env) {
  const base = appData(env);
  if (!base) return null;
  const versions = await versionDirs(path.join(base, "Adobe", "After Effects"));
  for (const dir of versions.reverse()) {
    /** @type {string[]} */
    let files;
    try {
      files = (await fsp.readdir(dir)).filter((f) => /prefs.*\.txt$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      let raw = "";
      try {
        raw = await fsp.readFile(path.join(dir, f), "utf8");
      } catch {
        continue;
      }
      const m = raw.match(/"[^"]*Disk Cache[^"]*Folder[^"]*"\s*=\s*"([^"]+)"/i);
      if (m && m[1]) return m[1].replace(/\\\\/g, "\\");
    }
  }
  return null;
}

/** Cherche les dossiers `… Disk Cache …\.noindex` sous une base. Le marqueur `.noindex` est la
 *  signature qu'AE pose sur son cache disque où qu'il soit — bien plus fiable qu'un chemin en dur.
 *  @param {string} base @param {number} depth @param {string[]} out */
async function findAeCacheDirs(base, depth, out) {
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(base, e.name);
    if (AE_DISK_CACHE_RE.test(e.name)) out.push(full);
    else if (depth > 0) await findAeCacheDirs(full, depth - 1, out);
    await yieldLoop();
  }
}

/** Cache disque After Effects. @param {NodeJS.ProcessEnv} [env] */
async function aeDiskCacheRoots(env) {
  const declared = await aeDeclaredCacheDir(env);
  const bases = [];
  if (declared) bases.push(declared);
  const base = appData(env);
  if (base) bases.push(path.join(base, "Adobe", "Common"));
  /** @type {string[]} */
  const found = [];
  for (const b of bases) {
    if (AE_DISK_CACHE_RE.test(path.basename(b))) found.push(b);
    else await findAeCacheDirs(b, AE_SEARCH_DEPTH, found);
  }
  const uniq = [...new Set(found)];
  return uniq.map((dir, i) => root(dir, i === 0 ? "aeDiskCache" : `aeDiskCache${i}`, "diskCache"));
}

/** Sauvegardes automatiques : dans Documents pour Premiere, à côté du projet pour After Effects.
 *  NON régénérables — ce sont des versions du travail, jamais purgées par défaut.
 *  @param {'ppro'|'aeft'} app @param {NodeJS.ProcessEnv} [env] */
async function autoSaveRoots(app, env) {
  const home = userProfile(env);
  if (!home || app !== "ppro") return [];
  const versions = await versionDirs(path.join(home, "Documents", "Adobe", "Premiere Pro"));
  /** @type {ReturnType<typeof root>[]} */
  const out = [];
  for (const v of versions) {
    const dir = path.join(v, "Adobe Premiere Pro Auto-Save");
    out.push(root(dir, `autoSave-${path.basename(v)}`, "autoSave", { regenerable: false }));
  }
  return out;
}

/** Fichiers de prévisualisation posés à côté du projet (réglage « Identique au projet », le défaut).
 *  @param {'ppro'|'aeft'} app @param {string|null} projectPath */
function previewRoots(app, projectPath) {
  if (!projectPath) return [];
  const dir = path.dirname(projectPath);
  const names = app === "ppro"
    ? [["Adobe Premiere Pro Video Previews", "videoPreviews"], ["Adobe Premiere Pro Audio Previews", "audioPreviews"]]
    : [["Adobe After Effects Auto-Save", "aeProjectAutoSave"]];
  return names.map(([name, id]) =>
    root(path.join(dir, name), id, id === "aeProjectAutoSave" ? "autoSave" : "previews", {
      regenerable: id !== "aeProjectAutoSave",
    }),
  );
}

/** Toutes les racines candidates pour une application, dédupliquées, filtrées sur l'existence réelle.
 *  @param {'ppro'|'aeft'} app
 *  @param {{ projectPath?: string|null, env?: NodeJS.ProcessEnv }} [ctx]
 *  @returns {Promise<AdobeCacheRoot[]>} */
async function adobeCacheRoots(app, ctx) {
  const c = ctx || {};
  const env = c.env;
  const candidates = [
    ...commonRoots(env),
    ...(app === "aeft" ? await aeDiskCacheRoots(env) : []),
    ...(await autoSaveRoots(app, env)),
    ...previewRoots(app, c.projectPath || null),
  ];
  /** @type {AdobeCacheRoot[]} */
  const out = [];
  const seen = new Set();
  for (const r of candidates) {
    const key = path.resolve(r.dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if ((await fsp.stat(r.dir)).isDirectory()) out.push(r);
    } catch {
      // Dossier absent = cache jamais créé : on ne le liste pas plutôt que d'afficher 0 o.
    }
  }
  return out;
}

/** Pèse chaque racine. Séquentiel volontaire : plusieurs `dirSize` en parallèle saturent le disque
 *  pendant que l'utilisateur monte.
 *  @param {AdobeCacheRoot[]} roots @returns {Promise<AdobeCacheRoot[]>} */
async function measure(roots) {
  for (const r of roots) r.size = await dirSize(r.dir, MEASURE_DEPTH);
  return roots;
}

/** Entrées de premier niveau d'un dossier, avec taille et date. Un media cache porte des milliers de
 *  fichiers : on ne les remonte jamais un par un au renderer, on les agrège en tranches d'âge.
 *  @param {string} dir */
async function topEntries(dir) {
  /** @type {fs.Dirent[]} */
  let list;
  try {
    list = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {{path:string,size:number,mtime:number}[]} */
  const out = [];
  let n = 0;
  for (const e of list) {
    const full = path.join(dir, e.name);
    try {
      const st = await fsp.stat(full);
      const size = e.isDirectory() ? await dirSize(full, MEASURE_DEPTH) : st.size;
      out.push({ path: full, size, mtime: st.mtimeMs });
    } catch {
      // Fichier verrouillé par l'application : il ne sera pas supprimable non plus, on l'ignore.
    }
    if (++n % 200 === 0) await yieldLoop();
  }
  return out;
}

/** Entrées plus vieilles que `days` jours. Générique : le filtre doit rendre les entrées TELLES
 *  QU'ELLES SONT ENTRÉES (`path`/`size` compris), pas leur seule date.
 *  @template {{mtime:number}} T @param {T[]} entries @param {number} days @param {number} [now] @returns {T[]} */
function olderThan(entries, days, now) {
  const cutoff = (typeof now === "number" ? now : Date.now()) - days * DAY_MS;
  return entries.filter((e) => e.mtime < cutoff);
}

/** Détail d'une racine : poids total et ce que libérerait chaque tranche d'ancienneté.
 *  @param {string} dir @returns {Promise<{ok:boolean,error?:string,root?:string,size?:number,files?:number,buckets?:{days:number,size:number,files:number}[],disk?:any}>} */
async function scan(dir) {
  if (!dir) return { ok: false, error: "noFolder" };
  try {
    if (!(await fsp.stat(dir)).isDirectory()) return { ok: false, error: "folderMissing" };
  } catch {
    return { ok: false, error: "folderMissing" };
  }
  const entries = await topEntries(dir);
  const size = entries.reduce((s, e) => s + e.size, 0);
  const buckets = AGE_BUCKETS.map((days) => {
    const old = olderThan(entries, days);
    return { days, size: old.reduce((s, e) => s + e.size, 0), files: old.length };
  });
  return { ok: true, root: dir, size, files: entries.length, buckets, disk: await diskInfo(dir) };
}

/** Vrai si `p` est une racine connue ou vit à l'intérieur. Comparaison sur chemins RÉSOLUS (`..`
 *  neutralisés) avec séparateur final, sinon `…\Media Cache Files-perso` passerait pour du cache.
 *  @param {string} p @param {{dir:string}[]} roots */
function insideAdobeRoots(p, roots) {
  let target;
  try {
    target = path.resolve(String(p || ""));
  } catch {
    return false;
  }
  if (!target) return false;
  return (roots || []).some((r) => {
    const dir = path.resolve(r.dir);
    if (target === dir) return true; // vider une racine est l'usage nominal
    return target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
  });
}

/** Vide une racine (le dossier lui-même est conservé, l'application le réutilise). `minAgeDays`
 *  restreint aux entrées plus anciennes que N jours.
 *  @param {string} dir @param {number} minAgeDays */
async function emptyRoot(dir, minAgeDays) {
  const entries = await topEntries(dir);
  const doomed = minAgeDays > 0 ? olderThan(entries, minAgeDays) : entries;
  let freed = 0;
  const failed = [];
  for (const e of doomed) {
    try {
      await fsp.rm(e.path, { recursive: true, force: true });
      freed += e.size;
    } catch (err) {
      failed.push(e.path);
    }
    await yieldLoop();
  }
  return { freed, removed: doomed.length - failed.length, failed };
}

/** Purge un lot de cibles. Chaque cible est revalidée contre les racines recalculées côté core :
 *  un chemin envoyé par le renderer qui n'y tombe pas est IGNORÉ, jamais supprimé.
 *  @param {{dir:string, minAgeDays?:number}[]} targets
 *  @param {{dir:string}[]} roots
 *  @returns {Promise<{ok:boolean,freed:number,removed:string[],skipped:string[],failed:string[]}>} */
async function clean(targets, roots) {
  const list = Array.isArray(targets) ? targets : [];
  let freed = 0;
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {string[]} */
  const failed = [];
  for (const target of list) {
    const dir = String((target && target.dir) || "");
    if (!insideAdobeRoots(dir, roots)) {
      skipped.push(dir);
      continue;
    }
    const r = await emptyRoot(dir, Number(target.minAgeDays) || 0);
    freed += r.freed;
    failed.push(...r.failed);
    if (r.removed > 0) removed.push(dir);
  }
  return { ok: true, freed, removed, skipped, failed };
}

module.exports = {
  AGE_BUCKETS,
  adobeCacheRoots,
  measure,
  scan,
  clean,
  // Exportés pour les tests : ce sont les fonctions pures qui portent la sécurité et la découverte.
  insideAdobeRoots,
  olderThan,
  commonRoots,
  previewRoots,
};
