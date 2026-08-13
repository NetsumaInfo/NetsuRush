// @ts-check
// core/uistate.js
// Miroir DURABLE du `localStorage` du renderer.
//
// Pourquoi : tous les réglages de l'interface (thème, fond, volumes, colonnes, raccourcis de coupe,
// options des modules…) vivent dans `localStorage`, qui appartient au profil WebView2 de l'app et à
// UNE origine. Un profil WebView2 recréé, un changement d'origine (app installée vs session de dev,
// panneau CEP) ou un nettoyage de stockage suffisent donc à ramener toute l'app à ses valeurs par
// défaut — l'utilisateur devait tout re-régler après chaque mise à jour.
//
// `core/prefs.js` ne couvre que les réglages qui décrivent le TRAVAIL (détection, export, insertion)
// et impose une forme typée. Ici, on ne connaît RIEN des clés : le fichier est un sac
// clé(string) → valeur(string), exactement ce que le renderer met dans `localStorage`. La sélection
// des clés miroir vit côté renderer (`src/lib/uiState.ts`).

const path = require('node:path');
const fs = require('node:fs');
const { NR_HOME } = require('./config');

const STATE_FILE = path.join(NR_HOME, 'ui-state.json');

// Une valeur qui dépasse ce seuil n'est pas un réglage mais un jeu de données que le renderer aurait
// dû ranger ailleurs : on refuse de la recopier plutôt que de réécrire des mégaoctets à chaque
// frappe. La clé reste vivante côté renderer, elle n'est simplement pas sauvegardée.
const MAX_VALUE_BYTES = 512 * 1024;
// Plafond global du fichier : au-delà, on garde l'état déjà connu et on rejette le patch.
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** @returns {Record<string, string>} */
function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch (_) {
    return {}; // premier lancement, ou fichier illisible → le renderer sème ce qu'il a
  }
}

/** Écriture atomique : un core tué en plein vol ne doit pas laisser un JSON tronqué. */
function writeState(state) {
  fs.mkdirSync(NR_HOME, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

/**
 * @param {object} deps
 * @param {(channel: string, payload: any) => void} deps.broadcast
 */
function createUiState({ broadcast }) {
  let state = readState();

  function get() {
    return { ok: true, state };
  }

  /**
   * Patch clé→valeur. `null` supprime la clé (le renderer a fait `removeItem`).
   * @param {Record<string, string|null>} patch
   */
  function set(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'invalid ui state' };
    const next = { ...state };
    /** @type {string[]} */
    const skipped = [];
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (typeof key !== 'string' || !key) continue;
      if (value === null || value === undefined) {
        if (key in next) { delete next[key]; changed = true; }
        continue;
      }
      if (typeof value !== 'string') continue;
      if (Buffer.byteLength(value) > MAX_VALUE_BYTES) { skipped.push(key); continue; }
      if (next[key] !== value) { next[key] = value; changed = true; }
    }
    if (!changed) return { ok: true, skipped };
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > MAX_TOTAL_BYTES) return { ok: false, error: 'ui state too large' };
    state = next;
    try {
      writeState(state);
    } catch (e) {
      return { ok: false, error: String(e) };
    }
    // Les autres renderers appliquent le patch (et pas tout le sac) : ils ne touchent que ce qui a
    // changé, sans écraser un réglage qu'ils viennent eux-mêmes de modifier.
    broadcast('uistate:changed', { patch });
    return { ok: true, skipped };
  }

  return { get, set };
}

module.exports = { createUiState, STATE_FILE, MAX_VALUE_BYTES, MAX_TOTAL_BYTES };
