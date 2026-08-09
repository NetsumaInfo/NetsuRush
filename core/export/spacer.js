// @ts-check
// Séparateur NOIR intercalé entre les plans d'un export FUSIONNÉ : sans lui, deux plans consécutifs
// se touchent à l'image près et rien ne dit à l'œil où l'un finit. Module PUR (construction d'args et
// d'ordre de concaténation) — la sonde et l'exécution ffmpeg restent dans core/export.js.
//
// Le séparateur est un plan encodé comme les autres, PAS un filtre appliqué au montage : la fusion
// passe par le démuxeur `concat` en copie de flux, qui exige des paramètres identiques d'un morceau
// au suivant. On le fabrique donc aux dimensions, cadence et paramètres audio RÉELS du premier
// morceau produit — un silence à 44,1 kHz collé devant des plans à 48 kHz fait échouer la copie et
// force le ré-encodage de tout le montage (le repli existe, mais il coûte le prix fort).

// Encodeur ffmpeg à employer pour produire un silence dans le codec d'une piste existante. Les noms
// de décodeur et d'encodeur coïncident presque toujours ; ces quatre-là font exception.
const AUDIO_ENCODER_BY_CODEC = {
  opus: 'libopus',
  mp3: 'libmp3lame',
  vorbis: 'libvorbis',
  aac: 'aac',
};

// Dispositions reconnues par `anullsrc`. Au-delà, le stéréo est le repli le plus sûr : une couche de
// silence dans une disposition que le conteneur refuse ferait échouer le morceau entier.
const CHANNEL_LAYOUTS = { 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' };

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_FPS = 25;

/** @param {number} channels @returns {string} */
const channelLayout = (channels) => CHANNEL_LAYOUTS[channels] || 'stereo';

/**
 * Encodeur du silence. En mode « copie », les plans gardent le codec de leur source : le silence
 * doit donc être encodé DANS ce codec (on ne peut pas « copier » un flux qu'on vient de générer).
 * @param {string} audioMode @param {string} partCodec @param {string[]} audioArgs
 * @returns {string[]}
 */
function silenceCodecArgs(audioMode, partCodec, audioArgs) {
  if (audioMode !== 'copy') return audioArgs;
  return ['-c:a', AUDIO_ENCODER_BY_CODEC[partCodec] || partCodec || 'aac'];
}

/**
 * @typedef {object} SpacerSpec
 * @property {number} seconds   durée du noir
 * @property {number} width @property {number} height @property {number} fps
 * @property {{ codec: string, channels: number, sampleRate: number }|null} audio
 *           pistes du premier morceau ; null = les plans n'ont pas de son (le séparateur non plus,
 *           sinon la concaténation compare un flux à rien)
 * @property {string} audioMode @property {string[]} videoArgs @property {string[]} audioArgs
 * @property {string[]} tagArgs @property {string} out
 */

/**
 * Args ffmpeg produisant le morceau noir silencieux.
 * @param {SpacerSpec} spec @returns {string[]}
 */
function spacerArgs(spec) {
  const fps = spec.fps > 0 ? spec.fps : DEFAULT_FPS;
  const size = `${Math.max(2, spec.width)}x${Math.max(2, spec.height)}`;
  const args = ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${size}:r=${fps}:d=${spec.seconds}`];
  if (spec.audio) {
    const rate = spec.audio.sampleRate > 0 ? spec.audio.sampleRate : DEFAULT_SAMPLE_RATE;
    args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=${channelLayout(spec.audio.channels)}:sample_rate=${rate}`);
  }
  args.push('-t', String(spec.seconds), ...spec.videoArgs);
  args.push(...(spec.audio ? silenceCodecArgs(spec.audioMode, spec.audio.codec, spec.audioArgs) : ['-an']));
  args.push(...spec.tagArgs, spec.out);
  return args;
}

/**
 * Ordre de concaténation : le séparateur va ENTRE les plans, jamais en tête ni en queue — un montage
 * qui commence ou finit par du noir a l'air tronqué, alors qu'on ne voulait que marquer les coupes.
 * @param {string[]} parts @param {string|null} spacer @returns {string[]}
 */
function interleave(parts, spacer) {
  if (!spacer || parts.length < 2) return parts;
  return parts.flatMap((part, i) => (i === 0 ? [part] : [spacer, part]));
}

module.exports = { spacerArgs, interleave, channelLayout, silenceCodecArgs, AUDIO_ENCODER_BY_CODEC };
