// @ts-check
// Choix de l'encodeur matériel d'un profil d'export, partagé par le moteur d'export fichier et par la
// préparation des médias de NetsuBridge : deux écrans qui encodent avec le même vocabulaire de profil
// doivent viser le même moteur, sinon un transfert « GPU » repart en CPU sans le dire.

const gpu = require('./gpu');
const { selectGpuEncoder } = require('./encodeArgs');

const VENDOR_SUFFIX = { nvenc: '_nvenc', amf: '_amf', qsv: '_qsv' };

/** @type {import('./gpu').GpuEncoderCapabilities|null} */
let capsCache = null;

/** @returns {Promise<import('./gpu').GpuEncoderCapabilities>} */
async function caps() {
  if (!capsCache) capsCache = await gpu.detectGpuCaps();
  return capsCache;
}

/**
 * Encodeur GPU à utiliser, ou null (CPU).
 * @param {{ workflow?: string, codec: string, encoderMode?: string }} profile
 * @returns {Promise<string|null>}
 */
async function pickGpuEncoder(profile) {
  if (profile.workflow && profile.workflow !== 'video_encode') return null;
  if (profile.encoderMode === 'cpu') return null;
  const c = await caps();
  if (!c.hasGpuEncoder) return null;
  const suffix = VENDOR_SUFFIX[profile.encoderMode];
  if (suffix) return (c.codecEncoderOptions?.[profile.codec] || []).find((encoder) => encoder.endsWith(suffix)) || null;
  return selectGpuEncoder(profile.codec, c);
}

module.exports = { pickGpuEncoder };
