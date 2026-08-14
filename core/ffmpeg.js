// @ts-check
// ffmpeg/ffprobe : exec générique + sondes (durée/dimensions, stratégie de lecture, pistes audio)
// et découpe lossless. Réencodage proxy/vignette = modules proxy.js / thumbs.js.

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { ffBin, fsp, fileReady, SEQ_DIR, VOICE_DIR } = require('./config');
const { cacheIndex } = require('./cacheIndex');

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(ffBin(bin), args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// Cache mémoire des sondes ffprobe par (chemin, mtime) : chaque ouverture de clip re-sondait le
// fichier (~0,3-0,8 s de spawn ffprobe) pour des métadonnées immuables tant que le fichier ne change
// pas. Les échecs ne sont PAS cachés (fichier en cours d'écriture → la sonde doit se retenter).
const PROBE_CACHE_MAX = 500;
const probeCache = new Map(); // `${kind}|${path}` → { mtime, result }
async function probeCached(kind, filePath, compute) {
  let mt = 0;
  try { mt = (await fsp.stat(filePath)).mtimeMs; } catch (_) { return compute(); } // introuvable : pas de cache
  const key = kind + '|' + filePath;
  const hit = probeCache.get(key);
  if (hit && hit.mtime === mt) return hit.result;
  const result = await compute();
  if (result && !result.error) {
    probeCache.delete(key);
    probeCache.set(key, { mtime: mt, result });
    if (probeCache.size > PROBE_CACHE_MAX) probeCache.delete(probeCache.keys().next().value);
  }
  return result;
}

async function probeMediaRaw(filePath) {
  const metaRaw = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'format=duration:stream=width,height',
    '-of', 'json', filePath,
  ]);
  const meta = JSON.parse(metaRaw.toString());
  const duration = parseFloat(meta?.format?.duration) || 0;
  const st = meta?.streams?.[0] || {};
  // fast: durée + dimensions only (no full keyframe scan — trop lent sur longs fichiers)
  return { duration, width: st.width || 0, height: st.height || 0 };
}
const probeMedia = (p) => probeCached('meta', p, () => probeMediaRaw(p));

// Décide la stratégie de lecture : codec décodable nativement par Chromium → remux copie (instantané),
// sinon transcode live NVENC. Renvoie aussi la durée pour la barre de scrub.
async function playInfoRaw(filePath) {
  try {
    const raw = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt,avg_frame_rate:format=duration', '-of', 'json', filePath,
    ]);
    const j = JSON.parse(raw.toString());
    const st = (j.streams || [])[0] || {};
    const codec = st.codec_name || '';
    const pix = st.pix_fmt || '';
    const duration = parseFloat(j.format && j.format.duration) || 0;
    // fps exact depuis la fraction avg_frame_rate ("24000/1001" → 23.976).
    const [n, d] = String(st.avg_frame_rate || '0/1').split('/');
    const fps = (parseFloat(d) ? parseFloat(n) / parseFloat(d) : 0) || 0;
    // Décodable <video> : H.264/HEVC/AV1/VP9/VP8 en 8-bit 4:2:0. Sinon (ProRes/DNxHD/10-bit…) → transcode.
    const native = ['h264', 'hevc', 'av1', 'vp9', 'vp8'].includes(codec) && /^yuvj?420p$/.test(pix);
    return { duration, codec, pix, fps, native };
  } catch (e) {
    return { duration: 0, codec: '', pix: '', fps: 0, native: false, error: String(e.stderr || e) };
  }
}
const playInfo = (p) => probeCached('play', p, () => playInfoRaw(p));

// Liste des pistes audio (pour choisir laquelle garder/convertir à l'upscale).
async function probeAudioTracksRaw(filePath) {
  try {
    const raw = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'a',
      // `sample_rate` sert au séparateur noir de la fusion : un silence généré à une autre fréquence
      // que les plans casse la concaténation par copie et force le ré-encodage de tout le montage.
      '-show_entries', 'stream=index,codec_name,channels,sample_rate:stream_tags=language,title',
      '-of', 'json', filePath,
    ]);
    const streams = (JSON.parse(raw.toString()).streams) || [];
    // index relatif (a:N) = position dans la liste audio. `title` = titre libre de piste (« Japanese »,
    // « VF »…), 2e signal de langue après le tag `language` (cf. core/audioLang.js).
    return { tracks: streams.map((s, i) => ({
      index: i, codec: s.codec_name || '?', channels: s.channels || 0,
      sampleRate: Number(s.sample_rate) || 0,
      lang: (s.tags && s.tags.language) || null,
      title: (s.tags && s.tags.title) || null,
    })) };
  } catch (e) {
    return { tracks: [], error: String(e.stderr || e) };
  }
}
const probeAudioTracks = (p) => probeCached('audio', p, () => probeAudioTracksRaw(p));

