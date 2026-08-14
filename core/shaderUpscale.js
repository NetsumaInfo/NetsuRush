// @ts-check
// Moteur d'upscale « Turbo » : shaders GLSL GPU via le filtre ffmpeg `libplacebo` (Vulkan). Aucun
// python, aucun réseau neuronal lourd → quasi temps réel. Alternative rapide au moteur IA
// (python/upscaler, Real-ESRGAN/CUGAN). 1 commande ffmpeg par job ; progression via -progress pipe.
// libplacebo gère la colorimétrie proprement → pas besoin du hack swscale du mode IA.

const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { ffBin, SHADER_DIR, UPSCALE_TEST_DIR, fsp } = require('./config');
const { importToMediaPool } = require('./resolve');
const { codecExt, sanitizeName } = require('./utils');
const { playInfo, probeMedia } = require('./ffmpeg');
const { t } = require('./i18n');
const { resolveProcessEncoding } = require('./processEncoding');

// Shaders Turbo : id (renderer) → fichier .glsl custom (custom_shader_path) OU scaler libplacebo
// intégré (`upscaler`, pas de fichier). Anime = CNN GLSL (ArtCNN/Anime4K) ; réel = lanczossharp.
// Suffixes ArtCNN : `_DS` = doubleur qui débruite ET accentue, `_DN` = doubleur qui débruite et
// adoucit. Ce sont des poids distincts, pas un post-filtre : ils ne se combinent pas avec la variante
// neutre du même réseau.
const SHADERS = {
  artcnn_c4f32:    { file: 'ArtCNN_C4F32.glsl', upscaler: null },
  artcnn_c4f32_ds: { file: 'ArtCNN_C4F32_DS.glsl', upscaler: null },
  artcnn_c4f32_dn: { file: 'ArtCNN_C4F32_DN.glsl', upscaler: null },
  artcnn_c4f16:    { file: 'ArtCNN_C4F16.glsl', upscaler: null },
  artcnn_c4f16_ds: { file: 'ArtCNN_C4F16_DS.glsl', upscaler: null },
  artcnn_c4f16_dn: { file: 'ArtCNN_C4F16_DN.glsl', upscaler: null },
  artcnn_quality:  { file: 'ArtCNN_C4F32_DS.glsl', upscaler: null },
  anime4k:        { file: 'Anime4K_ModeA.glsl', upscaler: null },
  anime4k_aa_hq:  { file: 'Anime4K_ModeAA_HQ.glsl', upscaler: null },
  anime4k_bb_hq:  { file: 'Anime4K_ModeBB_HQ.glsl', upscaler: null },
  lanczos:        { file: null, upscaler: 'ewa_lanczossharp' },
};

// Ces deux choix restent dans le même sélecteur « Shader », mais l'architecture R n'existe
// officiellement qu'en ONNX. Le routeur les envoie au sidecar sans créer de fausse version GLSL.
const MODEL_SHADERS = {
  artcnn_r16f96: 'artcnn_r16f96',
  artcnn_r8f64: 'artcnn_r8f64',
};
function modelForShader(id) { return MODEL_SHADERS[id] || null; }

// NVENC : libellés de vitesse x264 → paliers pX (p1 rapide … p7 qualité). Cohérent avec
// python/upscaler/codecs.py (NVENC_PRESET).
const NVENC_PRESET = {
  ultrafast: 'p1', superfast: 'p1', veryfast: 'p2', faster: 'p3',
  fast: 'p4', medium: 'p4', slow: 'p6', slower: 'p7', veryslow: 'p7',
};

