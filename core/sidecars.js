// @ts-check
// Sidecars python : détection de plans (detect.py serve, pool de daemons — modèles chauds),
// recherche SigLIP 2 (search.py serve, daemons GPU + CPU persistants) et upscale Real-ESRGAN
// (upscale.py serve, worker persistant). Le modèle reste chargé entre les appels ; les commandes
// sont du JSON ligne-à-ligne (stdin→stdout). La concurrence (détection/indexation parallèles)
// est décidée par core/scheduler.js selon la VRAM/RAM libres.

const path = require('path');
const { spawn } = require('child_process');
const { CONFIG, PYTHON, DETECT_ENV, UPSCALE_TEST_DIR, fsp } = require('./config');
const { perfEnv } = require('./prefs'); // options de performance partagées entre les fenêtres
const { cacheIndex } = require('./cacheIndex');
const scheduler = require('./scheduler');
const { importToMediaPool } = require('./resolve'); // pont Python externe (core/resolve.js)
const { codecExt: upscaleExt, hasFiles, sanitizeName } = require('./utils');
const { resolveProcessEncoding } = require('./processEncoding');
const { MANIFEST, modelDir, RIFE_TORCH_DIR, RIFE_ARCH_DIR, GMFSS_DIR, DRBA_DIR, DRBA_ARCH_DIR } = require('./models');   // dossiers de poids gérés (BEN2/MatAnyone…) → env sidecar
const logbus = require('./logbus'); // journal Console : forward du stderr des sidecars python

// Env du process daemon = DETECT_ENV + chemins des poids gérés par le manager (BEN2/Lucida/MatAnyone) pour
// que les moteurs chargent depuis NR_HOME/models plutôt que de re-tirer le repo HF.
function procEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = langEnv();
  const ben2 = modelDir('ben2'); if (ben2) env.NETSURUSH_BEN2_DIR = ben2;
  const birefnet = modelDir('birefnet'); if (birefnet) env.NETSURUSH_BIREFNET_DIR = birefnet;
  const lucida = modelDir('lucida'); if (lucida) env.NETSURUSH_LUCIDA_DIR = lucida;
  const mat = modelDir('matanyone'); if (mat) env.NETSURUSH_MATANYONE_DIR = mat;
  // Modèles de PROFONDEUR : leur moteur (transformers) accepte un dossier local à la place du dépôt
  // HF. Sans cette table, il retéléchargeait le modèle dans son propre cache alors que Paramètres ›
  // Modèles venait de l'installer — annoncé « installé », facturé deux fois en disque et en réseau.
  /** @type {Record<string, string>} */
  const localModelDirs = {};
  for (const [id, entry] of Object.entries(MANIFEST)) {
    if (entry.task !== 'depth') continue;
    const dir = modelDir(id);
    if (hasFiles(dir)) localModelDirs[id] = dir;
  }
  if (Object.keys(localModelDirs).length) env.NETSURUSH_MODEL_DIRS = JSON.stringify(localModelDirs);
  // RIFE PyTorch : les poids de TOUTES les versions partagent un dossier, et leurs modules
  // d'architecture vivent juste à côté (cf. nrproc/rife_torch.py).
  env.NETSURUSH_RIFE_TORCH_DIR = RIFE_TORCH_DIR;
  env.NETSURUSH_RIFE_ARCH_DIR = RIFE_ARCH_DIR;
  // GMFSS : poids et paquet python extraits côte à côte (cf. nrproc/gmfss.py).
  env.NETSURUSH_GMFSS_DIR = GMFSS_DIR;
  env.NETSURUSH_DRBA_DIR = DRBA_DIR;
  env.NETSURUSH_DRBA_ARCH_DIR = DRBA_ARCH_DIR;
  return env;
}

// La langue et les options de performance sont lues à chaque spawn : saveConfig({ lang }) et une
// bascule des Paramètres sont donc prises en compte sans redémarrer le core pour les prochains
// workers, tout en conservant intégralement l'environnement ML existant.
/** @param {NodeJS.ProcessEnv} [extra] @returns {NodeJS.ProcessEnv} */
function langEnv(extra = {}) {
  return { ...DETECT_ENV, ...perfEnv(), NR_LANG: CONFIG.lang || 'fr', ...extra };
}

// Scripts Python à la racine du dépôt (core/ → ../python). En bundle, surchargeable via env.
const PY_DIR = process.env.NETSURUSH_PY_DIR || path.join(__dirname, '..', 'python');
const DETECT_SCRIPT = path.join(PY_DIR, 'detect.py');
const SEARCH_SCRIPT = path.join(PY_DIR, 'search.py');
const UPSCALE_SCRIPT = path.join(PY_DIR, 'upscale.py');
const PROCESS_SCRIPT = path.join(PY_DIR, 'process.py');
const TRANSCRIBE_SCRIPT = path.join(PY_DIR, 'transcribe.py');
const SILENCE_SCRIPT = path.join(PY_DIR, 'silence.py');
const FILLER_SCRIPT = path.join(PY_DIR, 'filler.py');

// Anti-hang : detect.py émet PROGRESS/STAGE en continu pendant l'extraction et l'inférence. Un
// silence prolongé = process figé (hang CUDA, deadlock decode) → on tue et on résout proprement,
// sinon le handler RPC pend indéfiniment et bloque cutTimeline + le poll Resolve. Watchdog
// d'INACTIVITÉ (pas un délai total : un long film prend légitimement des minutes).
// 5 min sans aucune sortie : OmniShotCut lit toute la vidéo en RAM AVANT d'émettre sa 1re
// progression (~70 s muets pour 24 min, ~130 s pour ~45 min) → marge pour les longs films.
const DETECT_IDLE_MS = 300000;

// Lance detect.py one-shot, renvoie la dernière ligne JSON. `tagPath` (chemin du rush) accompagne
// chaque événement `scenes:progress` → la découpe EN LOT (N détections en parallèle) route le pct
// vers le bon rush. En découpe simple le listener ignore le chemin (lit juste .pct).
function runDetect(event, args, tagPath) {
  return new Promise((resolve) => {
    const py = spawn(PYTHON, [DETECT_SCRIPT, ...args], { env: langEnv() });
    let out = '';
    let errTail = '';
    let done = false;
    let last = Date.now();
    const finish = (r) => { if (done) return; done = true; clearInterval(wd); resolve(r); };
    // Même émetteur MONOTONE que le daemon, et surtout le même compteur : ce chemin est le REPLI
    // pris quand le daemon meurt en plein job, donc la barre est déjà à mi-course — repartir de la
    // progression brute de python la ferait reculer d'un coup.
    const emit = detectEmit(event, tagPath);
    const wd = setInterval(() => {
      if (Date.now() - last > DETECT_IDLE_MS) {
        try { py.kill('SIGKILL'); } catch (_) {}
        finish({ scenes: [], error: 'python: délai dépassé (aucune progression)' });
      }
    }, 5000);
    py.stdout.on('data', (d) => { last = Date.now(); out += d.toString(); });
    py.stderr.on('data', (d) => {
      last = Date.now();
      const s = d.toString();
      errTail = (errTail + s).slice(-600);
      logbus.py('detect', s);
      emit(s);
    });
    py.on('close', () => {
      const line = out.trim().split('\n').pop() || '';
      try { finish(JSON.parse(line)); }
      catch (_) { finish({ scenes: [], error: 'python: ' + (errTail || 'sortie illisible') }); }
    });
    py.on('error', (e) => finish({ scenes: [], error: String(e) }));
  });
}

