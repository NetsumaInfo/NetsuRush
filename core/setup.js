// @ts-check
// core/setup.js
// Provisionnement du 1er lancement (app packagée). L'installeur NSIS ne pose QUE le code + node.exe +
// les scripts python ; le runtime adapté au poste, les packs des modules choisis et les éventuels
// modèles sélectionnés sont installés ici, à la demande, dans NR_HOME (écrivable).
//
//   setupStatus() → ce qui est déjà prêt (environnement / ffmpeg) sans rien installer.
//   runSetup(ev)  → lance scripts/setup.ps1 puis setup-models.js, diffuse la progression,
//                   écrit nr.config.json (chemins absolus) en fin de course.
// Après un setup réussi, l'app doit REDÉMARRER : config.js fige PYTHON/ffmpeg au require.

const path = require('path');
const { language, t } = require('./i18n');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { CONFIG, NR_HOME } = require('./config');
const { detectHardware } = require('./hardware');
const { MANIFEST } = require('./models');
const CONFIG_PATH = path.join(NR_HOME, 'nr.config.json');

// Dossier des ressources bundlées (renseigné par la coquille Tauri en release). En dev, le dépôt.
const RESOURCE_DIR = process.env.NR_RESOURCE_DIR || path.join(__dirname, '..');
// « Packagé » = lancé par la coquille Tauri release (NR_RESOURCE_DIR posé). En dev (node du PATH,
// venv local du développeur) on ne gate JAMAIS : le provisionnement ne concerne que l'app installée.
const PACKAGED = !!process.env.NR_RESOURCE_DIR;

// Versions ffmpeg qu'une installation packagée peut garder — MIROIR de $FfmpegAccepted dans
// scripts/setup.ps1 (version épinglée + repli zip), l'égalité des deux listes étant verrouillée par
// test/packaging.test.cjs. La première est la cible (le miroir NetsuRush), la seconde le repli
// légitime quand ce miroir est injoignable ; l'accepter ici évite qu'une installation valide
// redemande le setup en boucle.
const FFMPEG_ACCEPTED_VERSIONS = ['9.0', '8.1'];
// Bump when an update adds a mandatory runtime capability. Existing installs without this marker
// leave the quick path and run `probeRuntime`, which sends incomplete environments to repair.
const SETUP_RUNTIME_VERSION = 4;

const SETUP_LABELS = {
  fr: { video: 'Prérequis vidéo', ai: 'Prérequis de calcul' },
  en: { video: 'Video prerequisites', ai: 'Compute prerequisites' },
  es: { video: 'Requisitos de vídeo', ai: 'Requisitos de cálculo' },
  de: { video: 'Video-Voraussetzungen', ai: 'Rechen-Voraussetzungen' },
  ja: { video: '動画の前提環境', ai: '計算の前提環境' },
  zh: { video: '视频运行环境', ai: '计算运行环境' },
};

const SETUP_MODULES = new Set(['derush', 'script', 'notebook', 'search', 'upscale', 'reference', 'transfer', 'voice', 'chat', 'optimisation', 'presets', 'fusion']);

function sanitizeSetupOptions(options) {
  const input = options && typeof options === 'object' ? options : {};
  const modules = [...new Set(Array.isArray(input.modules) ? input.modules.map(String) : [])].filter((id) => SETUP_MODULES.has(id));
  if (!modules.includes('derush')) modules.unshift('derush');
  const models = [...new Set(Array.isArray(input.models) ? input.models.map(String) : [])].filter((id) => MANIFEST[id] && id !== 'transnetv2');
  // Extension CEP Premiere/After Effects : posée pendant l'installation quand l'utilisateur la coche
  // (elle active du même geste la mise à jour automatique, cf. core/adobePanel.js).
  return { modules, models, adobePanel: !!input.adobePanel };
}

function mlEngineName(backend) {
  if (backend === 'cuda') return 'NVIDIA CUDA';
  if (backend === 'rocm') return 'AMD ROCm';
  if (backend === 'xpu') return 'Intel XPU';
  return 'CPU';
}