// Codecs montage à paramètres fixes (CPU), mêmes profils que python/upscaler/codecs.py.
const FIXED_CODECS = {
  prores_proxy:  ['-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le'],
  prores_lt:     ['-c:v', 'prores_ks', '-profile:v', '1', '-pix_fmt', 'yuv422p10le'],
  prores_422:    ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le'],
  prores_hq:     ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'],
  prores_4444:   ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le'],
  prores_4444xq: ['-c:v', 'prores_ks', '-profile:v', '5', '-pix_fmt', 'yuva444p10le'],
  dnxhr_lb:      ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb',  '-pix_fmt', 'yuv422p'],
  dnxhr_sq:      ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_sq',  '-pix_fmt', 'yuv422p'],
  dnxhr_hq:      ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq',  '-pix_fmt', 'yuv422p'],
  dnxhr_hqx:     ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hqx', '-pix_fmt', 'yuv422p10le'],
  dnxhr_444:     ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_444', '-pix_fmt', 'yuv444p10le'],
};

// Profils codec réels (-profile:v) par codec réglable — miroir de python/upscaler/codecs.py.PROFILES.
// Chaque profil impose son pix_fmt (sous-échantillonnage chroma + profondeur). NVENC H.264 = pas de
// 10-bit ; NVENC HEVC 10-bit = p010le. Entrée = [nom -profile:v, pix_fmt].
const PROFILES = {
  x264: { baseline: ['baseline', 'yuv420p'], main: ['main', 'yuv420p'], high: ['high', 'yuv420p'],
    high10: ['high10', 'yuv420p10le'], high422: ['high422', 'yuv422p10le'], high444: ['high444', 'yuv444p10le'] },
  h264_nvenc: { baseline: ['baseline', 'yuv420p'], main: ['main', 'yuv420p'], high: ['high', 'yuv420p'],
    high444: ['high444p', 'yuv444p'] },
  x265: { main: ['main', 'yuv420p'], main10: ['main10', 'yuv420p10le'], main12: ['main12', 'yuv420p12le'],
    'main422-10': ['main422-10', 'yuv422p10le'], 'main422-12': ['main422-12', 'yuv422p12le'],
    'main444-8': ['main444-8', 'yuv444p'], 'main444-10': ['main444-10', 'yuv444p10le'],
    'main444-12': ['main444-12', 'yuv444p12le'] },
  hevc_nvenc: { main: ['main', 'yuv420p'], main10: ['main10', 'p010le'],
    'rext444-8': ['rext', 'yuv444p'], 'rext444-10': ['rext', 'yuv444p16le'] },
};

// [profil -profile:v | null, pix_fmt] pour un codec réglable. Profil explicite prioritaire, sinon
// repli sur la profondeur (8/10-bit 4:2:0) — compat avec l'ancien réglage.
function profileFor(codec, profile, bitDepth) {
  const family = String(codec).startsWith('h264_') ? 'h264' : String(codec).startsWith('hevc_') ? 'hevc' : null;
  const table = PROFILES[codec] || (family === 'h264' ? PROFILES.h264_nvenc : family === 'hevc' ? PROFILES.hevc_nvenc : null);
  if (table && profile && table[profile]) return table[profile];
  const ten = (bitDepth | 0) >= 10;
  if (codec === 'x264' || family === 'h264') return ['high', 'yuv420p'];
  if (codec === 'x265') return ten ? ['main10', 'yuv420p10le'] : ['main', 'yuv420p'];
  if (family === 'hevc') return ten ? ['main10', 'p010le'] : ['main', 'yuv420p'];
  return [null, 'yuv420p'];
}

// Pixel format demandé en sortie du filtre libplacebo, accordé au codec/profil/profondeur.
// Montage (ProRes/DNxHR) = format fixe ; encodeurs réglables = dérivé du profil.
function filterPixFmt(codec, bitDepth, profile) {
  if (codec === 'prores_4444' || codec === 'prores_4444xq') return 'yuva444p10le';
  if (String(codec).startsWith('prores')) return 'yuv422p10le';
  if (codec === 'dnxhr_hqx') return 'yuv422p10le';
  if (codec === 'dnxhr_444') return 'yuv444p10le';
  if (String(codec).startsWith('dnxhr')) return 'yuv422p';
  if (PROFILES[codec] || /^(?:h264|hevc)_(?:nvenc|qsv|amf)$/.test(String(codec))) return profileFor(codec, profile, bitDepth)[1];
  return 'yuv420p';
}

