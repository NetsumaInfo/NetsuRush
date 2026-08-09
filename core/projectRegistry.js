// @ts-check
// core/projectRegistry.js
// Registre « projet → rushs » : mémorise, pour chaque projet de montage déjà ouvert, les chemins de
// ses médias. L'index de recherche (frame_embeddings_v1 / face_embeddings_v2) ne connaît QUE des
// chemins de fichiers : sans ce registre, restreindre une recherche (ou la galerie de visages) à un
// projet autre que celui ouvert est impossible — l'API Resolve n'expose le Media Pool que du projet
// COURANT, et charger un autre projet pour le lire serait destructeur.
//
// Le registre se remplit PASSIVEMENT : chaque `listMediaPool` en ligne réussi enregistre sa tranche.
// Un projet devient donc sélectionnable dès qu'il a été ouvert une fois dans NetsuRush.
//
// Persisté dans DATA_DIR (~/.netsurush) → survit au respawn du core.

const path = require('node:path');
const fs = require('node:fs');

const FILE_NAME = 'project-rushes.json';

/**
 * @typedef {object} ProjectEntry
 * @property {number} at      dernier enregistrement (ms epoch)
 * @property {string[]} paths chemins des rushs du projet
 */

/**
 * @param {object} deps
 * @param {string} deps.dataDir
 */
function createProjectRegistry({ dataDir }) {
  const file = path.join(dataDir, FILE_NAME);
  /** @type {Record<string, ProjectEntry>} */
  let projects = {};
  /** @type {string|null} */
  let current = null;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.projects && typeof raw.projects === 'object') projects = raw.projects;
  } catch (_) { /* premier lancement / fichier absent */ }

  function persist() {
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects }));
      fs.renameSync(tmp, file);   // rename atomique
      return true;
    } catch (_) { return false; }
  }

  /** @param {any[]} clips @returns {string[]} */
  function clipPaths(clips) {
    const out = [];
    for (const clip of clips || []) {
      const p = clip && clip.path;
      if (typeof p === 'string' && p) out.push(p);
    }
    return [...new Set(out)];
  }

  /**
   * Enregistre les rushs d'un projet. Sans nom de projet ou sans rush, on ne touche à rien : une
   * lecture vide (projet en cours d'ouverture) ne doit pas effacer une tranche valide.
   * @param {string|null|undefined} project
   * @param {any[]} clips
   */
  function record(project, clips) {
    const name = String(project || '').trim();
    if (!name) return false;
    current = name;
    const paths = clipPaths(clips);
    if (!paths.length) return false;
    const prev = projects[name];
    // Tranche inchangée : rien à réécrire, mais c'est un SUCCÈS — le recensement compte les projets
    // relevés, pas les écritures disque.
    if (prev && prev.paths.length === paths.length && prev.paths.every((p, i) => p === paths[i])) return true;
    projects[name] = { at: Date.now(), paths };
    persist();
    return true;
  }

  /** Projets connus, le plus récemment vu en tête. */
  function list() {
    const rows = Object.entries(projects).map(([name, entry]) => ({
      name, at: entry.at || 0, count: entry.paths.length, current: name === current,
    }));
    rows.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || b.at - a.at);
    return { projects: rows, current, error: null };
  }

  /**
   * Union des chemins des projets demandés (noms inconnus ignorés).
   * @param {string[]} names
   */
  function pathsFor(names) {
    const out = new Set();
    for (const name of names || []) {
      const entry = projects[String(name)];
      if (!entry) continue;
      for (const p of entry.paths) out.add(p);
    }
    return [...out];
  }

  /** @param {string} name */
  function forget(name) {
    if (!projects[name]) return false;
    delete projects[name];
    return persist();
  }

  return { record, list, pathsFor, forget };
}

module.exports = { createProjectRegistry };
