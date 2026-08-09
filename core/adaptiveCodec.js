// @ts-check
// Résout le choix UI vers le moteur matériel exact réellement sondé sur cette machine.
// Les ids `*_gpu` restent des alias automatiques pour les anciens appels internes éventuels.

const { getCapabilities } = require('./export/capabilities');
const { detectHardware } = require('./hardware');
const { hwVendor } = require('./export/encodeArgs');

const H264_GPU = new Set(['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_gpu']);
const HEVC_GPU = new Set(['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_gpu']);

/** @param {string} codec */
function gpuFamily(codec) {
  if (H264_GPU.has(codec)) return 'h264';
  if (HEVC_GPU.has(codec)) return 'hevc';
  return null;
}

/** @param {'h264'|'hevc'} family @param {string|null|undefined} profile @param {number} bitDepth */
function profileKey(family, profile, bitDepth) {
  if (family === 'h264') {
    if (!profile) return 'h264_high';
    if (profile === 'baseline' || profile === 'main' || profile === 'high' || profile === 'high444') return `h264_${profile}`;
    return null; // 10/12-bit et 4:2:2 : CPU, qualité préservée.
  }
  if (profile === 'main10' || (!profile && bitDepth >= 10)) return 'h265_main10';
  if (profile === 'rext444-8') return 'h265_rext444_8';
  if (profile === 'rext444-10') return 'h265_rext444_10';
  if (!profile || profile === 'main') return 'h265_main';
  return null;
}

/** @param {'h264'|'hevc'} family @param {string|null|undefined} profile @param {number} bitDepth */
function cpuProfile(family, profile, bitDepth) {
  if (family === 'h264') return profile || 'high';
  if (profile === 'rext444-8') return 'main444-8';
  if (profile === 'rext444-10') return 'main444-10';
  return profile || (bitDepth >= 10 ? 'main10' : 'main');
}

/**
 * @typedef {object} AdaptiveCodec
 * @property {string} requested
 * @property {string} codec
 * @property {string|null} profile
 * @property {boolean} hardware
 * @property {string|null} vendor
 * @property {string|null} capabilityKey
 * @property {string} fallbackCodec
 * @property {string|null} fallbackProfile
 */

/**
 * Fonction pure, testable sans lancer ffmpeg.
 * @param {string} requested
 * @param {string|null|undefined} profile
 * @param {number} bitDepth
 * @param {{ codecEncoders?: Record<string, string|null>, codecEncoderOptions?: Record<string, string[]>, upscaleProfileEncoderOptions?: Record<string, string[]>, h264Encoder?: string|null, h265Encoder?: string|null, vendors?: string[] }} caps
 * @returns {AdaptiveCodec}
 */
function resolveAdaptiveCodec(requested, profile, bitDepth, caps) {
  const family = gpuFamily(String(requested));
  if (!family) {
    return {
      requested: String(requested), codec: String(requested), profile: profile || null,
      hardware: false, vendor: null, capabilityKey: null,
      fallbackCodec: String(requested), fallbackProfile: profile || null,
    };
  }

  const key = profileKey(family, profile, bitDepth | 0);
  const fallbackCodec = family === 'h264' ? 'x264' : 'x265';
  const fallbackProfile = cpuProfile(family, profile, bitDepth | 0);
  const automatic = String(requested).endsWith('_gpu');
  const physicalVendor = (encoder) => String(encoder).endsWith('_nvenc') ? 'nvidia'
    : String(encoder).endsWith('_amf') ? 'amd' : String(encoder).endsWith('_qsv') ? 'intel' : null;
  const vendorSet = Array.isArray(caps.vendors) ? new Set(caps.vendors) : null;
  const ofVendor = (encoders) => (vendorSet && vendorSet.size
    ? encoders.filter((encoder) => vendorSet.has(physicalVendor(encoder)))
    : encoders);
  // Sondes du profil, de la plus précise à la plus générale. Une clé ABSENTE = profil jamais sondé ;
  // une liste VIDE = profil sondé et REFUSÉ (ex. NVENC vivant mais incapable de Main 10) → CPU. Sans
  // cette distinction, un profil refusé retombait sur l'encodeur générique de la famille et
  // l'encodage échouait au runtime avec le moteur que la sonde venait justement d'écarter.
  // `strict` : une sonde par profil (liste d'encodeurs validés) fait AUTORITÉ, un choix explicite
  // absent de sa liste part sur le CPU. `codecEncoders` n'est qu'une digest héritée (un encodeur par
  // codec, sans vendeur) : un id explicite conservé depuis une autre machine y vaut « le GPU de
  // cette famille » et se résout sur le moteur réellement sondé.
  const PROBES = [
    { map: caps.upscaleProfileEncoderOptions, strict: true, single: false },
    { map: caps.codecEncoderOptions, strict: true, single: false },
    { map: caps.codecEncoders, strict: false, single: true },
  ];
  let probe = null;
  for (const source of PROBES) {
    if (!key || !source.map || !Object.prototype.hasOwnProperty.call(source.map, key)) continue;
    const value = source.map[key];
    probe = { strict: source.strict, options: ofVendor(source.single ? (value ? [value] : []) : (value || [])) };
    break;
  }
  const explicit = String(requested);
  const fromProbe = () => {
    if (automatic) return probe.options[0] || null;
    if (probe.options.includes(explicit)) return explicit;
    return probe.strict ? null : (probe.options[0] || null);
  };
  const generic = family === 'h264' ? caps.h264Encoder : caps.h265Encoder;
  const encoder = !key ? null
    : probe ? fromProbe()
      // Capacités partielles (aucune sonde par profil) : dernier recours = l'encodeur de famille.
      : automatic ? (ofVendor(generic ? [generic] : [])[0] || null) : null;
  if (!encoder) {
    return {
      requested: String(requested), codec: fallbackCodec, profile: fallbackProfile,
      hardware: false, vendor: null, capabilityKey: key,
      fallbackCodec, fallbackProfile,
    };
  }
  return {
    requested: String(requested), codec: encoder, profile: profile || null,
    hardware: true, vendor: hwVendor(encoder), capabilityKey: key,
    fallbackCodec, fallbackProfile,
  };
}

/** @param {string} requested @param {string|null|undefined} profile @param {number} bitDepth */
async function resolveInstalledCodec(requested, profile, bitDepth) {
  if (!gpuFamily(String(requested))) return resolveAdaptiveCodec(requested, profile, bitDepth, {});
  const [caps, hardware] = await Promise.all([getCapabilities(), detectHardware()]);
  const vendors = hardware.primaryVendor === 'cpu' || hardware.primaryVendor === 'other'
    ? [] : [hardware.primaryVendor];
  return resolveAdaptiveCodec(requested, profile, bitDepth, { ...caps, vendors });
}

module.exports = { resolveAdaptiveCodec, resolveInstalledCodec, gpuFamily, profileKey };
