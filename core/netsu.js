// @ts-check
// core/netsu.js
// Façade du format de partage « .netsu ».
//
// Le fichier est un CONTENEUR SQLite (core/netsu/db.js) : un document board, ses items ligne par
// ligne, et les octets des médias adressés par contenu. Ce choix est celui d'un fichier qu'on
// modifie en continu — pas d'une archive écrite d'un bloc — même si, pour l'instant, seuls
// l'export et l'import passent par ici.
//
// Ce que garde ce module : les signatures publiques (`exportBoard` / `importBoard`) attendues par
// core/rpc.js, et la lecture des archives v1 (ZIP) déjà partagées, reconnues par leurs premiers
// octets. Toute la logique vit dans core/netsu/*.
//
// Ce que l'utilisateur choisit vraiment, c'est le NIVEAU d'embarquement de chaque média
// (cf. core/netsu/levels.js) : garder juste le lien, la plage jouée, la plage élargie, ou le
// fichier entier. Les anciens modes de l'archive v1 s'y ramènent un pour un.

const fs = require('node:fs');
const path = require('node:path');
const { t } = require('./i18n');
const { openNetsu, sniff } = require('./netsu/db');
const { writeBoardDoc, readBoardDoc } = require('./netsu/board');
const { zipStore, unzip, readZipBoard } = require('./netsu/legacyZip');
const { describeSource } = require('./netsu/embed');
const { saveBoardProject, readBoardProject } = require('./netsu/project');
const sessions = require('./netsu/session');
const recents = require('./netsu/recents');
const sidecar = require('./netsu/sidecar');
const relocate = require('./netsu/relocate');
const levels = require('./netsu/levels');

// Modes de l'archive v1 → niveaux v2. Un ancien appelant (préférence enregistrée, panneau pas
// encore rechargé) doit continuer à produire le résultat qu'il demandait.
const MODE_TO_LEVEL = { full: 'full', light: 'preview', links: 'link' };

// Sondes menées de front pendant l'estimation : ffprobe est court mais spawné par fichier, et un
// board peut en aligner des centaines.
const PROBE_CONCURRENCY = 4;

/** @param {any} opts @returns {{ level: string, quality: string, marginSec: number }} */
function readDefaults(opts) {
  const raw = opts || {};
  const fromMode = MODE_TO_LEVEL[String(raw.mode || '')];
  return {
    level: levels.normalizeLevel(raw.level != null ? raw.level : fromMode),
    quality: levels.normalizeQuality(raw.quality),
    marginSec: levels.normalizeMargin(raw.marginSec),
  };
}

// Une écriture à la fois PAR FICHIER. L'autosave part toutes les demi-secondes ; un enregistrement
// qui recopie un rush dure plus longtemps que ça. Deux passes concurrentes sur le même document
// feraient tourner le ménage de l'une (liste des médias à garder déjà périmée) pendant que l'autre
// range ses fichiers — le premier effacerait ce que la seconde vient d'adopter.
/** @type {Map<string, Promise<any>>} */
const writeChains = new Map();

/** @template T @param {string} filePath @param {() => Promise<T>} task @returns {Promise<T>} */
function queued(filePath, task) {
  const key = path.resolve(String(filePath || '')).toLowerCase();
  const previous = writeChains.get(key) || Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(() => {}, () => {});
  writeChains.set(key, tail);
  // La file se referme quand plus personne n'attend derrière : sinon la table garde une entrée par
  // fichier touché depuis le démarrage.
  void tail.then(() => { if (writeChains.get(key) === tail) writeChains.delete(key); });
  return run;
}

/** Supprime les journaux laissés à côté d'un conteneur (fermeture propre = ils n'existent plus). */
function dropJournals(filePath) {
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(filePath + suffix, { force: true }); } catch (_) { /* déjà absent */ }
  }
}

/**
 * Écrit la scène dans un .netsu. On construit d'abord un fichier `.part` DANS LE DOSSIER CIBLE,
 * puis on renomme : le rename est atomique sur le même volume, donc un export interrompu ne laisse
 * jamais un .netsu à moitié écrit à la place d'un fichier valide. Écrire directement dans la cible
 * finale plutôt que dans un temporaire recopié évite de passer deux fois plusieurs Go sur le disque.
 * @param {any} refStore @param {any} scene @param {string} destPath @param {any} opts
 */
function exportBoard(refStore, scene, destPath, opts) {
  if (!scene || !Array.isArray(scene.items)) return Promise.resolve({ ok: false, error: t('sceneInvalid') });
  if (!destPath) return Promise.resolve({ ok: false, error: t('destinationMissing') });
  return queued(destPath, () => writeExport(refStore, scene, destPath, opts));
}

