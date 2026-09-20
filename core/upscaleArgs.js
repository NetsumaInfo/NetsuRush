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
 * Resolution class the output fits in (1080, 1440, 2160), 0 = the factor applies. Restoration keeps
 * the source size, and RTX VSR has its ×2 imposed by the NVIDIA SDK: neither takes a target.
 * @param {any} s
 */
function upscaleTarget(s) {
  if (!s || s.mode === 'restore') return 0;
  if (upscaleEngine(s) === 'turbo' && RTX_SHADERS.has(s.shader)) return 0;
  return Number(s.targetHeight) | 0;
}

/** yuv420 exige des dimensions paires ; jamais moins de 2 px. */
const even = (n) => Math.max(2, Math.round(n) - (Math.round(n) % 2));

/** Rounds up, ignoring float noise (1920.0000001 stays 1920). */
const ceilPx = (n) => Math.max(1, Math.ceil(n - 1e-6));

/** Resolution class a model is never fed above: the HD box, 1920×1080. */
const FEED_CAP = 1080;

/**
 * Factor fitting an image inside a resolution class. A class is named after its short side and
 * spans 16:9, oriented like the image: 1080 is the 1920×1080 box, so a 1920×800 scope frame and
 * a 1080×1920 vertical frame are both 1080p.
 */
function boxScale(width, height, short) {
  const long = (short * 16) / 9;
  const [boxW, boxH] = width >= height ? [long, short] : [short, long];
  return Math.min(boxW / width, boxH / height);
}

/** Source dimensions fitted inside a resolution class, ratio kept, even for yuv420. */
function fitBox(width, height, short) {
  const s = boxScale(width, height, short);
  return { width: even(width * s), height: even(height * s) };
}

/**
 * What the engine is fed, and what must come out of it.
 *
 * A network ALWAYS outputs `native × input`: the input is the only free choice, and inference
 * cost follows its pixels. Hence three rules:
 *  - the input is the source, brought down to the 1080p box when it is larger (above it a network
 *    pays 2-4× the time for detail most masters never had), and never reduced below that;
 *  - when the network cannot reach the output from there, the input is enlarged BEFORE it:
 *    enlarging after it would make up pixels it never saw;
 *  - otherwise the network overshoots and its result is reduced to the output, including a
 *    1080p → 1080p job, which comes out cleaner than the source.
 *
 * Twin of `plan_size` in python/upscaler/plan.py, which does the actual work once the model (and
 * so its native factor) is loaded. Both are checked against test/fixtures/upscale-plan.json.
 *
 * @param {{ srcWidth: number, srcHeight: number, target?: number, scale?: number, native?: number }} o
 *   `target` = resolution class (1080, 1440, 2160); 0 = the `scale` factor applies.
 *   `native` missing or 0 = free-size engine (libplacebo): it renders the output directly.
 * @returns {{ feed: { width: number, height: number }, out: { width: number, height: number },
 *             resample: 'none'|'down' } | null}
 *   `null` when the source dimensions are missing.
 */
function upscalePlan({ srcWidth, srcHeight, target = 0, scale = 1, native = 0 }) {
  if (!srcWidth || !srcHeight) return null;
  const outScale = target ? boxScale(srcWidth, srcHeight, target) : (scale | 0 || 1);
  const out = { width: even(srcWidth * outScale), height: even(srcHeight * outScale) };
  const src = { width: srcWidth, height: srcHeight };
  if (!native) return { feed: src, out, resample: 'none' };

  const cap = Math.min(1, boxScale(srcWidth, srcHeight, FEED_CAP));
  const feedScale = Math.max(cap, outScale / native);
  // Rounded up: `native × input` must never land below the output, or it would have to be
  // enlarged after the network.
  const feed = feedScale === 1 ? src
    : { width: ceilPx(srcWidth * feedScale), height: ceilPx(srcHeight * feedScale) };
  const exact = feed.width * native === out.width && feed.height * native === out.height;
  return { feed, out, resample: exact ? 'none' : 'down' };
}

/**
 * Output size of a free-size engine: the resolution class when one is given, the factor
 * otherwise. Surfaces that send no target (board) keep their behaviour.
 * @param {{ width: number, height: number }} dims probed source dimensions
 * @param {number} [scale] factor
 * @param {number} [target] resolution class (1080, 1440, 2160)
 */
function outputSize(dims, scale, target) {
  const plan = upscalePlan({ srcWidth: dims.width, srcHeight: dims.height, target, scale });
  return plan ? plan.out : { width: even(0), height: even(0) };
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
  const targetHeight = upscaleTarget(settings);

  if (engine === 'turbo') {
    return {
      engine,
      args: {
        shader: settings.shader, scale, targetHeight,
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
      model: settings.model, scale, targetHeight,
      // Le débruitage n'existe que sur les modèles qui l'exposent ; l'envoyer ailleurs serait ignoré
      // au mieux, contradictoire au pire (cf. useUpscale, qui le réserve au modèle « light »).
      denoise: settings.model === 'light' ? settings.denoise : undefined,
      tile: settings.tile, tilePad: settings.tilePad, prePad: settings.prePad, fp32: settings.fp32,
      cleanupNoise: settings.cleanupNoise, cleanupEdges: settings.cleanupEdges,
    },
  };
}

module.exports = { upscaleArgs, upscaleEngine, upscaleModelId, upscaleScale, upscaleTarget, upscalePlan, outputSize, fitBox, even,
  FEED_CAP, RTX_SHADERS, MODEL_BACKED_SHADERS };
