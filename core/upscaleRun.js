// @ts-check
// core/upscaleRun.js
// One shot range -> one upscaled file. Shared by the collection archive and by the profile export:
// both feed the SAME engines (`sidecars.runUpscale` / `turbo.runTurbo`) with the same arguments, so
// a setting added on one side cannot silently diverge on the other.
//
// The engine owns the cut (`segments`) and the encode (codec/container/audio taken from the export
// profile): an upscale replaces the pixels, so the stream copy of a remux can never produce it.

const path = require('node:path');
const { upscaleArgs, upscaleModelId, upscaleScale } = require('./upscaleArgs');

// Upscale encodes run at once. The AI engine loads a model into VRAM and saturates the GPU on its
// own; Turbo shaders (libplacebo) are light enough to run two.
const IA_CONCURRENCY = 1;
const TURBO_CONCURRENCY = 2;

/**
 * @typedef {{ enabled: true, engine: 'ia'|'turbo', model: string, scale: number, args: Record<string, any> }} NormalizedUpscale
 */

/**
 * Normalized upscale settings, or null when the option is off or unusable. The input is the
 * NetsuLab settings shape (`UpSettings` plus `enabled`), exactly as stored by the hosting screen —
 * `core/upscaleArgs.js` derives engine, model and arguments from it.
 * @param {any} u
 * @returns {NormalizedUpscale|null}
 */
function normalizeUpscale(u) {
  if (!u || !u.enabled) return null;
  const { engine, args } = upscaleArgs(u);
  const model = upscaleModelId(u);
  if (!model) return null;
  return { enabled: true, engine, model, scale: upscaleScale(u), args };
}

/**
 * How many upscale jobs may run at once for these settings.
 * @param {NormalizedUpscale|null} upscale
 */
function upscaleConcurrency(upscale) {
  return upscale && upscale.engine === 'turbo' ? TURBO_CONCURRENCY : IA_CONCURRENCY;
}

/**
 * Engine arguments for ONE shot: the source range, the exact destination file, and the encoding
 * settings of the export profile.
 * @param {{ upscale: NormalizedUpscale, profile: any, input: string, out: string,
 *           start: number, end: number, baseName?: string, audioTrack?: number|null }} job
 */
function upscaleClipArgs(job) {
  const { upscale, profile, input, out, start, end } = job;
  const track = job.audioTrack == null ? -1 : Number(job.audioTrack);
  return {
    ...upscale.args,
    input,
    // `savePath` = exact destination; `outDir` only backs the engine's own naming when it cannot be
    // honoured. One segment per call, so the single-job rule of runUpscale always applies.
    savePath: out,
    outDir: path.dirname(out),
    baseName: job.baseName || path.basename(out).replace(/\.[^.]+$/, ''),
    // Engines that cannot honour `savePath` (the RTX CLI writes its own MP4) at least name the file
    // after the destination, so the produced path stays next to the one the caller planned. Its
    // real path is what `runUpscaleClip` returns — never assume `out` was written.
    outputName: path.basename(out).replace(/\.[^.]+$/, ''),
    whole: false,
    segments: [{ in: start, out: end }],
    exportCodec: profile.codec,
    encoderMode: profile.encoderMode,
    speed: profile.speed,
    container: profile.container,
    audioMode: profile.audioMode,
    // Same rule as `encodeArgs.audioMapArgs`: an explicit track is mapped alone, no choice keeps
    // every track (`-1` on the engine side). The engines default to track 0 instead, which silently
    // dropped the other languages of a multi-track rush.
    audioTrack: Number.isFinite(track) && track >= 0 ? track : -1,
    importBack: false,
  };
}

/**
 * Produces one upscaled file. `turbo` hides three executions (GLSL shader, RTX CLI, ONNX weights)
 * behind one selector — the routing lives in `core/turbo.js` and nowhere else.
 * @param {any} event SSE shim ({ sender: { send } })
 * @param {Parameters<typeof upscaleClipArgs>[0]} job
 * @param {{ upscaleMod: any, turboMod?: any }} deps
 * @returns {Promise<{ ok: boolean, file: string|null, error: string|null }>}
 */
async function runUpscaleClip(event, job, deps) {
  const args = upscaleClipArgs(job);
  let r = null;
  try {
    r = job.upscale.engine === 'turbo'
      ? await deps.turboMod.runTurbo(deps.upscaleMod, event, args)
      : await deps.upscaleMod.runUpscale(event, args);
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  const produced = r && r.ok && Array.isArray(r.outputs) && r.outputs[0];
  return { ok: !!produced, file: produced || null, error: produced ? null : (r && r.error) || null };
}

module.exports = {
  normalizeUpscale, upscaleConcurrency, upscaleClipArgs, runUpscaleClip,
  IA_CONCURRENCY, TURBO_CONCURRENCY,
};
