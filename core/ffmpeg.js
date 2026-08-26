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

// Découpe FRAME-EXACTE d'un plan (extraction du Derush). Copie de flux seulement quand frameCut
// prouve l'exactitude sur les paquets source ; sinon ré-encodage précis h264 (GPU sondé, repli CPU)
// + copie audio (puis AAC si le conteneur refuse la piste). Un `-ss/-t` en copie aveugle reculait de
// 24-70 frames en tête sur les rips BluRay. Requires paresseux : capabilities requiert ce module.
async function exportClip({ input, start, end, output }) {
  if (end <= start) throw new Error('fin <= début');
  const frameCut = require('./export/frameCut');
  let fps = 0;
  try { fps = (await playInfo(input)).fps || 0; } catch (_) {}
  let plan = null;
  try { plan = await frameCut.planClip(input, start, end, fps); } catch (_) {}
  if (plan) {
    try {
      await run('ffmpeg', frameCut.copyArgs(input, plan, [], output));
      return output;
    } catch (_) { /* conteneur incompatible avec la copie → ré-encode ci-dessous */ }
  }
  const { pickGpuEncoder } = require('./export/encoder');
  const { videoEncodeArgs } = require('./export/encodeArgs');
  let enc = null;
  try { enc = await pickGpuEncoder({ workflow: 'video_encode', codec: 'h264_high' }); } catch (_) {}
  const bounds = frameCut.encodeCutBounds(start, end, fps);
  const base = bounds
    ? ['-y', '-ss', String(bounds.ss), '-i', input, '-t', String(bounds.duration), '-frames:v', String(bounds.vframes)]
    : ['-y', '-ss', String(start), '-i', input, '-t', String(end - start)];
  const cut = (encoder, audioArgs) => run('ffmpeg', [
    ...base,
    '-map', '0:v:0', '-map', '0:a?',
    ...videoEncodeArgs('h264_high', encoder), ...audioArgs,
    '-avoid_negative_ts', 'make_zero', output,
  ]);
  try {
    await cut(enc, ['-c:a', 'copy']);
  } catch (e) {
    try { await cut(enc, ['-c:a', 'aac', '-b:a', '192k']); }
    catch (_) { await cut(null, ['-c:a', 'aac', '-b:a', '192k']); } // dernier repli : tout CPU
  }
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
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// `image2pipe` concatène les PNG dans un seul flux : on les redécoupe en suivant leurs chunks
// (longueur + type + données + CRC) jusqu'à IEND. Chercher la signature à l'aveugle suffirait presque,
// mais rien n'interdit à ces 8 octets d'apparaître dans un IDAT compressé — le découpage serait faux.
function splitPngs(buf) {
  const out = [];
  let p = 0;
  while (p + 8 <= buf.length && buf.compare(PNG_SIG, 0, 8, p, p + 8) === 0) {
    let q = p + 8;
    while (q + 12 <= buf.length) {
      const len = buf.readUInt32BE(q);
      const type = buf.toString('latin1', q + 4, q + 8);
      q += 12 + len;
      if (type === 'IEND') break;
    }
    if (q > buf.length) break;
    out.push(buf.subarray(p, q));
    p = q;
  }
  return out;
}

async function sampleFrame(filePath, opts = {}) {
  const target = String(filePath || '');
  if (!target) return { ok: false, error: 'chemin manquant' };
  const side = Math.max(16, Math.min(512, Number(opts.side) || 220));
  const at = Math.max(0, Number(opts.at) || 0);
  // Plusieurs cadres = on couvre la PORTÉE lue au lieu de son premier instant. Une palette de plan
  // décrit ce qu'on voit du début à la fin ; une frame isolée ne dit rien d'un plan qui change de
  // lumière. Fin non fournie ⇒ la durée sondée du fichier.
  const count = Math.max(1, Math.min(32, Math.round(Number(opts.count) || 1)));
  let span = 0;
  if (count > 1) {
    let to = Number(opts.to);
    if (!Number.isFinite(to) || to <= at) {
      try { to = (await probeMedia(target)).duration || 0; } catch (_) { to = 0; }
    }
    if (to > at) span = to - at;
  }
  const frames = span > 0 ? count : 1;

  let err = '';
  const shoot = async (keyOnly) => {
    try {
      // `encoding: 'buffer'` est indispensable : en utf8, execFile corromprait les octets du PNG.
      const out = await run('ffmpeg', sampleArgs(target, at, span, frames, side, keyOnly), { encoding: 'buffer' });
      return splitPngs(Buffer.isBuffer(out) ? out : Buffer.from(out));
    } catch (e) {
      err = String((e && e.stderr) || (e && e.message) || e).trim().split(/\r?\n/).pop();
      return [];
    }
  };

  // Passe rapide d'abord (images clés seules). Un fichier peut n'en avoir presque aucune dans la
  // portée — plan fixe, aplat de couleur, GOP très long — et le tirage raterait alors des pans
  // entiers du plan. En dessous de la moitié de ce qui est demandé on repasse en décodage complet,
  // seul cas où l'extraction coûte le prix de la lecture.
  const enough = Math.max(2, Math.ceil(frames / 2));
  let pngs = frames > 1 ? await shoot(true) : [];
  if (pngs.length < Math.min(enough, frames)) pngs = await shoot(false);
  if (!pngs.length) return { ok: false, error: err || 'aucune image rendue' };
  // `png` reste le premier cadre : les appelants qui n'en veulent qu'un n'ont rien à changer.
  return { ok: true, png: pngs[0].toString('base64'), pngs: pngs.map((p) => p.toString('base64')) };
}

// Arguments d'un tirage de cadres.
//
// `keyOnly` est ce qui rend l'extraction fluide : `-skip_frame nokey` fait sauter au décodeur tout ce
// qui n'est pas une image clé, donc on lit une poignée d'images au lieu de toute la portée — et ces
// images-là sont justement celles qui DIFFÈRENT entre elles, puisqu'un encodeur en pose une à chaque
// rupture. Le `select` ne garde qu'une clé par tranche de temps pour que les cadres restent répartis
// du début à la fin au lieu de s'agglutiner sur un passage agité.
// Sans images clés exploitables, repli sur `fps` : décodage complet de la portée, cadence régulière.
function sampleArgs(target, at, span, frames, side, keyOnly) {
  const args = ['-v', 'error'];
  if (keyOnly) args.push('-skip_frame', 'nokey');
  // Seek AVANT -i : rapide sur une vidéo. Sur une image fixe, un `-ss` non nul ne trouverait rien,
  // d'où la garde.
  if (at > 0) args.push('-ss', String(at));
  args.push('-i', target);
  if (span > 0) args.push('-t', String(span));
  // Les deux côtés bornés à `side`, ratio conservé : une palette n'a pas besoin du détail fin, et
  // le coût cesse de dépendre du poids du fichier. Le redimensionnement passe AVANT la sélection :
  // ce qui suit travaille sur des vignettes.
  const scale = `scale='min(${side},iw)':'min(${side},ih)':force_original_aspect_ratio=decrease`;
  let vf = scale;
  const selecting = keyOnly && frames > 1 && span > 0;
  if (frames > 1 && span > 0) {
    vf = selecting
      ? `${scale},select='isnan(prev_selected_t)+gte(t-prev_selected_t,${(span / frames).toFixed(6)})'`
      : `fps=${(frames / span).toFixed(6)},${scale}`;
  }
  args.push('-vf', vf);
  // `select` laisse passer des cadres irréguliers : sans ça ffmpeg en dupliquerait pour tenir une
  // cadence constante et le tirage rendrait plusieurs fois la même image. Réservé à CETTE passe :
  // un ffmpeg trop ancien pour l'option échoue ici, et le repli `fps` (qui n'en a pas besoin) prend
  // le relais au lieu de faire tomber l'extraction entière.
  if (selecting) args.push('-fps_mode', 'passthrough');
  args.push(
    '-frames:v', String(frames),
    '-f', 'image2pipe', '-vcodec', 'png', '-',
  );
  return args;
}

module.exports = { run, probeMedia, playInfo, probeAudioTracks, extractAudio, exportClip, extractFrames, compareFrames, sampleFrame };
