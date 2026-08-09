// @ts-check
// Config partagée du process principal : nr.config.json (écrit par l'install-script), interpréteur
// python du venv, env du sidecar (UTF-8 / CUDA / chemins de modèles offline), binaires ffmpeg et
// dossiers de cache. Feuille du graphe de modules (n'importe rien de local).

const path = require('path');
const fs = require('fs');
const os = require('os');

const fsp = fs.promises;

const PLUGIN_ID = 'com.netsurush.app';

// Dossier de données ÉCRIVABLE de l'app (config + runtime provisionné au 1er lancement). En bundle
// l'installeur NSIS `currentUser` pose le code en lecture seule → nr.config.json (chemins absolus du
// venv/ffmpeg/poids) et le runtime téléchargé vivent ici, hors du dossier d'install. Surchargeable
// via NR_HOME ; défaut = %LOCALAPPDATA%\NetsuRush (Windows) ou ~/.netsurush (autres).
const NR_HOME = process.env.NR_HOME
  || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'NetsuRush')
    : path.join(os.homedir(), '.netsurush'));
const CONFIG_PATH = path.join(NR_HOME, 'nr.config.json');
// Fonds d'écran importés par l'utilisateur : persistants (un fond survit à un nettoyage de cache,
// sinon l'app perdrait son apparence) et adressés par hash de contenu, comme les assets du board.
const WALLPAPER_DIR = path.join(NR_HOME, 'wallpapers');

// Espace de travail strictement lié à la session de l'application. Les fichiers placés ici
// accélèrent une opération en cours (frames/mattes Roto, tests pleine résolution, WAV de travail),
// mais n'ont aucune valeur au prochain lancement. La coquille Tauri et le core le suppriment tous
// les deux à la fermeture ; le boot le remet aussi à zéro après un crash ou une extinction forcée.
const SESSION_CACHE_ROOT = path.join(os.tmpdir(), 'netsurush-session');
const VOICE_DIR = path.join(SESSION_CACHE_ROOT, 'voice');
const UPSCALE_TEST_DIR = path.join(SESSION_CACHE_ROOT, 'processing-tests');
const ROTO_DIR = path.join(SESSION_CACHE_ROOT, 'roto');
const SEQ_DIR = path.join(SESSION_CACHE_ROOT, 'sequence-frames');

