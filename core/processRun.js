// @ts-check
// core/processRun.js
// One shot range -> one processed file. Shared by the collection archive (upscale only) and by the
// profile export (upscale, interpolation, depth): both feed the SAME engines as the Traitements
// panel, with the same arguments, so a setting added on one side cannot silently diverge.
//
// The engine owns the cut (`segments`) and the encode (codec/container/audio taken from the export
// profile): a processing pass replaces the pixels, which the stream copy of a remux cannot do.
//
// A profile may ask for TWO passes. They then run one after the other, file to file: the first cuts
// the shot and writes a temporary file, the last one writes the destination. Each op decodes and
// re-encodes its own file — same trade-off as the chain of the Traitements panel.

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { upscaleArgs, upscaleModelId, upscaleScale, upscaleTarget } = require('./upscaleArgs');

// Processing jobs run at once. A model loaded in VRAM saturates the GPU on its own; Turbo shaders
// (libplacebo) are the only ones light enough to run two.
const IA_CONCURRENCY = 1;
const TURBO_CONCURRENCY = 2;

/** Ops an export profile can run. Cutout is absent: its alpha needs a codec a profile may not carry. */
const PROCESS_KINDS = ['upscale', 'interpolate', 'depth'];

/**
 * `target` = resolution class of an upscale (1080, 1440, 2160), 0 when the factor applies.
 * @typedef {{ kind: string, engine: string, model: string, scale: number, target: number, args: Record<string, any> }} NormalizedProcess
 */

const num = (v, fallback) => (v == null || Number.isNaN(Number(v)) ? fallback : Number(v));

/**
 * Per-op mapping from the settings of the Traitements panel to the engine arguments. Twin of the
 * renderer hooks (`useUpscale` / `useInterpolate` / `useDepth`): the archive queue replays a job
 * from persisted settings, with no renderer alive, so the mapping has to exist here anyway.
 */
const OPS = {
  upscale: {
    id: (s) => upscaleModelId(s),
    scale: (s) => upscaleScale(s),
    target: (s) => upscaleTarget(s),
    engine: (s) => upscaleArgs(s).engine,
    args: (s) => upscaleArgs(s).args,
  },
  interpolate: {
    id: (s) => String((s && s.model) || ''),
    // The factor IS the scale of an interpolation: it multiplies the frames, not the pixels.
    scale: (s) => num(s && s.factor, 2),
    engine: () => 'ia',
    args: (s) => ({
      model: s.model, factor: num(s.factor, 2),
      // `null` = follow the factor; a target fps overrides it.
      targetFps: s.targetFps != null ? num(s.targetFps, null) : undefined,
      slowmo: !!s.slowmo, dedup: !!s.dedup,
    }),
  },
  depth: {
    id: (s) => String((s && s.model) || ''),
    scale: () => 1,
    engine: () => 'ia',
    args: (s) => ({ model: s.model, colormap: s.colormap, dedup: !!s.dedup }),
  },
};

/**
 * Normalized settings for one op, or null when it is unusable (unknown op, no model). The input is
 * the NetsuLab settings shape, exactly as stored by the hosting screen.
 * @param {string} kind @param {any} settings
 * @returns {NormalizedProcess|null}
 */
function normalizeProcess(kind, settings) {
  const op = OPS[kind];
  if (!op || !settings) return null;
  const model = op.id(settings);
  if (!model) return null;
  const target = 'target' in op ? op.target(settings) : 0;
  return { kind, engine: op.engine(settings), model, scale: op.scale(settings), target, args: op.args(settings) };
}

/** The passes of a job, as a list — one op and a chain of two are the same thing here. */
const stepsOf = (proc) => (Array.isArray(proc) ? proc : proc ? [proc] : []);

/**
 * The passes a screen asks for, in order, or null. A screen stores the settings of EVERY op it has
 * shown (`upscale`, `interpolate`, `depth`) and `kinds` names the ones that run: switching type in
 * the editor must not throw away what the other op was tuned to.
 * @param {any} p settings of an export profile or of a collection's archive
 * @returns {NormalizedProcess[]|null}
 */
function normalizeProcessSettings(p) {
  if (!p || !p.enabled) return null;
  const steps = [];
  for (const kind of Array.isArray(p.kinds) ? p.kinds : []) {
    // The same op twice would pay the GPU twice for what one pass already did.
    if (!PROCESS_KINDS.includes(kind) || steps.some((s) => s.kind === kind)) continue;
    const step = normalizeProcess(kind, p[kind]);
    if (step) steps.push(step);
  }
  return steps.length ? steps : null;
}

/** The upscale pass of a chain, if any — the only one the ledger can reason about. */
const upscaleStep = (proc) => stepsOf(proc).find((s) => s.kind === 'upscale') || null;

/**
 * How many jobs may run at once. A chain is only as parallel as its strictest step: the two ops
 * share one GPU.
 * @param {NormalizedProcess|NormalizedProcess[]|null} proc
 */
function processConcurrency(proc) {
  const limits = stepsOf(proc).map((s) => (s.kind === 'upscale' && s.engine === 'turbo' ? TURBO_CONCURRENCY : IA_CONCURRENCY));
  return limits.length ? Math.min(...limits) : IA_CONCURRENCY;
}

/**
 * Engine arguments for ONE pass: the source (a range of the rush, or the whole file handed over by
 * the previous pass), the destination file, and the encoding settings of the export profile.
 * @param {{ process: NormalizedProcess, profile: any, input: string, out: string,
 *           start?: number|null, end?: number|null, baseName?: string, audioTrack?: number|null,
 *           audioMode?: string }} job
 */