// Arguments d'encodage vidéo (NVENC GPU haute qualité par défaut ; x264/x265 CPU ; montage fixe).
// Le profil réel pilote -profile:v ET le pix_fmt (chroma + profondeur).
function videoCodecArgs(codec, quality, preset, bitDepth, profile) {
  if (codec === 'x264') {
    const [ffp, pix] = profileFor(codec, profile, bitDepth);
    return ['-c:v', 'libx264', '-crf', String(quality), '-preset', preset, '-profile:v', ffp, '-pix_fmt', pix];
  }
  if (codec === 'x265') {
    const [ffp, pix] = profileFor(codec, profile, bitDepth);
    return ['-c:v', 'libx265', '-crf', String(quality), '-preset', preset, '-profile:v', ffp, '-pix_fmt', pix, '-tag:v', 'hvc1'];
  }
  if (/^(?:h264|hevc)_(?:nvenc|qsv|amf)$/.test(String(codec))) {
    const family = String(codec).startsWith('h264_') ? 'h264' : 'hevc';
    const p = NVENC_PRESET[preset] || 'p5';
    const [ffp, pix] = profileFor(codec, profile, bitDepth);
    let args;
    if (String(codec).endsWith('_nvenc')) {
      args = ['-c:v', codec, '-preset', p, '-tune', 'hq', '-rc', 'vbr', '-cq', String(quality), '-b:v', '0', '-spatial-aq', '1', '-temporal-aq', '1'];
    } else if (String(codec).endsWith('_qsv')) {
      args = ['-c:v', codec, '-preset', preset, '-global_quality', String(quality)];
    } else {
      args = ['-c:v', codec, '-usage', 'transcoding', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(quality), '-qp_p', String(quality)];
    }
    if (ffp) args.push('-profile:v', ffp);
    args.push('-pix_fmt', String(codec).endsWith('_nvenc') ? pix : (String(pix).includes('10') ? 'p010le' : 'nv12'));
    if (family === 'hevc') args.push('-tag:v', 'hvc1');
    return args;
  }
  return FIXED_CODECS[codec] || FIXED_CODECS.prores_hq;
}

function audioCodecArgs(mode, abr) {
  if (mode === 'aac')  return ['-c:a', 'aac', '-b:a', `${abr | 0}k`];
  if (mode === 'ac3')  return ['-c:a', 'ac3', '-b:a', `${abr | 0}k`];
  if (mode === 'flac') return ['-c:a', 'flac'];
  if (mode === 'pcm')  return ['-c:a', 'pcm_s16le'];
  return ['-c:a', 'copy'];
}

// Certains builds ffmpeg (ex. git-master récents) embarquent libplacebo mais échouent à l'initialiser
// (« Error initializing filters » sur tout appel libplacebo, même minimal). On sonde donc UNE fois un
// ffmpeg dont libplacebo FONCTIONNE : binaire de la config d'abord, repli PATH si la config est cassée.
let _placeboBin; // undefined = pas encore sondé ; string = ffmpeg OK ; false = aucun

function testPlacebo(bin) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-init_hw_device', 'vulkan', '-f', 'lavfi',
      '-i', 'color=c=black:s=64x64:d=0.1', '-vf', 'libplacebo=w=128:h=128', '-f', 'null', '-'];
    execFile(bin, args, { timeout: 30000 }, (err) => resolve(!err));
  });
}

async function libplaceboBin() {
  if (_placeboBin !== undefined) return _placeboBin;
  const candidates = [ffBin('ffmpeg')];
  if (ffBin('ffmpeg') !== 'ffmpeg') candidates.push('ffmpeg'); // repli PATH si la config pointe un build cassé
  for (const c of candidates) {
    if (await testPlacebo(c)) { _placeboBin = c; return c; }
  }
  _placeboBin = false;
  return false;
}

