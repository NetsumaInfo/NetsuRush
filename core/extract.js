// @ts-check
// Extraction du VRAI média derrière un lien (réseaux sociaux + ~1800 sites) via yt-dlp (vidéo) et
// gallery-dl (images), installés dans le venv (.venv). On télécharge le fichier dans le dossier
// d'assets du board (durable) puis on renvoie le(s) chemin(s) + le type au renderer, qui pose un
// item vidéo/image NATIF (pas une carte embed). Pour un projet ouvert, la destination est directement
// son dossier compagnon organisé ; le magasin global ne sert que pour un board sans fichier.
//
// Stratégie (jusqu'à 2 passes : sans cookies puis avec, le contenu public marche sans login) :
//   1. yt-dlp → meilleure vidéo mp4 (merge HLS/DASH via ffmpeg) ;
//   2. si pas de vidéo (post photo), gallery-dl → image(s) pleine résolution.
// Cookies navigateur (--cookies-from-browser) en 2e passe pour le contenu nécessitant connexion.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PYTHON, DETECT_ENV, DATA_DIR, ffBin, COOKIES_BROWSER, jsRuntimeArgs } = require('./config');
const { t } = require('./i18n');
const sidecar = require('./netsu/sidecar');
const downloadTarget = require('./netsu/downloadTarget');

// Python qui porte yt-dlp/gallery-dl : le venv local en priorité (dev, où `python` du PATH n'est
// pas forcément le venv), sinon l'interpréteur configuré (packaging / CONFIG.python).
function resolvePython() {
  const venv = process.platform === 'win32'
    ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '..', '.venv', 'bin', 'python');
  try { if (fs.existsSync(venv)) return venv; } catch (_) {}
  return PYTHON;
}
const PY = resolvePython();

const ASSETS_DIR = path.join(DATA_DIR, 'reference', 'assets');
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi', 'ogv']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'tiff', 'tif']);

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}

// dossier de ffmpeg si fourni en absolu (bundle) → passé à yt-dlp ; sinon il le cherche dans le PATH.
function ffmpegDir() {
  const f = ffBin('ffmpeg');
  return path.isAbsolute(f) ? path.dirname(f) : null;
}

// Lance un process et résout { code, stdout, stderr }. Tué dur après `timeoutMs`.
function run(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(PY, args, { env: DETECT_ENV });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, stdout: out, stderr: String(e) }); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
  });
}

function extOf(p) { return (p.split('.').pop() || '').toLowerCase(); }

let toolCheckPromise = null;

async function toolAvailable(moduleName) {
  const { code, stderr } = await run(['-m', moduleName, '--version'], 15000);
  return { ok: code === 0, error: stderr.trim() };
}

async function checkTools() {
  if (!toolCheckPromise) {
    toolCheckPromise = (async () => {
      const [yt, gl] = await Promise.all([toolAvailable('yt_dlp'), toolAvailable('gallery_dl')]);
      return { yt, gl };
    })();
  }
  return toolCheckPromise;
}

// Vidéo destinée à un LECTEUR DE BOARD, pas à un montage : H.264 en 1080p au plus. Le même plan
// existe en AV1 et en VP9, souvent en 4K — la WebView les décode en logiciel, un 2160p AV1 rend un
// carré noir (MEDIA_ERR_DECODE) pour cent fois le poids d'un 1080p avc1. Le repli garde une sortie
// même quand la plateforme n'a rien en avc1.
const YTDLP_FORMAT = [
  'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]',
  'b[vcodec^=avc1][height<=1080]',
  'bv*[ext=mp4][height<=1080]+ba[ext=m4a]',
  'b[ext=mp4]',
  'b',
].join('/');

