// @ts-check
// Aiguillage du panier « temps réel » : l'UI n'expose qu'UN sélecteur, mais trois exécutions
// possibles se cachent derrière — shader GLSL via ffmpeg libplacebo, CLI NVIDIA RTX VSR, ou poids
// ArtCNN R exécuté par le sidecar ONNX. Le choix est fait ICI, à un seul endroit : les deux
// appelants (panneau Traitements et board de référence) divergeaient sinon au moindre ajout.

const shaderUpscale = require('./shaderUpscale');
const rtxUpscale = require('./rtxUpscale');
const { t } = require('./i18n');

// Entrées du sélecteur servies par le CLI RTX Video SDK plutôt que par libplacebo.
const RTX_SHADERS = new Set(['rtx_vsr']);

/**
 * @param {{ runUpscale: (event: any, opts: any) => Promise<any> }} sidecars
 * @param {any} event
 * @param {any} opts options d'upscale, `shader` = id du sélecteur temps réel
 */
function runTurbo(sidecars, event, opts) {
  const shader = opts && opts.shader;
  if (RTX_SHADERS.has(shader)) return rtxUpscale.runRtxUpscale(event, opts);
  const model = shaderUpscale.modelForShader(shader);
  if (model) return sidecars.runUpscale(event, Object.assign({}, opts, { model }));
  return shaderUpscale.runShaderUpscale(event, opts);
}

/**
 * Test sur UNE image, même aiguillage que `runTurbo`. `engine !== 'turbo'` → moteur IA (le cas
 * nominal). RTX VSR n'a pas d'équivalent image : son CLI ne traite que des fichiers vidéo entiers.
 * @param {{ runUpscaleFrame: (opts: any) => Promise<any>, recordTestFrames: (res: any, source: string, files: string[]) => any }} sidecars
 * @param {any} opts options de test, `engine`/`shader` = choix du sélecteur unique
 */
async function runTurboFrame(sidecars, opts) {
  const o = opts || {};
  if (o.engine !== 'turbo') return sidecars.runUpscaleFrame(o);
  if (RTX_SHADERS.has(o.shader)) return { ok: false, error: t('turboFrameUnsupported') };
  const model = shaderUpscale.modelForShader(o.shader);
  if (model) return sidecars.runUpscaleFrame(Object.assign({}, o, { model }));
  const res = await shaderUpscale.runShaderFrame(o);
  return sidecars.recordTestFrames(res, o.input, [res.orig, res.out].filter(Boolean));
}

/**
 * Upscale d'une IMAGE, même aiguillage que `runTurbo`. Le GIF animé a son propre chemin des deux
 * côtés : une image fixe est rendue en une frame, un GIF garde ses frames et sa cadence. RTX VSR n'a
 * pas d'équivalent image (son CLI ne traite que des fichiers vidéo entiers) : il est refusé ici
 * plutôt que substitué en silence par un autre moteur.
 * @param {{ runUpscaleImage: (opts: any) => Promise<any>, runUpscaleGif: (opts: any) => Promise<any> }} sidecars
 * @param {any} opts options d'upscale, `shader` = id du sélecteur temps réel
 */
function runTurboImage(sidecars, opts) {
  const o = opts || {};
  if (RTX_SHADERS.has(o.shader)) return Promise.resolve({ ok: false, error: t('turboFrameUnsupported') });
  const gif = /\.gif$/i.test(String(o.input || ''));
  const model = shaderUpscale.modelForShader(o.shader);
  if (model) {
    const withModel = Object.assign({}, o, { model });
    return gif ? sidecars.runUpscaleGif(withModel) : sidecars.runUpscaleImage(withModel);
  }
  return gif ? shaderUpscale.runShaderGif(o) : shaderUpscale.runShaderImage(o);
}

/**
 * Cet id du sélecteur unique relève-t-il du panier « temps réel » ? Répondre ici évite de recopier
 * la liste des shaders chez chaque appelant (elle vit à trois endroits : GLSL, RTX, poids ONNX).
 * @param {string} id
 */
function isTurboShader(id) {
  return RTX_SHADERS.has(id) || !!shaderUpscale.SHADERS[id] || !!shaderUpscale.modelForShader(id);
}

module.exports = { runTurbo, runTurboFrame, runTurboImage, isTurboShader, RTX_SHADERS };
