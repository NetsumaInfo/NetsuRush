// @ts-check
// Extraction du VRAI média derrière un lien (réseaux sociaux + ~1800 sites).
//
// yt-dlp et gallery-dl (images d'un post photo) sont installés dans le venv (.venv) par le setup ;
// l'absence de gallery-dl n'empêche jamais l'extraction.
//
// On télécharge le fichier dans le dossier d'assets du board (durable) puis on renvoie le(s)
// chemin(s) + le type au renderer, qui pose un item vidéo/image NATIF (pas une carte embed). Pour un
// projet ouvert, la destination est directement son dossier compagnon organisé ; le magasin global
// ne sert que pour un board sans fichier.
//
// A post is a LIST OF SLIDES, not a single medium:
//   1. one metadata pass (`-J -i --ignore-no-formats-error`) enumerates the slides — without that
//      flag a single photo slide makes yt-dlp exit non-zero and the whole post is discarded;
//   2. slides WITH formats are downloaded by yt-dlp (best avc1 ≤1080p, merged to mp4);
//   3. slides WITHOUT formats are photos: their largest thumbnail IS the full-resolution file.
// X/Twitter exposes neither format nor thumbnail for a photo post, so it has a dedicated resolver on
// the public syndication endpoint of the official embeds.
//
// Cookies: public pass first, then ONE authenticated pass — an exported cookies.txt if there is one,
// otherwise the keyring of an installed browser.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  PYTHON, DETECT_ENV, DATA_DIR, ffBin,
  cookieBrowserCandidates, ytCookiesFile, jsRuntimeArgs,
} = require('./config');
const { t } = require('./i18n');
const { downloadBytes } = require('./reference');
const sidecar = require('./netsu/sidecar');
const downloadTarget = require('./netsu/downloadTarget');

const ASSETS_DIR = path.join(DATA_DIR, 'reference', 'assets');
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi', 'ogv']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'tiff', 'tif']);
// Beyond this, a post is not a reference board any more. Same ceiling as the gallery-dl pass.
const MAX_SLIDES = 20;
// Public endpoint behind the official tweet embeds: the only route that still yields the photos of a
// tweet without an account.
const TWEET_ENDPOINT = 'https://cdn.syndication.twimg.com/tweet-result';

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}

// dossier de ffmpeg si fourni en absolu (bundle) → passé à yt-dlp ; sinon il le cherche dans le PATH.
function ffmpegDir() {
  const f = ffBin('ffmpeg');
  return path.isAbsolute(f) ? path.dirname(f) : null;
}

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

/** yt-dlp, toujours par son module : le venv porte le paquet, pas un exécutable autonome.
 * @returns {{ bin: string, args: string[] }} */
function ytDlpCommand() {
  return { bin: PY, args: ['-m', 'yt_dlp'] };
}

/** gallery-dl : même interpréteur, autre module. Il n'est pas obligatoire — son absence fait
 * simplement sauter la passe images.
 * @returns {{ bin: string, args: string[] } | null} */
function galleryCommand() {
  return PY ? { bin: PY, args: ['-m', 'gallery_dl'] } : null;
}

// Lance un process et résout { code, stdout, stderr, missing }. Tué dur après `timeoutMs`.
// `missing` = l'exécutable lui-même est absent (ENOENT) : ce n'est pas un lien qui échoue.
function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: DETECT_ENV });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(killer);
      const missing = /** @type {NodeJS.ErrnoException} */ (e)?.code === 'ENOENT';
      resolve({ code: -1, stdout: out, stderr: String(e), missing });
    });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code: code ?? -1, stdout: out, stderr: err, missing: false }); });
  });
}

function extOf(p) { return (p.split('.').pop() || '').toLowerCase(); }

let toolCheckPromise = null;

async function ytdlpAvailable() {
  const cmd = ytDlpCommand();
  const { code, stderr, missing } = await run(cmd.bin, [...cmd.args, '--version'], 20000);
  return {
    ok: code === 0,
    missing,
    error: missing ? t('ytdlpMissing', { path: cmd.bin }) : stderr.trim(),
  };
}

async function galleryAvailable() {
  const cmd = galleryCommand();
  if (!cmd) return { ok: false, missing: true, error: '' };
  const { code, stderr, missing } = await run(cmd.bin, [...cmd.args, '--version'], 20000);
  return { ok: code === 0, missing, error: stderr.trim() };
}