// --- Daemon de détection (detect.py serve) : modèles TransNetV2/OmniShotCut gardés CHAUDS entre
// les jobs → plus de cold-start torch+poids à chaque détection (c'était le « blocage » au lancement).
// 1 job à la fois par daemon ; le PARALLÉLISME vient du pool (scheduler.makePool) dimensionné par
// detectConcurrency() selon la VRAM libre. Même squelette que makeSearchDaemon (watchdog d'inactivité
// pendant un job en cours ; un daemon mort rejette proprement ses jobs → repli one-shot).
function makeDetectDaemon() {
  let proc = null, seq = 0, buf = '', last = 0, wd = null, curProg = null;
  const pending = new Map();
  const touch = () => { last = Date.now(); };
  function startWatch() {
    if (wd) return;
    wd = setInterval(() => {
      if (!proc || pending.size === 0) { clearInterval(wd); wd = null; return; }
      if (Date.now() - last > DETECT_IDLE_MS) { try { proc.kill('SIGKILL'); } catch (_) {} }
    }, 5000);
  }
  function start() {
    if (proc) return;
    proc = spawn(PYTHON, [DETECT_SCRIPT, 'serve'], { env: langEnv() });
    touch();
    proc.stdout.on('data', (d) => {
      touch();
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        const resolve = pending.get(msg.id);
        if (resolve) { pending.delete(msg.id); resolve(msg.result); }
      }
    });
    proc.stderr.on('data', (d) => { touch(); const s = d.toString(); logbus.py('detect', s); if (curProg) curProg(s); });
    const onDead = () => {
      proc = null; buf = '';
      if (wd) { clearInterval(wd); wd = null; }
      for (const resolve of pending.values()) resolve({ scenes: [], error: 'sidecar détection interrompu' });
      pending.clear();
    };
    proc.on('exit', onDead);
    proc.on('error', onDead);
  }
  return {
    req(payload, onProg) {
      start();
      if (!proc) return Promise.resolve({ scenes: [], error: 'sidecar détection injoignable' });
      const id = ++seq;
      curProg = onProg || null;
      touch();
      startWatch();
      return new Promise((resolve) => {
        pending.set(id, resolve);
        try { proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n'); }
        catch (e) { pending.delete(id); resolve({ scenes: [], error: String(e) }); }
      }).finally(() => { if (curProg === onProg) curProg = null; });
    },
    kill() { try { proc?.kill(); } catch (_) {} },
    idle() { return pending.size === 0; },
  };
}

const MAX_DETECT_DAEMONS = 6;
const DETECT_JOB_MB = 1600;   // coût VRAM d'une détection GPU (modèle + frames + activations + marge)
const detectPool = scheduler.makePool(makeDetectDaemon, { max: MAX_DETECT_DAEMONS, seed: makeDetectDaemon() });
// Nb de détections tenables en parallèle (VRAM libre, repli RAM sur machine sans GPU NVIDIA).
function detectConcurrency() {
  return scheduler.concurrencyFor({ perJobMB: DETECT_JOB_MB, max: MAX_DETECT_DAEMONS });
}

// Clamp MONOTONE par rush : les jobs parallèles émettent chacun leur PROGRESS, on garantit qu'un
// pct ne recule JAMAIS pour un même chemin (événements tardifs, repli one-shot qui repart de 0…).
const detectLastPct = new Map();
// Émetteur monotone SANS remise à zéro : lit `PROGRESS:<pct>` dans un chunk stderr (detect.py est
// l'unique autorité de progression, les STAGE:* ne portent aucun pourcentage) et n'émet que ce qui
// avance. Partagé par le daemon et le repli one-shot pour qu'un basculement de l'un à l'autre en
// plein job continue la même barre.
function detectEmit(event, tagPath) {
  return (s) => {
    if (!event?.sender) return;
    const m = s.match(/PROGRESS:(\d+)/g);
    if (!m) return;
    const pct = parseInt(m[m.length - 1].slice(9), 10);
    const prev = detectLastPct.get(tagPath);
    if (prev != null && pct <= prev) return;
    detectLastPct.set(tagPath, pct);
    event.sender.send('scenes:progress', { path: tagPath || null, pct });
  };
}
function detectProgress(event, tagPath) {
  detectLastPct.set(tagPath, -1);
  return detectEmit(event, tagPath);
}