function videoEngineName(vendor) {
  if (vendor === 'nvidia') return 'NVIDIA NVENC';
  if (vendor === 'amd') return 'AMD AMF';
  if (vendor === 'intel') return 'Intel Quick Sync';
  return 'CPU';
}

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (_) { return false; }
}
// Les builds publiés s'identifient « ffmpeg version 9.0-full_build… » (gyan) ou « …version n8.1-… »
// (BtbN) ; un build git rend « version N-125157-g… », qui n'appartient à aucune version stable et ne
// correspond donc à aucune version acceptée — c'est ce qui le désigne comme binaire à remplacer.
const FFMPEG_VERSION_RE = /ffmpeg version n?(\d+\.\d+(?:\.\d+)?)/;
// Un encodeur vidéo au moins doit répondre présent, sinon le binaire est là mais inexploitable.
const FFMPEG_ENCODER_RE = /\b(?:hevc_nvenc|h264_nvenc|h264_amf|h264_qsv|libx264)\b/;

/** Version annoncée par un binaire ffmpeg, ou `null` s'il ne répond pas.
 * @param {string} bin @returns {string|null} */
function ffmpegVersion(bin) {
  try {
    const result = spawnSync(bin, ['-hide_banner', '-version'], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
    if (result.status !== 0) return null;
    const m = FFMPEG_VERSION_RE.exec(String(result.stdout || ''));
    return m ? m[1] : null;
  } catch (_) { return null; }
}

/** Sonde complète d'un binaire ffmpeg en UN SEUL lancement : ffmpeg écrit sa liste d'encodeurs sur
 * stdout et son bandeau — qui porte la version — sur stderr. Les demander séparément (`-encoders`
 * puis `-version`) doublait le coût de la vérification, mesuré à 159 ms au lieu de 85 ms.
 * @param {string} bin @returns {{usable: boolean, version: string|null}} */
function ffmpegProbe(bin) {
  try {
    const result = spawnSync(bin, ['-encoders'], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
    if (result.status !== 0) return { usable: false, version: null };
    const m = FFMPEG_VERSION_RE.exec(String(result.stderr || ''));
    return { usable: FFMPEG_ENCODER_RE.test(String(result.stdout || '')), version: m ? m[1] : null };
  } catch (_) { return { usable: false, version: null }; }
}

/** La version installée fait-elle partie des versions acceptées ? Un correctif de la même mineure
 * (9.0.1 pour 9.0) est accepté : il ne change ni les options de ligne de commande ni les encodeurs.
 * @param {string|null|undefined} found @param {string[]} accepted @returns {boolean} */
function ffmpegVersionAccepted(found, accepted = FFMPEG_ACCEPTED_VERSIONS) {
  if (!found) return false;
  return accepted.some((v) => found === v || found.startsWith(`${v}.`));
}

/** Arbitre de version pour le CHEMIN RAPIDE. `ffmpegVersion` est écrit dans nr.config.json par
 * setup.ps1 : quand il est là, juger ne coûte qu'une comparaison de chaînes, donc le démarrage
 * nominal ne lance AUCUN processus. Une configuration écrite par un setup antérieur ne le porte pas
 * ; on interroge alors le binaire (`-version`, 75 ms) plutôt que de rendre `false`, ce qui ferait
 * retomber `setupStatus` sur `probeRuntime` — démarrage de Python et import de torch — à chaque fois.
 * @param {any} config @returns {boolean} */
function ffmpegVersionOk(config) {
  if (typeof config.ffmpegVersion === 'string' && config.ffmpegVersion) {
    return ffmpegVersionAccepted(config.ffmpegVersion);
  }
  return ffmpegVersionAccepted(ffmpegVersion(config.ffmpeg));
}

// ffmpeg prêt : binaire configuré (bundle) présent, utilisable, ET dans une version acceptée. En dev
// (non packagé), ffmpeg vient du PATH (prérequis dev documenté) → considéré prêt.
//
// La version est vérifiée parce qu'une installation antérieure a pu poser un build git-master ou une
// 7.1 : sans ce contrôle, `exists()` suffisait à la conserver pour toujours et aucun poste déjà
// installé ne recevrait jamais la version épinglée. Le repli étant dans la liste acceptée, un poste
// qui a dû s'y rabattre ne retombe pas en boucle sur l'écran d'installation. Ce chemin LENT
// interroge le binaire et ignore `config.ffmpegVersion` : un fichier de configuration peut mentir.
function ffmpegReady(config = CONFIG) {
  if (!PACKAGED) return true;
  if (!exists(config.ffmpeg)) return false;
  const { usable, version } = ffmpegProbe(config.ffmpeg);
  return usable && ffmpegVersionAccepted(version);
}
// venv ML prêt : interpréteur python du venv configuré et présent. En dev, venv/python local.
function venvReady() {
  if (!PACKAGED) return true;
  return exists(CONFIG.python);
}

// La présence de python.exe ne garantit pas que le moteur obligatoire est utilisable : un ancien
// venv peut avoir été interrompu après la création ou conserver un paquet pip incomplet. Cette sonde
// est volontairement exécutée à chaque setup:status afin qu'une installation déjà présente soit
// revalidée avant d'autoriser l'interface.
function readInstalledConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')); }
  catch (_) { return CONFIG; }
}

// Une configuration qui a déjà franchi le setup complet ne doit pas recharger torch et tous les
// modules Python à chaque démarrage (et un update de l'app ne doit pas ramener l'utilisateur sur la
// page de téléchargement). Ce contrôle volontairement superficiel ne sonde que les chemins écrits
// par setup.ps1/setup-models.js ; si l'un d'eux a disparu, on retombe sur la vérification complète
// et l'écran de réparation.
function quickSetupReady(config = CONFIG, options = {}) {
  if ((!PACKAGED && !options.ignorePackageGate) || !config || !config.setupCompletedAt) return false;
  if (Number(config.setupRuntimeVersion) !== SETUP_RUNTIME_VERSION) return false;
  if (!exists(config.python) || !exists(config.ffmpeg)) return false;
  if (config.ffprobe && !exists(config.ffprobe)) return false;
  // La VERSION de ffmpeg se juge ici, pas seulement dans `ffmpegReady`. `setupStatus` court-circuite
  // ce dernier dès que le contrôle rapide passe (`quickReady ? true : ffmpegReady(...)`) : tester la
  // version uniquement là-bas la rendait inatteignable sur une installation déjà complète, soit
  // exactement les postes qu'une montée de version doit rattraper.
  if (!ffmpegVersionOk(config)) return false;
  const selected = Array.isArray(config.setupModels) ? config.setupModels : [];
  if (selected.includes('omnishotcut') && !exists(config.omnishotCkpt)) return false;
  if (selected.some((id) => String(id).startsWith('siglip2-')) && !exists(config.siglipDir)) return false;
  return true;
}

function probeRuntime(config = CONFIG) {
  if (!PACKAGED) return true;
  if (!exists(config.python)) return { ok: false, transnet: false, torch: false, gpu: false, omnishotcut: false, siglip: false, online: false, error: 'python absent' };
  const selected = Array.isArray(config.setupModels) ? config.setupModels : [];
  const needsOmni = selected.includes('omnishotcut');
  const needsSiglip = selected.some((id) => id.startsWith('siglip2-'));
  const code = [
    'import json, os',
    'r={"transnet":False,"torch":False,"gpu":False,"omnishotcut":False,"online":False}',
    'import torch; r["torch"]=True',
    'from transnetv2_pytorch import TransNetV2; r["transnet"]=True',
    'import yt_dlp, gallery_dl, curl_cffi; r["online"]=True',
    needsOmni ? 'import omnishotcut, decord; r["omnishotcut"]=True' : 'r["omnishotcut"]=True',
    'b=os.environ.get("NETSURUSH_ML_BACKEND", "cpu")',
    'r["actual"]=("rocm" if torch.cuda.is_available() and getattr(torch.version,"hip",None) else ("cuda" if torch.cuda.is_available() else ("xpu" if hasattr(torch,"xpu") and torch.xpu.is_available() else "cpu")))',
    'r["gpu"]=(b=="cpu" or r["actual"]==b)',
    'print(json.dumps(r))',
  ].join('; ');
  try {
    const result = spawnSync(
      config.python,
      ['-c', code],
      { windowsHide: true, timeout: 30000, encoding: 'utf8', env: { ...process.env, NETSURUSH_ML_BACKEND: config.mlBackend || 'cpu' } },
    );
    const parsed = result.status === 0 ? JSON.parse(String(result.stdout || '').trim()) : {};
    const siglip = !needsSiglip || exists(config.siglipDir);
    const omniWeight = !needsOmni || exists(config.omnishotCkpt);
    return { ...parsed, siglip, omnishotcut: !!parsed.omnishotcut && omniWeight, ok: !!parsed.transnet && !!parsed.torch && !!parsed.gpu && !!parsed.omnishotcut && !!parsed.online && siglip, error: result.status === 0 ? null : String(result.stderr || '').trim() };
  } catch (_) {
    return { ok: false, transnet: false, torch: false, gpu: false, omnishotcut: false, siglip: false, online: false, error: String(_) };
  }
}

// État du provisionnement (aucune installation déclenchée).
async function setupStatus() {
  const installed = readInstalledConfig();
  const quickReady = quickSetupReady(installed);
  const venv = PACKAGED ? exists(installed.python) : venvReady();
  // Le chemin nominal est uniquement une vérification de fichiers. probeRuntime lance Python et
  // importe torch/les modèles : réservé au premier lancement ou à une réparation nécessaire.
  const runtime = quickReady ? { ok: true, transnet: true, torch: true, gpu: true, omnishotcut: true, siglip: true, online: true, actual: installed.mlBackend || 'cpu' } : probeRuntime(installed);
  const transnet = runtime === true || !!runtime.transnet;
  const ffmpeg = quickReady ? true : ffmpegReady(installed);
  const weights = exists(installed.omnishotCkpt) || exists(path.join(NR_HOME, 'models'));
  const hardware = await detectHardware();
  const mlBackend = installed.mlBackend || hardware.initialMlBackend;
  const onnxBackend = installed.onnxBackend || hardware.initialOnnxBackend;
  const labels = SETUP_LABELS[language()] || SETUP_LABELS.fr;
  const installedModules = Array.isArray(installed.setupModules)
    ? sanitizeSetupOptions({ modules: installed.setupModules, models: [] }).modules
    : [...SETUP_MODULES];
  const installedModels = Array.isArray(installed.setupModels) ? installed.setupModels : [];
  const modelsReady = runtime === true || (!!runtime.omnishotcut && !!runtime.siglip);
  const gpuReady = runtime === true || !!runtime.gpu;
  const onlineReady = runtime === true || !!runtime.online;
  return {
    // « prêt » = de quoi faire tourner les fonctions cœur. TransNetV2 est dans le socle pip ; tous
    // les autres modèles sont optionnels et gérés séparément.
    ready: venv && transnet && ffmpeg && modelsReady && gpuReady && onlineReady,
    venv, transnet, ffmpeg, weights,
    hardware,
    mlBackend,
    onnxBackend,
    installedModules,
    installedModels,
    runtime,
    home: NR_HOME,
    items: [
      { id: 'venv', label: `${labels.ai} · ${mlEngineName(mlBackend)}`, done: venv },
      { id: 'transnet', label: `${labels.ai} · TransNetV2`, done: transnet },
      { id: 'gpu', label: `${labels.ai} · ${mlEngineName(mlBackend)}`, done: gpuReady },
      ...(installedModels.includes('omnishotcut') ? [{ id: 'omnishotcut', label: `${labels.ai} · OmniShotCut`, done: runtime === true || !!runtime.omnishotcut }] : []),
      ...(installedModels.some((id) => id.startsWith('siglip2-')) ? [{ id: 'siglip', label: `${labels.ai} · SigLIP 2`, done: runtime === true || !!runtime.siglip }] : []),
      { id: 'ffmpeg', label: `${labels.video} · ${videoEngineName(hardware.primaryVendor)}`, done: ffmpeg },
      { id: 'online', label: 'NetsuBoard · yt-dlp', done: onlineReady },
    ],
  };
}

// Localise setup.ps1 : ressources bundlées (release) puis dépôt (dev).
function setupScript() {
  for (const p of [
    path.join(RESOURCE_DIR, 'scripts', 'setup.ps1'),
    path.join(__dirname, '..', 'scripts', 'setup.ps1'),
  ]) if (exists(p)) return p;
  return null;
}

// Pose l'extension CEP Premiere/After Effects choisie à l'écran d'installation. L'installation
// mémorise l'empreinte du panneau : les versions suivantes de NetsuRush le remettront à jour seules.
function installAdobePanel(send) {
  send({ stage: 'adobePanel', label: t('setupAdobePanel') });
  const result = require('./adobePanel').installPanel();
  if (!result.ok) send({ stage: 'error', label: `${t('setupAdobePanelFailed')} : ${result.error || ''}`.trim() });
  return { ok: result.ok, dir: result.dir || null, version: result.version || null, error: result.error || null };
}

// Le core POSE le panneau tout seul au démarrage quand une app Adobe est présente. Décocher la case
// à l'installation doit donc COUPER cet automatisme, sinon le panneau reviendrait au lancement
// suivant et le choix n'aurait servi à rien. Un poste SANS Adobe n'exprime aucun refus : la case y
// est absente, couper l'automatisme priverait l'utilisateur du panneau s'il installe Premiere plus
// tard.
function declineAdobePanel() {
  const { findAdobeExe } = require('./adobe');
  if (!['ppro', 'aeft'].some((app) => !!findAdobeExe(app, CONFIG))) return;
  require('./adobePanel').setPanelAutoUpdate(false);
}

let running = false;

// Lance le provisionnement. ev = shim Electron (ev.sender.send) → SSE. Idempotent : setup.ps1 saute
// les étapes déjà faites. Résout { ok, error?, needsRestart? }.
async function runSetup(ev, options = {}) {
  if (running) return Promise.resolve({ ok: false, error: t('setupRunning') });
  const script = setupScript();
  if (!script) return Promise.resolve({ ok: false, error: t('setupMissing') });
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: t('setupWindows') });

  running = true;
  const selection = sanitizeSetupOptions(options);
  // Seule mesure RÉELLE du matériel : elle conditionne le moteur installé, et c'est le seul moment
  // où l'utilisateur accepte d'attendre. Les démarrages suivants relisent le profil enregistré.
  const hardware = await detectHardware({ force: true });
  const send = (payload) => { try { ev?.sender?.send('setup:progress', payload); } catch (_) {} };
  send({ pct: 0, stage: 'start', label: t('setupStart') });

  return new Promise((resolve) => {
    // Paths travel through env vars because Windows argument quoting broke some locations. Reading
    // the script explicitly as UTF-8 also keeps Windows PowerShell 5.1 from treating CJK as ANSI.
    const env = {
      ...process.env,
      NR_SETUP_HOME: NR_HOME,
      NR_SETUP_RESOURCE: RESOURCE_DIR,
      NR_SETUP_LANG: language(),
      NR_SETUP_SCRIPT: script,
      NR_SETUP_HARDWARE: JSON.stringify(hardware),
      NR_SETUP_MODULES: JSON.stringify(selection.modules),
      NR_SETUP_MODELS: JSON.stringify(selection.models),
    };
    // `-File`, never `-Command` with a scriptblock built from a file read at runtime. The former
    // shape — Bypass + [scriptblock]::Create(ReadAllText(...)) + a hidden window — is what fileless
    // loaders do, AMSI scans the constructed block, and Defender's classifiers score the whole
    // process tree accordingly: an unsigned app.exe spawning node.exe spawning that is how
    // Trojan:Script/Wacatac.B!ml gets earned. `-File` reads the script the ordinary way.
    // The UTF-8 the scriptblock used to force now comes from the script's BOM, which is what
    // Windows PowerShell 5.1 reads; scripts/build.ps1 rewrites the staged copy with one too.
    // `Bypass` stays until setup.ps1 is Authenticode-signed — see docs/code-signing.md.
    const ps = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    ], { windowsHide: true, env });

    let errTail = '';
    const onLine = (raw) => {
      const line = raw.trim();
      if (!line) return;
      // Marqueurs émis par setup.ps1 : STAGE:<id>|<label>  ·  PROGRESS:<0-100>  ·  ERROR:<msg>
      //   ·  DL:<état>|<octets reçus>|<octets attendus>|<nom>
      const mStage = line.match(/^STAGE:([^|]+)\|?(.*)$/);
      const mProg = line.match(/^PROGRESS:(\d+)/);
      const mErr = line.match(/^ERROR:(.*)$/);
      const mDl = line.match(/^DL:([a-z]+)\|(\d+)\|(\d+)\|(.*)$/);
      // Suivi par élément = état vivant, pas une ligne de journal de plus.
      if (mDl) { send({ dl: { state: mDl[1], done: Number(mDl[2]), total: Number(mDl[3]), name: mDl[4].trim() } }); return; }
      if (mErr) { errTail = mErr[1].trim(); send({ stage: 'error', label: errTail }); return; }
      if (mStage) { send({ stage: mStage[1].trim(), label: (mStage[2] || '').trim() }); return; }
      if (mProg) { send({ pct: Math.round(Math.min(100, parseInt(mProg[1], 10)) * 0.78) }); return; }
      send({ line });
    };
    let buf = '';
    const pump = (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    };
    ps.stdout.on('data', pump);
    ps.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-1000); pump(d); });

    ps.on('error', (e) => { running = false; resolve({ ok: false, error: String(e) }); });
    ps.on('close', (code) => {
      if (buf.trim()) onLine(buf);
      if (code !== 0) {
        running = false;
        const prefix = { fr:'setup.ps1 a échoué', en:'setup.ps1 failed', es:'setup.ps1 falló', de:'setup.ps1 ist fehlgeschlagen', ja:'setup.ps1 に失敗しました', zh:'setup.ps1 失败' }[language()];
        resolve({ ok: false, error: errTail || `${prefix} (code ${code})` });
        return;
      }

      const worker = spawn(process.execPath, [path.join(__dirname, 'setup-models.js')], { windowsHide: true, env });
      let workerTail = '';
      let workerBuffer = '';
      const pumpWorker = (chunk) => {
        workerBuffer += chunk.toString();
        let nl;
        while ((nl = workerBuffer.indexOf('\n')) >= 0) {
          const line = workerBuffer.slice(0, nl).trim();
          workerBuffer = workerBuffer.slice(nl + 1);
          if (!line.startsWith('SETUPMODEL:')) { if (line) send({ line }); continue; }
          try {
            const progress = JSON.parse(line.slice('SETUPMODEL:'.length));
            if (progress.stage === 'error') workerTail = progress.error || workerTail;
            const count = Math.max(1, Number(progress.count) || selection.models.length || 1);
            const index = Math.max(0, Number(progress.index) || 0);
            const modelPct = typeof progress.pct === 'number' ? progress.pct : 0;
            const pct = progress.stage === 'done' && !progress.id
              ? 100
              : Math.min(99, 78 + Math.round(((index + modelPct / 100) / count) * 21));
            // Les modèles rapportent déjà leurs octets : on les relaie sous la forme de setup.ps1.
            if (progress.id) {
              const state = progress.stage === 'error' ? 'error'
                : progress.stage === 'done' ? 'done'
                  : progress.stage === 'canceled' ? 'skip'
                    : progress.stage === 'download' ? 'download' : 'work';
              send({ dl: { state, done: Number(progress.done) || 0, total: Number(progress.total) || 0, name: progress.id } });
            }
            send({ pct, stage: 'models', label: progress.id || t('setupDone') });
          } catch { send({ line }); }
        }
      };
      worker.stdout.on('data', pumpWorker);
      worker.stderr.on('data', (chunk) => { workerTail = (workerTail + chunk.toString()).slice(-1000); pumpWorker(chunk); });
      worker.on('error', (error) => {
        running = false;
        resolve({ ok: false, error: String(error) });
      });
      worker.on('close', (workerCode) => {
        running = false;
        if (workerBuffer.trim()) pumpWorker('\n');
        if (workerCode === 0) {
          send({ pct: 99, stage: 'verify', label: 'Vérification de l’installation…' });
          const fresh = readInstalledConfig();
          const verified = probeRuntime(fresh);
          if (!ffmpegReady(fresh) || verified !== true && !verified.ok) {
            resolve({ ok: false, error: verified !== true && verified.error ? verified.error : 'La vérification finale du runtime a échoué' });
            return;
          }
          // Extension Adobe : optionnelle et sans impact sur le runtime → un échec est signalé mais
          // ne fait jamais échouer l'installation (l'onglet Adobe permet de réessayer).
          if (!selection.adobePanel) declineAdobePanel();
          const adobePanel = selection.adobePanel ? installAdobePanel(send) : null;
          send({ pct: 100, stage: 'done', label: t('setupDone') });
          resolve({ ok: true, needsRestart: true, verified: true, ...(adobePanel ? { adobePanel } : {}) });
        } else {
          resolve({ ok: false, error: workerTail || `model setup failed (code ${workerCode})` });
        }
      });
    });
  });
}

module.exports = {
  mlEngineName, videoEngineName, sanitizeSetupOptions, quickSetupReady, probeRuntime, setupStatus, runSetup,
  // Exportés pour les tests : `test/packaging.test.cjs` vérifie que cette liste ne diverge pas de
  // $FfmpegAccepted dans scripts/setup.ps1, `test/setup-selection.test.cjs` exerce la comparaison.
  SETUP_RUNTIME_VERSION, FFMPEG_ACCEPTED_VERSIONS, ffmpegVersionAccepted,
};