// Nombre de frames d'un job (rush entier ou plage) → barre de progression réelle.
async function clipFrames(input, start, end) {
  const info = await playInfo(input).catch(() => ({ fps: 0, duration: 0 }));
  const fps = info.fps || 0;
  const dur = (start != null && end != null) ? Math.max(0, end - start) : (info.duration || 0);
  return Math.max(1, Math.round(dur * fps));
}

// `runOne`/`writeFrame` spawn ffmpeg with cwd = SHADER_DIR (the shader is passed as a relative
// name). A missing directory makes spawn fail with ENOENT, which surfaced as « ffmpeg introuvable »
// and sent everyone looking for the wrong problem — so name the real cause instead.
function shaderDirError() {
  return fs.existsSync(SHADER_DIR)
    ? null
    : `dossier des shaders absent — lance scripts/fetch-shaders.ps1 (dossier ${SHADER_DIR})`;
}

const even = (n) => Math.max(2, n - (n % 2)); // yuv420 exige des dimensions paires
// Une image de test ne doit jamais bloquer l'UI : un décodage qui patine est abandonné.
const FRAME_TIMEOUT_MS = 60_000;

// Débanding libplacebo (anti-aplats de dégradé, très utile en anime) : paliers (itérations/seuil) +
// grain réglable (masque les bandes résiduelles). level "none" → pas de débanding.
function debandOpts(level, grain) {
  const lv = { light: [1, 3], medium: [2, 5], strong: [3, 8] }[level];
  if (!lv) return '';
  return `:deband=1:deband_iterations=${lv[0]}:deband_threshold=${lv[1]}:deband_grain=${Math.max(0, grain | 0)}`;
}

// Construit la commande ffmpeg libplacebo d'un job. `cwd` = SHADER_DIR → le shader est passé en nom
// RELATIF (custom_shader_path=Fichier.glsl), ce qui évite l'échappement des chemins Windows (`C:\`)
// dans la chaîne de filtre. Les chemins entrée/sortie restent en argv absolus (pas d'échappement).
// `upscaler` = noyau de redimensionnement (la chroma pour un shader custom, OU le scaler entier pour
// l'option « réel »). sigmoid = anti-ringing/halos sur agrandissement. deband = anti-aplats.
function placeboFilter({ sh, ow, oh, sharp, sigmoid, deband, grain, dither, pix }) {
  const up = sharp === 'soft' ? 'spline36' : 'ewa_lanczossharp';
  let placebo = `libplacebo=w=${ow}:h=${oh}:upscaler=${up}`;
  if (sh.file) placebo += `:custom_shader_path=${sh.file}`;
  if (sigmoid === false) placebo += ':sigmoid=0';
  placebo += debandOpts(deband, grain);
  if (dither === false) placebo += ':dithering=none'; // tramage actif par défaut (réduit le banding 8-bit)
  return `${placebo}:format=${pix}`;
}

function buildArgs({ input, out, sh, ow, oh, codec, quality, preset, bitDepth, profile, audio, abr, audioTrack, start, end, deband, grain, sharp, sigmoid, dither, videoArgs, audioArgs, container }) {
  const pixArg = Array.isArray(videoArgs) ? videoArgs.indexOf('-pix_fmt') : -1;
  const pix = pixArg >= 0 && videoArgs[pixArg + 1] ? videoArgs[pixArg + 1] : filterPixFmt(codec, bitDepth, profile);
  const placebo = placeboFilter({ sh, ow, oh, sharp, sigmoid, deband, grain, dither, pix });
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
    '-init_hw_device', 'vulkan'];
  if (start != null) args.push('-ss', String(start));
  if (end != null && start != null) args.push('-t', String(Math.max(0, end - start)));
  args.push('-i', input, '-vf', placebo, '-map', '0:v:0');
  args.push(...(Array.isArray(videoArgs) ? videoArgs : videoCodecArgs(codec, quality, preset, bitDepth, profile)));
  if (audio !== 'none') {
    const track = audioTrack | 0;
    args.push('-map', track < 0 ? '0:a?' : `0:a:${track}?`, ...(Array.isArray(audioArgs) ? audioArgs : audioCodecArgs(audio, abr)));
  }
  else args.push('-an');
  if (container === 'mp4' || container === 'mov' || !container) args.push('-movflags', '+faststart');
  args.push(out);
  return args;
}

