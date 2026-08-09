// @ts-check
// Construction des arguments ffmpeg d'encodage (vidéo/audio) selon un profil d'export.
// Un codec détaillé → -c:v + -profile:v + -pix_fmt + -crf|-cq.
// GPU = encodeurs matériels multi-vendeurs (NVENC NVIDIA / QSV Intel / AMF AMD) ; CPU = libx264/
// libx265/libsvtav1/libvpx-vp9/prores_ks/dnxhd/cfhd/ffv1. Le moteur core/export.js choisit GPU vs CPU
// et passe l'encodeur GPU résolu (ou null) — encodeur validé par une VRAIE sonde d'encodage
// (core/export/capabilities.js), jamais par la simple présence dans `ffmpeg -encoders`.

/**
 * @typedef {object} ExportProfileLike
 * @property {string} workflow
 * @property {string} codec
 * @property {string} audioMode
 * @property {string} container
 * @property {string} [encoderMode]
 * @property {string} [speed]
 */

/** Vrai si l'encodeur ffmpeg est un NVENC (cq vs crf). @param {string} enc */
function isNvenc(enc) {
  return /_nvenc$/.test(enc);
}

/** Vendeur matériel d'un encodeur ffmpeg, ou null si logiciel. @param {string} enc @returns {string|null} */
function hwVendor(enc) {
  if (/_nvenc$/.test(enc)) return 'nvenc';
  if (/_qsv$/.test(enc)) return 'qsv';
  if (/_amf$/.test(enc)) return 'amf';
  return null;
}

/** Vrai si l'encodeur est matériel. @param {string} enc */
function isHardwareEncoder(enc) {
  return hwVendor(enc) != null;
}

// Encodeurs matériels CANDIDATS par famille, par ordre de préférence (qualité/stabilité constatées).
// La sonde ne retient que ceux qui encodent RÉELLEMENT sur cette machine.
const HW_CANDIDATES = {
  h264: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
  h265: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf'],
  av1: ['av1_nvenc', 'av1_qsv', 'av1_amf'],
};

/** Famille d'un codec d'export (miroir de getCodecFamily côté renderer). @param {string} codec */
function codecFamily(codec) {
  if (codec.startsWith('h264_')) return 'h264';
  if (codec.startsWith('h265_')) return 'h265';
  if (codec.startsWith('av1_')) return 'av1';
  if (codec.startsWith('vp9')) return 'vp9';
  if (codec.startsWith('dnxhr_')) return 'dnxhr';
  if (codec.startsWith('cineform')) return 'cineform';
  if (codec === 'ffv1') return 'ffv1';
  return 'prores';
}

/**
 * Encodeurs matériels candidats pour un codec (avant sonde). Chaque couple codec/moteur possède ses
 * vrais profile/pix_fmt ; la sonde réelle élimine ensuite ce que le GPU physique ne sait pas faire.
 * @param {string} codec @returns {string[]}
 */
function hwCandidates(codec) {
  return (HW_CANDIDATES[codecFamily(codec)] || []).filter((encoder) => gpuCodecSpec(codec, encoder));
}

/**
 * Encodeur GPU disponible pour un codec, d'après les capacités SONDÉES.
 * `caps.codecEncoders` est le verdict empirique (codec → encodeur matériel qui encode vraiment).
 * @param {string} codec
 * @param {{ codecEncoders?: Record<string, string|null>, h264Encoder?: string|null, h265Encoder?: string|null, av1Encoder?: string|null }} caps
 * @returns {string|null}
 */
function selectGpuEncoder(codec, caps) {
  const probed = caps && caps.codecEncoders;
  if (probed && Object.prototype.hasOwnProperty.call(probed, codec)) return probed[codec] || null;
  // Repli (capacités non sondées) : ancien comportement par famille.
  if (codec.startsWith('h264_')) return (caps && caps.h264Encoder) || null;
  if (codec.startsWith('h265_')) return (caps && caps.h265Encoder) || null;
  if (codec.startsWith('av1_')) return (caps && caps.av1Encoder) || null;
  return null;
}

