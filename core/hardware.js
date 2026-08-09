// @ts-check
// Inventaire matériel Windows partagé par le setup et les diagnostics runtime. Le nom du GPU seul
// n'est pas toujours fiable (pilotes génériques, iGPU renommé) : le Vendor ID PCI reste prioritaire.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NR_HOME } = require('./config');

/** @typedef {'nvidia'|'amd'|'intel'|'other'} GpuVendor */
/**
 * @typedef {object} GpuDevice
 * @property {string} name
 * @property {GpuVendor} vendor
 * @property {string|null} driverVersion
 * @property {string|null} pnpDeviceId
 * @property {'igpu'|'dgpu'|'unknown'} role
 */
/**
 * @typedef {object} HardwareProfile
 * @property {GpuDevice[]} gpus
 * @property {string[]} cpus
 * @property {GpuVendor[]} vendors
 * @property {GpuVendor|'cpu'} primaryVendor
 * @property {'cuda'|'rocm'|'xpu'|'cpu'} initialMlBackend
 * @property {'cuda'|'directml'|'cpu'} initialOnnxBackend
 * @property {number} windowsBuild
 * @property {string} label
 */

/**
 * @param {unknown} name
 * @param {unknown} pnpDeviceId
 * @returns {GpuVendor}
 */
function classifyGpu(name, pnpDeviceId) {
  const pci = String(pnpDeviceId || '').toUpperCase();
  if (pci.includes('VEN_10DE')) return 'nvidia';
  if (pci.includes('VEN_1002') || pci.includes('VEN_1022')) return 'amd';
  if (pci.includes('VEN_8086')) return 'intel';

  const n = String(name || '').toLowerCase();
  if (/nvidia|geforce|quadro|tesla/.test(n)) return 'nvidia';
  if (/\bamd\b|radeon|advanced micro devices/.test(n)) return 'amd';
  if (/\bintel\b|iris|\barc\b|uhd graphics|hd graphics/.test(n)) return 'intel';
  return 'other';
}

/** @param {string} name @returns {'igpu'|'dgpu'|'unknown'} */
function gpuRole(name) {
  if (/(integrated|apu|vega graphics|radeon\s+graphics$|uhd graphics|iris xe|iris\(r\)|arc integrated)/i.test(name)) return 'igpu';
  if (/(geforce|quadro|tesla|rtx|gtx|radeon rx|radeon pro|arc a\d|arc pro)/i.test(name)) return 'dgpu';
  return 'unknown';
}

/** @param {unknown} raw @returns {GpuDevice[]} */
function normalizeGpuInventory(raw) {
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return rows
    .map((row) => {
      const r = /** @type {Record<string, unknown>} */ (row);
      const name = String(r.Name || r.name || '').trim();
      const pnp = String(r.PNPDeviceID || r.pnpDeviceId || '').trim() || null;
      const driver = String(r.DriverVersion || r.driverVersion || '').trim() || null;
      return name ? { name, vendor: classifyGpu(name, pnp), driverVersion: driver, pnpDeviceId: pnp, role: gpuRole(name) } : null;
    })
    .filter((gpu) => gpu != null);
}

// Liste conservatrice publiée par AMD pour ROCm 7.2.1 / PyTorch 2.9.1 sous Windows. Un nom non
// listé utilise DirectML pour ONNX et CPU pour PyTorch : jamais de roue ROCm installée au hasard.
const ROCM_WINDOWS_GPU_PATTERNS = [
  /Radeon RX 9070(?: XT)?$/i,
  /Radeon AI PRO R9700$/i,
  /Radeon RX 9060 XT$/i,
  /Radeon RX 7900 XTX$/i,
  /Radeon PRO W7900(?: Dual Slot)?$/i,
  /Radeon RX 7700$/i,
  /Ryzen AI Max\+? (?:PRO )?395(?: w\/ Radeon 8060S(?: Graphics)?)?$/i,
  /Ryzen AI Max (?:PRO )?390(?: w\/ Radeon 8050S(?: Graphics)?)?$/i,
  /Ryzen AI Max (?:PRO )?385(?: w\/ Radeon 8050S(?: Graphics)?)?$/i,
  /Ryzen AI 9 (?:HX )?(?:PRO )?(?:375|370|365|475|470|465)(?: w\/ Radeon \w+(?: Graphics)?)?$/i,
];

/** @param {string} name */
function supportsRocmWindows(name) {
  return ROCM_WINDOWS_GPU_PATTERNS.some((pattern) => pattern.test(name));
}

/** @param {string} name */
function supportsIntelXpuWindows(name) {
  return /\bIntel\b.*\bArc\b|\bArc\b.*\bGraphics\b/i.test(name);
}

