// @ts-check
// core/upscaleArgs.js
// Réglages d'upscale (forme `UpSettings` du renderer) → arguments des moteurs.
//
// Pourquoi côté core et pas dans le renderer : la file d'archivage REJOUE un archivage depuis les
// réglages persistés, sans renderer vivant. Le mappage doit donc exister ici de toute façon ; le
// dupliquer côté renderer le ferait diverger.
//
// Jumeau de `src/components/upscale/useUpscale.ts` (mêmes noms d'arguments, mêmes règles) : les deux
// alimentent les MÊMES fonctions `runUpscale` / `runTurbo`. Toute option ajoutée là-bas se rajoute ici.

/** Shaders temps réel dont l'échelle est imposée par le SDK NVIDIA. */
const RTX_SHADERS = new Set(['rtx_vsr']);
/** Shaders adossés à un poids ONNX : ils passent par le moteur IA malgré leur place dans « Turbo ». */
const MODEL_BACKED_SHADERS = new Set(['artcnn_r16f96', 'artcnn_r8f64']);

const num = (v, fallback) => (v == null || Number.isNaN(Number(v)) ? fallback : Number(v));

/**
 * Le moteur réellement employé. « Restaurer » force l'IA (les modèles 1× n'ont pas d'équivalent
 * shader) ; sinon le champ `engine` fait foi, exactement comme dans le panneau Traitements.
 * @param {any} s
 */
function upscaleEngine(s) {
  if (!s || s.mode === 'restore') return 'ia';
  return s.engine === 'turbo' ? 'turbo' : 'ia';
}

/** Identité du traitement pour l'utilisateur : le modèle IA, ou le shader temps réel. */
function upscaleModelId(s) {
  return upscaleEngine(s) === 'turbo' ? String((s && s.shader) || '') : String((s && s.model) || '');
}

/** Échelle effective : les modèles de restauration travaillent à 1×, RTX VSR à 2× imposé. */
function upscaleScale(s) {
  if (!s) return 2;
  if (s.mode === 'restore') return 1;
  if (upscaleEngine(s) === 'turbo' && RTX_SHADERS.has(s.shader)) return 2;
  return num(s.scale, 2);
}

/**
 * Arguments propres au moteur (hors source, dossier et bornes, que l'appelant ajoute).
 * @param {any} s réglages d'upscale
 * @returns {{ engine: 'ia'|'turbo', args: Record<string, any> }}
 */
function upscaleArgs(s) {
  const settings = s || {};
  const engine = upscaleEngine(settings);
  const scale = upscaleScale(settings);

  if (engine === 'turbo') {
    return {
      engine,
      args: {
        shader: settings.shader, scale,
        deband: settings.tDeband, grain: settings.tGrain, sharp: settings.tSharp,
        sigmoid: settings.tSigmoid, dither: settings.tDither,
        vsrQuality: settings.rtxQuality, hdr: settings.rtxHdr,
        hdrContrast: settings.rtxHdrContrast, hdrSaturation: settings.rtxHdrSaturation,
        hdrMidGray: settings.rtxHdrMidGray, hdrNits: settings.rtxHdrNits,
      },
    };
  }
  return {
    engine,
    args: {
      model: settings.model, scale,
      // Le débruitage n'existe que sur les modèles qui l'exposent ; l'envoyer ailleurs serait ignoré
      // au mieux, contradictoire au pire (cf. useUpscale, qui le réserve au modèle « light »).
      denoise: settings.model === 'light' ? settings.denoise : undefined,
      tile: settings.tile, tilePad: settings.tilePad, prePad: settings.prePad, fp32: settings.fp32,
      cleanupNoise: settings.cleanupNoise, cleanupEdges: settings.cleanupEdges,
    },
  };
}

module.exports = { upscaleArgs, upscaleEngine, upscaleModelId, upscaleScale, RTX_SHADERS, MODEL_BACKED_SHADERS };