/**
 * Arguments vidéo. Si gpuEncoder fourni → encodeur matériel ; sinon CPU.
 * @param {string} codec
 * @param {string|null} gpuEncoder
 * @returns {string[]}
 */
function videoEncodeArgs(codec, gpuEncoder, speed = 'balanced') {
  if (gpuEncoder) return gpuVideoArgs(codec, gpuEncoder, speed);
  return cpuVideoArgs(codec, speed);
}

// Réglages matériels exacts par codec ET vendeur. Les profils avancés ne portent pas le même nom
// selon l'API (HEVC NVENC/QSV utilisent RExt ; AMF s'arrête à Main/Main10). Le probe tranche ensuite
// selon la génération du GPU : une option annoncée par ffmpeg mais refusée par le matériel disparaît.
/** @type {Record<string, { q: string, nvenc?: {profile?:string,pix:string}, qsv?: {profile?:string,pix:string}, amf?: {profile?:string,pix:string} }>} */
const GPU_MAP = {
  h264_baseline: { q: '20', nvenc: { profile: 'baseline', pix: 'nv12' }, qsv: { profile: 'baseline', pix: 'nv12' }, amf: { profile: 'constrained_baseline', pix: 'nv12' } },
  h264_main: { q: '19', nvenc: { profile: 'main', pix: 'nv12' }, qsv: { profile: 'main', pix: 'nv12' }, amf: { profile: 'main', pix: 'nv12' } },
  h264_high: { q: '19', nvenc: { profile: 'high', pix: 'nv12' }, qsv: { profile: 'high', pix: 'nv12' }, amf: { profile: 'high', pix: 'nv12' } },
  h264_high10: { q: '20', nvenc: { profile: 'high10', pix: 'p010le' } },
  h264_high422: { q: '20', nvenc: { profile: 'high422', pix: 'p210le' } },
  h264_high444: { q: '19', nvenc: { profile: 'high444p', pix: 'yuv444p' } },
  h265_main: { q: '19', nvenc: { profile: 'main', pix: 'nv12' }, qsv: { profile: 'main', pix: 'nv12' }, amf: { profile: 'main', pix: 'nv12' } },
  h265_main10: { q: '20', nvenc: { profile: 'main10', pix: 'p010le' }, qsv: { profile: 'main10', pix: 'p010le' }, amf: { profile: 'main10', pix: 'p010le' } },
  h265_main12: { q: '22', nvenc: { profile: 'rext', pix: 'p016le' }, qsv: { profile: 'rext', pix: 'p012le' } },
  h265_main422_10: { q: '21', nvenc: { profile: 'rext', pix: 'p210le' }, qsv: { profile: 'rext', pix: 'y210le' } },
  h265_main444: { q: '20', nvenc: { profile: 'rext', pix: 'yuv444p' }, qsv: { profile: 'rext', pix: 'vuyx' } },
  h265_main444_10: { q: '21', nvenc: { profile: 'rext', pix: 'yuv444p16le' }, qsv: { profile: 'rext', pix: 'xv30le' } },
  av1_main: { q: '28', nvenc: { profile: 'main', pix: 'nv12' }, qsv: { profile: 'main', pix: 'nv12' }, amf: { profile: 'main', pix: 'nv12' } },
  av1_main10: { q: '28', nvenc: { profile: 'main', pix: 'p010le' }, qsv: { profile: 'main', pix: 'p010le' }, amf: { profile: 'main', pix: 'p010le' } },
};

/** @param {string} codec @param {string} encoder */
function gpuCodecSpec(codec, encoder) {
  const vendor = hwVendor(encoder);
  const entry = GPU_MAP[codec];
  return vendor && entry ? entry[vendor] || null : null;
}