// Détection de plans (TransNetV2 ou OmniShotCut au choix) + mise en cache SQLite.
// Passe par le pool de daemons (modèle chaud, jobs parallèles) ; si le daemon meurt en plein job
// (crash python/CUDA), repli one-shot runDetect — la détection « fonctionne à tous les coups ».
async function detectScenes(event, filePath, threshold = 0.5, model = 'transnetv2', options = {}) {
  const onProg = detectProgress(event, filePath);
  const e = await detectPool.acquire();
  try {
    let r = await e.d.req({ cmd: 'detect', path: filePath, threshold: Number(threshold), model, options }, onProg);
    if (r && r.error && /interrompu|injoignable/.test(String(r.error))) {
      r = await runDetect(event, ['detect', filePath, String(threshold), model, JSON.stringify(options || {})], filePath);
    }
    return r;
  } finally {
    detectPool.release(e);
    detectLastPct.delete(filePath);
  }
}
// Lecture DIRECTE du cache de scènes depuis Node (node:sqlite, readonly). L'ancien chemin spawnait
// detect.py à CHAQUE appel (~0,5-2 s d'interpréteur Python) pour une simple SELECT — c'était LE délai
// ressenti à l'ouverture d'un rush déjà découpé (CutStudio, MediaPicker, envoi timeline). Réplique
// exacte de detect.py#cmd_get : même requête, même forme de réponse, même péremption mtime (>1 s).
/** @type {any} */
let sceneDbHandle = null; // DatabaseSync | null (pas encore ouvert) | false (indisponible)
function sceneDb() {
  if (sceneDbHandle === false) return null;
  if (sceneDbHandle) return sceneDbHandle;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const os = require('os');
    const fs = require('fs');
    const p = path.join(os.homedir(), '.netsurush', 'netsurush.db');
    if (!fs.existsSync(p)) return null; // pas encore de cache : ne rien créer, on réessaiera
    sceneDbHandle = new DatabaseSync(p, { readOnly: true });
    return sceneDbHandle;
  } catch (_) {
    sceneDbHandle = false; // node:sqlite absent → repli spawn définitif
    return null;
  }
}
// null = lecture directe impossible (db/table absente, erreur SQLite) → repli spawn python.
function stableJson(value) {
  if (Array.isArray(value)) {
    const entries = value.map(stableJson);
    if (value.every((entry) => entry == null || ['string', 'number', 'boolean'].includes(typeof entry))) entries.sort();
    return `[${entries.join(',')}]`;
  }
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function readSceneCacheDirect(filePath, model, threshold, options) {
  const db = sceneDb();
  if (!db) return null;
  try {
    const sql = 'SELECT mtime, options_key, threshold, fps, duration, frames, scenes_json, options_json FROM scene_cache_v4 '
      + 'WHERE file_path=? AND model=?' + (threshold == null ? '' : ' AND threshold=?')
      + ' ORDER BY created_at DESC';
    // Statement préparé PAR APPEL (jamais mémorisé) : un StatementSync conservé peut être finalisé
    // par le GC → « statement has been finalized » (même piège que core/reference.js).
    const rows = threshold == null
      ? db.prepare(sql).all(filePath, model)
      : db.prepare(sql).all(filePath, model, Number(threshold));
    const wanted = options == null ? null : stableJson(options);
    const row = rows.find((candidate) => wanted == null || stableJson(JSON.parse(String(candidate.options_json || '{}'))) === wanted);
    if (!row) return options == null ? { scenes: [], cached: false, model, error: null } : null;
    let mt = 0;
    try { mt = require('fs').statSync(filePath).mtimeMs / 1000; } catch (_) { /* fichier disparu */ }
    if (Math.abs(Number(row.mtime) - mt) > 1.0) return { scenes: [], cached: false, stale: true, model, error: null };
    return {
      scenes: JSON.parse(String(row.scenes_json)), options: JSON.parse(String(row.options_json || 'null')),
      fps: row.fps, duration: row.duration, frames: row.frames, threshold: row.threshold,
      model, optionsKey: row.options_key, cached: true, error: null,
    };
  } catch (_) {
    try {
      const sql = 'SELECT mtime, threshold, fps, duration, frames, scenes_json FROM scene_cache_v3 '
        + 'WHERE file_path=? AND model=?' + (threshold == null ? '' : ' AND threshold=?')
        + ' ORDER BY created_at DESC LIMIT 1';
      const row = threshold == null
        ? db.prepare(sql).get(filePath, model)
        : db.prepare(sql).get(filePath, model, Number(threshold));
      if (!row) return { scenes: [], cached: false, model, error: null };
      let mt = 0;
      try { mt = require('fs').statSync(filePath).mtimeMs / 1000; } catch (_) {}
      if (Math.abs(Number(row.mtime) - mt) > 1.0) return { scenes: [], cached: false, stale: true, model, error: null };
      return { scenes: JSON.parse(String(row.scenes_json)), fps: row.fps, duration: row.duration,
        frames: row.frames, threshold: row.threshold, model, cached: true, error: null };
    } catch (_) { return null; }
  }
}
// threshold optionnel : si fourni, ne renvoie QUE la découpe de ce seuil exact (sinon la dernière,
// tous seuils confondus).
function getCachedScenes(filePath, model = 'transnetv2', threshold, options) {
  const direct = readSceneCacheDirect(filePath, model, threshold, options);
  if (direct) return Promise.resolve(direct);
  const args = ['get', filePath, model];
  if (threshold != null) args.push(String(threshold));
  if (threshold != null && options != null) args.push(JSON.stringify(options));
  return runDetect(null, args);
}

// Détection de silences (Silero VAD) one-shot : silence.py léger → pas de daemon. Même squelette
// que runDetect (watchdog d'inactivité, dernière ligne JSON) mais progression en SSE `voice:progress`.
function runSilence(event, source, audio, params = {}) {
  return new Promise((resolve) => {
    const py = spawn(PYTHON, [SILENCE_SCRIPT, 'process', source, audio, JSON.stringify(params || {})], { env: langEnv() });
    let out = '';
    let errTail = '';
    let done = false;
    let last = Date.now();
    const finish = (r) => { if (done) return; done = true; clearInterval(wd); resolve(r); };
    const wd = setInterval(() => {
      if (Date.now() - last > DETECT_IDLE_MS) {
        try { py.kill('SIGKILL'); } catch (_) {}
        finish({ ok: false, speech: [], silence: [], error: 'silero: délai dépassé (aucune progression)' });
      }
    }, 5000);
    py.stdout.on('data', (d) => { last = Date.now(); out += d.toString(); });
    py.stderr.on('data', (d) => {
      last = Date.now();
      const s = d.toString();
      errTail = (errTail + s).slice(-600);
      logbus.py('silence', s);
      if (event?.sender) {
        if (s.includes('STAGE:load')) event.sender.send('voice:progress', { phase: 'silence', pct: 20 });
        if (s.includes('STAGE:infer')) event.sender.send('voice:progress', { phase: 'silence', pct: 55 });
      }
    });
    py.on('close', () => {
      const line = out.trim().split('\n').pop() || '';
      try { finish(JSON.parse(line)); }
      catch (_) { finish({ ok: false, speech: [], silence: [], error: 'silero: ' + (errTail || 'sortie illisible') }); }
    });
    py.on('error', (e) => finish({ ok: false, speech: [], silence: [], error: String(e) }));
  });
}

// Détection ACOUSTIQUE des hésitations (filler.py, librosa) one-shot. payload = {words, silences, params}.
function runFiller(event, source, audio, payload = {}) {
  return new Promise((resolve) => {
    const py = spawn(PYTHON, [FILLER_SCRIPT, 'process', source, audio, JSON.stringify(payload || {})], { env: langEnv() });
    let out = '';
    let errTail = '';
    let done = false;
    let last = Date.now();
    const finish = (r) => { if (done) return; done = true; clearInterval(wd); resolve(r); };
    const wd = setInterval(() => {
      if (Date.now() - last > DETECT_IDLE_MS) {
        try { py.kill('SIGKILL'); } catch (_) {}
        finish({ ok: false, fillers: [], error: 'filler: délai dépassé (aucune progression)' });
      }
    }, 5000);
    py.stdout.on('data', (d) => { last = Date.now(); out += d.toString(); });
    py.stderr.on('data', (d) => {
      last = Date.now();
      const s = d.toString();
      errTail = (errTail + s).slice(-600);
      logbus.py('filler', s);
      if (event?.sender) {
        if (s.includes('STAGE:load')) event.sender.send('voice:progress', { phase: 'filler', pct: 20 });
        if (s.includes('STAGE:infer')) event.sender.send('voice:progress', { phase: 'filler', pct: 55 });
      }
    });
    py.on('close', () => {
      const line = out.trim().split('\n').pop() || '';
      try { finish(JSON.parse(line)); }
      catch (_) { finish({ ok: false, fillers: [], error: 'filler: ' + (errTail || 'sortie illisible') }); }
    });
    py.on('error', (e) => finish({ ok: false, fillers: [], error: String(e) }));
  });
}

// Daemons python persistants (modèle chargé 1 fois chacun). Choix GPU/CPU DYNAMIQUE selon ce qui
// tourne en parallèle :
//   - daemon GPU (dGpu) : indexation (embed lourd) ET requêtes quand RIEN n'indexe (rapide, modèle
//                         déjà chaud). C'est le seul modèle GPU → jamais de double VRAM.
//   - daemon CPU (dCpu) : requêtes UNIQUEMENT pendant une indexation en cours (GPU occupé) + les
//                         commandes sans modèle (status/indexed, juste SQLite).
// → si recherche en parallèle de l'index : CPU ; sinon : GPU. Recherche jamais bloquée par l'index.
function makeSearchDaemon(extraEnv, onStderr, idleKillMs) {
  let proc = null, seq = 0, buf = '', last = 0, wd = null;
  // Fin de stderr du daemon : quand il meurt (OOM VRAM, traceback python, kill du watchdog), c'est
  // la SEULE trace de la cause. Sans elle, l'UI n'affichait que « sidecar recherche interrompu » et
  // le clip fautif restait inexplicable.
  let errTail = '';
  let killedByWatchdog = false;
  let route = onStderr;   // routeur stderr COURANT (mutable) : searchIndex l'écrase par job → progression
  const pending = new Map();
  const touch = () => { last = Date.now(); };
  const killMs = () => (typeof idleKillMs === 'function' ? idleKillMs() : idleKillMs);
  function startWatch() {
    // anti-hang : si le daemon ne produit plus AUCUNE sortie pendant le délai (adaptatif selon la
    // phase) alors qu'une commande est en cours, on le tue → onDead rejette les pending → la boucle
    // d'indexation saute le clip et continue (au lieu de figer longtemps).
    if (wd || !idleKillMs) return;
    wd = setInterval(() => {
      if (!proc || pending.size === 0) { clearInterval(wd); wd = null; return; }
      const limit = killMs();
      if (limit && Date.now() - last > limit) { killedByWatchdog = true; try { proc.kill(); } catch (_) {} }
    }, 3000);
  }
  function start() {
    if (proc) return;
    proc = spawn(PYTHON, [SEARCH_SCRIPT, 'serve'], { env: langEnv(extraEnv) });
    touch();
    proc.stdout.on('data', (d) => {
      touch();
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        const resolve = pending.get(msg.id);
        if (resolve) { pending.delete(msg.id); resolve(msg.result); }
      }
    });
    proc.stderr.on('data', (d) => {
      touch();
      const s = d.toString();
      // On garde les seules lignes DIAGNOSTIQUES : les marqueurs de progression noieraient la trace.
      const diag = s.split('\n').filter((line) => line.trim() && !/^(STAGE|PROGRESS|PHASE):/.test(line.trim())).join('\n');
      if (diag) errTail = (errTail + '\n' + diag).slice(-600);
      logbus.py('search', s);
      if (route) route(s);
    });
    const onDead = (info) => {
      proc = null; buf = '';
      if (wd) { clearInterval(wd); wd = null; }
      const cause = killedByWatchdog
        ? `aucune sortie pendant ${Math.round((killMs() || 0) / 1000)} s`
        : typeof info === 'string' ? info
          : typeof info === 'number' ? `code ${info}`
            : (info && info.message) || 'arrêt inattendu';
      const tail = errTail.trim().split('\n').slice(-4).join(' | ');
      const error = indexAborting
        ? 'indexation annulée'
        : `sidecar recherche interrompu (${cause})${tail ? ' — ' + tail : ''}`;
      if (pending.size) logbus.py('search', error + '\n');   // visible dans Paramètres › Console
      for (const resolve of pending.values()) resolve({ hits: [], error });
      pending.clear();
      errTail = '';
      killedByWatchdog = false;
    };
    proc.on('exit', (code, signal) => onDead(signal ? `signal ${signal}` : code));
    proc.on('error', onDead);
  }
  return {
    req(cmd, payload) {
      start();
      if (!proc) return Promise.resolve({ hits: [], error: 'sidecar recherche injoignable' });
      const id = ++seq;
      touch();
      startWatch();
      return new Promise((resolve) => {
        pending.set(id, resolve);
        try { proc.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n'); }
        catch (e) { pending.delete(id); resolve({ hits: [], error: String(e) }); }
      });
    },
    kill() { try { proc?.kill(); } catch (_) {} },
    // Aucune requête en vol. `pool.busy` ne suffit pas : les requêtes de recherche passent par
    // `dGpu` SANS acquérir le pool (cf. queryReq), donc un daemon « libre » côté pool peut très
    // bien être en train de répondre.
    idle() { return pending.size === 0; },
    // Fixe le routeur de progression pour le job courant (null = repli sur onStderr d'origine).
    // Permet à 2 indexations concurrentes (plans + visages), sur 2 daemons du pool, d'avoir chacune
    // sa propre destination SSE sans se marcher dessus.
    setRoute(fn) { route = fn || onStderr; },
  };
}

// Routeur de progression PAR JOB : chaque indexation (plans/visages/labels) a sa propre destination
// SSE + sa propre phase. `kind` ('clip'|'face'|'label') distingue les tâches côté renderer → deux
// indexations peuvent tourner EN MÊME TEMPS sans mélanger leurs barres de progression.
// Un job d'indexation traverse DEUX travaux qui ont chacun leur propre échelle 0..100 : la découpe
// (detect.py imbriqué, `PROGRESS:<pct>`) puis l'embedding (`STAGE:prog:i/n`). Les superposer sur la
// même échelle faisait consommer TOUTE la barre par la découpe (PROGRESS:98 → 95), après quoi le
// clamp monotone jetait chaque pas d'embedding : la barre restait figée à 95 pendant la partie la
// plus longue du travail. Chaque phase a donc sa sous-plage, et l'ensemble ne fait qu'avancer.
const INDEX_DETECT_LO = 5, INDEX_DETECT_HI = 35;
const INDEX_EMBED_LO = 40, INDEX_EMBED_HI = 95;
const spanPct = (lo, hi, f) => lo + Math.round((hi - lo) * Math.max(0, Math.min(1, f)));

function makeIndexRouter(event, kind) {
  let phase = '';
  let lastPct = -1;
  // Un daemon peut regrouper plusieurs marqueurs stderr dans un même chunk. Clamp par job pour que
  // la barre renderer ne recule jamais.
  const send = (pct) => {
    if (!event?.sender) return;
    if (pct != null) {
      const n = Math.max(0, Math.min(INDEX_EMBED_HI, Number(pct)));
      if (n < lastPct) return;
      lastPct = n;
    }
    event.sender.send('search:progress', { pct, phase, kind });
  };
  return (s) => {
    const ph = s.match(/PHASE:(\w+)/);
    if (ph) { phase = ph[1]; send(null); }   // changement de phase (pct inchangé)
    // detect.py émet AUSSI ses propres STAGE:load/STAGE:infer : hors phase de découpe seulement,
    // sinon le chargement du modèle de détection sauterait dans la plage d'embedding.
    const detecting = phase === 'detect';
    if (s.includes('STAGE:load')) send(detecting ? INDEX_DETECT_LO : 4);
    if (!detecting && s.includes('STAGE:infer')) send(INDEX_EMBED_LO - 2);
    const mp = s.match(/STAGE:prog:(\d+)\/(\d+)/);
    if (mp) {
      const f = parseInt(mp[1], 10) / Math.max(1, parseInt(mp[2], 10));
      send(detecting ? spanPct(INDEX_DETECT_LO, INDEX_DETECT_HI, f) : spanPct(INDEX_EMBED_LO, INDEX_EMBED_HI, f));
    }
    const dp = s.match(/PROGRESS:(\d+)/g);
    if (dp) {
      const f = parseInt(dp[dp.length - 1].slice(9), 10) / 100;
      send(detecting ? spanPct(INDEX_DETECT_LO, INDEX_DETECT_HI, f) : spanPct(INDEX_EMBED_LO, INDEX_EMBED_HI, f));
    }
  };
}

const dGpu = makeSearchDaemon({}, null, 180000);   // GPU : index + requêtes si libre (3 min sans sortie = hang → kill)
const dCpu = makeSearchDaemon({ NETSURUSH_SIGLIP_DEVICE: 'cpu' }, null);   // CPU : requêtes pendant une indexation
let indexActive = 0;   // nb d'indexations en cours → route les requêtes vers CPU tant que > 0

// --- Pool de daemons GPU pour l'indexation PARALLÈLE (opt-in) ---
// Chaque daemon = 1 SigLIP en VRAM (~0,6 Go mesuré). dGpu = entrée 0 (réutilisé, modèle chaud). Les
// daemons supplémentaires sont spawné à la demande quand plusieurs indexations arrivent en même temps.
// La concurrence est plafonnée CÔTÉ RENDERER via indexConcurrency() selon la VRAM libre → le pool ne
// dépasse jamais ce que la VRAM tient. Idle-kill 3 min → les daemons extra libèrent leur VRAM après.
const MAX_INDEX_DAEMONS = 6;
const idxPool = scheduler.makePool(() => makeSearchDaemon({}, null, 180000),
  { max: MAX_INDEX_DAEMONS, seed: dGpu });

// Nb d'indexations GPU tenables EN PARALLÈLE selon la VRAM libre (repli RAM sans GPU NVIDIA).
const SIGLIP_MB = 1200;      // coût d'un daemon supplémentaire (modèle ~0,6 Go + activations + marge)
function indexConcurrency() {
  return scheduler.concurrencyFor({ perJobMB: SIGLIP_MB, max: MAX_INDEX_DAEMONS });
}

// Indexation (index / face-index / char-label-index) : occupe un daemon du pool (spawn un nouveau si
// dispo, sinon attend) et route SA progression vers `event`, taguée `kind` → plusieurs indexations
// tournent vraiment en parallèle, chacune avec sa propre barre côté renderer.
// Annulation RÉELLE d'une indexation : les jobs en vol durent des minutes (un rush entier), attendre
// la fin du clip courant donnait un bouton « Arrêt… » qui semblait mort. On tue donc les daemons du
// pool : leurs requêtes en attente se résolvent en `indexation annulée` et les boucles renderer
// s'arrêtent immédiatement. Le prochain job relance un process neuf (modèle rechargé).
let indexAborting = false;
function abortIndex() {
  indexAborting = true;
  try { idxPool.killAll(); } catch (_) {}
  // Fenêtre courte : les 'exit' arrivent de façon asynchrone, on veut qu'ils soient étiquetés
  // « annulée » — au-delà, une vraie mort de daemon doit redevenir un diagnostic.
  setTimeout(() => { indexAborting = false; }, 2000);
  return { ok: true };
}

function searchIndex(event, cmd, payload, kind) {
  indexActive++;
  return idxPool.acquire()
    .then((e) => {
      e.d.setRoute(makeIndexRouter(event, kind || 'clip'));
      return e.d.req(cmd, payload).finally(() => { e.d.setRoute(null); idxPool.release(e); });
    })
    .finally(() => { indexActive = Math.max(0, indexActive - 1); });
}
// Requête : CPU si une indexation tourne en parallèle, sinon GPU (modèle chaud).
function queryReq(cmd, payload) { return (indexActive > 0 ? dCpu : dGpu).req(cmd, payload); }
// Commandes sans modèle (status/indexed/shots/face-status) : toujours le daemon CPU (juste SQLite).
function cpuReq(cmd, payload) { return dCpu.req(cmd, payload); }
function killSearch() { idxPool.killAll(); dCpu.kill(); }

// Une option de performance vit dans l'ENVIRONNEMENT du sidecar, or un daemon garde celui de son
// spawn : sans ce coup de balai, basculer un réglage ne changeait rien tant qu'un daemon restait
// chaud (3 min d'inactivité, ou indéfiniment pour le daemon d'entrée) — donc un réglage qui semble
// ignoré. On ne relance QUE les daemons libres : tuer un daemon occupé annulerait l'indexation en
// cours pour un réglage qui ne vaut que pour la suivante.
function refreshPerfEnv() {
  const recycle = (daemon) => {
    try { if (daemon.idle()) daemon.kill(); } catch (_) {}
  };
  for (const entry of [...idxPool.pool, ...detectPool.pool]) {
    if (entry.busy) continue;
    recycle(/** @type {any} */ (entry.d));
  }
  recycle(dCpu);
}
// Tue TOUS les daemons python persistants (recherche + détection + upscale…) — appelé à l'arrêt du
// core pour ne pas laisser de process orphelins qui occupent GPU/VRAM.
function killSidecars() {
  try { killSearch(); } catch (_) {}
  try { detectPool.killAll(); } catch (_) {}
  try { dUpscale.kill(); } catch (_) {}
  try { dProcess.kill(); } catch (_) {}
  try { dTranscribe.kill(); } catch (_) {}
}

// Worker persistant : un process python qui garde le modèle Real-ESRGAN chargé en VRAM entre les
// appels (test d'image instantané après le 1er, export multi-plans sans recharger le modèle).
// Commandes sérialisées (1 GPU) → la progression stderr correspond toujours à la requête en cours.
function makeUpscaleDaemon() {
  let proc = null, seq = 0, buf = '', chain = Promise.resolve(), curProg = null;
  const pending = new Map();
  function start() {
    if (proc) return;
    proc = spawn(PYTHON, [UPSCALE_SCRIPT, 'serve'], { env: langEnv() });
    const child = proc;
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg && msg.ok === false && msg.error) logbus.emit('python:upscale', 'error', String(msg.error));
        const resolve = pending.get(msg.id);
        if (resolve) { pending.delete(msg.id); resolve(msg); }
      }
    });
    proc.stderr.on('data', (d) => { const s = d.toString(); logbus.py('upscale', s); if (curProg) curProg(s); });
    const onDead = () => {
      if (proc !== child) return;
      proc = null; buf = '';
      for (const resolve of pending.values()) resolve({ ok: false, error: 'worker upscale interrompu' });
      pending.clear();
    };
    proc.on('exit', onDead);
    proc.on('error', onDead);
  }
  function send(payload, onProg, timeoutMs = 0) {
    start();
    if (!proc) return Promise.resolve({ ok: false, error: 'worker upscale injoignable' });
    const id = ++seq;
    curProg = onProg || null;
    return new Promise((resolve) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (!pending.delete(id)) return;
        const stuck = proc;
        proc = null;
        try { stuck?.kill(); } catch (_) {}
        resolve({ ok: false, error: `test d'upscale interrompu après ${Math.round(timeoutMs / 1000)} s` });
      }, timeoutMs) : null;
      pending.set(id, (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      });
      try { proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n'); }
      catch (e) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        resolve({ ok: false, error: String(e) });
      }
    }).finally(() => { if (curProg === onProg) curProg = null; });
  }
  return {
    req(payload, onProg, timeoutMs) {
      const p = chain.then(() => send(payload, onProg, timeoutMs));
      chain = p.catch(() => {});
      return p;
    },
    kill() { try { proc?.kill(); } catch (_) {} },
  };
}
const dUpscale = makeUpscaleDaemon();

