// @ts-check
// Résolution du profil d'encodage NetsuLab. Réutilise strictement la taxonomie/les arguments de
// l'export général ; les anciens champs codec/profile restent un repli de migration.

const { getCapabilities } = require('./export/capabilities');
const {
  selectGpuEncoder, videoEncodeArgs, audioEncodeArgs, containerTagArgs,
} = require('./export/encodeArgs');
const { resolveInstalledCodec } = require('./adaptiveCodec');
const { codecExt } = require('./utils');

/** @param {string|undefined} mode @param {string[]} options */
function exactEncoder(mode, options) {
  const suffix = mode === 'nvenc' ? '_nvenc' : mode === 'amf' ? '_amf' : mode === 'qsv' ? '_qsv' : null;
  return suffix ? options.find((encoder) => encoder.endsWith(suffix)) || null : null;
}

/** @param {any} opts */
async function resolveProcessEncoding(opts) {
  const exportCodec = typeof opts?.exportCodec === 'string' && opts.exportCodec ? opts.exportCodec : null;
  if (!exportCodec) {
    const legacy = await resolveInstalledCodec(String(opts?.codec || 'x264'), opts?.profile, Number(opts?.bitDepth) || 8);
    return {
      ...legacy,
      ext: codecExt(legacy.codec), container: codecExt(legacy.codec), audioMode: String(opts?.audio || 'copy'),
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
  const audioMode = String(opts?.audioMode || 'copy');
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

module.exports = { resolveProcessEncoding };
