// @ts-check
// Portail de créneaux d'encodage PARTAGÉ par tout le processus core.
//
// Pourquoi : `exportClips` limitait déjà ses propres plans (pool interne), mais RIEN ne limitait
// deux appels concurrents. Rendre 5 rushs en parallèle depuis NetsuTalk lançait donc 5 × 3 ffmpeg :
// les sessions NVENC saturent (« OpenEncodeSessionEx failed »), le CPU thrash, et le rendu global
// devient plus lent qu'en série. Le portail est la SEULE source de vérité du nombre d'encodes en vol.
//
// Limite effective = la PLUS BASSE des limites enregistrées par les jobs en cours (jamais de
// sur-souscription : un job CPU à 2 bride l'ensemble tant qu'il tourne), plafonnée par DEFAULT_LIMIT.

const DEFAULT_LIMIT = 4;

/** @type {Set<{ limit: number }>} */
const registered = new Set();
/** @type {(() => void)[]} */
const waiters = [];
let active = 0;

function effectiveLimit() {
  let min = DEFAULT_LIMIT;
  for (const h of registered) if (h.limit < min) min = h.limit;
  return Math.max(1, min);
}

function drain() {
  while (waiters.length && active < effectiveLimit()) {
    active++;
    const next = waiters.shift();
    if (next) next();
  }
}

/**
 * Déclare la limite d'un job (plusieurs jobs = limite la plus basse). À relâcher à la fin du job.
 * @param {number} limit @returns {{ release: () => void }}
 */
function register(limit) {
  const handle = { limit: Math.max(1, Math.round(limit) || 1) };
  registered.add(handle);
  return {
    release() {
      if (!registered.delete(handle)) return;
      drain(); // la limite remonte peut-être → réveiller les attentes
    },
  };
}

/** @returns {Promise<void>} */
function acquire() {
  if (active < effectiveLimit()) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  active = Math.max(0, active - 1);
  drain();
}

/**
 * Exécute `fn` en occupant un créneau (attend si le portail est plein).
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
async function withSlot(fn) {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** État courant (diagnostic / logs). */
function stats() {
  return { active, limit: effectiveLimit(), waiting: waiters.length, jobs: registered.size };
}

module.exports = { register, withSlot, stats, DEFAULT_LIMIT };