async function checkTools() {
  if (!toolCheckPromise) {
    toolCheckPromise = (async () => {
      const [yt, gl] = await Promise.all([ytdlpAvailable(), galleryAvailable()]);
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

// Arguments communs à TOUTES les invocations yt-dlp : ce que l'outil doit savoir du poste (runtime
// JS, ffmpeg, cookies) et de la plateforme visée, jamais ce qu'on lui demande de faire.
function commonArgs(url, cookies) {
  const args = [
    '--no-playlist', '--no-warnings', '--no-progress', '--socket-timeout', '30',
    ...jsRuntimeArgs(),
  ];
  // Instagram changes its public web API frequently. The current extractor plus browser
  // impersonation keeps this path independent from a locked local Chrome cookie database.
  if (/https?:\/\/(?:www\.)?instagram\.com\//i.test(url)) args.push('--impersonate', 'chrome');
  const ffDir = ffmpegDir();
  if (ffDir) args.push('--ffmpeg-location', ffDir);
  if (cookies && cookies.file) args.push('--cookies', cookies.file);
  else if (cookies && cookies.browser) args.push('--cookies-from-browser', cookies.browser);
  return args;
}

/** Largest thumbnail of an entry — for a photo slide this IS the medium (yt-dlp points `thumbnail`
 * at the uncapped variant).
 * @returns {string} */
function bestThumbUrl(entry) {
  if (!entry) return '';
  if (entry.thumbnail) return String(entry.thumbnail);
  const list = (Array.isArray(entry.thumbnails) ? entry.thumbnails : []).filter((th) => th && th.url);
  if (!list.length) return '';
  const sized = list.filter((th) => Number(th.width) > 0 && Number(th.height) > 0);
  // Sans dimension annoncée, l'ordre de yt-dlp fait foi : il classe du pire au meilleur.
  if (!sized.length) return String(list[list.length - 1].url);
  return String(sized.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a)).url);
}

/** Slides of a post, in order. `video` = a stream yt-dlp can download, `image` = fetch `thumb`.
 * @returns {Promise<{ slides: { index: number, id: string, kind: 'video'|'image', thumb: string }[], error: string, missing: boolean }>} */
async function dumpSlides(url, cookies) {
  const cmd = ytDlpCommand();
  const args = [url, '-J', '-i', '--ignore-no-formats-error', ...commonArgs(url, cookies)];
  const { code, stdout, stderr, missing } = await run(cmd.bin, [...cmd.args, ...args], 120000);
  let info = null;
  try { info = JSON.parse(stdout); } catch (_) { info = null; }
  if (!info) return { slides: [], error: missing ? t('ytdlpMissing', { path: cmd.bin }) : (stderr.trim() || t('ytdlpFailed', { code })), missing };
  const entries = info._type === 'playlist' && Array.isArray(info.entries) ? info.entries : [info];
  const slides = [];
  entries.slice(0, MAX_SLIDES).forEach((entry, i) => {
    if (!entry) return;
    const hasStream = Array.isArray(entry.formats) && entry.formats.length > 0;
    const thumb = bestThumbUrl(entry);
    if (!hasStream && !thumb) return;
    slides.push({
      index: i + 1,
      id: String(entry.id || i + 1),
      kind: hasStream ? 'video' : 'image',
      thumb,
    });
  });
  return { slides, error: stderr.trim(), missing: false };
}

// Les slides VIDÉO d'un post → fichiers mp4 dans `outputDir`.
async function downloadVideos(url, slides, playlist, cookies, outputDir) {
  if (!slides.length) return [];
  const outTpl = path.join(outputDir, 'nr-yt-%(id)s.%(ext)s');
  const args = [
    url,
    '-f', YTDLP_FORMAT,
    '--merge-output-format', 'mp4',
    '-i', '--ignore-no-formats-error',
    '--no-simulate', '--max-filesize', '1024m', '--restrict-filenames',
    '-o', outTpl,
    '--print', 'after_move:filepath',
    ...commonArgs(url, cookies),
  ];
  if (playlist) args.push('--playlist-items', slides.map((s) => s.index).join(','));
  const cmd = ytDlpCommand();
  const { stdout } = await run(cmd.bin, [...cmd.args, ...args], 300000);
  const written = stdout.split(/\r?\n/).map((s) => s.trim())
    .filter((p) => p && fs.existsSync(p) && VIDEO_EXTS.has(extOf(p)));
  // L'id dans le nom de sortie rattache un fichier à sa position : une slide qui échoue n'imprime rien.
  const out = [];
  const left = [...written];
  for (const slide of slides) {
    const hit = left.findIndex((p) => path.basename(p).includes(slide.id));
    const file = hit >= 0 ? left.splice(hit, 1)[0] : null;
    if (file) out.push({ index: slide.index, path: file, kind: 'video' });
  }
  // Repli d'ordre : id absent du nom (`--restrict-filenames`).
  slides.filter((s) => !out.some((o) => o.index === s.index)).forEach((slide, i) => {
    if (left[i]) out.push({ index: slide.index, path: left[i], kind: 'video' });
  });
  return out;
}

// Extension d'un média téléchargé : type MIME renvoyé par le CDN d'abord (fiable), sinon l'URL.
function extFor(contentType, url) {
  const sub = String(contentType || '').split('/')[1] || '';
  const fromMime = { jpeg: 'jpg', jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', avif: 'avif', mp4: 'mp4', webm: 'webm', quicktime: 'mov' }[sub.toLowerCase()];
  if (fromMime) return fromMime;
  try {
    const ext = extOf(new URL(url).pathname);
    if (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext)) return ext;
  } catch (_) {}
  return 'jpg';
}

// Les slides PHOTO : octets pris sur le CDN (URL déjà signée) et écrits dans `outputDir`.
async function downloadStills(slides, outputDir, prefix) {
  const out = [];
  for (const slide of slides) {
    if (!slide.thumb) continue;
    try {
      const res = await downloadBytes(slide.thumb);
      const kind = res.type.startsWith('video/') ? 'video' : 'image';
      const file = path.join(outputDir, `${prefix}-${slide.id}-${String(slide.index).padStart(2, '0')}.${extFor(res.type, slide.thumb)}`);
      fs.writeFileSync(file, res.buf);
      out.push({ index: slide.index, path: file, kind });
    } catch (_) {
      // Une slide qui refuse ses octets ne condamne pas le reste du post.
    }
  }
  return out;
}

// gallery-dl : images (post photo, carrousel) → un sous-dossier dédié, puis on liste les fichiers.
// Dernier recours : il n'est pas provisionné, il ne sert donc que sur un poste qui en a un.
async function tryGallery(url, cookies, outputDir) {
  const cmd = galleryCommand();
  if (!cmd) return { ok: false, error: '' };
  const sub = path.join(outputDir, `nr-gl-${crypto.randomBytes(5).toString('hex')}`);
  ensureDir(sub);
  const args = [
    '-q', '-D', sub,
    '--range', `1-${MAX_SLIDES}`, '--filesize-max', '256M', '--no-mtime',
    url,
  ];
  if (cookies && cookies.file) args.push('--cookies', cookies.file);
  else if (cookies && cookies.browser) args.push('--cookies-from-browser', cookies.browser);

  const { stderr } = await run(cmd.bin, [...cmd.args, ...args], 120000);
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

// --- X / Twitter -----------------------------------------------------------------------------
// Son extracteur yt-dlp n'expose rien d'un post photo. L'endpoint public des embeds officiels rend
// chaque média du tweet (photos et variantes vidéo) sans compte.

function tweetId(url) {
  const m = String(url || '').match(/(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d+)/i);
  return m ? m[1] : null;
}

// `name=orig` = le fichier original, pas la version recadrée servie dans la timeline.
function photoOriginal(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('name', 'orig');
    return u.toString();
  } catch (_) { return url; }
}

// X ne sert que du H.264 (1080p au plus) : la variante au plus haut débit est sans risque pour la WebView.
function bestVariant(info) {
  const variants = (info && Array.isArray(info.variants) ? info.variants : [])
    .filter((v) => v && v.url && String(v.content_type || '').includes('mp4'));
  if (!variants.length) return '';
  return variants.reduce((a, b) => (Number(b.bitrate || 0) > Number(a.bitrate || 0) ? b : a)).url;
}

/** @returns {Promise<{ index: number, id: string, kind: 'video'|'image', thumb: string }[]>} */
async function tweetSlides(url) {
  const id = tweetId(url);
  if (!id) return [];
  let data = null;
  try {
    const res = await downloadBytes(`${TWEET_ENDPOINT}?id=${id}&token=a&lang=en`);
    data = JSON.parse(res.buf.toString('utf8'));
  } catch (_) { return []; }
  const details = data && Array.isArray(data.mediaDetails) ? data.mediaDetails : [];
  const slides = [];
  details.slice(0, MAX_SLIDES).forEach((media, i) => {
    if (!media) return;
    const isPhoto = media.type === 'photo';
    const thumb = isPhoto ? photoOriginal(media.media_url_https) : bestVariant(media.video_info);
    if (!thumb) return;
    slides.push({ index: i + 1, id: `${id}-${i + 1}`, kind: isPhoto ? 'image' : 'video', thumb });
  });
  return slides;
}

/** Passes de cookies : la publique d'abord (le contenu public n'a rien à prouver), puis UNE passe
 * authentifiée. Un cookies.txt exporté passe avant le trousseau d'un navigateur — il reste lisible
 * même navigateur ouvert, là où Chrome verrouille sa base.
 * @returns {({ file: string|null, browser: string|null }|null)[]} */
function cookiePasses() {
  const file = ytCookiesFile();
  if (file) return [null, { file, browser: null }];
  const browser = cookieBrowserCandidates()[0];
  return browser ? [null, { file: null, browser }] : [null];
}

// Ne garde que la slide demandée (1-based). Hors bornes → le post entier.
function pickSlide(slides, index) {
  if (!index) return slides;
  const one = slides.filter((s) => s.index === index);
  return one.length ? one : slides;
}

// Extrait le média derrière `url`. Passe sans cookies d'abord (public), puis avec (contenu connecté).
/** @param {string} url @param {{ projectPath?: string, title?: string, index?: number }} [options] */
async function extractMedia(url, options = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: t('invalidUrl') };
  const projectPath = String(options.projectPath || '');
  const videoDir = projectPath ? downloadTarget.bucketDir(projectPath, 'video') : ASSETS_DIR;
  const imageDir = projectPath ? downloadTarget.bucketDir(projectPath, 'image') : ASSETS_DIR;
  ensureDir(videoDir);
  ensureDir(imageDir);
  const wanted = Number(options.index) > 0 ? Math.floor(Number(options.index)) : 0;
  const finish = (items) => {
    const ordered = items.slice().sort((a, b) => a.index - b.index).map((it) => ({ path: it.path, kind: it.kind }));
    if (!ordered.length) return null;
    return projectPath ? organizeProjectItems(projectPath, ordered, options.title) : { ok: true, items: ordered };
  };

  // X / Twitter : résolveur dédié EN PREMIER, seule voie vers les photos d'un tweet.
  const tweet = pickSlide(await tweetSlides(url), wanted);
  if (tweet.length) {
    const stills = await downloadStills(tweet.filter((s) => s.kind === 'image'), imageDir, 'nr-tw');
    const clips = await downloadStills(tweet.filter((s) => s.kind === 'video'), videoDir, 'nr-tw');
    const done = finish([...stills, ...clips]);
    if (done) return done;
  }

  const tools = await checkTools();
  if (!tools.yt.ok && !tools.gl.ok) {
    return { ok: false, error: tools.yt.error || t('extractToolsMissing') };
  }
  const errors = [];
  for (const ck of cookiePasses()) {
    if (tools.yt.ok) {
      const { slides, error, missing } = await dumpSlides(url, ck);
      if (error) errors.push(error);
      if (!missing && slides.length) {
        const picked = pickSlide(slides, wanted);
        const playlist = slides.length > 1;
        const videos = await downloadVideos(url, picked.filter((s) => s.kind === 'video'), playlist, ck, videoDir);
        // Une slide vidéo dont le flux a échoué garde sa vignette plutôt que de disparaître.
        const missed = picked.filter((s) => s.kind === 'video' && !videos.some((v) => v.index === s.index));
        const stills = await downloadStills([...picked.filter((s) => s.kind === 'image'), ...missed], imageDir, 'nr-st');
        const done = finish([...videos, ...stills]);
        if (done) return done;
      }
    }
    if (tools.gl.ok) {
      const g = await tryGallery(url, ck, imageDir);
      if (g.ok) return projectPath ? organizeProjectItems(projectPath, g.items, options.title) : g;
      if (g.error) errors.push(g.error);
    }
  }
  const tail = errors.find(Boolean);
  return { ok: false, error: tail || t('extractNothing') };
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
  return organized.length ? { ok: true, items: organized } : { ok: false, error: t('extractOrganizeFailed') };
}

module.exports = { extractMedia };
