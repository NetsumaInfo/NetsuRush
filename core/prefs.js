// @ts-check
// core/prefs.js
// Préférences PARTAGÉES entre les renderers de NetsuRush.
//
// Pourquoi côté core : les réglages du renderer vivent dans `localStorage`, qui est par ORIGINE.
// L'app Tauri (tauri://localhost), le panneau CEP (http://127.0.0.1:8730/app ou :1420) et les
// fenêtres détachées n'ont donc PAS le même stockage — un rush découpé dans l'app apparaissait
// « pas découpé » dans le panneau, parce que le modèle / le seuil / les options de détection y
// étaient restés aux valeurs par défaut et que le cache de plans est indexé sur ce triplet.
//
// Le fichier est un simple sac clé→valeur : le core ne connaît RIEN de la forme des réglages, il
// stocke et rediffuse. La sélection des clés partagées vit côté renderer (hooks/useSharedPrefs).

const path = require('node:path');
const fs = require('node:fs');
const { NR_HOME } = require('./config');

const STATE_FILE = path.join(NR_HOME, 'prefs.json');

/** @returns {Record<string, unknown>} */
function readPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (_) {
    return {}; // premier lancement, ou fichier illisible → on repart des valeurs du renderer
  }
}

/** Écriture atomique : un core tué en plein vol ne doit pas laisser un JSON tronqué. */
function writePrefs(prefs) {
  fs.mkdirSync(NR_HOME, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

const VRAM_PROFILES = ['economy', 'balanced', 'performance'];

/**
 * Traduit les options de performance de la recherche en variables d'environnement des sidecars.
 *
 * Relu à CHAQUE spawn, comme la langue : basculer une option ne demande donc pas de redémarrer le
 * core. Le fichier fait foi plutôt que l'état en mémoire — une fenêtre détachée ou le panneau CEP
 * écrivent par le même chemin, et c'est le disque qu'ils ont en commun.
 *
 * Le core valide la FORME sans juger la valeur (python borne ce qui doit l'être) : une clé absente
 * ou mal typée laisse simplement le défaut python en place, jamais une variable vide qui se lirait
 * comme un choix.
 * @returns {Record<string, string>}
 */
function perfEnv() {
  const raw = readPrefs().searchPerf;
  if (!raw || typeof raw !== 'object') return {};
  const perf = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Record<string, string>} */
  const env = {};
  if (typeof perf.shotDecode === 'boolean') env.NETSURUSH_SHOT_DECODE = perf.shotDecode ? '1' : '0';
  if (typeof perf.onnxGpu === 'boolean') env.NETSURUSH_ONNX_GPU = perf.onnxGpu ? '1' : '0';
  if (typeof perf.vramProfile === 'string' && VRAM_PROFILES.includes(perf.vramProfile)) {
    env.NETSURUSH_VRAM_PROFILE = perf.vramProfile;
  }
  if (typeof perf.maxPatches === 'number' && Number.isFinite(perf.maxPatches)) {
    env.NETSURUSH_MAX_PATCHES = String(Math.round(perf.maxPatches));
  }
  return env;
}

/**
 * @param {object} deps
 * @param {(channel: string, payload: any) => void} deps.broadcast
 */
function createPrefs({ broadcast }) {
  let prefs = readPrefs();

  function get() {
    return { ok: true, prefs };
  }

  /** Fusion superficielle : chaque clé partagée est remplacée en entier (jamais fusionnée en profondeur). */
  function set(patch) {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid prefs' };
    const next = { ...prefs, ...patch };
    if (JSON.stringify(next) === JSON.stringify(prefs)) return { ok: true, prefs };
    prefs = next;
    try {
      writePrefs(prefs);
    } catch (e) {
      return { ok: false, error: String(e) };
    }
    // Les autres renderers appliquent le patch (et pas tout le sac) : ils ne touchent que ce qui a changé.
    broadcast('prefs:changed', { patch });
    return { ok: true, prefs };
  }

  return { get, set };
}

module.exports = { createPrefs, perfEnv, VRAM_PROFILES };
