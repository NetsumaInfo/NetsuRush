// @ts-check
// core/netsu/recents.js
// Projets .netsu récemment ouverts — la mémoire de « où sont mes projets ».
//
// Un projet lié à un fichier QUITTE la bibliothèque interne : c'est le fichier qui fait foi, et une
// copie parallèle dans la base de l'app finirait par diverger de lui. Mais sans rien pour les
// retrouver, l'utilisateur devrait renaviguer jusqu'à son fichier à chaque lancement — d'où cette
// liste, qui ne stocke QUE des chemins et un titre d'affichage : elle n'est jamais une source de
// vérité sur le contenu, seulement un carnet d'adresses.
//
// Le fichier vit dans NR_HOME (écriture atomique, patron de core/prefs.js) : partagé par l'app, la
// fenêtre détachée et le panneau CEP, qui n'ont pas le même `localStorage`.

const path = require('node:path');
const fs = require('node:fs');
const { NR_HOME } = require('../config');

const STATE_FILE = path.join(NR_HOME, 'netsu-recents.json');
// Au-delà, la liste cesse d'être une aide : on ne reconnaît plus ses propres projets dedans.
const MAX_ENTRIES = 20;

/** @returns {any[]} */
function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return []; // premier lancement, ou fichier illisible → liste vide, jamais une erreur
  }
}

/** @param {any[]} entries */
function writeAll(entries) {
  fs.mkdirSync(NR_HOME, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

/** @param {string} filePath @returns {string} */
function keyFor(filePath) {
  return path.resolve(String(filePath || '')).toLowerCase();
}

/**
 * La liste, débarrassée des fichiers disparus. Le filtrage se fait à la LECTURE et non à l'écriture :
 * un projet sur un disque externe débranché doit réapparaître quand on rebranche, pas être oublié
 * définitivement au premier démarrage sans lui. On ne réécrit donc jamais le fichier ici.
 * @param {string} [type] restreint au type demandé ('board', 'notebook') — un accueil ne propose que
 *                        les documents qu'il sait ouvrir.
 * @returns {{ path: string, title: string, type: string, openedAt: number, modifiedAt: number, missing: boolean, sourceSceneId?: string }[]}
 */
function list(type) {
  return readAll()
    .filter((entry) => !type || String((entry && entry.type) || 'board') === type)
    .filter((entry) => entry && typeof entry.path === 'string')
    .map((entry) => {
      const filePath = String(entry.path);
      const entryType = String(entry.type || 'board');
      let modifiedAt = 0;
      let missing = false;
      try { modifiedAt = fs.statSync(filePath).mtimeMs; } catch (_) { missing = true; }
      return {
        path: filePath,
        title: entryType === 'board'
          ? path.basename(filePath, path.extname(filePath))
          : String(entry.title || path.basename(filePath)),
        type: entryType,
        openedAt: Number(entry.openedAt) || 0,
        modifiedAt,
        missing,
        sourceSceneId: typeof entry.sourceSceneId === 'string' ? entry.sourceSceneId : undefined,
      };
    })
    .sort((a, b) => b.openedAt - a.openedAt);
}

/**
 * Note un projet comme le plus récent. Un même fichier ne figure qu'une fois : la clé est le chemin
 * résolu en minuscules, sinon deux graphies du même fichier occuperaient deux lignes sous Windows.
 * @param {{ path: string, title?: string, type?: string, sourceSceneId?: string }} entry
 */
function remember(entry) {
  const filePath = String((entry && entry.path) || '');
  if (!filePath) return list();
  const key = keyFor(filePath);
  const all = readAll();
  const previous = all.find((e) => e && typeof e.path === 'string' && keyFor(e.path) === key);
  const kept = all.filter((e) => e && typeof e.path === 'string' && keyFor(e.path) !== key);
  const sourceSceneId = typeof entry.sourceSceneId === 'string'
    ? entry.sourceSceneId
    : typeof previous?.sourceSceneId === 'string' ? previous.sourceSceneId : undefined;
  const next = [
    {
      path: path.resolve(filePath),
      title: String((entry && entry.title) || path.basename(filePath)),
      type: String((entry && entry.type) || 'board'),
      openedAt: Date.now(),
      ...(sourceSceneId ? { sourceSceneId } : {}),
    },
    ...kept,
  ].slice(0, MAX_ENTRIES);
  try { writeAll(next); } catch (_) { /* disque plein ou NR_HOME en lecture seule : la liste n'est pas critique */ }
  return list();
}

/** Retire une entrée (fichier déplacé, projet abandonné). */
function forget(filePath) {
  const key = keyFor(filePath);
  try { writeAll(readAll().filter((e) => e && typeof e.path === 'string' && keyFor(e.path) !== key)); } catch (_) { /* idem */ }
  return list();
}

// Rattache une ancienne entrée à la scène interne dont elle provenait, sans la faire remonter dans
// « Récent ». Cette migration ne change QUE l'identité : openedAt reste exactement celui du fichier.
function linkSource(filePath, sourceSceneId) {
  const key = keyFor(filePath);
  const id = String(sourceSceneId || '');
  if (!key || !id) return list();
  try {
    writeAll(readAll().map((entry) => (
      entry && typeof entry.path === 'string' && keyFor(entry.path) === key
        ? { ...entry, sourceSceneId: id }
        : entry
    )));
  } catch (_) { /* la migration est best-effort, la lecture reste fonctionnelle */ }
  return list();
}

module.exports = { list, remember, forget, linkSource, MAX_ENTRIES, STATE_FILE };
