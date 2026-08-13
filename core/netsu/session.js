// @ts-check
// core/netsu/session.js
// Registre des documents .netsu OUVERTS.
//
// Un projet enregistré n'est pas une archive qu'on réécrit à chaque fois : c'est une base SQLite
// tenue ouverte pendant qu'on travaille dedans (cf. core/netsu/db.js). Rouvrir le fichier à chaque
// enregistrement coûterait la reconstruction des statements et la relecture du journal WAL, et
// surtout ferait perdre les caches ci-dessous — c'est-à-dire tout ce qui rend un Ctrl+S instantané.
//
// Deux caches vivent dans la session, et les deux existent pour la MÊME raison : ne pas relire des
// gigaoctets pour redécouvrir ce qu'on savait déjà.
//   `mediaIds`  → chemin absolu ⇒ identité de contenu du média. Sans lui, chaque enregistrement
//                 relirait les 4 premiers Mo de chaque rush (core/netsu/embed.js#mediaIdOf).
//   `itemJson`  → item ⇒ dernier JSON écrit. C'est ce qui permet de n'écrire QUE les lignes qui ont
//                 bougé ; sans lui, déplacer une note réécrirait les mille items du board.
//
// Le registre est indexé sur le chemin RÉSOLU et en minuscules : sous Windows deux graphies du même
// fichier ouvriraient deux bases sur le même disque, chacune ignorant les écritures de l'autre.

const path = require('node:path');
const { openNetsu } = require('./db');

/** @type {Map<string, any>} */
const sessions = new Map();

/** @param {string} filePath @returns {string} */
function keyFor(filePath) {
  return path.resolve(String(filePath || '')).toLowerCase();
}

/**
 * Ouvre le document, ou rend celui déjà ouvert. Ne crée le fichier que si on le demande —
 * « Ouvrir » sur un fichier absent doit échouer, pas fabriquer un projet vide.
 * @param {string} filePath @param {{ create?: boolean, appVersion?: string }} [opts]
 */
function openSession(filePath, opts) {
  const key = keyFor(filePath);
  const existing = sessions.get(key);
  if (existing) return existing;

  const handle = openNetsu(filePath, opts);
  const session = {
    key,
    path: path.resolve(filePath),
    handle,
    /** @type {Map<string, { id: string, size: number, mtime: number }>} */
    mediaIds: new Map(),
    /** @type {Map<string, Map<string, string>>} document ⇒ (item ⇒ dernier JSON écrit) */
    itemJson: new Map(),
    openedAt: Date.now(),
  };
  sessions.set(key, session);
  return session;
}

/** @param {string} filePath */
function getSession(filePath) {
  return sessions.get(keyFor(filePath)) || null;
}

/** @param {string} filePath @returns {boolean} fermé (false = n'était pas ouvert) */
function closeSession(filePath) {
  const key = keyFor(filePath);
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
  try { session.handle.close(); } catch (_) { /* base déjà fermée : rien à replier */ }
  return true;
}

/** Ferme tout — appelé à l'arrêt du core, pour que le journal WAL soit replié dans les fichiers. */
function closeAll() {
  for (const key of [...sessions.keys()]) closeSession(key);
}

/** @returns {string[]} chemins des documents ouverts */
function openPaths() {
  return [...sessions.values()].map((s) => s.path);
}

module.exports = { openSession, getSession, closeSession, closeAll, openPaths };