// yt-dlp : meilleure vidéo mp4 → fichier(s) dans ASSETS_DIR. Renvoie les chemins vidéo écrits.
async function tryYtdlp(url, cookiesBrowser, outputDir) {
  const outTpl = path.join(outputDir, 'nr-yt-%(id)s.%(ext)s');
  const args = [
    '-m', 'yt_dlp', url,
    '-f', YTDLP_FORMAT,
    '--merge-output-format', 'mp4',
    '--no-playlist', '--no-warnings', '--no-progress', '--no-simulate',
    '--socket-timeout', '30', '--max-filesize', '1024m',
    '--restrict-filenames',
    '-o', outTpl,
    '--print', 'after_move:filepath',
    ...jsRuntimeArgs(),
  ];
  // Instagram changes its public web API frequently. The current extractor plus browser
  // impersonation keeps this path independent from a locked local Chrome cookie database.
  if (/https?:\/\/(?:www\.)?instagram\.com\//i.test(url)) args.push('--impersonate', 'chrome');
  const ffDir = ffmpegDir();
  if (ffDir) args.push('--ffmpeg-location', ffDir);
  if (cookiesBrowser) args.push('--cookies-from-browser', cookiesBrowser);

  const { code, stdout, stderr } = await run(args, 120000);
  const paths = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const items = [];
  for (const p of paths) if (fs.existsSync(p) && VIDEO_EXTS.has(extOf(p))) items.push({ path: p, kind: 'video' });
  return code === 0 && items.length ? { ok: true, items } : { ok: false, error: stderr.trim() };
}

// gallery-dl : images (post photo, carrousel) → un sous-dossier dédié, puis on liste les fichiers.
async function tryGallery(url, cookiesBrowser, outputDir) {
  const sub = path.join(outputDir, `nr-gl-${crypto.randomBytes(5).toString('hex')}`);
  ensureDir(sub);
  const args = [
    '-m', 'gallery_dl', '-q', '-D', sub,
    '--range', '1-20', '--filesize-max', '256M', '--no-mtime',
    url,
  ];
  if (cookiesBrowser) args.push('--cookies-from-browser', cookiesBrowser);

  const { stderr } = await run(args, 120000);
  let files = [];
  try { files = fs.readdirSync(sub); } catch (_) {}
  const items = [];
  for (const f of files) {
    const p = path.join(sub, f);
    const e = extOf(p);
    if (IMAGE_EXTS.has(e) || VIDEO_EXTS.has(e)) items.push({ path: p, kind: IMAGE_EXTS.has(e) ? 'image' : 'video' });
  }
  if (!items.length) { try { fs.rmSync(sub, { recursive: true, force: true }); } catch (_) {} }
  return items.length ? { ok: true, items } : { ok: false, error: stderr.trim() };
}

// Extrait le média derrière `url`. Passe sans cookies d'abord (public), puis avec (contenu connecté).
/** @param {string} url @param {{ projectPath?: string, title?: string }} [options] */
async function extractMedia(url, options = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'URL invalide' };
  const projectPath = String(options.projectPath || '');
  const videoDir = projectPath ? downloadTarget.bucketDir(projectPath, 'video') : ASSETS_DIR;
  const imageDir = projectPath ? downloadTarget.bucketDir(projectPath, 'image') : ASSETS_DIR;
  ensureDir(videoDir);
  ensureDir(imageDir);
  const tools = await checkTools();
  if (!tools.yt.ok && !tools.gl.ok) {
    return { ok: false, error: t('extractToolsMissing') };
  }
  const browsers = COOKIES_BROWSER ? [null, COOKIES_BROWSER] : [null];
  const errors = [];
  for (const ck of browsers) {
    if (tools.yt.ok) {
      const v = await tryYtdlp(url, ck, videoDir);
      if (v.ok) return projectPath ? organizeProjectItems(projectPath, v.items, options.title) : v;
      if (v.error) errors.push(v.error);
    }
    if (tools.gl.ok) {
      const g = await tryGallery(url, ck, imageDir);
      if (g.ok) return projectPath ? organizeProjectItems(projectPath, g.items, options.title) : g;
      if (g.error) errors.push(g.error);
    }
  }
  const tail = errors.find(Boolean);
  return { ok: false, error: tail || 'aucun média extractible (compte privé, lien non supporté, ou outil à jour requis)' };
}

function organizeProjectItems(projectPath, items, title) {
  const index = sidecar.indexSidecar(projectPath);
  const organized = [];
  for (const item of items || []) {
    const adopted = sidecar.adopt(projectPath, item.path, {
      place: { kind: item.kind, title: title || path.basename(item.path, path.extname(item.path)) },
      index,
    });
    if (!adopted.ok || !adopted.path) continue;
    if (path.resolve(adopted.path) !== path.resolve(item.path) && sidecar.isInSidecar(projectPath, item.path)) {
      try { fs.rmSync(item.path, { force: true }); } catch (_) {}
    }
    organized.push({ path: adopted.path, kind: item.kind });
  }
  return organized.length ? { ok: true, items: organized } : { ok: false, error: 'échec du rangement du média' };
}

module.exports = { extractMedia };