// nr.config.json écrit par le setup du 1er lancement (setup.ps1). Priorité : NR_HOME (écrivable,
// bundle) puis core/nr.config.json (legacy/dev, à côté du code).
function loadConfig() {
  const def = { dev: false, devUrl: 'http://localhost:1420', dist: 'renderer' };
  for (const p of [CONFIG_PATH, path.join(__dirname, 'nr.config.json')]) {
    try {
      // strip d'un éventuel BOM UTF-8 : Set-Content -Encoding UTF8 (PowerShell 5.1) en ajoute un, et
      // JSON.parse lève sur ce caractère de tête → la config était silencieusement ignorée.
      if (fs.existsSync(p)) return { ...def, ...JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')) };
    } catch (_) {}
  }
  return def;
}
const CONFIG = loadConfig();

// Binaire ffmpeg/ffprobe : chemin absolu de nr.config.json (bundle) en priorité, sinon PATH.
function ffBin(name) {
  if (name === 'ffmpeg'  && CONFIG.ffmpeg)  return CONFIG.ffmpeg;
  if (name === 'ffprobe' && CONFIG.ffprobe) return CONFIG.ffprobe;
  return name;
}

// Binaire transcribe.cpp (moteur ASR natif, modèles GGUF streaming type Nemotron). Fourni par
// l'utilisateur (prébuild GitHub) — jamais compilé dans le repo. Résolution : nr.config.json
// (transcribeCppBin) → env NR_TRANSCRIBE_CLI → NR_HOME/bin/transcribe-cli(.exe) → sinon nom nu (PATH).
function transcribeCli() {
  const exe = process.platform === 'win32' ? 'transcribe-cli.exe' : 'transcribe-cli';
  for (const c of [CONFIG.transcribeCppBin, process.env.NR_TRANSCRIBE_CLI, path.join(NR_HOME, 'bin', exe)]) {
    try { if (c && fs.existsSync(c)) return c; } catch (_) {}
  }
  return exe; // tenté via le PATH au spawn (échoue proprement si absent)
}
const ML_BACKEND = ['cuda', 'rocm', 'xpu', 'cpu'].includes(CONFIG.mlBackend)
  ? CONFIG.mlBackend
  : '';
const ONNX_BACKEND = ['cuda', 'directml', 'openvino', 'cpu'].includes(CONFIG.onnxBackend)
  ? CONFIG.onnxBackend
  : '';
// Backend du binaire natif : CUDA sur NVIDIA, Vulkan sur AMD/Intel, CPU sinon. Le binaire garde
// sa propre sonde/fallback ; une valeur explicite dans nr.config.json reste prioritaire.
const HARDWARE_VENDORS = Array.isArray(CONFIG.hardware?.vendors) ? CONFIG.hardware.vendors : [];
const TRANSCRIBE_BACKEND = CONFIG.transcribeCppBackend
  || (ML_BACKEND === 'cuda' ? 'cuda'
    : ML_BACKEND === 'rocm' || ML_BACKEND === 'xpu' || HARDWARE_VENDORS.some((v) => v === 'amd' || v === 'intel')
      ? 'vulkan'
      : 'cpu');

// Interpréteur Python des SIDECARS ML (détection/recherche/upscale) : venv local (torch CUDA).
const PYTHON = CONFIG.python || (process.platform === 'win32' ? 'python' : 'python3');

// Interpréteur Python du PONT RESOLVE : la fusionscript.dll de Resolve 21 est compilée pour
// Python 3.13 (ABI) → charger le helper avec un 3.13, distinct du venv 3.10 des sidecars.
// Surchargeable via nr.config.json (resolvePython) ; à défaut on retombe sur PYTHON.
const RESOLVE_PYTHON = CONFIG.resolvePython || PYTHON;

// RTX Video Super Resolution : le CLI RTXVideoProcessor (MIT, téléchargé par le gestionnaire de
// modèles) et les deux DLL du RTX Video SDK vivent dans le MÊME dossier — NGX charge `nvngx_*.dll`
// depuis le répertoire de l'exécutable, jamais depuis le PATH. Les DLL sont propriétaires NVIDIA et
// non redistribuables : l'utilisateur les dépose lui-même (Paramètres › Modèles).
const RTX_DIR = path.join(NR_HOME, 'models', 'upscale', 'rtx-video');
const RTX_EXE = 'RTXVideoProcessor.exe';
const RTX_DLLS = ['nvngx_vsr.dll', 'nvngx_truehdr.dll'];
// Chemin du CLI RTX s'il est réellement installé, sinon null (le moteur rend alors une erreur qui
// nomme ce qui manque au lieu d'un échec de spawn opaque).
function rtxBin() {
  const exe = CONFIG.rtxBin || process.env.NR_RTX_BIN || path.join(RTX_DIR, RTX_EXE);
  try { return fs.existsSync(exe) ? exe : null; } catch (_) { return null; }
}

// Env du sidecar python. Poids OmniShotCut en local (offline) si fournis par la config.
const DETECT_ENV = { ...process.env };
// Force UTF-8 sur stdin/stdout/FS du sidecar python : sinon Windows décode le JSON entrant
// en cp1252 et corrompt les chemins accentués (é → Ã©, fichier introuvable).
DETECT_ENV.PYTHONUTF8 = '1';
DETECT_ENV.PYTHONIOENCODING = 'utf-8';
DETECT_ENV.NETSURUSH_ML_BACKEND = ML_BACKEND;
DETECT_ENV.NETSURUSH_ONNX_BACKEND = ONNX_BACKEND;
// PyTorch/CUDA réserve par défaut une ÉNORME plage de mémoire virtuelle (commit) au démarrage →
// sur Windows avec un pagefile bas, ça jette WinError 1455 (« fichier de pagination insuffisant »).
// LAZY charge les kernels CUDA à la demande → commit bien plus faible, même perf à l'usage.
if (ML_BACKEND === 'cuda') {
  DETECT_ENV.CUDA_MODULE_LOADING = 'LAZY';
  // Allocateur CUDA plus souple (segments extensibles) → moins de réservation d'un bloc.
  DETECT_ENV.PYTORCH_CUDA_ALLOC_CONF = 'expandable_segments:True';
}
if (CONFIG.omnishotCkpt) DETECT_ENV.NETSURUSH_OMNISHOT_CKPT = CONFIG.omnishotCkpt;
if (CONFIG.autoshotCkpt) DETECT_ENV.NETSURUSH_AUTOSHOT_CKPT = CONFIG.autoshotCkpt;
// Dossier local du modèle SigLIP 2 (offline) si fourni par la config (sinon DL HuggingFace).
if (CONFIG.siglipDir) DETECT_ENV.NETSURUSH_SIGLIP_DIR = CONFIG.siglipDir;
// Variante SigLIP 2 (base/so400m/giant). ⚠️ change la dimension d'embedding → ré-indexer tout.
if (CONFIG.siglipModel) DETECT_ENV.NETSURUSH_SIGLIP_MODEL = CONFIG.siglipModel;
// Recherche visage RÉEL : dossier des poids ONNX opencv_zoo (YuNet + SFace). Défaut TOUJOURS posé
// (NR_HOME/weights/face) → les poids téléchargés depuis Paramètres › Modèles sont trouvés même sans
// nr.config.json (dev). Le domaine ANIMÉ (imgutils/CCIP) télécharge dans le cache HF (défaut lib).
DETECT_ENV.NETSURUSH_FACE_DIR = CONFIG.faceDir || path.join(NR_HOME, 'weights', 'face');
// Bascule brute-force → FAISS : seuil fixe (nb de plans) OU fraction de RAM (sinon search.py
// calcule le seuil selon la RAM, fraction par défaut 0.5).
if (CONFIG.faissThreshold) DETECT_ENV.NETSURUSH_FAISS_THRESHOLD = String(CONFIG.faissThreshold);
if (CONFIG.ramFraction) DETECT_ENV.NETSURUSH_RAM_FRACTION = String(CONFIG.ramFraction);
// Poids Real-ESRGAN en local (offline) → upscale.py. + binaires ffmpeg/ffprobe configurés
// (bundle) pour que le sidecar upscale décode/encode via le même ffmpeg que main.js (hors PATH).
// Défaut TOUJOURS posé, comme pour les visages : sans configuration, le gestionnaire écrivait dans
// NR_HOME/realesrgan pendant que le sidecar lisait ~/.netsurush/realesrgan — deux dossiers distincts,
// donc un modèle annoncé installé et pourtant retéléchargé au premier usage.
DETECT_ENV.NETSURUSH_REALESRGAN_DIR = CONFIG.realesganDir || path.join(NR_HOME, 'realesrgan');
// Module voix : modèles offline (packaging) du sidecar transcribe.py / silence.py.
// Whisper = dossier CTranslate2 ; Parakeet = dossier ONNX (onnx-asr) ; Silero = poids ONNX.
if (CONFIG.whisperDir) DETECT_ENV.NETSURUSH_WHISPER_DIR = CONFIG.whisperDir;
if (CONFIG.whisperCompute) DETECT_ENV.NETSURUSH_WHISPER_COMPUTE = CONFIG.whisperCompute;
if (CONFIG.parakeetDir) DETECT_ENV.NETSURUSH_PARAKEET_DIR = CONFIG.parakeetDir;
if (CONFIG.sileroDir) DETECT_ENV.NETSURUSH_SILERO_DIR = CONFIG.sileroDir;
// NOVA-VAD (confirmation anti-bruit par-dessus Silero) : dépôt vendoré (models/ + src/classifier.py).
// Absent → silence.py garde Silero seul (dégradation gracieuse). En dev, vad_nova retombe sur <repo>/vendor/nova-vad.
if (CONFIG.novaDir) DETECT_ENV.NETSURUSH_NOVA_DIR = CONFIG.novaDir;
// Hub de traitements (process.py) : caches de modèles offline si fournis par la config.
if (CONFIG.rembgDir) DETECT_ENV.U2NET_HOME = CONFIG.rembgDir;          // cache modèles rembg
if (CONFIG.procHfHome) DETECT_ENV.HF_HOME = CONFIG.procHfHome;          // cache HF depth (si fourni)
if (CONFIG.rifeModelDir) DETECT_ENV.NETSURUSH_RIFE_DIR = CONFIG.rifeModelDir; // modèles RIFE custom (AniSmooth) optionnel
DETECT_ENV.NETSURUSH_FFMPEG = ffBin('ffmpeg');
DETECT_ENV.NETSURUSH_FFPROBE = ffBin('ffprobe');
DETECT_ENV.NETSURUSH_SESSION_DIR = SESSION_CACHE_ROOT;

// Extraction de médias sociaux : navigateur source pour les cookies yt-dlp/gallery-dl.
// Valeurs utiles : "chrome", "edge", "firefox", ou null/false pour désactiver la passe cookies.
const COOKIES_BROWSER = CONFIG.cookiesBrowser === false || CONFIG.cookiesBrowser === null
  ? null
  : (process.env.NR_COOKIES_BROWSER || CONFIG.cookiesBrowser || 'chrome');

// Vignettes = minuscules mais COÛTEUSES à régénérer (seek+décode par plan, des centaines par rush)
// → cache PERSISTANT dans ~/.netsurush (comme la DB des plans). os.tmpdir() était nettoyé par
// Windows (Storage Sense/Disk Cleanup) → vignettes régénérées à chaque session.
const DATA_DIR = path.join(os.homedir(), '.netsurush');

// Types de cache gérés par Paramètres › Stockage. Source unique : l'index latéral (cacheIndex),
// les politiques (cachePolicy) et l'UI s'y adossent.
const CACHE_KINDS = ['thumb', 'indexThumbs', 'proxy', 'voice', 'upscaleTest', 'roto', 'scenes', 'transcripts', 'embeddings', 'faces'];

// Dossier de cache RELOCALISABLE (Paramètres › Stockage). Ne couvre que les vignettes et les proxies :
// ce sont les deux gros postes purement régénérables. Le reste (base SQLite, index FAISS, roto-cache,
// modèles) reste en place — la base est référencée en dur par python/detect.py.
// Défauts historiques conservés quand aucun dossier n'est choisi : proxies jetables dans os.tmpdir(),
// vignettes persistantes sous ~/.netsurush.
const DEFAULT_THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const DEFAULT_PROXY_DIR = path.join(os.tmpdir(), 'netsurush-proxies');
function resolveCacheDirs(root) {
  return root
    ? { thumb: path.join(root, 'thumbs'), proxy: path.join(root, 'proxies') }
    : { thumb: DEFAULT_THUMB_DIR, proxy: DEFAULT_PROXY_DIR };
}
// État MUTABLE : les consommateurs (thumbs.js, proxy.js) passent par les getters, jamais par une
// const destructurée au require — sinon changer de dossier exigerait un redémarrage du core.
let cacheRoot = (CONFIG.cache && CONFIG.cache.dir) || null;
let cacheDirs = resolveCacheDirs(cacheRoot);

function markCacheRoot(root) {
  if (!root) return;
  try {
    const resolved = path.resolve(root);
    fs.mkdirSync(resolved, { recursive: true });
    fs.writeFileSync(path.join(resolved, '.netsurush-cache-root'), resolved, 'utf8');
  } catch (_) {}
}

markCacheRoot(cacheRoot);

const getThumbDir = () => cacheDirs.thumb;
const getProxyDir = () => cacheDirs.proxy;
const getCacheRoot = () => cacheRoot;
/** Bascule le dossier de cache (null = défauts) et crée l'arborescence. N'écrit PAS nr.config.json :
 *  la persistance et la migration des fichiers existants sont du ressort de cacheAdmin. */
function setCacheDir(root) {
  cacheRoot = root || null;
  cacheDirs = resolveCacheDirs(cacheRoot);
  markCacheRoot(cacheRoot);
  for (const d of [cacheDirs.thumb, cacheDirs.proxy]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }
  return { ...cacheDirs };
}
// Shaders GLSL du moteur d'upscale "Turbo" (ArtCNN/Anime4K, lus par ffmpeg libplacebo). Dev = vendor/
// (gitignored, peuplé par scripts/fetch-shaders.ps1) ; bundle = resources/shaders (NR_RESOURCE_DIR).
const SHADER_DIR = process.env.NETSURUSH_SHADER_DIR || CONFIG.shaderDir
  || (process.env.NR_RESOURCE_DIR
    ? path.join(process.env.NR_RESOURCE_DIR, 'shaders')
    : path.join(__dirname, '..', 'vendor', 'shaders'));
// Les modèles ArtCNN R sont fournis dans ce même dossier, mais exécutés par le sidecar ONNX.
DETECT_ENV.NETSURUSH_SHADER_DIR = SHADER_DIR;
// Crée les dossiers de cache au démarrage. CRITIQUE pour le dossier des proxies quand il vit dans
// os.tmpdir(), que Windows purge (Storage Sense) → sans ce mkdir, ffmpeg ne peut pas écrire le proxy
// (.tmp) et AUCUN aperçu vidéo ne se génère (rush ET recherche). Les dossiers persistants sont créés
// aussi par sûreté (première installation). recursive : ne lève pas si déjà présent.
for (const d of [DATA_DIR, cacheDirs.thumb, cacheDirs.proxy, SESSION_CACHE_ROOT, VOICE_DIR, UPSCALE_TEST_DIR, ROTO_DIR, SEQ_DIR, WALLPAPER_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}

// Écrit (fusionne) des clés dans nr.config.json de NR_HOME (dossier écrivable). Best-effort : sert
// la persistance durable de préférences légères (ex. langue de l'UI) lues au PROCHAIN boot du core
// Le singleton CONFIG garde son identité afin que tous ses consommateurs voient immédiatement les
// préférences légères modifiées à chaud (notamment la langue), sans redémarrage du core.
function saveConfig(patch) {
  try {
    fs.mkdirSync(NR_HOME, { recursive: true });
    let current = {};
    try {
      if (fs.existsSync(CONFIG_PATH)) current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
    } catch (_) {}
    const next = { ...current, ...patch };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
    Object.assign(CONFIG, patch);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Cache « fichier prêt » non bloquant : true si présent et non vide.
async function fileReady(p) {
  try { return (await fsp.stat(p)).size > 0; } catch (_) { return false; }
}
// Rend la main à l'event loop. Les appels FFI Resolve sont SYNCHRONES (l'await sur une valeur
// directe ne cède pas) → dans une boucle longue (grosse timeline) le loop est affamé, la fenêtre
// passe « Not Responding » et peut crasher. On insère ce yield périodiquement.
const yieldLoop = () => new Promise((r) => setImmediate(r));

module.exports = {
  PLUGIN_ID, CONFIG, ffBin, transcribeCli, ML_BACKEND, ONNX_BACKEND, TRANSCRIBE_BACKEND,
  PYTHON, RESOLVE_PYTHON, DETECT_ENV, COOKIES_BROWSER,
  VOICE_DIR, DATA_DIR, UPSCALE_TEST_DIR, ROTO_DIR, SEQ_DIR, SESSION_CACHE_ROOT,
  SHADER_DIR, RTX_DIR, RTX_EXE, RTX_DLLS, rtxBin, NR_HOME, CONFIG_PATH, WALLPAPER_DIR,
  // Dossiers relocalisables : TOUJOURS via les getters (une const destructurée au require figerait la
  // valeur et ignorerait un changement de dossier fait depuis Paramètres › Stockage).
  CACHE_KINDS, DEFAULT_THUMB_DIR, DEFAULT_PROXY_DIR, getThumbDir, getProxyDir, getCacheRoot, setCacheDir,
  fsp, fileReady, yieldLoop, saveConfig,
};