// Lance UN job ffmpeg, parse -progress (frame=N + progress=end) → 'upscale:progress'. Résout
// { ok, output|error } sans throw.
function runOne(event, bin, jobArgs, fileLabel, i, total, frames) {
  const send = (pct, phase) => { if (event?.sender) event.sender.send('upscale:progress', { file: fileLabel, pct, done: i, total, phase }); };
  send(1, 'model');
  return new Promise((resolve) => {
    const cp = spawn(bin, jobArgs, { cwd: SHADER_DIR });
    let errTail = '';
    let buf = '';
    cp.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        const mf = line.match(/^frame=(\d+)/);
        if (mf) send(Math.min(99, Math.round((parseInt(mf[1], 10) / frames) * 100)), 'upscale');
        else if (line === 'progress=end') send(100, 'upscale');
      }
    });
    cp.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-800); });
    cp.on('error', (e) => resolve({ ok: false, error: `ffmpeg introuvable : ${e.message}` }));
    cp.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: errTail.trim() || `ffmpeg code ${code} (Vulkan/libplacebo indisponible ?)` });
    });
  });
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit | 0), items.length) }, worker));
  return results;
}

// Upscale Turbo d'un clip : 1 job (rush entier ou plage) ou N jobs (plans sélectionnés). 1 fichier
// de sortie par job. Le renderer parallélise les sources ; ici, une source unique peut paralléliser
// ses plans avec la même limite explicite de concurrence.
async function runShaderUpscale(event, opts) {
  const { input, shader = 'artcnn_c4f32', scale = 2,
    quality = 20, preset = 'slow', bitDepth = 8, audio = 'copy', abr = 192, audioTrack = 0,
    deband = 'light', grain = 4, sharp = 'sharp', sigmoid = true, dither = true,
    outDir, segments, whole, importBack, baseName, outputName, savePath, parallel = false, concurrency = 2 } = opts || {};
  if (!input) return { ok: false, error: t('sourceMissing') };
  if (!outDir) return { ok: false, error: t('outputFolderMissing') };
  const dirErr = shaderDirError();
  if (dirErr) return { ok: false, error: dirErr };
  const resolved = await resolveProcessEncoding(opts || {});
  const sh = SHADERS[shader] || SHADERS.artcnn_c4f32;
  // Shader custom absent (vendor/shaders pas provisionné) → message clair plutôt qu'un échec ffmpeg obscur.
  if (sh.file && !fs.existsSync(path.join(SHADER_DIR, sh.file))) {
    return { ok: false, error: `shader « ${sh.file} » absent — lance scripts/fetch-shaders.ps1 (dossier ${SHADER_DIR})` };
  }
  // ffmpeg dont libplacebo fonctionne (le build provisionné peut l'avoir cassé) — sinon erreur explicite.
  const bin = await libplaceboBin();
  if (!bin) {
    return { ok: false, error: t('turboUnavailable') };
  }

  let dims;
  try { dims = await probeMedia(input); } catch (e) { return { ok: false, error: `source illisible : ${String(e)}` }; }
  if (!dims.width || !dims.height) return { ok: false, error: t('videoDimensionsMissing') };
  const s = scale | 0 || 1;
  const ow = even(dims.width * s);
  const oh = even(dims.height * s);

  const ext = resolved.ext || codecExt(resolved.codec);
  const customName = typeof outputName === 'string' && outputName.trim();
  const base = sanitizeName(customName || baseName || path.basename(input).replace(/\.[^.]+$/, ''));
  const jobs = (whole || !Array.isArray(segments) || !segments.length)
    ? [{ start: undefined, end: undefined, tag: '' }]
    : segments.map((seg, i) => ({ start: seg.in, end: seg.out, tag: `_plan${i + 1}` }));
  const total = jobs.length;
  const outputs = [];
  let lastErr = null;
  let usedEncoder = resolved.codec;

  const results = await mapConcurrent(jobs, parallel ? Math.min(4, Math.max(2, concurrency | 0)) : 1, async (j, i) => {
    // `savePath` = destination EXACTE imposée par l'appelant (cf. runUpscale) ; un seul job, sinon
    // les N sorties s'écraseraient.
    const out = (total === 1 && savePath)
      ? String(savePath)
      : path.join(outDir, `${base}${customName ? '' : `_turbo_${s}x`}${j.tag}.${ext}`);
    if (path.resolve(out).toLowerCase() === path.resolve(input).toLowerCase()) {
      return { ok: false, error: 'le nom de sortie écraserait le fichier source', out };
    }
    const fileLabel = path.basename(out);
    const frames = await clipFrames(input, j.start, j.end);
    const args = buildArgs({
      input, out, sh, ow, oh, codec: resolved.codec, quality: quality | 0, preset: String(preset), bitDepth: bitDepth | 0, profile: resolved.profile,
      audio: resolved.audioMode || String(audio), abr, audioTrack, start: j.start != null ? j.start : null, end: j.end != null ? j.end : null,
      deband: String(deband), grain, sharp: String(sharp), sigmoid: sigmoid !== false, dither: dither !== false,
      videoArgs: resolved.videoArgs, audioArgs: resolved.audioArgs, container: resolved.container,
    });
    let r = await runOne(event, bin, args, fileLabel, i, total, frames);
    if (!r.ok && resolved.hardware) {
      console.warn(`[turbo] ${resolved.codec} indisponible pendant le job, repli ${resolved.fallbackCodec}`);
      const fallbackArgs = buildArgs({
        input, out, sh, ow, oh, codec: resolved.fallbackCodec, quality: quality | 0, preset: String(preset), bitDepth: bitDepth | 0, profile: resolved.fallbackProfile,
        audio: resolved.audioMode || String(audio), abr, audioTrack, start: j.start != null ? j.start : null, end: j.end != null ? j.end : null,
        deband: String(deband), grain, sharp: String(sharp), sigmoid: sigmoid !== false, dither: dither !== false,
        videoArgs: resolved.fallbackVideoArgs, audioArgs: resolved.audioArgs, container: resolved.container,
      });
      r = await runOne(event, bin, fallbackArgs, fileLabel, i, total, frames);
      if (r.ok) usedEncoder = resolved.fallbackCodec;
    }
    return Object.assign({}, r, { out });
  });
  for (const r of results) {
    if (r.ok) outputs.push(r.out);
    else lastErr = r.error;
  }

  let imported = 0;
  if (importBack && outputs.length) {
    try { const res = await importToMediaPool(outputs); imported = res && res.count ? res.count : 0; } catch (_) {}
  }
  return { ok: outputs.length > 0, outputs, imported, total, failed: total - outputs.length, encoder: usedEncoder,
    error: outputs.length ? null : lastErr };
}