// Worker persistant du hub de traitements (process.py serve) : garde les modèles RIFE / depth /
// rembg chauds entre les appels. Clone EXACT de makeUpscaleDaemon (jobs sérialisés via chain de
// Promise, 1 process, progression stderr correspondant toujours à la requête en cours).
function makeProcessDaemon() {
  let proc = null, seq = 0, buf = '', chain = Promise.resolve(), curProg = null;
  let idleTimer = null;
  const pending = new Map();
  const armIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    // Les modèles de détourage/profondeur peuvent occuper plusieurs Go de VRAM. On les garde
    // chauds pour les tests rapprochés, puis on libère le worker après une minute d'inactivité.
    idleTimer = setTimeout(() => {
      if (proc && pending.size === 0) { try { proc.kill(); } catch (_) {} }
    }, 60_000);
  };
  function start() {
    if (proc) return;
    proc = spawn(PYTHON, [PROCESS_SCRIPT, 'serve'], { env: procEnv() });
    const child = proc;
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        // Échec de job = renvoyé en RÉSULTAT JSON (stdout), pas en stderr → logbus.py ne le voit
        // jamais et l'erreur reste MUETTE dans le panneau Console (ex. « No module named 'rembg' »
        // n'apparaissait qu'en notice). On la pousse explicitement dans le journal.
        if (msg && msg.ok === false && msg.error) logbus.emit('python:process', 'error', String(msg.error));
        const resolve = pending.get(msg.id);
        if (resolve) { pending.delete(msg.id); resolve(msg); }
      }
    });
    proc.stderr.on('data', (d) => { const s = d.toString(); logbus.py('process', s); if (curProg) curProg(s); });
    const onDead = () => {
      if (proc !== child) return;
      proc = null; buf = '';
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      for (const resolve of pending.values()) resolve({ ok: false, error: 'worker traitements interrompu' });
      pending.clear();
    };
    proc.on('exit', onDead);
    proc.on('error', onDead);
  }
  function send(payload, onProg, timeoutMs = 0) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    start();
    if (!proc) return Promise.resolve({ ok: false, error: 'worker traitements injoignable' });
    const id = ++seq;
    curProg = onProg || null;
    return new Promise((resolve) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (!pending.delete(id)) return;
        const stuck = proc;
        proc = null;
        try { stuck?.kill(); } catch (_) {}
        resolve({ ok: false, error: `test du modèle interrompu après ${Math.round(timeoutMs / 1000)} s` });
      }, timeoutMs) : null;
      pending.set(id, (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      });
      try { proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n'); }
      catch (e) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        resolve({ ok: false, error: String(e) });
      }
    }).finally(() => { if (curProg === onProg) curProg = null; armIdle(); });
  }
  return {
    req(payload, onProg, timeoutMs) {
      const p = chain.then(() => send(payload, onProg, timeoutMs));
      chain = p.catch(() => {});
      return p;
    },
    kill() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      try { proc?.kill(); } catch (_) {}
    },
  };
}
const dProcess = makeProcessDaemon();