/**
 * Contrôle de débit en qualité constante, propre à chaque vendeur (mêmes réglages = noms différents).
 * @param {string} vendor @param {string} q @returns {string[]}
 */
function gpuRateArgs(vendor, q) {
  if (vendor === 'nvenc') return ['-cq', q];
  if (vendor === 'qsv') return ['-global_quality', q];
  if (vendor === 'amf') return ['-rc', 'cqp', '-qp_i', q, '-qp_p', q];
  return [];
}

/** @param {string} codec @param {string} enc @returns {string[]} */
function gpuVideoArgs(codec, enc, speed = 'balanced') {
  const vendor = hwVendor(enc);
  const entry = GPU_MAP[codec];
  const m = gpuCodecSpec(codec, enc);
  if (!vendor || !entry || !m) throw new Error(`encodeur ${enc} incompatible avec ${codec}`);
  const args = ['-c:v', enc];
  const normalizedSpeed = ['fast', 'quality', 'max'].includes(speed) ? speed : 'balanced';
  if (vendor === 'nvenc') {
    const preset = { fast: 'p2', balanced: 'p4', quality: 'p6', max: 'p7' }[normalizedSpeed];
    args.push('-preset', preset, '-tune', 'hq');
  } else if (vendor === 'qsv') {
    const preset = { fast: 'veryfast', balanced: 'medium', quality: 'slow', max: 'veryslow' }[normalizedSpeed];
    args.push('-preset', preset);
  } else if (vendor === 'amf') {
    const quality = { fast: 'speed', balanced: 'balanced', quality: 'quality', max: 'quality' }[normalizedSpeed];
    args.push('-usage', 'transcoding', '-quality', quality);
  }
  if (m.profile) args.push('-profile:v', m.profile);
  args.push('-pix_fmt', m.pix);
  args.push(...gpuRateArgs(vendor, entry.q));
  return args;
}

