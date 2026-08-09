// @ts-check
// Instantané machine joint AUTOMATIQUEMENT à un rapport de bug. Un bêta-testeur ne sait pas décrire
// sa configuration (« RTX 3060, 32 Go » ne dit ni le pilote, ni le backend IA réellement actif, ni
// l'encodeur choisi par ffmpeg) : ces trois-là expliquent la moitié des rapports. Tout est LU, rien
// n'est demandé. Aucune sonde ne charge de modèle et aucune ne peut bloquer l'envoi : les mesures
// lentes (ffmpeg, nvidia-smi, encodeurs) sont bornées et rendent `null` plutôt que d'attendre.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { detectHardware } = require('./hardware');
const { getCapabilities } = require('./export/capabilities');
const { gpuInfo } = require('./scheduler');
const {
  NR_HOME, CONFIG, PYTHON, ffBin, ML_BACKEND, ONNX_BACKEND, TRANSCRIBE_BACKEND,
} = require('./config');

// Aucune sonde ne doit retenir le formulaire : au-delà, on envoie ce qu'on a. Les valeurs manquantes
// se lisent « non sondé » côté rapport, ce qui reste plus utile qu'un envoi jamais parti.
const PROBE_TIMEOUT_MS = 6000;
const VERSION_TIMEOUT_MS = 4000;
const MB = 1024 * 1024;

/** Borne une promesse : rend `fallback` si elle n'a pas répondu à temps. @template T
 * @param {Promise<T>} promise @param {number} ms @param {T} fallback @returns {Promise<T>} */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** Première ligne de `<bin> -version` (identifie un ffmpeg système vs celui du setup).
 * @param {string} bin @returns {Promise<string|null>} */
function binVersion(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const line = String(stdout).split(/\r?\n/)[0].trim();
      resolve(line || null);
    });
  });
}

/**
 * Remplace le dossier personnel par `~`. Le formulaire promet que les noms d'utilisateur sont
 * masqués : les chemins de l'instantané (venv, NR_HOME) le trahissaient, alors qu'ils restent
 * parfaitement lisibles sous cette forme.
 * @param {unknown} value
 */
function maskHome(value) {
  const s = String(value == null ? '' : value);
  const home = os.homedir();
  if (!home || !s) return s;
  return s.split(home).join('~');
}

/** Windows 11 se présente en 10.0.x : le build est la seule façon de les distinguer. */
function osLabel() {
  if (process.platform !== 'win32') return `${os.type()} ${os.release()}`;
  const build = Number(os.release().split('.')[2]) || 0;
  return `Windows ${build >= 22000 ? '11' : '10'} (build ${build || '?'})`;
}

/** @returns {{ totalGB:number, freeGB:number }|null} */
function diskUsage(dir) {
  try {
    const st = /** @type {any} */ (fs).statfsSync(dir);
    const total = (st.blocks * st.bsize) / (1024 * MB);
    const free = (st.bavail * st.bsize) / (1024 * MB);
    return { totalGB: Math.round(total * 10) / 10, freeGB: Math.round(free * 10) / 10 };
  } catch (_) {
    return null; // statfsSync absent (Node ancien) ou chemin illisible
  }
}

/** Version de l'app : package.json du dépôt en dev, des ressources en bundle. */
function appVersion() {
  const roots = [process.env.NR_RESOURCE_DIR, path.join(__dirname, '..')].filter(Boolean);
  for (const root of roots) {
    try { return String(JSON.parse(fs.readFileSync(path.join(String(root), 'package.json'), 'utf8')).version || ''); }
    catch (_) { /* essai suivant */ }
  }
  return '';
}

/** Modules provisionnés par le setup (une IA absente explique à elle seule un « ça ne marche pas »). */
function setupSummary() {
  return {
    completedAt: CONFIG.setupCompletedAt || null,
    modules: Array.isArray(CONFIG.setupModules) ? CONFIG.setupModules : [],
    models: Array.isArray(CONFIG.setupModels) ? CONFIG.setupModels : [],
    pythonFound: !!CONFIG.python,
    ffmpegFound: !!CONFIG.ffmpeg,
  };
}