// Worker ASR persistant (transcribe.py serve) : garde le modèle Whisper/Parakeet chargé en VRAM
// entre les clips. Jobs sérialisés (1 GPU) → la progression stderr correspond toujours au job en
// cours. Même squelette que makeUpscaleDaemon (chain de Promise, pas de concurrence).
function makeTranscribeDaemon() {
  let proc = null, seq = 0, buf = '', chain = Promise.resolve(), curProg = null;
  let idleMs = 0, idleTimer = null; // 0 = jamais décharger (modèle gardé chaud en VRAM)
  const pending = new Map();
  // Déchargement auto : après `idleMs` sans job, on TUE le sidecar → libère la VRAM. Le prochain job
  // le relance (cold-start torch). Réarmé après chaque job ; désactivé si idleMs=0 ou job en cours.
  function armIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (!idleMs || !proc) return;
    idleTimer = setTimeout(() => {
      if (proc && pending.size === 0) { try { proc.kill(); } catch (_) {} }
    }, idleMs);
  }
  function start() {
    if (proc) return;
    proc = spawn(PYTHON, [TRANSCRIBE_SCRIPT, 'serve'], { env: langEnv() });
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        const resolve = pending.get(msg.id);
        if (resolve) { pending.delete(msg.id); resolve(msg.result); }
      }
    });
    proc.stderr.on('data', (d) => { const s = d.toString(); logbus.py('transcribe', s); if (curProg) curProg(s); });
    const onDead = () => {
      proc = null; buf = '';
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      for (const resolve of pending.values()) resolve({ ok: false, words: [], error: 'sidecar transcription interrompu' });
      pending.clear();
    };
    proc.on('exit', onDead);
    proc.on('error', onDead);
  }
  function send(payload, onProg) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } // job en cours → pas de déchargement
    start();
    if (!proc) return Promise.resolve({ ok: false, words: [], error: 'sidecar transcription injoignable' });
    const id = ++seq;
    curProg = onProg || null;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      try { proc.stdin.write(JSON.stringify({ id, cmd: 'transcribe', ...payload }) + '\n'); }
      catch (e) { pending.delete(id); resolve({ ok: false, words: [], error: String(e) }); }
    }).finally(() => { if (curProg === onProg) curProg = null; armIdle(); });
  }
  return {
    req(payload, onProg) {
      // Le job peut porter son propre délai de déchargement (réglage de dictée).
      if (payload && typeof payload.idleMs === 'number') idleMs = Math.max(0, payload.idleMs);
      const p = chain.then(() => send(payload, onProg));
      chain = p.catch(() => {});
      return p;
    },
    kill() { try { proc?.kill(); } catch (_) {} },
  };
}
const dTranscribe = makeTranscribeDaemon();

