// @ts-check
// Codecs / conteneurs / helpers de format pour l'export After Effects (ffmpeg args, extensions).

const path = require('path');
const fs = require('fs');
const { codecExt } = require('../utils');
const { gpuVideoArgs } = require('../export/encodeArgs');

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

function videoCodecArgs(codec) {
  if (codec === 'x264') return ['-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p'];
  if (codec === 'x265') return ['-c:v', 'libx265', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1'];
  if (/^h264_(?:nvenc|qsv|amf)$/.test(codec)) return gpuVideoArgs('h264_high', codec);
  if (/^hevc_(?:nvenc|qsv|amf)$/.test(codec)) return [...gpuVideoArgs('h265_main10', codec), '-tag:v', 'hvc1'];
  return FIXED_CODECS[codec] || FIXED_CODECS.prores_hq;
}

function audioCodecArgs(mode, abr) {
  if (mode === 'none') return ['-an'];
  if (mode === 'copy' || mode === 'remux') return ['-c:a', 'copy'];
  if (mode === 'aac') return ['-c:a', 'aac', '-b:a', `${abr || 192}k`];
  if (mode === 'ac3') return ['-c:a', 'ac3', '-b:a', `${abr || 192}k`];
  if (mode === 'flac') return ['-c:a', 'flac'];
  if (mode === 'pcm') return ['-c:a', 'pcm_s16le'];
  return ['-c:a', 'copy'];
}

function audioOut(mode, abr, container) {
  const ext = container || (mode === 'pcm' ? 'wav' : 'm4a');   // conteneurs importables par AE
  if (mode === 'remux' || mode === 'copy') return { ext, args: ['-c:a', 'copy'] };
  // L'AIFF ne porte pas de PCM little-endian : `-c:a pcm_s16le` y est refusé par le muxeur.
  if (mode === 'pcm' && ext === 'aiff') return { ext, args: ['-c:a', 'pcm_s16be'] };
  return { ext, args: audioCodecArgs(mode, abr) };
}

/**
 * Ce qu'un conteneur accepte RÉELLEMENT au muxage. Le remux ne convertit rien (`-c copy`) : c'est
 * le flux SOURCE qui doit entrer dans le conteneur, pas le codec choisi dans le panneau. Le MP4 est
 * le conteneur strict — il refuse ProRes, DNxHD et le PCM, que le MOV porte tous. Un rush ProRes
 * réencapsulé en MP4 est refusé au muxage.
 */
const MP4_VIDEO = new Set(['h264', 'hevc', 'h265', 'av1', 'mpeg4', 'vp9']);
const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac', 'opus']);

function containerAccepts(ext, videoCodec, audioCodec) {
  if (ext !== 'mp4' && ext !== 'm4a') return true;   // MOV : tout passe
  if (videoCodec && !MP4_VIDEO.has(videoCodec)) return false;
  if (audioCodec && !MP4_AUDIO.has(audioCodec)) return false;
  return true;
}

/**
 * Id d'encodeur du panneau → nom de FLUX (ce que ffprobe lit dans le fichier produit) : sans elle,
 * `x264` et `h264_nvenc` passent pour des codecs inconnus, donc refusés du MP4 — le conteneur
 * naturel du H.264.
 */
function streamCodecName(codec) {
  const id = String(codec || '');
  if (id === 'x264' || id.startsWith('h264_')) return 'h264';
  if (id === 'x265' || id.startsWith('hevc_') || id.startsWith('h265_')) return 'hevc';
  if (id.startsWith('prores')) return 'prores';
  if (id.startsWith('dnx')) return 'dnxhd';
  return id;
}

/**
 * Codec audio réellement écrit, selon le traitement demandé et ce que porte la source. Deux
 * vocabulaires arrivent ici : celui de l'export AE (`aac`, `pcm`) et celui des profils d'export
 * (`aac_192`, `pcm_s16`) — d'où la comparaison par préfixe et non par égalité.
 */
function outAudioCodec(mode, sourceCodec) {
  const id = String(mode || '');
  if (id === 'none') return null;
  if (id === 'copy' || id === 'remux') return sourceCodec || null;   // le flux source tel quel
  if (id.startsWith('pcm')) return 'pcm_s16le';
  if (id.startsWith('aac')) return 'aac';
  if (id.startsWith('ac3') || id.startsWith('eac3')) return 'ac3';
  if (id.startsWith('alac')) return 'alac';
  if (id.startsWith('flac')) return 'flac';
  return sourceCodec || null;
}

/**
 * Conteneur d'un fichier VIDÉO produit, rabattu sur le MOV quand le MP4 ne peut pas porter les flux.
 * `videoCodec` = codec réellement écrit (source en remux, codec choisi en réencode).
 */
function videoOutExt(wanted, videoCodec, audioCodec) {
  const ext = wanted || 'mov';
  return containerAccepts(ext, videoCodec, audioCodec) ? ext : 'mov';
}

/** Idem pour une piste son dédiée : le PCM d'un rush ProRes va en WAV, jamais en M4A. */
function audioOutExt(wanted, audioCodec) {
  const ext = wanted || 'm4a';
  if (containerAccepts(ext, null, audioCodec)) return ext;
  return /^pcm/.test(String(audioCodec)) ? 'wav' : 'mov';
}

// atempo borné [0.5, 2.0] → chaîne pour un facteur de vitesse quelconque.
function atempoChain(rate) {
  const parts = [];
  let x = rate;
  while (x > 2.0) { parts.push('atempo=2.0'); x /= 2.0; }
  while (x < 0.5) { parts.push('atempo=0.5'); x /= 0.5; }
  parts.push('atempo=' + x.toFixed(6));
  return parts.join(',');
}

function uniquePath(dir, base, ext) {
  let name = `${base}.${ext}`;
  let i = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${base} (${i++}).${ext}`;
  return path.join(dir, name);
}

const AUDIO_PRODUCES = new Set(['remux', 'aac', 'pcm']);

/**
 * Décisions de format d'un job de préparation, dans le vocabulaire de codecs de l'export AE.
 * `prepareMedia` ne connaît QUE cette forme : NetsuBridge lui en passe une autre, bâtie sur le
 * vocabulaire des profils d'export, sans que la préparation ait à connaître les deux tables.
 */
function aeFormat({ codec, audio, abr, videoContainer, audioContainer }) {
  return {
    ext: videoContainer || codecExt(codec),
    videoArgs: videoCodecArgs(codec),
    audioArgs: audioCodecArgs(audio, abr),
    audioOnly: audioOut(audio, abr, audioContainer),
    producesAudio: AUDIO_PRODUCES.has(audio),
  };
}

// Images fixes : jamais transcodées (resteraient des vidéos) → toujours liées telles quelles.
const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'tif', 'tiff', 'bmp', 'gif', 'exr', 'dpx', 'tga', 'webp', 'heic', 'heif', 'psd']);
const isImagePath = (p) => IMG_EXT.has(path.extname(p || '').slice(1).toLowerCase());

module.exports = {
  FIXED_CODECS, videoCodecArgs, audioCodecArgs, audioOut, atempoChain, uniquePath,
  AUDIO_PRODUCES, IMG_EXT, isImagePath, codecExt, aeFormat,
  containerAccepts, outAudioCodec, videoOutExt, audioOutExt, streamCodecName,
};