/** @returns {Promise<any>} Instantané complet ; les sondes lentes rendent `null` sans bloquer. */
async function collectBugContext() {
  const [hardware, capabilities, gpu, ffmpeg] = await Promise.all([
    withTimeout(detectHardware(), PROBE_TIMEOUT_MS, null),
    withTimeout(getCapabilities(), PROBE_TIMEOUT_MS, null),
    withTimeout(gpuInfo(), VERSION_TIMEOUT_MS, null),
    withTimeout(binVersion(ffBin('ffmpeg')), VERSION_TIMEOUT_MS, null),
  ]);
  const cpus = os.cpus();
  return {
    ok: true,
    collectedAt: Date.now(),
    app: { version: appVersion(), home: maskHome(NR_HOME), lang: CONFIG.lang || null },
    os: { label: osLabel(), platform: process.platform, arch: process.arch, release: os.release() },
    cpu: {
      name: (hardware && hardware.cpus && hardware.cpus[0]) || (cpus[0] && cpus[0].model) || 'inconnu',
      threads: cpus.length,
    },
    memory: { totalMB: Math.round(os.totalmem() / MB), freeMB: Math.round(os.freemem() / MB) },
    gpu: {
      devices: (hardware && hardware.gpus) || [],
      label: (hardware && hardware.label) || null,
      vram: gpu, // nvidia-smi : total + libre au moment du rapport (null hors NVIDIA)
    },
    runtime: {
      node: process.version,
      python: maskHome(PYTHON),
      backends: { ml: ML_BACKEND, onnx: ONNX_BACKEND, transcribe: TRANSCRIBE_BACKEND },
      ffmpeg,
    },
    encoding: capabilities ? {
      h264: capabilities.h264Encoder || null,
      h265: capabilities.h265Encoder || null,
      av1: capabilities.av1Encoder || null,
      hardware: capabilities.hwEncoders || [],
    } : null,
    storage: { home: maskHome(NR_HOME), disk: diskUsage(NR_HOME) },
    setup: setupSummary(),
  };
}

/** @param {any} value @param {string} fallback */
function orDash(value, fallback = 'non sondé') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

/** Rendu texte compact — sert l'embed Discord ET le rapport téléchargeable. @param {any} ctx */
function formatBugContext(ctx) {
  if (!ctx || !ctx.ok) return 'Contexte système indisponible.';
  const lines = [
    `App        : v${orDash(ctx.app?.version, '?')} · langue ${orDash(ctx.app?.lang, 'auto')}`,
    `OS         : ${orDash(ctx.os?.label)} (${orDash(ctx.os?.arch)})`,
    `CPU        : ${orDash(ctx.cpu?.name)} · ${orDash(ctx.cpu?.threads)} threads`,
    `RAM        : ${orDash(ctx.memory?.totalMB)} Mo total · ${orDash(ctx.memory?.freeMB)} Mo libres`,
    `GPU        : ${orDash(ctx.gpu?.label)}`,
  ];
  for (const d of ctx.gpu?.devices || []) {
    lines.push(`             ↳ ${d.name} · pilote ${orDash(d.driverVersion, '?')} · ${d.vendor}/${d.role}`);
  }
  if (ctx.gpu?.vram) lines.push(`VRAM       : ${ctx.gpu.vram.freeMB} Mo libres / ${ctx.gpu.vram.totalMB} Mo`);
  lines.push(
    `Backends   : torch ${orDash(ctx.runtime?.backends?.ml)} · onnx ${orDash(ctx.runtime?.backends?.onnx)} · asr ${orDash(ctx.runtime?.backends?.transcribe)}`,
    `Node       : ${orDash(ctx.runtime?.node)}`,
    `Python     : ${orDash(ctx.runtime?.python)}`,
    `ffmpeg     : ${orDash(ctx.runtime?.ffmpeg, 'introuvable')}`,
  );
  if (ctx.encoding) {
    lines.push(`Encodeurs  : h264 ${orDash(ctx.encoding.h264, 'aucun')} · h265 ${orDash(ctx.encoding.h265, 'aucun')} · av1 ${orDash(ctx.encoding.av1, 'aucun')}`);
  }
  const disk = ctx.storage?.disk;
  lines.push(`Stockage   : ${ctx.storage?.home}${disk ? ` · ${disk.freeGB} Go libres / ${disk.totalGB} Go` : ''}`);
  const setup = ctx.setup || {};
  lines.push(`Setup      : ${setup.completedAt ? new Date(setup.completedAt).toISOString().slice(0, 10) : 'jamais'} · python ${setup.pythonFound ? 'ok' : 'absent'} · ffmpeg ${setup.ffmpegFound ? 'ok' : 'absent'}`);
  if (setup.modules?.length) lines.push(`Modules    : ${setup.modules.join(', ')}`);
  return lines.join('\n');
}

module.exports = { collectBugContext, formatBugContext };