// Mappe les marqueurs stderr du sidecar (STAGE:load/infer/prog:i/n) en pourcentage 6..95 → SSE.
function voiceProgress(event, phase) {
  return (s) => {
    if (!event?.sender) return;
    const send = (pct) => event.sender.send('voice:progress', { phase, pct: Math.min(95, pct) });
    if (s.includes('STAGE:load')) send(6);
    if (s.includes('STAGE:infer')) send(18);
    const mp = s.match(/STAGE:prog:(\d+)\/(\d+)/);
    if (mp) send(18 + Math.round((parseInt(mp[1], 10) / Math.max(1, parseInt(mp[2], 10))) * 77));
  };
}

// Clé de nr.config.json portant le dossier provisionné à l'installation, par modèle ASR.
const ASR_SETUP_DIR = { 'whisper-turbo': 'whisperDir', 'parakeet-v3': 'parakeetDir' };

// Dossier local du modèle ASR demandé : copie gérée par Paramètres › Modèles en priorité, sinon le
// chemin provisionné à l'installation POUR CE modèle. Le daemon reste chaud et sert toutes les
// variantes → le chemin voyage par job (une variable d'environnement figée au spawn ferait charger
// le modèle de l'installation quelle que soit la variante choisie dans l'interface).
function asrModelDir(model) {
  const managed = modelDir(model);
  if (managed && hasFiles(managed)) return managed;
  const provisioned = ASR_SETUP_DIR[model] ? CONFIG[ASR_SETUP_DIR[model]] : null;
  return provisioned && hasFiles(provisioned) ? provisioned : null;
}

// Transcription d'un audio déjà extrait (WAV 16 kHz mono). `source` = vidéo d'origine (clé de cache).
// `verbatim` : Whisper amorcé pour transcrire les hésitations (clé de cache séparée côté python).
function transcribeAudio(event, { source, audio, model = 'whisper-turbo', lang = 'fr', idleMs, verbatim = false }) {
  return dTranscribe.req(
    { source, audio, model, lang, idleMs, verbatim, model_dir: asrModelDir(model) },
    voiceProgress(event, 'transcribe'),
  );
}

// Identification de langue d'un extrait audio (repli ML du sélecteur de piste — cf. core/audioLang.js).
// Réutilise le daemon Whisper (modèle déjà chaud) via l'op `langid`. `audio` = WAV court déjà extrait.
// Renvoie { ok, lang: code|null, prob }.
function detectTrackLang({ source = '', audio, model = 'whisper-turbo' }) {
  return dTranscribe.req({ cmd: 'langid', source, audio, model, model_dir: asrModelDir(model) });
}

// Un encodeur matériel peut devenir indisponible après la sonde (limite de sessions, pilote
// réinitialisé). On rejoue alors le job avec le codec CPU de la même famille, sans intervention.
async function adaptiveRequest(daemon, payload, onProgress, resolved) {
  let r = await daemon.req(payload, onProgress);
  if ((!r || !r.ok) && resolved.hardware) {
    console.warn(`[encode] ${resolved.codec} indisponible pendant le job, repli ${resolved.fallbackCodec}`);
    try { if (payload.out) await fsp.unlink(payload.out); } catch (_) {}
    r = await daemon.req({
      ...payload,
      codec: resolved.fallbackCodec,
      profile: resolved.fallbackProfile,
      video_args: resolved.fallbackVideoArgs || payload.video_args,
    }, onProgress);
  }
  return r;
}

// Upscale d'un clip : 1 job (rush entier ou plage in/out) ou N jobs (plans sélectionnés).
// Chaque job = 1 fichier de sortie. Progression par fichier via 'upscale:progress'.
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function runUpscale(event, opts) {
  const { input, model = 'light', scale = 4, denoise, tile = 0, tilePad = 10, prePad = 0,
    cleanupNoise = 0, cleanupEdges = 0,
    fp32 = false, quality = 20, preset = 'medium', bitDepth = 8, audio = 'copy', abr = 192, audioTrack = 0,
    outDir, segments, whole, importBack, baseName, outputName, savePath } = opts || {};
  if (!input) return { ok: false, error: 'aucune source' };
  if (!outDir) return { ok: false, error: 'aucun dossier de sortie' };
  const resolved = await resolveProcessEncoding(opts || {});
  const ext = resolved.ext || upscaleExt(resolved.codec);
  const customName = typeof outputName === 'string' && outputName.trim();
  const base = sanitizeName(customName || baseName || path.basename(input).replace(/\.[^.]+$/, ''));
  const jobs = (whole || !Array.isArray(segments) || !segments.length)
    ? [{ start: undefined, end: undefined, tag: '' }]
    : segments.map((s, i) => ({ start: s.in, end: s.out, tag: `_plan${i + 1}` }));
  const total = jobs.length;
  const outputs = [];
  let lastErr = null;
  for (let i = 0; i < total; i++) {
    const j = jobs[i];
    // `savePath` = destination EXACTE imposée par l'appelant (archivage d'une collection : le fichier
    // doit retomber sur le nom attendu du dossier de stockage). Un seul job, sinon les N sorties
    // s'écraseraient — le suffixe numéroté reprend la main.
    const out = (total === 1 && savePath)
      ? String(savePath)
      : path.join(outDir, `${base}${customName ? '' : `_upscaled_${scale}x`}${j.tag}.${ext}`);
    if (samePath(out, input)) { lastErr = 'le nom de sortie écraserait le fichier source'; continue; }
    const fileLabel = path.basename(out);
    const payload = {
      cmd: 'upscale', input, out, model: String(model), outscale: scale | 0, codec: resolved.codec,
      tile: tile | 0, tile_pad: tilePad | 0, pre_pad: prePad | 0,
      quality: quality | 0, preset: String(preset), bitdepth: bitDepth | 0, profile: resolved.profile,
      audio: resolved.audioMode || String(audio), abr: abr | 0, atrack: audioTrack | 0,
      video_args: resolved.videoArgs, audio_args: resolved.audioArgs, container: resolved.container,
      start: j.start != null ? j.start : null, end: j.end != null ? j.end : null,
      denoise: denoise != null ? denoise : null, fp32: !!fp32,
      cleanup_noise: cleanupNoise, cleanup_edges: cleanupEdges,
    };
    // Un job peut être rejoué (repli encodeur matériel → profil CPU). Le second passage
    // recommence à STAGE:load ; ne jamais faire reculer la barre déjà avancée du même fichier.
    let lastPct = -1;
    const send = (pct, phase) => {
      if (!event?.sender) return;
      const next = Math.max(lastPct, Math.max(0, Math.min(100, Number(pct) || 0)));
      lastPct = next;
      event.sender.send('upscale:progress', { file: fileLabel, pct: next, done: i, total, phase });
    };
    send(0, 'model');
    const onProgress = (s) => {
      const mp = s.match(/STAGE:prog:(\d+)\/(\d+)/);
      if (mp) send(Math.min(99, Math.round((parseInt(mp[1], 10) / parseInt(mp[2], 10)) * 100)), 'upscale');
      else if (s.includes('STAGE:infer')) send(2, 'upscale');
      else if (s.includes('STAGE:load')) send(1, 'model');
    };
    const r = await adaptiveRequest(dUpscale, payload, onProgress, resolved);
    if (r && r.ok && r.output) outputs.push(r.output);
    else lastErr = (r && r.error) || 'échec upscale';
  }
  let imported = 0;
  if (importBack && outputs.length) {
    try { const res = await importToMediaPool(outputs); imported = res && res.count ? res.count : 0; } catch (_) {}
  }
  return { ok: outputs.length > 0, outputs, imported, total, failed: total - outputs.length,
    error: outputs.length ? null : lastErr };
}