// Une image PNG écrite par ffmpeg (frame source telle quelle, ou passée par le filtre Turbo).
function writeFrame(bin, input, time, out, filter) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (filter) args.push('-init_hw_device', 'vulkan');
  args.push('-ss', String(Math.max(0, time)), '-i', input);
  if (filter) args.push('-vf', filter);
  args.push('-frames:v', '1', '-update', '1', '-f', 'image2', out);
  return new Promise((resolve) => {
    execFile(bin, args, { cwd: SHADER_DIR, timeout: FRAME_TIMEOUT_MS }, (err, _out, stderr) => {
      if (!err) return resolve({ ok: true });
      resolve({ ok: false, error: String(stderr || err).trim().split(/\r?\n/).pop() });
    });
  });
}

// Test du moteur Turbo sur UNE image → 2 PNG (avant / après), comme `sidecars.runUpscaleFrame` pour
// le moteur IA. Sans lui, l'aperçu n'existait tout simplement pas pour les shaders : le bouton
// disparaissait dès qu'un shader était choisi et il fallait lancer l'encodage complet pour juger.
async function runShaderFrame(opts) {
  const { input, time = 0, shader = 'artcnn_c4f32', scale = 2,
    deband = 'light', grain = 4, sharp = 'sharp', sigmoid = true, dither = true } = opts || {};
  if (!input) return { ok: false, error: t('sourceMissing') };
  const sh = SHADERS[shader];
  if (!sh) return { ok: false, error: `${t('unknownModel')}: ${shader}` };
  const dirErr = shaderDirError();
  if (dirErr) return { ok: false, error: dirErr };
  if (sh.file && !fs.existsSync(path.join(SHADER_DIR, sh.file))) {
    return { ok: false, error: `shader « ${sh.file} » absent — lance scripts/fetch-shaders.ps1 (dossier ${SHADER_DIR})` };
  }
  const bin = await libplaceboBin();
  if (!bin) return { ok: false, error: t('turboUnavailable') };
  let dims;
  try { dims = await probeMedia(input); } catch (e) { return { ok: false, error: `source illisible : ${String(e)}` }; }
  if (!dims.width || !dims.height) return { ok: false, error: t('videoDimensionsMissing') };

  const s = scale | 0 || 1;
  const ow = even(dims.width * s);
  const oh = even(dims.height * s);
  await fsp.mkdir(UPSCALE_TEST_DIR, { recursive: true });
  const id = `${Date.now()}_${Math.round(time * 1000)}`;
  const orig = path.join(UPSCALE_TEST_DIR, `orig_${id}.png`);
  const out = path.join(UPSCALE_TEST_DIR, `turbo_${id}.png`);
  // yuv444p en sortie de filtre : l'encodeur PNG convertit ensuite en RGB sans sous-échantillonner.
  const filter = placeboFilter({ sh, ow, oh, sharp, sigmoid, deband, grain, dither, pix: 'yuv444p' });

  const src = await writeFrame(bin, input, time, orig, null);
  if (!src.ok) return { ok: false, error: src.error };
  const up = await writeFrame(bin, input, time, out, filter);
  if (!up.ok) return { ok: false, error: up.error };
  return { ok: true, orig, out, width: ow, height: oh };
}