// Extrait l'audio d'une vidéo en WAV PCM 16 kHz mono (format attendu par Silero VAD et les ASR).
// Caché dans VOICE_DIR (jetable) sous un nom = hash(chemin + mtime) → ré-extrait si la source change,
// resservi instantanément sinon. `track` = index de piste audio (a:N, défaut 0). Le décodage audio
// reste côté ffmpeg (JAMAIS en JS). Renvoie le chemin du WAV.
// Extractions en cours par clé : des appels PARALLÈLES sur la même source (ex. transcription ∥
// détection de silences) partagent UNE extraction ffmpeg au lieu d'écrire le même .tmp en course.
const audioInflight = new Map();

// `seconds` > 0 → n'extrait que les N premières secondes (assez pour l'identification de langue ML,
// évite de décoder un rush entier). Clé de cache séparée (suffixe `|sN`) → ne bust pas le WAV complet.
/** @param {{ input?: string, track?: number, seconds?: number }} [o] */
async function extractAudio({ input, track = 0, seconds = 0 } = {}) {
  if (!input) throw new Error('aucune source audio');
  let mtime = 0;
  try { mtime = (await fsp.stat(input)).mtimeMs; } catch (_) {}
  const snip = seconds > 0 ? Math.round(seconds) : 0;
  const key = crypto.createHash('md5').update(`${input}|${mtime}|a${track}${snip ? `|s${snip}` : ''}`).digest('hex');
  const output = path.join(VOICE_DIR, `${key}.wav`);
  try {
    if ((await fsp.stat(output)).size > 0) { cacheIndex().touch(output); return output; }
  } catch (_) { /* à générer */ }
  const inflight = audioInflight.get(key);
  if (inflight) return inflight;
  const job = (async () => {
    const tmp = `${output}.tmp.wav`;
    await run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-map', `0:a:${track | 0}?`,
      ...(snip ? ['-t', String(snip)] : []),
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', tmp,
    ]);
    await fsp.rename(tmp, output); // rename atomique (lecteurs concurrents ne voient pas un WAV partiel)
    cacheIndex().record({ kind: 'voice', file: output, source: input });
    return output;
  })();
  audioInflight.set(key, job);
  try { return await job; } finally { audioInflight.delete(key); }
}

async function exportClip({ input, start, end, output }) {
  if (end <= start) throw new Error('fin <= début');
  await run('ffmpeg', [
    '-y', '-ss', String(start), '-i', input, '-t', String(end - start),
    '-c', 'copy', '-avoid_negative_ts', 'make_zero', output,
  ]);
  return output;
}

// Extrait une image PNG sans redimensionnement pour comparer le rendu FINAL au rush source. Ce chemin
// est distinct des vignettes de grille (JPEG 360–720p) : une comparaison qualité doit conserver chaque
// pixel du fichier exporté. Cache de session par chemin + mtime + instant, écriture atomique.
async function compareFrame(input, time) {
  let mtime = 0;
  try { mtime = (await fsp.stat(input)).mtimeMs; } catch (_) { throw new Error(`fichier introuvable : ${input}`); }
  const at = Math.max(0, Number(time) || 0);
  const key = crypto.createHash('md5').update(`${input}|${mtime}|${at.toFixed(4)}`).digest('hex');
  const output = path.join(SEQ_DIR, `compare-${key}.png`);
  if (await fileReady(output)) return output;
  const tmp = `${output}.tmp.png`;
  const fast = Math.max(0, at - 2);
  const exact = at - fast;
  try {
    await run('ffmpeg', [
      '-y', '-v', 'error', ...(fast > 0 ? ['-ss', String(fast)] : []), '-i', input,
      ...(exact > 0 ? ['-ss', String(exact)] : []), '-an', '-frames:v', '1',
      '-c:v', 'png', '-pix_fmt', 'rgba', '-f', 'image2', tmp,
    ]);
    await fsp.rename(tmp, output);
    cacheIndex().record({ kind: 'thumb', file: output, source: input });
    return output;
  } catch (e) {
    try { await fsp.rm(tmp, { force: true }); } catch (_) {}
    throw e;
  }
}

async function compareFrames(opts = {}) {
  if (!opts.beforePath || !opts.afterPath) return { ok: false, error: 'sources de comparaison manquantes' };
  try {
    const [before, after, meta] = await Promise.all([
      compareFrame(opts.beforePath, opts.beforeTime),
      compareFrame(opts.afterPath, opts.afterTime),
      probeMedia(opts.afterPath),
    ]);
    return { ok: true, before, after, width: meta.width || 0, height: meta.height || 0 };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e) };
  }
}

// Repli de cadence quand la source n'expose pas de fps exploitable (ffprobe muet, flux sans avg_frame_rate).
const DEFAULT_SEQ_FPS = 12;

