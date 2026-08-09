// @ts-check
// Ordonnanceur de ressources central : mesure VRAM (nvidia-smi) + RAM libres et décide combien de
// jobs IA peuvent tourner EN PARALLÈLE (détection de plans, indexation SigLIP…). Fournit aussi le
// pool générique de daemons (acquire/release + file d'attente + spawn à la demande) partagé par la
// détection et l'indexation — un seul endroit possède la politique de concurrence.

const os = require('os');
const { execFile } = require('child_process');

// VRAM GPU libre (Mio) via nvidia-smi (caché 400 ms). null = pas de GPU NVIDIA / nvidia-smi absent.
let _vram = { ts: 0, val: /** @type {number|null} */ (null) };
function gpuFreeMB() {
  const now = Date.now();
  if (now - _vram.ts < 400) return Promise.resolve(_vram.val);
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeout: 4000 }, (err, stdout) => {
      let v = null;
      if (!err && stdout) { const n = parseInt(String(stdout).trim().split('\n')[0], 10); if (Number.isFinite(n)) v = n; }
      _vram = { ts: Date.now(), val: v };
      resolve(v);
    });
  });
}

// Nom + VRAM TOTALE et libre du GPU (Mio), caché 5 s. null = pas de GPU NVIDIA / nvidia-smi absent.
// La VRAM totale, pas la libre : « ce modèle ne rentrera jamais sur cette carte » est une propriété du
// matériel, alors que la libre varie avec ce qui tourne à côté et ferait clignoter un avertissement.
let _gpu = { ts: 0, val: /** @type {{name:string,totalMB:number,freeMB:number}|null} */ (null) };
function gpuInfo() {
  const now = Date.now();
  if (now - _gpu.ts < 5000) return Promise.resolve(_gpu.val);
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 4000 }, (err, stdout) => {
        let v = null;
        if (!err && stdout) {
          const [name, total, free] = String(stdout).trim().split('\n')[0].split(',').map((s) => s.trim());
          const t = parseInt(total, 10), f = parseInt(free, 10);
          if (name && Number.isFinite(t)) v = { name, totalMB: t, freeMB: Number.isFinite(f) ? f : 0 };
        }
        _gpu = { ts: Date.now(), val: v };
        resolve(v);
      });
  });
}

// RAM système libre (Mio).
function ramFreeMB() { return Math.floor(os.freemem() / (1024 * 1024)); }

/**
 * Nb de jobs tenables en parallèle pour un type de tâche donné, selon la VRAM libre (GPU NVIDIA)
 * avec repli RAM (machine sans nvidia-smi : les modèles tournent alors sur CPU, en RAM).
 * Snapshot au lancement (suffit : un OOM en cours = erreur propre sur ce job, le reste continue).
 * @param {{ perJobMB: number, baseMB?: number, max: number, ramPerJobMB?: number, ramBaseMB?: number }} o
 *  perJobMB   coût VRAM d'un job supplémentaire (modèle + activations + marge)
 *  baseMB     marge VRAM gardée libre (défaut 800)
 *  max        plafond dur
 *  ramPerJobMB / ramBaseMB  équivalents pour le repli CPU/RAM (défauts 3000 / 4000)
 */
async function concurrencyFor(o) {
  const { perJobMB, baseMB = 800, max, ramPerJobMB = 3000, ramBaseMB = 4000 } = o;
  const free = await gpuFreeMB();
  if (free != null) {
    return Math.max(1, Math.min(max, 1 + Math.floor(Math.max(0, free - baseMB) / perJobMB)));
  }
  // Pas de GPU NVIDIA mesurable → jobs CPU, bornés par la RAM libre (plafond prudent 2).
  const ram = ramFreeMB();
  return Math.max(1, Math.min(max, 2, 1 + Math.floor(Math.max(0, ram - ramBaseMB) / ramPerJobMB)));
}

/**
 * Pool générique de daemons : entrée 0 optionnelle (daemon "chaud" réutilisé), spawn à la demande
 * jusqu'à `max`, file d'attente au-delà. release() passe le daemon au suivant en file (reste busy).
 * @template D
 * @param {() => D} spawnDaemon
 * @param {{ max: number, seed?: D }} opts
 */
function makePool(spawnDaemon, opts) {
  const { max, seed } = opts;
  const pool = seed ? [{ d: seed, busy: false }] : [];
  /** @type {((e: {d: D, busy: boolean}) => void)[]} */
  const waiters = [];
  function acquire() {
    const free = pool.find((e) => !e.busy);
    if (free) { free.busy = true; return Promise.resolve(free); }
    if (pool.length < max) {
      const e = { d: spawnDaemon(), busy: true };
      pool.push(e);
      return Promise.resolve(e);
    }
    return new Promise((res) => waiters.push(res)); // tous occupés → attendre une libération
  }
  /** @param {{d: D, busy: boolean}} e */
  function release(e) {
    const w = waiters.shift();
    if (w) { w(e); return; } // passe le daemon (reste busy) au suivant en file
    e.busy = false;
  }
  function killAll() {
    pool.forEach((e) => { try { /** @type {any} */ (e.d).kill(); } catch (_) {} });
  }
  return { acquire, release, killAll, pool };
}

module.exports = { gpuFreeMB, gpuInfo, ramFreeMB, concurrencyFor, makePool };
