// @ts-check
// « Ce process tourne-t-il ? » — SOURCE UNIQUE pour tout le core.
//
// Quatre modules ré-implémentaient la même sonde à l'identique (`tasklist /fi imagename eq X`) et
// chacun spawnait la sienne : le statut Adobe interroge deux images toutes les 8 s, la
// réconciliation d'alimentation d'hôte tourne toutes les 4 s, les attentes de sortie de Resolve
// sondent toutes les 500 ms. Sur Windows chaque `tasklist` énumère TOUS les processus (~30-150 ms) ;
// ces sondes indépendantes se superposaient en rafales pendant les rendus, là où la machine en a
// le plus besoin.
//
// Ici : UN instantané sert toutes les images, les appels concurrents partagent le même vol, et un
// cache très court (plus court que la boucle d'attente la plus serrée) absorbe les rafales sans
// jamais retarder une attente.
const { execFile } = require("child_process");

const TTL_MS = 400;
const TASKLIST_TIMEOUT_MS = 8000;

/**
 * Noms d'images d'un `tasklist /nh /fo csv` (1re colonne CSV), en minuscules.
 * @param {string} stdout
 * @returns {Set<string>}
 */
function parseTasklistImages(stdout) {
  const images = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line);
    if (m) images.add(m[1].toLowerCase());
  }
  return images;
}

/**
 * @param {{ execFileFn?: typeof execFile, ttlMs?: number }} [deps]
 */
function createProcessList(deps = {}) {
  const execFileFn = deps.execFileFn || execFile;
  const ttlMs = deps.ttlMs == null ? TTL_MS : deps.ttlMs;
  /** @type {{ at: number, images: Set<string> } | null} */
  let cache = null;
  /** @type {Promise<Set<string>> | null} */
  let inFlight = null;

  function readImages() {
    return new Promise((resolve) => {
      try {
        execFileFn("tasklist", ["/nh", "/fo", "csv"], { timeout: TASKLIST_TIMEOUT_MS }, (err, out) => {
          // Pas de Windows, `tasklist` absent, délai dépassé : on ne sait pas → aucune image connue,
          // exactement le repli des sondes d'origine (elles répondaient `false`).
          resolve(err ? new Set() : parseTasklistImages(String(out)));
        });
      } catch (_) {
        resolve(new Set());
      }
    });
  }

  /** Instantané des images en cours (caché `ttlMs`, vol partagé entre appels concurrents). */
  function snapshot() {
    if (cache && Date.now() - cache.at < ttlMs) return Promise.resolve(cache.images);
    if (!inFlight) {
      inFlight = readImages().then((images) => {
        cache = { at: Date.now(), images };
        inFlight = null;
        return images;
      });
    }
    return inFlight;
  }

  /**
   * @param {string} image nom d'exécutable, ex. « Resolve.exe »
   * @returns {Promise<boolean>}
   */
  async function isImageRunning(image) {
    if (!image) return false;
    return (await snapshot()).has(image.toLowerCase());
  }

  /** À appeler après un lancement ou un `taskkill` : la prochaine sonde relit le vrai état. */
  function invalidate() {
    cache = null;
  }

  return { isImageRunning, invalidate, snapshot };
}

const shared = createProcessList();

module.exports = {
  createProcessList,
  parseTasklistImages,
  isImageRunning: shared.isImageRunning,
  invalidate: shared.invalidate,
};