function processClipArgs(job) {
  const { process: proc, profile, input, out } = job;
  const track = job.audioTrack == null ? -1 : Number(job.audioTrack);
  const stem = path.basename(out).replace(/\.[^.]+$/, '');
  // No bounds = the whole file: the cut already happened, upstream in the chain.
  const cut = job.start != null && job.end != null;
  return {
    ...proc.args,
    input,
    // `savePath` = exact destination, honoured by the upscale engines only; every op also gets
    // `outputName`, which drops the engine's own suffix and lands the file on the planned name.
    // Its real path is what `runProcess` returns — never assume `out` was written.
    savePath: out,
    outDir: path.dirname(out),
    baseName: job.baseName || stem,
    outputName: stem,
    whole: !cut,
    segments: cut ? [{ in: job.start, out: job.end }] : undefined,
    exportCodec: profile.codec,
    encoderMode: profile.encoderMode,
    speed: profile.speed,
    container: profile.container,
    audioMode: job.audioMode || profile.audioMode,
    // Same rule as `encodeArgs.audioMapArgs`: an explicit track is mapped alone, no choice keeps
    // every track (`-1` on the engine side). The engines default to track 0 instead, which silently
    // dropped the other languages of a multi-track rush.
    audioTrack: Number.isFinite(track) && track >= 0 ? track : -1,
    importBack: false,
  };
}

/**
 * Runs ONE pass. `turbo` hides three executions (GLSL shader, RTX CLI, ONNX weights) behind one
 * selector — that routing lives in `core/turbo.js` and nowhere else.
 * @param {any} event @param {Parameters<typeof processClipArgs>[0]} job
 * @param {{ sidecars: any, turbo?: any }} deps
 * @returns {Promise<{ ok: boolean, file: string|null, error: string|null }>}
 */
async function runStep(event, job, deps) {
  const args = processClipArgs(job);
  const { kind, engine } = job.process;
  let r = null;
  try {
    if (kind === 'interpolate') r = await deps.sidecars.runInterpolate(event, args);
    else if (kind === 'depth') r = await deps.sidecars.runDepth(event, args);
    else if (engine === 'turbo') r = await deps.turbo.runTurbo(deps.sidecars, event, args);
    else r = await deps.sidecars.runUpscale(event, args);
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  const produced = r && r.ok && Array.isArray(r.outputs) && r.outputs[0];
  return { ok: !!produced, file: produced || null, error: produced ? null : (r && r.error) || null };
}

/**
 * Rescales the progress of pass `i` onto the whole chain, on whatever channel the engine speaks.
 * @param {any} event @param {number} i @param {number} total
 */
function stepEvent(event, i, total) {
  if (!event || !event.sender) return event;
  return { sender: { send: (ch, p) => event.sender.send(ch, {
    ...p, pct: Math.round(((i + Math.min(100, Math.max(0, Number(p && p.pct) || 0)) / 100) / total) * 100),
  }) } };
}

/**
 * Produces one processed file, through one pass or a chain of them. Only the FIRST pass cuts the
 * shot and reads the source's audio track; the ones after it take the whole file the previous one
 * wrote, and copy its audio rather than encoding the same track a second time.
 *
 * The progress of each pass is rescaled to the whole chain before it reaches the caller: two passes
 * that each count to 100 would otherwise send the bar backwards halfway through.
 * @param {any} event SSE shim ({ sender: { send } }) — passed to the engines
 * @param {{ process: NormalizedProcess|NormalizedProcess[], profile: any, input: string, out: string,
 *           start?: number|null, end?: number|null, baseName?: string, audioTrack?: number|null }} job
 * @param {{ sidecars: any, turbo?: any }} deps
 * @returns {Promise<{ ok: boolean, file: string|null, error: string|null, steps: number }>}
 */
async function runProcess(event, job, deps) {
  const steps = stepsOf(job.process);
  if (!steps.length) return { ok: false, file: null, error: null, steps: 0 };
  if (steps.length === 1) {
    const r = await runStep(event, { ...job, process: steps[0] }, deps);
    return { ...r, steps: 1 };
  }

  const ext = String((job.profile && job.profile.container) || 'mp4').toLowerCase();
  const stem = path.basename(job.out).replace(/\.[^.]+$/, '');
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'netsurush-process-'));
  /** @type {string[]} */
  const temps = [];
  try {
    let input = job.input;
    let r = { ok: false, file: null, error: null };
    for (let i = 0; i < steps.length; i++) {
      const last = i === steps.length - 1;
      const out = last ? job.out : path.join(work, `${stem}_${i + 1}.${ext}`);
      r = await runStep(stepEvent(event, i, steps.length), {
        ...job,
        process: steps[i],
        input,
        out,
        // The cut belongs to the first pass alone: the next ones read a file that IS the shot.
        start: i === 0 ? job.start : null,
        end: i === 0 ? job.end : null,
        audioMode: i === 0 ? undefined : 'copy',
      }, deps);
      if (!r.ok || !r.file) return { ...r, steps: steps.length };
      input = r.file;
      if (!last) temps.push(r.file);
    }
    return { ...r, steps: steps.length };
  } finally {
    for (const f of temps) { try { await fsp.rm(f, { force: true }); } catch (_) { /* best-effort */ } }
    try { await fsp.rm(work, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}

module.exports = {
  normalizeProcess, normalizeProcessSettings, upscaleStep, processConcurrency, processClipArgs, runProcess,
  PROCESS_KINDS, IA_CONCURRENCY, TURBO_CONCURRENCY,
};
