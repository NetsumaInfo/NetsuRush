// @ts-check
// Daemon Roto Studio (segmentation interactive + suppression d'objet). SCAFFOLD, runtime non testé.
// Spawn persistant `python roto.py serve` (session tenue en mémoire côté python) + protocole JSON-lines
// sérialisé (1 job à la fois). Endpoints exposés au renderer via IPC roto:*. Progression → SSE roto:progress.
//
// Séparé du daemon process.py (nrproc) : la segmentation interactive tient une SESSION (embeddings +
// memory bank) entre les clics, alors que process.py est batch (1 job = 1 fichier). Cf. nrroto/.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { PYTHON, DETECT_ENV, ROTO_DIR, ML_BACKEND } = require('./config');
const { modelDir } = require('./models');
const { hasFiles: hasWeights } = require('./utils');
const logbus = require('./logbus');
const { t } = require('./i18n');

// Env du daemon roto : poids SAM + MatAnyone (refine) + LaMa/MiniMax (removal), pris dans
// NR_HOME/models via le manager. Le python retombe sur le cache HF si un chemin manque.
function samEnv() {
  const env = { ...DETECT_ENV };
  // Du meilleur masque au plus léger : on prend le premier réellement installé. EdgeTAM ferme la
  // marche — 56 Mo, il tourne là où SAM 2.1 ne tient pas, mais ses masques sont plus grossiers.
  for (const id of ['sam2.1-large', 'sam2.1', 'sam2.1-small', 'sam2.1-tiny', 'edgetam']) {
    const dir = modelDir(id);
    if (hasWeights(dir)) { env.NETSURUSH_SAM_DIR = dir; break; }
  }
  // SAM 3 a son propre dossier : son unique poids ne se charge pas avec le paquet sam2, et le
  // confondre avec un checkpoint SAM 2.1 ferait échouer la construction du modèle.
  const sam3 = modelDir('sam3.1'); if (hasWeights(sam3)) env.NETSURUSH_SAM3_DIR = sam3;
  const mat = modelDir('matanyone'); if (hasWeights(mat)) env.NETSURUSH_MATANYONE_DIR = mat;
  const mat2 = modelDir('matanyone2'); if (hasWeights(mat2)) env.NETSURUSH_MATANYONE2_DIR = mat2;
  const vmm = modelDir('videomama'); if (hasWeights(vmm)) env.NETSURUSH_VIDEOMAMA_DIR = vmm;
  // Suppression d'objet : MiniMax est le seul moteur câblé depuis le retrait de Big LaMa.
  const mmx = modelDir('minimax-remover'); if (hasWeights(mmx)) env.NETSURUSH_MINIMAX_DIR = mmx;
  // Frames + mattes + points restent disponibles pendant toute la session pour retoucher sans
  // réextraire, puis disparaissent intégralement à la fermeture de NetsuRush.
  env.NETSURUSH_ROTO_CACHE = ROTO_DIR;
  // Réduit la fragmentation VRAM (SAM chaud + Wan/MiniMax cohabitent sur une petite carte).
  if (ML_BACKEND === 'cuda' && !env.PYTORCH_CUDA_ALLOC_CONF) env.PYTORCH_CUDA_ALLOC_CONF = 'expandable_segments:True';
  return env;
}

const PY_DIR = process.env.NETSURUSH_PY_DIR || path.join(__dirname, '..', 'python');
const ROTO_SCRIPT = path.join(PY_DIR, 'roto.py');

// Daemon persistant (clone du pattern makeProcessDaemon : chaîne de promesses = 1 job GPU à la fois).
function makeRotoDaemon() {
  let proc = null;
  let seq = 0;
  let buf = '';
  let chain = Promise.resolve();
  let curProg = null;
  const pending = new Map();

  function start() {
    if (proc) return;
    proc = spawn(PYTHON, [ROTO_SCRIPT, 'serve'], { env: samEnv() });
    proc.stdout.on('data', (b) => {
      buf += b.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const p = pending.get(msg.id);
          if (p) { pending.delete(msg.id); p(msg); }
        } catch (_) { /* ligne non-JSON ignorée */ }
      }
    });
    proc.stderr.on('data', (b) => { const s = b.toString(); logbus.py('roto', s); if (curProg) curProg(s); });
    const onDead = () => { proc = null; for (const p of pending.values()) p({ ok: false, error: t('rotoInterrupted') }); pending.clear(); };
    proc.on('close', onDead); proc.on('error', onDead);
  }

  function send(payload, onProg) {
    start();
    const id = ++seq;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      // Garde le dernier handler de progression si la requête n'en fournit pas : l'extraction en
      // thread (open) continue d'émettre STAGE:* pendant que le renderer scrub (mask/addPoint).
      if (onProg) curProg = onProg;
      try { proc.stdin.write(JSON.stringify(Object.assign({ id }, payload)) + '\n'); }
      catch (_) { pending.delete(id); resolve({ ok: false, error: t('rotoUnavailable') }); }
    });
  }

  function req(payload, onProg) {
    const p = chain.then(() => send(payload, onProg));
    chain = p.catch(() => {});
    return p;
  }

  return { req, kill: () => { try { if (proc) proc.kill(); } catch (_) {} proc = null; } };
}

const dRoto = makeRotoDaemon();