// Arguments CPU par codec. C'est AUSSI la liste de référence des codecs d'export connus du core
// (la sonde de capacités énumère ces clés) → tout nouveau codec s'ajoute ici.
/** @type {Record<string, string[]>} */
const CPU_TABLE = {
  h264_baseline: ['-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '19'],
  h264_main: ['-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18'],
  h264_high: ['-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18'],
  h264_high10: ['-c:v', 'libx264', '-profile:v', 'high10', '-pix_fmt', 'yuv420p10le', '-preset', 'slow', '-crf', '19'],
  h264_high422: ['-c:v', 'libx264', '-profile:v', 'high422', '-pix_fmt', 'yuv422p', '-preset', 'slow', '-crf', '18'],
  h265_main: ['-c:v', 'libx265', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20'],
  h265_main10: ['-c:v', 'libx265', '-profile:v', 'main10', '-pix_fmt', 'yuv420p10le', '-preset', 'slow', '-crf', '21'],
  h265_main12: ['-c:v', 'libx265', '-profile:v', 'main12', '-pix_fmt', 'yuv420p12le', '-preset', 'slow', '-crf', '22'],
  h265_main422_10: ['-c:v', 'libx265', '-profile:v', 'main422-10', '-pix_fmt', 'yuv422p10le', '-preset', 'slow', '-crf', '21'],
  h264_high444: ['-c:v', 'libx264', '-profile:v', 'high444', '-pix_fmt', 'yuv444p', '-preset', 'slow', '-crf', '18'],
  h265_main444: ['-c:v', 'libx265', '-profile:v', 'main444-8', '-pix_fmt', 'yuv444p', '-preset', 'slow', '-crf', '20'],
  h265_main444_10: ['-c:v', 'libx265', '-profile:v', 'main444-10', '-pix_fmt', 'yuv444p10le', '-preset', 'slow', '-crf', '21'],
  av1_main: ['-c:v', 'libsvtav1', '-pix_fmt', 'yuv420p', '-preset', '6', '-crf', '32'],
  av1_main10: ['-c:v', 'libsvtav1', '-pix_fmt', 'yuv420p10le', '-preset', '6', '-crf', '32'],
  // VP9 (libvpx-vp9) : web/WebM. `-b:v 0` = qualité constante pure (sinon le CRF est ignoré),
  // `-row-mt 1` = multi-thread par rangées (libvpx est lent sans).
  vp9: ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-crf', '31', '-b:v', '0', '-row-mt', '1'],
  vp9_10: ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p10le', '-crf', '31', '-b:v', '0', '-row-mt', '1'],
  prores_422_lt: ['-c:v', 'prores_ks', '-profile:v', '1', '-pix_fmt', 'yuv422p10le'],
  prores_422: ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le'],
  prores_422_hq: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'],
  prores_4444: ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le'],
  prores_4444_xq: ['-c:v', 'prores_ks', '-profile:v', '5', '-pix_fmt', 'yuva444p10le'],
  // DNxHR (Avid) : encodeur dnxhd, profils résolution-indépendants. hqx/444 = 10 bits.
  dnxhr_lb: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb', '-pix_fmt', 'yuv422p'],
  dnxhr_sq: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_sq', '-pix_fmt', 'yuv422p'],
  dnxhr_hq: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq', '-pix_fmt', 'yuv422p'],
  dnxhr_hqx: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hqx', '-pix_fmt', 'yuv422p10le'],
  dnxhr_444: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_444', '-pix_fmt', 'yuv444p10le'],
  // GoPro CineForm (cfhd) : intermédiaire visually-lossless. Échelle `-quality` INVERSÉE et bornée
  // (film3+ = 0 = meilleur … low = 12) : `filmscan1` n'existe pas côté ffmpeg et faisait échouer
  // l'encodage → film3 = qualité haute, film3+ = maximum.
  cineform: ['-c:v', 'cfhd', '-quality', 'film3', '-pix_fmt', 'yuv422p10le'],
  cineform_hq: ['-c:v', 'cfhd', '-quality', 'film3+', '-pix_fmt', 'yuv422p10le'],
  // FFV1 (archivage LOSSLESS, sans perte réelle) : level 3 + slices/slicecrc = résistance aux erreurs,
  // `-g 1` = tout en intra (chaque image décodable seule, exigence d'archivage).
  ffv1: ['-c:v', 'ffv1', '-level', '3', '-coder', '1', '-context', '1', '-g', '1', '-slices', '16', '-slicecrc', '1', '-pix_fmt', 'yuv422p10le'],
};

/** Tous les codecs d'export connus du core (source unique : la table CPU). @returns {string[]} */
function listCodecs() {
  return Object.keys(CPU_TABLE);
}

/** @param {string} codec @returns {string[]} */
function cpuVideoArgs(codec, speed = 'balanced') {
  const args = [...(CPU_TABLE[codec] || CPU_TABLE.h264_high)];
  const normalizedSpeed = ['fast', 'quality', 'max'].includes(speed) ? speed : 'balanced';
  const presetIndex = args.indexOf('-preset');
  if (presetIndex >= 0) {
    if (codec.startsWith('av1_')) {
      args[presetIndex + 1] = { fast: '10', balanced: '6', quality: '4', max: '2' }[normalizedSpeed];
    } else {
      args[presetIndex + 1] = { fast: 'veryfast', balanced: 'medium', quality: 'slow', max: 'veryslow' }[normalizedSpeed];
    }
  } else if (codec.startsWith('vp9')) {
    args.push('-cpu-used', { fast: '5', balanced: '3', quality: '2', max: '1' }[normalizedSpeed]);
  }
  return args;
}

// Arguments audio par mode. Table = liste de référence des codecs audio connus du core (miroir de
// EXPORT_AUDIO_OPTIONS côté renderer) → tout nouveau codec s'ajoute ICI et nulle part ailleurs.
// Trois codecs avec perte seulement (AAC diffusion, Opus web, MP3 compatibilité) déclinés en débits,
// plus les sans-perte du montage. Un mode inconnu (profil d'une version antérieure) retombe sur AAC.
/** @type {Record<string, string[]>} */
const AUDIO_TABLE = {
  copy: ['-c:a', 'copy'],
  none: ['-an'],
  aac_128: ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000'],
  aac: ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'],
  aac_256: ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000'],
  aac_320: ['-c:a', 'aac', '-b:a', '320k', '-ar', '48000'],
  opus_128: ['-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on', '-application', 'audio'],
  opus: ['-c:a', 'libopus', '-b:a', '160k', '-vbr', 'on', '-application', 'audio'],
  opus_192: ['-c:a', 'libopus', '-b:a', '192k', '-vbr', 'on', '-application', 'audio'],
  mp3_192: ['-c:a', 'libmp3lame', '-b:a', '192k'],
  mp3: ['-c:a', 'libmp3lame', '-b:a', '320k'],
  flac: ['-c:a', 'flac', '-compression_level', '5'],
  alac: ['-c:a', 'alac'],
  pcm16: ['-c:a', 'pcm_s16le', '-ar', '48000'],
  pcm24: ['-c:a', 'pcm_s24le', '-ar', '48000'],
};

/** Tous les codecs audio connus du core (source unique : la table audio). @returns {string[]} */
function listAudioModes() {
  return Object.keys(AUDIO_TABLE);
}

/** @param {string} audioMode @returns {string[]} */
function audioEncodeArgs(audioMode) {
  return [...(AUDIO_TABLE[audioMode] || AUDIO_TABLE.aac)];
}

/**
 * Tag conteneur obligatoire pour HEVC en mp4/mov (sinon lecteurs refusent).
 * @param {string} codec @param {string} ext @returns {string[]}
 */
function containerTagArgs(codec, ext) {
  const e = (ext || '').toLowerCase();
  if (codec.startsWith('h265_') && (e === 'mp4' || e === 'mov')) return ['-tag:v', 'hvc1'];
  return [];
}

/**
 * Mapping des flux, TOUJOURS explicite (ne PAS dépendre de la sélection par défaut de ffmpeg, qui
 * saute l'audio sur certains conteneurs et à la fusion concat). La vidéo est mappée + :
 *  - audioMode 'none'        → aucune piste audio (vidéo seule) ;
 *  - audioTrack index fourni → CETTE piste audio (fichiers multi-pistes), optionnelle (`?`) ;
 *  - défaut (audioTrack null)→ TOUTES les pistes audio (`0:a?`), optionnelles.
 * Le suffixe `?` rend le map audio optionnel → pas d'échec ffmpeg sur une source muette.
 * @param {number|null|undefined} audioTrack @param {string} audioMode @returns {string[]}
 */
function audioMapArgs(audioTrack, audioMode) {
  if (audioMode === 'none') return ['-map', '0:v:0'];
  if (audioTrack != null && audioTrack >= 0) return ['-map', '0:v:0', '-map', `0:a:${audioTrack}?`];
  return ['-map', '0:v:0', '-map', '0:a?'];
}

/**
 * Mapping audio pour la FUSION (concat demuxer : un seul input virtuel 0). Même logique, mais la vidéo
 * est optionnelle (`0:v:0?`) car des parts peuvent différer.
 * @param {string} audioMode @returns {string[]}
 */
function mergeMapArgs(audioMode) {
  return audioMode === 'none' ? ['-map', '0:v:0?'] : ['-map', '0:v:0?', '-map', '0:a?'];
}

module.exports = {
  selectGpuEncoder, videoEncodeArgs, gpuVideoArgs, cpuVideoArgs, audioEncodeArgs, audioMapArgs,
  mergeMapArgs, containerTagArgs, isNvenc, isHardwareEncoder, hwVendor, hwCandidates, listCodecs,
  listAudioModes, codecFamily,
};