/** @param {any} refStore @param {any} scene @param {string} destPath @param {any} opts */
async function writeExport(refStore, scene, destPath, opts) {
  const defaults = readDefaults(opts);
  const partPath = `${destPath}.part`;
  let handle = null;
  try {
    // Partager PAR-DESSUS un document ouvert : la base doit être refermée avant qu'on efface son
    // fichier, sinon la session continue d'écrire dans un fichier qui n'existe plus.
    sessions.closeSession(destPath);
    dropJournals(partPath);
    try { fs.rmSync(partPath, { force: true }); } catch (_) { /* pas de reste d'un export interrompu */ }
    handle = openNetsu(partPath);
    const { counts } = await writeBoardDoc({
      handle,
      refStore,
      scene,
      defaults,
      freezeLinks: !!(opts && opts.freezeLinks),
      onProgress: opts && opts.onProgress,
    });
    handle.close();
    handle = null;
    dropJournals(partPath);
    fs.rmSync(destPath, { force: true }); // rename n'écrase pas sous Windows
    fs.renameSync(partPath, destPath);
    return { ok: true, path: destPath, bytes: fs.statSync(destPath).size, counts, mode: defaults.level, level: defaults.level };
  } catch (e) {
    if (handle) { try { handle.close(); } catch (_) { /* base déjà fermée */ } }
    try { fs.rmSync(partPath, { force: true }); } catch (_) { /* nettoyage best-effort */ }
    dropJournals(partPath);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Lit un .netsu, quel que soit son format. Le type est décidé par les premiers octets et non par
 * l'extension : v1 et v2 partagent la même, et un fichier v1 déjà envoyé doit rester ouvrable.
 * @param {any} refStore @param {string} srcPath
 */
function importBoard(refStore, srcPath) {
  try {
    const kind = sniff(srcPath);
    if (kind === 'zip') return readZipBoard(refStore, fs.readFileSync(srcPath), fs);
    if (kind !== 'sqlite') return { ok: false, error: t('invalidArchive') };

    const handle = openNetsu(srcPath, { create: false });
    try {
      return readBoardDoc({ handle, refStore });
    } finally {
      handle.close();
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Aperçu strictement en lecture : contrairement à openProject, ne crée pas de session et ne modifie
// pas l'ordre des récents. Le renderer l'utilise uniquement pour dessiner la vignette de la carte.
function previewProject(refStore, srcPath) {
  return importBoard(refStore, srcPath);
}

/** @param {any} scene @returns {Set<string>} */
function sceneItemIds(scene) {
  const ids = new Set();
  for (const item of (scene && scene.items) || []) {
    const id = String(item && item.id || '');
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Retrouve la scène interne d'origine d'un ancien Save As. Le nom ne sert qu'à réduire les candidats :
 * la décision exige un recouvrement fort des IDs d'items, stables quand le board continue d'évoluer.
 * @param {any} refStore @param {any} projectScene
 */
function inferSourceSceneId(refStore, projectScene) {
  const projectIds = sceneItemIds(projectScene);
  if (!projectIds.size) return undefined;
  const title = String(projectScene && projectScene.name || '').trim().toLocaleLowerCase();
  const minimum = Math.min(3, projectIds.size);
  let best;
  for (const meta of refStore.listScenes()) {
    if (!meta || String(meta.id || '').startsWith('__')) continue;
    if (String(meta.name || '').trim().toLocaleLowerCase() !== title) continue;
    const scene = refStore.loadScene(meta.id);
    const candidateIds = sceneItemIds(scene);
    let common = 0;
    for (const id of projectIds) if (candidateIds.has(id)) common += 1;
    const coverage = common / projectIds.size;
    if (common < minimum || coverage < 0.8) continue;
    const extra = Math.max(0, candidateIds.size - common);
    if (!best || coverage > best.coverage || (coverage === best.coverage && extra < best.extra)) {
      best = { id: String(meta.id), coverage, extra };
    }
  }
  return best && best.id;
}

/**
 * Récents du board avec migration des Save As produits avant sourceSceneId. L'ancienne signature
 * recentProjects(type) reste acceptée par les tests/appelants qui ne disposent pas du refStore.
 * @param {any|string} refStoreOrType @param {string} [type]
 */
function recentProjects(refStoreOrType, type) {
  const refStore = refStoreOrType && typeof refStoreOrType.listScenes === 'function' ? refStoreOrType : null;
  const wantedType = refStore ? type : refStoreOrType;
  const entries = recents.list(wantedType);
  if (!refStore || (wantedType && wantedType !== 'board')) return entries;
  for (const entry of entries) {
    if (entry.sourceSceneId || entry.missing) continue;
    const preview = previewProject(refStore, entry.path);
    if (!preview.ok || !preview.scene) continue;
    const sourceSceneId = inferSourceSceneId(refStore, preview.scene);
    if (!sourceSceneId) continue;
    recents.linkSource(entry.path, sourceSceneId);
    entry.sourceSceneId = sourceSceneId;
  }
  return entries;
}

/** @template T @param {T[]} items @param {number} limit @param {(item: T) => Promise<void>} fn */
async function eachWithLimit(items, limit, fn) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) await fn(items[cursor++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
}

/** Chemins de médias LOCAUX de la scène, dédoublonnés (un rush sert souvent plusieurs items). */
function localPaths(scene) {
  const paths = new Set();
  for (const item of (scene && scene.items) || []) {
    const refs = item && item.kind === 'sequence' ? item.frames || [] : [item && item.ref];
    for (const ref of refs) {
      const value = String(ref || '');
      if (value && !/^(https?:|data:|blob:)/i.test(value)) paths.add(value);
    }
  }
  return [...paths];
}

/**
 * Poids ESTIMÉ de la scène, par niveau, sans rien encoder. Sert à montrer à l'utilisateur ce qu'il
 * fabrique AVANT de lancer l'export. C'est un ordre de grandeur (cf. core/netsu/levels.js), jamais
 * une promesse : l'UI doit l'afficher comme tel.
 * @param {any} scene @param {any} opts
 */
async function weigh(scene, opts) {
  if (!scene || !Array.isArray(scene.items)) return { ok: false, error: t('sceneInvalid') };
  const defaults = readDefaults(opts);

  /** @type {Map<string, any>} */
  const sources = new Map();
  await eachWithLimit(localPaths(scene), PROBE_CONCURRENCY, async (p) => {
    sources.set(p, await describeSource(p));
  });

  const perLevel = { link: 0, preview: 0, margin: 0, full: 0 };
  const items = [];
  for (const item of scene.items) {
    const refs = item.kind === 'sequence' ? item.frames || [] : [item.ref];
    let bytes = 0;
    let long = false;
    for (const ref of refs) {
      const source = sources.get(String(ref || ''));
      const kindHint = item.kind === 'sequence' ? 'image' : item.kind;
      const info = { sourceSize: source ? source.size : 0 };
      const duration = source ? source.duration : 0;
      for (const level of levels.EMBED_LEVELS) {
        const plan = levels.planEmbed({ ...item, kind: kindHint }, { ...defaults, level, duration });
        const estimate = levels.estimateBytes(plan, info);
        perLevel[level] += estimate;
        if (level === defaults.level) {
          bytes += estimate;
          long = long || plan.long;
        }
      }
    }
    items.push({ id: item.id, kind: item.kind, bytes, long });
  }

  return { ok: true, level: defaults.level, total: perLevel[defaults.level], perLevel, items };
}

// --- Le .netsu comme document de travail -------------------------------------------------------
// « Partager… » (ci-dessus) fabrique un fichier autonome ; « Enregistrer sous… » (ci-dessous) fait
// du fichier LE document. La différence tient en une phrase : le premier écrit une copie et
// l'oublie, le second reste ouvert et se réenregistre au même endroit — d'où le registre de
// sessions et l'écriture incrémentale de core/netsu/project.js.

/**
 * Ouvre un projet. Une archive v1 (ZIP) n'est pas un document vivant : on la LIT quand même, en le
 * disant (`readonly`), plutôt que de refuser un fichier que l'utilisateur possède — « Enregistrer
 * sous » la convertit alors en projet.
 * @param {any} refStore @param {string} srcPath
 */
function openProject(refStore, srcPath) {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: t('invalidArchive') };
    if (sniff(srcPath) === 'zip') {
      const legacy = readZipBoard(refStore, fs.readFileSync(srcPath), fs);
      return legacy.ok ? { ...legacy, readonly: true } : legacy;
    }
    const session = sessions.openSession(srcPath, { create: false });
    const read = readBoardProject({ session, refStore });
    if (!read.ok) {
      sessions.closeSession(srcPath);
      return read;
    }
    recents.remember({ path: session.path, title: read.scene ? read.scene.name : '', type: 'board' });
    return { ...read, path: session.path, rev: session.handle.rev(), readonly: false };
  } catch (e) {
    sessions.closeSession(srcPath);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Enregistre le projet dans SON fichier. Le document est rouvert s'il ne l'était plus (core relancé
 * pendant la séance) plutôt que de renvoyer une erreur que l'utilisateur ne saurait pas corriger.
 * @param {any} refStore @param {string} filePath @param {any} scene
 */
function saveProject(refStore, filePath, scene) {
  if (!filePath) return Promise.resolve({ ok: false, error: t('destinationMissing') });
  return queued(filePath, async () => {
    try {
      const session = sessions.getSession(filePath) || sessions.openSession(filePath, { create: true });
      const res = await saveBoardProject({ session, refStore, scene });
      if (res.ok) recents.remember({ path: session.path, title: (scene && scene.name) || '', type: 'board' });
      return res;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

/**
 * « Enregistrer sous… » : le projet DÉMÉNAGE. Le fichier de destination est reparti de zéro (le
 * sélecteur a déjà demandé confirmation d'écrasement) et l'ancien document n'est refermé qu'APRÈS
 * une écriture réussie — sinon un disque plein laisserait l'utilisateur sans aucun document ouvert.
 * @param {any} refStore @param {{ scene: any, destPath: string, fromPath?: string, sourceSceneId?: string }} args
 */
function saveProjectAs(refStore, args) {
  const destPath = args && args.destPath;
  if (!destPath) return Promise.resolve({ ok: false, error: t('destinationMissing') });
  return queued(destPath, () => writeProjectAs(refStore, args));
}

/** @param {any} refStore @param {{ scene: any, destPath: string, fromPath?: string, sourceSceneId?: string }} args */
async function writeProjectAs(refStore, { scene, destPath, fromPath, sourceSceneId }) {
  try {
    sessions.closeSession(destPath);
    dropJournals(destPath);
    fs.rmSync(destPath, { force: true });

    const session = sessions.openSession(destPath, { create: true });
    const res = await saveBoardProject({ session, refStore, scene });
    if (!res.ok) {
      sessions.closeSession(destPath);
      return res;
    }
    if (fromPath && path.resolve(fromPath).toLowerCase() !== session.path.toLowerCase()) {
      sessions.closeSession(fromPath);
    }
    const convertedSceneId = typeof sourceSceneId === 'string' && sourceSceneId ? sourceSceneId : undefined;
    recents.remember({
      path: session.path,
      title: (scene && scene.name) || '',
      type: 'board',
      sourceSceneId: convertedSceneId,
    });
    const sourceCleanup = convertedSceneId ? refStore.deleteScene(convertedSceneId) : { ok: true };
    return {
      ...res,
      sidecarDir: sidecar.sidecarDirFor(session.path),
      ...(convertedSceneId ? { sourceSceneId: convertedSceneId, sourceCleanup } : {}),
    };
  } catch (e) {
    sessions.closeSession(destPath);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** Referme un projet (le journal WAL est replié dans le fichier). */
function closeProject(filePath) {
  return { ok: true, closed: sessions.closeSession(filePath) };
}

/** Referme tout — arrêt du core. Sans ça, un `-wal` traîne à côté de chaque projet ouvert. */
function closeAllProjects() {
  sessions.closeAll();
}

/**
 * Supprime définitivement un projet récent et son dossier compagnon. Les médias externes référencés
 * par le board ne sont jamais concernés : seul le dossier exact calculé par `sidecarDirFor` part.
 * Le chemin doit déjà appartenir aux récents et porter l'extension .netsu, afin qu'un renderer
 * compromis ne puisse pas transformer ce canal en suppression arbitraire.
 * @param {string} filePath
 */
function deleteProject(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  const known = recents.list('board').some((entry) => path.resolve(entry.path).toLowerCase() === resolved.toLowerCase());
  if (path.extname(resolved).toLowerCase() !== '.netsu' || !known) {
    return { ok: false, error: t('invalidArchive'), recents: recents.list('board') };
  }

  sessions.closeSession(resolved);
  const errors = [];
  for (const target of [resolved, `${resolved}-wal`, `${resolved}-shm`]) {
    try { fs.rmSync(target, { force: true }); }
    catch (e) { errors.push(String((e && e.message) || e)); }
  }

  const mediaDir = sidecar.sidecarDirFor(resolved);
  try { fs.rmSync(mediaDir, { recursive: true, force: true }); }
  catch (e) { errors.push(String((e && e.message) || e)); }

  const projectRemoved = !fs.existsSync(resolved);
  const mediaRemoved = !fs.existsSync(mediaDir);
  if (projectRemoved) recents.forget(resolved);
  return {
    ok: projectRemoved && mediaRemoved && errors.length === 0,
    projectRemoved,
    mediaRemoved,
    recents: recents.list('board'),
    ...(errors.length ? { error: errors.join(' · ') } : {}),
  };
}

/**
 * Relocalise EN LOT : l'utilisateur désigne un dossier, on y retrouve tous les médias manquants
 * qu'on peut identifier sans ambiguïté. Le renderer envoie ce qu'il affiche en placeholder (nom +
 * taille lus dans le fichier) et repointe les items sur ce qui revient.
 * @param {string} dirPath @param {{ id: string, name: string, size?: number }[]} wanted
 */
function relocateFrom(dirPath, wanted) {
  return relocate.matchIn(dirPath, wanted);
}

module.exports = {
  exportBoard, importBoard, weigh, zipStore, unzip,
  openProject, saveProject, saveProjectAs, closeProject, closeAllProjects,
  previewProject, recentProjects, forgetProject: recents.forget, deleteProject, relocateFrom,
};