// Mappe les marqueurs stderr du sidecar process.py (STAGE:load/infer/prog:i/n) en pourcentage pour
// le canal SSE 'process:progress'. `phase` = nom du mode (interpolate/depth/removebg) — même logique
// que la progression d'upscale. `send(pct, phase)` est fourni par l'appelant.
function processProg(send, mode) {
  return (s) => {
    const mp = s.match(/STAGE:prog:(\d+)\/(\d+)/);
    if (mp) send(Math.min(99, Math.round((parseInt(mp[1], 10) / parseInt(mp[2], 10)) * 100)), mode);
    else if (s.includes('STAGE:infer')) send(2, mode);
    else if (s.includes('STAGE:load')) send(1, 'model');
  };
}

// Découpe les jobs d'un traitement : rush entier (1 job) OU N plans sélectionnés (in/out).
// Même règle que runUpscale (whole/segments absents → 1 job sur tout le clip).
function processJobs(opts) {
  const { segments, whole } = opts || {};
  return (whole || !Array.isArray(segments) || !segments.length)
    ? [{ start: undefined, end: undefined, tag: '' }]
    : segments.map((s, i) => ({ start: s.in, end: s.out, tag: `_plan${i + 1}` }));
}

// Interpolation de frames (RIFE) : 1 job (rush/plage) ou N jobs (plans). 1 fichier de sortie par job.
async function runInterpolate(event, opts) {
  const { input, model = 'rife-v4.6', factor = 2, targetFps, slowmo = false, dedup = false,
    quality = 20, preset = 'medium', bitDepth = 8, audio = 'copy', abr = 192, audioTrack = 0,
    outDir, importBack, baseName, outputName } = opts || {};
  if (!input) return { ok: false, error: 'aucune source' };
  if (!outDir) return { ok: false, error: 'aucun dossier de sortie' };
  const resolved = await resolveProcessEncoding(opts || {});
  const ext = resolved.ext || upscaleExt(resolved.codec);
  const customName = typeof outputName === 'string' && outputName.trim();
  const base = sanitizeName(customName || baseName || path.basename(input).replace(/\.[^.]+$/, ''));
  const jobs = processJobs(opts);
  const total = jobs.length;
  const outputs = [];
  let lastErr = null;
  for (let i = 0; i < total; i++) {
    const j = jobs[i];
    const out = path.join(outDir, `${base}${customName ? '' : `_interp_${factor | 0}x`}${j.tag}.${ext}`);
    if (samePath(out, input)) { lastErr = 'le nom de sortie écraserait le fichier source'; continue; }
    const fileLabel = path.basename(out);
    const payload = {
      cmd: 'interpolate', input, out, model: String(model), factor: factor | 0,
      target_fps: targetFps != null ? targetFps : null, slowmo: !!slowmo, dedup: !!dedup,
      codec: resolved.codec, quality: quality | 0, preset: String(preset), bitdepth: bitDepth | 0, profile: resolved.profile,
      audio: resolved.audioMode || String(audio), abr: abr | 0, atrack: audioTrack | 0,
      video_args: resolved.videoArgs, audio_args: resolved.audioArgs, container: resolved.container,
      start: j.start != null ? j.start : null, end: j.end != null ? j.end : null,
    };
    let lastPct = -1;
    const send = (pct, phase) => {
      if (!event?.sender) return;
      const next = Math.max(lastPct, Math.max(0, Math.min(100, Number(pct) || 0)));
      lastPct = next;
      event.sender.send('process:progress', { file: fileLabel, pct: next, done: i, total, phase });
    };
    send(0, 'model');
    const r = await adaptiveRequest(dProcess, payload, processProg(send, 'interpolate'), resolved);
    if (r && r.ok && r.output) outputs.push(r.output);
    else lastErr = (r && r.error) || 'échec interpolation';
  }
  let imported = 0;
  if (importBack && outputs.length) {
    try { const res = await importToMediaPool(outputs); imported = res && res.count ? res.count : 0; } catch (_) {}
  }
  return { ok: outputs.length > 0, outputs, imported, total, failed: total - outputs.length,
    error: outputs.length ? null : lastErr };
}

// Estimation de profondeur (Depth-Anything / DPT) : carte de profondeur 8/16-bit, colormap au choix.
async function runDepth(event, opts) {
  const { input, model = 'depth-anything-v2-small', bits = 8, colormap = 'gray', dedup = false,
    quality = 20, preset = 'medium', bitDepth = 8, audio = 'copy', abr = 192, audioTrack = 0,
    outDir, importBack, baseName, outputName } = opts || {};
  if (!input) return { ok: false, error: 'aucune source' };
  if (!outDir) return { ok: false, error: 'aucun dossier de sortie' };
  const resolved = await resolveProcessEncoding(opts || {});
  const ext = resolved.ext || upscaleExt(resolved.codec);
  const customName = typeof outputName === 'string' && outputName.trim();
  const base = sanitizeName(customName || baseName || path.basename(input).replace(/\.[^.]+$/, ''));
  const jobs = processJobs(opts);
  const total = jobs.length;
  const outputs = [];
  let lastErr = null;
  for (let i = 0; i < total; i++) {
    const j = jobs[i];
    const out = path.join(outDir, `${base}${customName ? '' : '_depth'}${j.tag}.${ext}`);
    if (samePath(out, input)) { lastErr = 'le nom de sortie écraserait le fichier source'; continue; }
    const fileLabel = path.basename(out);
    const payload = {
      cmd: 'depth', input, out, model: String(model), bits: bits | 0, colormap: String(colormap), dedup: !!dedup,
      codec: resolved.codec, quality: quality | 0, preset: String(preset), bitdepth: bitDepth | 0, profile: resolved.profile,
      audio: resolved.audioMode || String(audio), abr: abr | 0, atrack: audioTrack | 0,
      video_args: resolved.videoArgs, audio_args: resolved.audioArgs, container: resolved.container,
      start: j.start != null ? j.start : null, end: j.end != null ? j.end : null,
    };
    let lastPct = -1;
    const send = (pct, phase) => {
      if (!event?.sender) return;
      const next = Math.max(lastPct, Math.max(0, Math.min(100, Number(pct) || 0)));
      lastPct = next;
      event.sender.send('process:progress', { file: fileLabel, pct: next, done: i, total, phase });
    };
    send(0, 'model');
    const r = await adaptiveRequest(dProcess, payload, processProg(send, 'depth'), resolved);
    if (r && r.ok && r.output) outputs.push(r.output);
    else lastErr = (r && r.error) || 'échec depth';
  }
  let imported = 0;
  if (importBack && outputs.length) {
    try { const res = await importToMediaPool(outputs); imported = res && res.count ? res.count : 0; } catch (_) {}
  }
  return { ok: outputs.length > 0, outputs, imported, total, failed: total - outputs.length,
    error: outputs.length ? null : lastErr };
}