// Upscale d'une IMAGE FIXE par le moteur shader, vers un fichier choisi par l'appelant.
//
// NetsuBoard n'embarque aucun moteur IA : sans ce chemin, une image du board n'aurait AUCUN moyen
// d'être agrandie, alors que libplacebo traite une image exactement comme une vidéo d'une frame —
// c'est déjà ce que fait `runShaderFrame` pour l'aperçu, qui écrit dans un dossier de test et rend
// deux fichiers (avant/après). Ici on écrit un seul fichier, à l'emplacement demandé.
//
// This path writes ONE still frame, so an animated GIF is refused rather than silently flattened:
// `-frames:v 1` would keep its first image only. Animated sources go to `runShaderGif`.
async function runShaderImage(opts) {
  const { input, out, shader = 'artcnn_c4f32', scale = 2,
    deband = 'light', grain = 4, sharp = 'sharp', sigmoid = true, dither = true } = opts || {};
  if (!input) return { ok: false, error: t('sourceMissing') };
  if (!out) return { ok: false, error: t('sourceMissing') };
  if (/\.gif$/i.test(String(input))) return { ok: false, error: t('turboGifUnsupported') };
  const sh = SHADERS[shader];
  if (!sh) return { ok: false, error: `${t('unknownModel')}: ${shader}` };
  const dirErr = shaderDirError();
  if (dirErr) return { ok: false, error: dirErr };
  if (sh.file && !fs.existsSync(path.join(SHADER_DIR, sh.file))) {
    return { ok: false, error: `shader « ${sh.file} » absent — lance scripts/fetch-shaders.ps1 (dossier ${SHADER_DIR})` };
  }
  const bin = await libplaceboBin();
  if (!bin) return { ok: false, error: t('turboUnavailable') };
  let dims;
  try { dims = await probeMedia(input); } catch (e) { return { ok: false, error: `source illisible : ${String(e)}` }; }
  if (!dims.width || !dims.height) return { ok: false, error: t('videoDimensionsMissing') };

  const s = scale | 0 || 1;
  const ow = even(dims.width * s);
  const oh = even(dims.height * s);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  // yuv444p en sortie de filtre : l'encodeur PNG convertit ensuite en RGB sans sous-échantillonner.
  const filter = placeboFilter({ sh, ow, oh, sharp, sigmoid, deband, grain, dither, pix: 'yuv444p' });
  const r = await writeFrame(bin, input, 0, out, filter);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, output: out, width: ow, height: oh };
}