// Relaie la progression stderr STAGE:* du daemon vers SSE roto:progress.
// `prog:cur/total[@frame]` → {pct, frame?} (frame = suivi live du slider pendant la propagation) ;
// `extractdone:N` → {extracted:N} (fin de l'extraction en thread : vrai nombre de frames) ;
// autres marqueurs (load/roi/refine/export/remove/dedupe/extractwait) → {stage} (phase affichée).
const STAGE_WORDS = /STAGE:(load|roi|refine|export|remove|dedupe|extractwait|extract)\b/;
function rotoProg(event) {
  return (s) => {
    if (!event || !event.sender) return;
    const m = s.match(/STAGE:prog:(\d+)\/(\d+)(?:@(\d+))?/);
    if (m) {
      const p = { pct: Math.min(99, Math.round((parseInt(m[1], 10) / parseInt(m[2], 10)) * 100)) };
      if (m[3] !== undefined) p.frame = parseInt(m[3], 10);
      event.sender.send('roto:progress', p);
    }
    const d = s.match(/STAGE:extractdone:(\d+)/);
    if (d) event.sender.send('roto:progress', { extracted: parseInt(d[1], 10) });
    const w = s.match(STAGE_WORDS);
    if (w && !m) event.sender.send('roto:progress', { stage: w[1] });
  };
}

// Résout le dossier de poids d'un modèle SAM demandé (sélecteur UI) → passé au python en `samDir`.
// Sans modèle demandé (ou non installé), le python retombe sur NETSURUSH_SAM_DIR / cache HF.
function samDirFor(model) {
  if (!model) return null;
  const dir = modelDir(model);
  return hasWeights(dir) ? dir : null;
}

// --- Endpoints (fins : délèguent au daemon) ---
let lastWork = null;   // dossier de travail de la session ouverte (cible du cancel.flag)

const rotoOpen = async (event, opts) => {
  const o = Object.assign({ cmd: 'open' }, opts);
  const dir = samDirFor(opts && opts.model);
  if (dir) o.samDir = dir;
  // L'id voyage en plus du dossier : SAM 3 et SAM 2 n'ont pas la même API, le python choisit son
  // moteur dessus. Un dossier de poids seul ne dit pas de quelle génération il est.
  if (opts && opts.model) o.samModel = opts.model;
  const r = await dRoto.req(o, rotoProg(event));
  if (r && r.ok && r.work) lastWork = r.work;
  return r;
};
const rotoAddPoint = (opts) => dRoto.req(Object.assign({ cmd: 'addPoint' }, opts));
const rotoClearPoints = (opts) => dRoto.req(Object.assign({ cmd: 'clearPoints' }, opts));
const rotoUndoPoint = () => dRoto.req({ cmd: 'undoPoint' });
const rotoPreviewPoint = (opts) => dRoto.req(Object.assign({ cmd: 'previewPoint' }, opts));
const rotoMask = (opts) => dRoto.req(Object.assign({ cmd: 'mask' }, opts));
const rotoSetPost = (opts) => dRoto.req(Object.assign({ cmd: 'setPost' }, opts));
const rotoSetView = (opts) => dRoto.req(Object.assign({ cmd: 'setView' }, opts));
const rotoSetObjects = (opts) => dRoto.req(Object.assign({ cmd: 'setObjects' }, opts));
const rotoRemovePoint = (opts) => dRoto.req(Object.assign({ cmd: 'removePoint' }, opts));
const rotoMovePoint = (opts) => dRoto.req(Object.assign({ cmd: 'movePoint' }, opts));
const rotoClearTracking = () => dRoto.req({ cmd: 'clearTracking' });
const rotoDedupe = (event, opts) => dRoto.req(Object.assign({ cmd: 'dedupe' }, opts || {}), rotoProg(event));
const rotoPropagate = (event, opts) => dRoto.req(Object.assign({ cmd: 'propagate' }, opts || {}), rotoProg(event));
const rotoRefine = (event, opts) => dRoto.req(Object.assign({ cmd: 'refine' }, opts), rotoProg(event));
// Bascule « utiliser le matte fin » : le calcul reste sur le disque, seule la source qui fait foi
// change — comparer avant/après ne doit rien relancer.
const rotoSetRefined = (opts) => dRoto.req(Object.assign({ cmd: 'setRefined' }, opts || {}));
const rotoExport = (event, opts) => dRoto.req(Object.assign({ cmd: 'export' }, opts), rotoProg(event));
const rotoObjectRemove = (event, opts) => dRoto.req(Object.assign({ cmd: 'objectRemove' }, opts), rotoProg(event));

// Annulation de la propagation en cours : le python teste <work>/cancel.flag à chaque frame.
// Écrit HORS de la file du daemon (le propagate occupe la chaîne) — c'est tout l'intérêt du flag.
const rotoCancel = () => {
  if (!lastWork) return { ok: false, error: t('noRotoSession') };
  try { fs.writeFileSync(path.join(lastWork, 'cancel.flag'), '1'); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
};

module.exports = {
  rotoOpen, rotoAddPoint, rotoClearPoints, rotoUndoPoint, rotoPreviewPoint, rotoMask, rotoSetPost,
  rotoSetView, rotoSetObjects, rotoRemovePoint, rotoMovePoint, rotoClearTracking, rotoDedupe,
  rotoPropagate, rotoRefine, rotoSetRefined, rotoExport, rotoObjectRemove, rotoCancel,
  killRoto: () => dRoto.kill(),
};