// Décompose une vidéo en images fixes pour le lecteur de séquence (APERÇU). Volontairement BASSE
// qualité (`height` 240 px, JPEG `-q:v 8`) et plafonnée (`max` 150) : c'est un aperçu de mouvement,
// pas un export — on ne veut pas gonfler le disque. Rééchantillonne à `fps` img/s (défaut 8) sur la
// plage [start, end] (secondes ; défaut = vidéo entière). Écrit les JPEG dans un dossier de travail
// temporaire, puis les déplace dans SEQ_DIR sous un nom = hash du contenu (dédup : une frame
// identique — scène figée — n'occupe qu'un fichier). Renvoie les CHEMINS (SEQ_DIR, purgé au boot)
// ET la cadence RÉELLEMENT employée (l'appelant en fait la cadence de lecture de la séquence).
// `fps` absent ou ≤ 0 = cadence de la SOURCE (relue par ffprobe) : la séquence rejoue au bon rythme.
async function extractFrames(input, opts = {}) {
  const fps = opts.fps > 0 ? opts.fps : (await playInfo(input)).fps || DEFAULT_SEQ_FPS;
  const max = opts.max > 0 ? opts.max : 200;
  const height = opts.height > 0 ? opts.height : 240;
  const start = opts.start > 0 ? opts.start : 0;
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'netsurush-frames-'));
  try {
    const args = ['-v', 'error'];
    if (start > 0) args.push('-ss', String(start));      // seek avant -i = rapide
    args.push('-i', input);
    if (opts.end > start) args.push('-t', String(opts.end - start));
    args.push('-vf', `fps=${fps},scale=-2:${height}`, '-frames:v', String(max), '-q:v', '8',
      path.join(work, 'f%05d.jpg'));
    await run('ffmpeg', args);
    const names = (await fsp.readdir(work)).filter((n) => n.endsWith('.jpg')).sort();
    const frames = [];
    for (const n of names) {
      const buf = await fsp.readFile(path.join(work, n));
      const dest = path.join(SEQ_DIR, `${crypto.createHash('md5').update(buf).digest('hex')}.jpg`);
      try { if (!(await fsp.stat(dest)).size) throw 0; } catch { await fsp.writeFile(dest, buf); }
      frames.push(dest);
    }
    return { frames, fps };
  } finally {
    try { await fsp.rm(work, { recursive: true, force: true }); } catch { /* nettoyage best-effort */ }
  }
}

// UN cadre d'un média, rendu en PNG minuscule EN MÉMOIRE (jamais sur disque : c'est un échantillon,
// pas une vignette à conserver — cf. thumbs.js pour ça).
//
// Sert la lecture des pixels côté renderer, qui n'a AUCUN moyen fiable d'y arriver seul : le
// protocole d'asset de la coquille teint le canvas (`getImageData` lève) et la voie HTTP dépend
// d'en-têtes CORS que la WebView n'honore pas toujours au chargement d'une <img>. Ici, ffmpeg lit le
// fichier SUR LE DISQUE — image fixe, GIF animé ou vidéo, peu importe — et le PNG rendu se charge en
// `data:` URL, donc sans la moindre restriction d'origine. C'est aussi la seule voie qui marche pour
// une source qu'aucun élément de la page n'a encore décodée.
async function sampleFrame(filePath, opts = {}) {
  const target = String(filePath || '');
  if (!target) return { ok: false, error: 'chemin manquant' };
  const side = Math.max(16, Math.min(512, Number(opts.side) || 220));
  const at = Math.max(0, Number(opts.at) || 0);
  const args = ['-v', 'error'];
  // Seek AVANT -i : rapide sur une vidéo. Sur une image fixe, un `-ss` non nul ne trouverait rien,
  // d'où la garde.
  if (at > 0) args.push('-ss', String(at));
  args.push(
    '-i', target,
    '-frames:v', '1',
    // Les deux côtés bornés à `side`, ratio conservé : une palette n'a pas besoin du détail fin, et
    // le coût cesse de dépendre du poids du fichier.
    '-vf', `scale='min(${side},iw)':'min(${side},ih)':force_original_aspect_ratio=decrease`,
    '-f', 'image2pipe', '-vcodec', 'png', '-',
  );
  try {
    // `encoding: 'buffer'` est indispensable : en utf8, execFile corromprait les octets du PNG.
    const out = await run('ffmpeg', args, { encoding: 'buffer' });
    const buf = Buffer.isBuffer(out) ? out : Buffer.from(out);
    if (!buf.length) return { ok: false, error: 'aucune image rendue' };
    return { ok: true, png: buf.toString('base64') };
  } catch (e) {
    const why = String((e && e.stderr) || (e && e.message) || e).trim().split(/\r?\n/).pop();
    return { ok: false, error: why || 'échec ffmpeg' };
  }
}

module.exports = { run, probeMedia, playInfo, probeAudioTracks, extractAudio, exportClip, extractFrames, compareFrames, sampleFrame };