/** @param {GpuDevice[]} gpus @param {{ windowsBuild?: number, cpuNames?: string[] }} [opts] @returns {HardwareProfile} */
function buildHardwareProfile(gpus, opts = {}) {
  /** @type {GpuVendor[]} */
  const vendors = [];
  const vendorSet = new Set();
  for (const gpu of gpus) if (!vendorSet.has(gpu.vendor)) { vendorSet.add(gpu.vendor); vendors.push(gpu.vendor); }
  /** @type {GpuVendor|'cpu'} */
  const primaryVendor = vendors.includes('nvidia') ? 'nvidia'
    : vendors.includes('amd') ? 'amd'
      : vendors.includes('intel') ? 'intel'
        : vendors[0] || 'cpu';
  const windowsBuild = Number(opts.windowsBuild) || 0;
  const cpus = Array.isArray(opts.cpuNames) ? opts.cpuNames.filter(Boolean) : [];
  const windows11 = windowsBuild >= 22000;
  const rocm = windows11 && (
    gpus.some((gpu) => gpu.vendor === 'amd' && supportsRocmWindows(gpu.name))
    || cpus.some(supportsRocmWindows)
  );
  const xpu = windows11 && gpus.some((gpu) => gpu.vendor === 'intel' && supportsIntelXpuWindows(gpu.name));
  /** @type {'cuda'|'rocm'|'xpu'|'cpu'} */
  const initialMlBackend = vendors.includes('nvidia') ? 'cuda' : rocm ? 'rocm' : xpu ? 'xpu' : 'cpu';
  /** @type {'cuda'|'directml'|'cpu'} */
  const initialOnnxBackend = vendors.includes('nvidia') ? 'cuda'
    : windowsBuild >= 18362 && gpus.length ? 'directml'
      : 'cpu';
  const label = gpus.length ? gpus.map((gpu) => gpu.name).join(' + ') : 'CPU';
  return { gpus, cpus, vendors, primaryVendor, initialMlBackend, initialOnnxBackend, windowsBuild, label };
}

/** @param {string} command @returns {Promise<string>} */
function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (chunk) => { out += chunk.toString(); });
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code !== 0) reject(new Error(`PowerShell exited with code ${code}`));
      else resolve(out.trim());
    });
  });
}

/** @returns {Promise<unknown>} */
async function queryWindowsGpus() {
  if (process.platform !== 'win32') return [];
  const command = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$items=@(Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID,DriverVersion)",
    'ConvertTo-Json -Compress -Depth 3 -InputObject $items',
  ].join('; ');
  try {
    const raw = await runPowerShell(command);
    return JSON.parse(raw.replace(/^\uFEFF/, '') || '[]');
  } catch (_) {
    return [];
  }
}

/** @returns {Promise<string[]>} */
async function queryWindowsCpuNames() {
  if (process.platform !== 'win32') return [];
  try {
    const raw = await runPowerShell(
      'Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress',
    );
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '') || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((name) => {
      const value = String(name || '').trim();
      return value ? [value] : [];
    });
  } catch (_) {
    return [];
  }
}

/** @type {Promise<HardwareProfile>|null} */
let cached = null;

// L'inventaire coûte deux démarrages de PowerShell (~12 s sur une machine chargée) : le garder en
// mémoire ne servait qu'à la session en cours, si bien que CHAQUE ouverture de l'application
// repayait l'analyse avant d'afficher quoi que ce soit. Le matériel d'un PC ne bouge pratiquement
// jamais → le profil est écrit sur disque et relu au démarrage suivant. `force` (diagnostic de
// compatibilité, installation) refait la mesure et réécrit le fichier.
const PROFILE_PATH = path.join(NR_HOME, 'hardware.json');
// À incrémenter quand la forme du profil change : un fichier d'une version antérieure serait relu
// tel quel et priverait l'application des champs ajoutés depuis.
const PROFILE_VERSION = 1;

/** @returns {HardwareProfile|null} */
function readProfile() {
  try {
    const saved = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
    if (saved.version !== PROFILE_VERSION || !saved.profile?.gpus) return null;
    // Une mise à jour de Windows change le build : la sonde en dépend, on la refait.
    if (saved.profile.windowsBuild !== currentWindowsBuild()) return null;
    return saved.profile;
  } catch (_) {
    return null; // absent, illisible, ou écrit par une version antérieure
  }
}

function writeProfile(profile) {
  try {
    fs.mkdirSync(NR_HOME, { recursive: true });
    fs.writeFileSync(PROFILE_PATH, JSON.stringify({ version: PROFILE_VERSION, profile }));
  } catch (error) {
    console.warn('matériel : profil non enregistré, il sera re-mesuré au prochain démarrage', String(error));
  }
}

function currentWindowsBuild() {
  return process.platform === 'win32' ? Number(os.release().split('.')[2]) || 0 : 0;
}

/** @param {{ force?: boolean }} [opts] @returns {Promise<HardwareProfile>} */
function detectHardware(opts = {}) {
  if (opts.force) cached = null;
  if (cached) return cached;
  if (!opts.force) {
    const saved = readProfile();
    if (saved) {
      cached = Promise.resolve(saved);
      return cached;
    }
  }
  const windowsBuild = currentWindowsBuild();
  cached = (async () => {
    const [gpuRaw, cpuNames] = await Promise.all([queryWindowsGpus(), queryWindowsCpuNames()]);
    const profile = buildHardwareProfile(normalizeGpuInventory(gpuRaw), { windowsBuild, cpuNames });
    writeProfile(profile);
    return profile;
  })();
  return cached;
}

module.exports = {
  classifyGpu, normalizeGpuInventory, supportsRocmWindows, supportsIntelXpuWindows,
  buildHardwareProfile, queryWindowsCpuNames, detectHardware,
};
