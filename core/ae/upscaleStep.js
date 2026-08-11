// @ts-check
// Upscale d'un plan pendant un transfert : le MÊME moteur que NetsuLab et que l'archivage d'une
// collection, avec les mêmes réglages (`UpSettings`). Rien n'est réimplémenté ici — ce module ne
// fait que traduire l'option du panneau en ce que `prepareMedia` attend.
//
// Deux vocabulaires d'encodage arrivent : celui de l'export AE (`codec: 'prores_422'`, `audio`) et
// celui des profils d'export (`exportCodec: 'h264_high'`, `container`…). Le moteur accepte les deux
// (cf. `resolveProcessEncoding`), donc l'appelant passe le sien tel quel plutôt que d'en convertir
// un dans l'autre — une conversion de plus serait une table de plus à faire diverger.

const { upscaleArgs, upscaleScale, upscaleModelId } = require('../upscaleArgs');

// Traitements audio de l'export AE → vocabulaire du moteur. Le PCM n'a pas d'équivalent : il
// retombe sur la copie du flux, qui est ce qui s'en approche le plus (aucune perte ajoutée).
const AUDIO_FOR_ENGINE = { none: 'none', aac: 'aac' };

/** Encodage AE (codec du panneau) dans la forme attendue par le moteur d'upscale. */
function aeEncoding(codec, audio, abr) {
  return { codec, audio: AUDIO_FOR_ENGINE[String(audio)] || 'copy', abr };
}

/**
 * @param {any} settings réglages du panneau (`UpSettings` + `enabled`)
 * @param {{ runUpscale?: Function, runTurbo?: Function }} engines exécutants déjà liés à l'événement
 * @param {any} encoding arguments d'encodage, dans le vocabulaire de l'appelant
 * @param {string} ext extension du fichier produit (elle doit suivre le conteneur choisi)
 * @returns {{ engine:string, args:any, encoding:any, ext:string, scale:number, model:string, run:Function }|null}
 */
function upscaleStep(settings, engines, encoding, ext) {
  if (!settings || !settings.enabled) return null;
  const { engine, args } = upscaleArgs(settings);
  const run = engine === 'turbo' ? engines.runTurbo : engines.runUpscale;
  if (typeof run !== 'function') return null;   // moteur non injecté : on n'invente pas d'upscale
  return { engine, args, encoding, ext, scale: upscaleScale(settings), model: upscaleModelId(settings), run };
}

module.exports = { upscaleStep, aeEncoding };