// Upscale of an ANIMATED GIF, frames and timing kept, GIF in and GIF out.
//
// A GIF is a video to libplacebo like anything else — what it is not is a video to the GIF muxer,
// which only takes 8-bit palettised frames while the filter hands back yuv444p. So the shaded stream
// is split in two: one branch computes the palette, the other is quantised against it. `stats_mode=
// diff` weights that palette towards the pixels that move rather than a static background, and
// `diff_mode=rectangle` rewrites only the changed area of each frame — without it a 2×/4× GIF grows
// far beyond its source for no visible gain.
//
// One ffmpeg pass, no intermediate frame dump: `palettegen` buffers the stream itself.
async function runShaderGif(opts) {
  const { input, out, shader = 'artcnn_c4f32', scale = 2,
    deband = 'light', grain = 4, sharp = 'sharp', sigmoid = true, dither = true } = opts || {};
  if (!input) return { ok: false, error: t('sourceMissing') };
  if (!out) return { ok: false, error: t('sourceMissing') };
  const sh = SHADERS[shader];
  if (!sh) return { ok: false, error: `${t('unknownModel')}: ${shader}` };
  const dirErr = shaderDirError();
  if (dirErr) return { ok: false, error: dirErr };
  if (sh.file && !fs.existsSync(path.join(SHADER_DIR, sh.file))) {
    return { ok: false, error: `shader « ${sh.file} » absent — lance scripts/fetch-shaders.ps1 (dossier ${SHADER_DIR})` };
  }
  const bin = await libplaceboBin();
  if (!bin) return { ok: false, error: t('turboUnavailable') };
  let dims;
  try { dims = await probeMedia(input); } catch (e) { return { ok: false, error: `source illisible : ${String(e)}` }; }
  if (!dims.width || !dims.height) return { ok: false, error: t('videoDimensionsMissing') };

  const s = scale | 0 || 1;
  const ow = even(dims.width * s);
  const oh = even(dims.height * s);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const placebo = placeboFilter({ sh, ow, oh, sharp, sigmoid, deband, grain, dither, pix: 'yuv444p' });
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
    '-init_hw_device', 'vulkan', '-i', input,
    '-filter_complex', `[0:v]${placebo}[up];[up]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-loop', '0', out]; // -loop 0 = boucle infinie, ce qu'est un GIF de référence sur un board
  const frames = await clipFrames(input);
  const r = await runOne(null, bin, args, path.basename(out), 0, 1, frames);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, output: out, width: ow, height: oh };
}

module.exports = { runShaderUpscale, runShaderFrame, runShaderImage, runShaderGif, SHADERS, modelForShader };
