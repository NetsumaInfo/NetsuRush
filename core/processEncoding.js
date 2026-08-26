// @ts-check
// Résolution du profil d'encodage NetsuLab. Réutilise strictement la taxonomie/les arguments de
// l'export général ; les anciens champs codec/profile restent un repli de migration.

const { getCapabilities } = require('./export/capabilities');
const {
  selectGpuEncoder, videoEncodeArgs, audioEncodeArgs, containerTagArgs,
  writtenAudioCodec, containerAcceptsAudio,
} = require('./export/encodeArgs');
const { probeAudioTracks } = require('./ffmpeg');
const { resolveInstalledCodec } = require('./adaptiveCodec');
const { codecExt } = require('./utils');

/** @param {string|undefined} mode @param {string[]} options */
function exactEncoder(mode, options) {
  const suffix = mode === 'nvenc' ? '_nvenc' : mode === 'amf' ? '_amf' : mode === 'qsv' ? '_qsv' : null;
  return suffix ? options.find((encoder) => encoder.endsWith(suffix)) || null : null;
}

/**
 * Codec de la piste audio que le job va RÉELLEMENT mapper (`atrack` = index relatif, comme
 * `-map 0:a:N`). Une sonde muette ne rend rien : aucune contrainte n'est déduite d'une lecture ratée.
 * @param {any} opts @returns {Promise<string|null>}
 */
async function sourceAudioCodec(opts) {
  const input = typeof opts?.input === 'string' && opts.input ? opts.input : null;
  if (!input) return null;
  const { tracks } = await probeAudioTracks(input);
  if (!tracks || !tracks.length) return null;
  const wanted = Number(opts?.audioTrack);
  const track = (Number.isFinite(wanted) && wanted >= 0 ? tracks[wanted] : tracks[0]) || tracks[0];
  return track.codec && track.codec !== '?' ? track.codec : null;
}

/**
 * Traitement audio arbitré CONTRE le conteneur. Le muxeur ne refuse qu'à l'écriture de l'en-tête,
 * donc après le job entier : copier le FLAC d'un rush dans un .mov tuait un upscale de dix minutes
 * à sa dernière seconde (« flac only supported in MP4 »). L'AAC est le seul repli que portent tous
 * les conteneurs de montage.
 * @param {string} container @param {string} audioMode @param {any} opts @returns {Promise<string>}
 */
async function audioModeForContainer(container, audioMode, opts) {
  if (audioMode === 'none') return audioMode;
  const written = writtenAudioCodec(audioMode, await sourceAudioCodec(opts));
  if (!written || containerAcceptsAudio(container, written)) return audioMode;
  console.warn(`[encode] ${written} n'entre pas dans un ${container} → repli AAC`);
  return 'aac';
}

/** @param {any} opts */
async function resolveProcessEncoding(opts) {
  const exportCodec = typeof opts?.exportCodec === 'string' && opts.exportCodec ? opts.exportCodec : null;
  if (!exportCodec) {
    const legacy = await resolveInstalledCodec(String(opts?.codec || 'x264'), opts?.profile, Number(opts?.bitDepth) || 8);
    const legacyContainer = codecExt(legacy.codec);
    return {
      ...legacy,
      ext: legacyContainer, container: legacyContainer,
      audioMode: await audioModeForContainer(legacyContainer, String(opts?.audio || 'copy'), opts),
      videoArgs: null, fallbackVideoArgs: null, audioArgs: null,
    };
  }

  const caps = await getCapabilities();
  const mode = String(opts?.encoderMode || 'gpu');
  const available = caps.codecEncoderOptions?.[exportCodec] || [];
  const gpuEncoder = mode === 'cpu' ? null
    : mode === 'gpu' ? selectGpuEncoder(exportCodec, caps)
      : exactEncoder(mode, available);
  // Valeur persistée devenue incompatible : le renderer la corrige après la sonde, le core garde
  // néanmoins un repli CPU sûr pour qu'un clic effectué pendant ce court délai ne casse pas le job.
  const speed = String(opts?.speed || 'balanced');
  const container = ['mp4', 'mkv', 'mov', 'webm'].includes(String(opts?.container)) ? String(opts.container) : 'mp4';
  const audioMode = await audioModeForContainer(container, String(opts?.audioMode || 'copy'), opts);
  const videoArgs = [...videoEncodeArgs(exportCodec, gpuEncoder, speed), ...containerTagArgs(exportCodec, container)];
  const fallbackVideoArgs = gpuEncoder
    ? [...videoEncodeArgs(exportCodec, null, speed), ...containerTagArgs(exportCodec, container)] : null;
  return {
    requested: exportCodec, codec: gpuEncoder || exportCodec, profile: null,
    hardware: !!gpuEncoder, vendor: gpuEncoder || null, capabilityKey: exportCodec,
    fallbackCodec: exportCodec, fallbackProfile: null,
    ext: container, container, audioMode,
    videoArgs, fallbackVideoArgs, audioArgs: audioEncodeArgs(audioMode),
  };
}

module.exports = { resolveProcessEncoding, audioModeForContainer };