// Détourage (rembg) : sortie alpha. Format = ProRes 4444 (.mov), PNG-seq (dossier), ou WebM alpha.
// Pour png_seq, `out` est un DOSSIER par job (`${base}_alpha${tag}/frame_%06d.png`), créé au préalable ;
// l'import Media Pool pousse alors le dossier (séquence d'images).
async function runRemoveBg(event, opts) {
  const { input, model = 'isnet-anime', format = 'prores_4444', dedup = false,
    despeckle = 0, edgeSmoothing = 0, edgeOffset = 0, outDir, importBack, baseName, outputName } = opts || {};
  if (!input) return { ok: false, error: 'aucune source' };
  if (!outDir) return { ok: false, error: 'aucun dossier de sortie' };
  const encoding = format === 'png_seq' ? null : await resolveProcessEncoding(opts || {});
  const alphaFormat = format === 'png_seq' ? 'png_seq'
    : String(opts?.exportCodec || '').startsWith('vp9') ? 'webm_alpha' : 'prores_4444';
  const ext2 = encoding?.ext || (alphaFormat === 'prores_4444' ? 'mov' : alphaFormat === 'webm_alpha' ? 'webm' : 'png');
  const customName = typeof outputName === 'string' && outputName.trim();
  const base = sanitizeName(customName || baseName || path.basename(input).replace(/\.[^.]+$/, ''));
  const jobs = processJobs(opts);
  const total = jobs.length;
  const outputs = [];
  let lastErr = null;
  for (let i = 0; i < total; i++) {
    const j = jobs[i];
    let out, imported;
    if (alphaFormat === 'png_seq') {
      const dir = path.join(outDir, `${base}${customName ? '' : '_alpha'}${j.tag}`);
      try { await fsp.mkdir(dir, { recursive: true }); } catch (_) {}
      out = path.join(dir, 'frame_%06d.png');
      imported = dir; // l'import vise le dossier de la séquence
    } else {
      out = path.join(outDir, `${base}${customName ? '' : '_alpha'}${j.tag}.${ext2}`);
      imported = out;
    }
    if (samePath(out, input)) { lastErr = 'le nom de sortie écraserait le fichier source'; continue; }
    const fileLabel = path.basename(out);
    const payload = {
      cmd: 'removebg', input, out, model: String(model), format: String(alphaFormat), dedup: !!dedup,
      despeckle: despeckle | 0, edge_smoothing: edgeSmoothing | 0, edge_offset: edgeOffset | 0,
      audio: encoding?.audioMode || 'none', audio_args: encoding?.audioArgs || null,
      atrack: Number.isFinite(Number(opts?.audioTrack)) ? Number(opts.audioTrack) : -1,
      container: encoding?.container || ext2,
      start: j.start != null ? j.start : null, end: j.end != null ? j.end : null,
    };
    let lastPct = -1;
    const send = (pct, phase) => {
      if (!event?.sender) return;
      const next = Math.max(lastPct, Math.max(0, Math.min(100, Number(pct) || 0)));
      lastPct = next;
      event.sender.send('process:progress', { file: fileLabel, pct: next, done: i, total, phase });
    };
    send(0, 'model');
    const r = await dProcess.req(payload, processProg(send, 'removebg'));
    if (r && r.ok && r.output) outputs.push(imported);
    else lastErr = (r && r.error) || 'échec détourage';
  }
  let imported = 0;
  if (importBack && outputs.length) {
    try { const res = await importToMediaPool(outputs); imported = res && res.count ? res.count : 0; } catch (_) {}
  }
  return { ok: outputs.length > 0, outputs, imported, total, failed: total - outputs.length,
    error: outputs.length ? null : lastErr };
}

// Les PNG de test sont écrits par le daemon python, pas par Node → on ne peut les indexer qu'une fois
// la requête résolue (et seulement si elle a réussi). Ces frames sont en pleine résolution et n'étaient
// jamais purgées : les indexer les rend visibles et nettoyables depuis Paramètres › Stockage.
function recordTestFrames(res, source, files) {
  try {
    if (!res || res.ok === false) return res;
    for (const f of files) cacheIndex().record({ kind: 'upscaleTest', file: f, source });
  } catch (_) {}
  return res;
}

// Test d'un traitement sur UNE frame → 2 PNG (avant / après) dans un cache tmp, servis via /media.
// Comme runUpscaleFrame mais piloté par `mode` (interpolate/depth/removebg) côté daemon.
async function runProcessFrame(opts) {
  const { input, time = 0, mode = 'depth', model = '',
    despeckle = 0, edgeSmoothing = 0, edgeOffset = 0 } = opts || {};
  if (!input) return { ok: false, error: 'aucune source' };
  try { await fsp.mkdir(UPSCALE_TEST_DIR, { recursive: true }); } catch (_) {}
  const id = `${Date.now()}_${Math.round(time * 1000)}`;
  const orig = path.join(UPSCALE_TEST_DIR, `orig_${id}.png`);
  const out = path.join(UPSCALE_TEST_DIR, `proc_${id}.png`);
  const res = await dProcess.req(
    { cmd: 'frame', input, orig, out, time, mode: String(mode), model: String(model),
      despeckle: despeckle | 0, edge_smoothing: edgeSmoothing | 0, edge_offset: edgeOffset | 0 },
    null,
    120_000,
  );
  return recordTestFrames(res, input, [orig, out]);
}

// Test d'upscale sur UNE frame → 2 PNG (avant / après) dans un cache tmp, servis via HTTP local.
async function runUpscaleFrame(opts) {
  const { input, time = 0, model = 'light', scale = 2, denoise, tile = 0, tilePad = 10, prePad = 0,
    fp32 = false, cleanupNoise = 0, cleanupEdges = 0 } = opts || {};
  if (!input) return { ok: false, error: 'aucune source' };
  try { await fsp.mkdir(UPSCALE_TEST_DIR, { recursive: true }); } catch (_) {}
  const id = `${Date.now()}_${Math.round(time * 1000)}`;
  const orig = path.join(UPSCALE_TEST_DIR, `orig_${id}.png`);
  const out = path.join(UPSCALE_TEST_DIR, `up_${id}.png`);
  // Via le worker persistant → après le 1er test (modèle chargé), les suivants sont quasi instantanés.
  const res = await dUpscale.req({
    cmd: 'frame', input, orig, out, time, model: String(model), outscale: scale | 0,
    tile: tile | 0, tile_pad: tilePad | 0, pre_pad: prePad | 0,
    denoise: denoise != null ? denoise : null, fp32: !!fp32,
    cleanup_noise: cleanupNoise, cleanup_edges: cleanupEdges,
  }, null, 180_000);
  return recordTestFrames(res, input, [orig, out]);
}

// Upscale d'un FICHIER image vers `out` (board de référence). Retour { ok, output, width, height }.
async function runUpscaleImage(opts) {
  const { input, out, model = 'light', scale = 2, denoise, tile = 0, tilePad = 10, prePad = 0, fp32 = false } = opts || {};
  if (!input || !out) return { ok: false, error: 'paramètres image incomplets' };
  return dUpscale.req({
    cmd: 'image', input, out, model: String(model), outscale: scale | 0,
    tile: tile | 0, tile_pad: tilePad | 0, pre_pad: prePad | 0,
    denoise: denoise != null ? denoise : null, fp32: !!fp32,
  });
}

// Upscale d'un GIF ANIMÉ vers `out` (.gif) — préserve l'animation (toutes les frames + fps).
async function runUpscaleGif(opts) {
  const { input, out, model = 'light', scale = 2, denoise, tile = 0, tilePad = 10, prePad = 0, fp32 = false } = opts || {};
  if (!input || !out) return { ok: false, error: 'paramètres gif incomplets' };
  return dUpscale.req({
    cmd: 'gif', input, out, model: String(model), outscale: scale | 0,
    tile: tile | 0, tile_pad: tilePad | 0, pre_pad: prePad | 0,
    denoise: denoise != null ? denoise : null, fp32: !!fp32,
  });
}

module.exports = {
  detectScenes, getCachedScenes, detectConcurrency,
  searchIndex, abortIndex, queryReq, cpuReq, killSearch, killSidecars, indexConcurrency, refreshPerfEnv,
  runUpscale, runUpscaleFrame, runUpscaleImage, runUpscaleGif, recordTestFrames,
  runInterpolate, runDepth, runRemoveBg, runProcessFrame,
  transcribeAudio, detectTrackLang, runSilence, runFiller,
};
