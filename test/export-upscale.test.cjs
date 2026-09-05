// Upscale shared by the profile export and by a collection's archive: one shot range -> one file,
// produced by the upscale engine instead of ffmpeg. What matters here is the wiring, because a
// wrong argument only shows up minutes into a GPU job: the destination is imposed, the cut is a
// single segment, and the encoding settings come from the export profile.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const upscaleRun = require('../core/upscaleRun');

const PROFILE = {
  workflow: 'video_encode', codec: 'h265_main10', container: 'mkv',
  audioMode: 'copy', encoderMode: 'gpu', speed: 'quality',
};

const job = (extra = {}) => ({
  upscale: upscaleRun.normalizeUpscale({ enabled: true, mode: 'upscale', engine: 'ia', model: 'light', scale: 2, denoise: 0.3 }),
  profile: PROFILE,
  input: 'S:/rushes/rush-01.mkv',
  out: 'S:/exports/plan_001.mkv',
  start: 12.5,
  end: 18,
  ...extra,
});

test('an option left off produces nothing to run', () => {
  assert.strictEqual(upscaleRun.normalizeUpscale(null), null);
  assert.strictEqual(upscaleRun.normalizeUpscale({ enabled: false, model: 'light' }), null);
  // No model and no shader: the engine would have nothing to load.
  assert.strictEqual(upscaleRun.normalizeUpscale({ enabled: true, model: '' }), null);
});

test('the settings of the Traitements panel are read as they are', () => {
  const ia = upscaleRun.normalizeUpscale({ enabled: true, mode: 'upscale', engine: 'ia', model: 'light', scale: 4 });
  assert.strictEqual(ia.engine, 'ia');
  assert.strictEqual(ia.model, 'light');
  assert.strictEqual(ia.scale, 4);
  // Restoration models work at 1x whatever the picked scale says.
  const restore = upscaleRun.normalizeUpscale({ enabled: true, mode: 'restore', model: 'codeformer', scale: 4 });
  assert.strictEqual(restore.scale, 1);
  assert.strictEqual(restore.engine, 'ia');
  // Turbo is identified by its shader, not by a model.
  const turbo = upscaleRun.normalizeUpscale({ enabled: true, mode: 'upscale', engine: 'turbo', shader: 'artcnn_c4f32', scale: 2 });
  assert.strictEqual(turbo.engine, 'turbo');
  assert.strictEqual(turbo.model, 'artcnn_c4f32');
});

test('one shot = one segment, written exactly where the export planned it', () => {
  const args = upscaleRun.upscaleClipArgs(job());
  assert.strictEqual(args.input, 'S:/rushes/rush-01.mkv');
  assert.strictEqual(args.savePath, 'S:/exports/plan_001.mkv');
  assert.strictEqual(args.outDir, path.dirname('S:/exports/plan_001.mkv'));
  assert.strictEqual(args.outputName, 'plan_001');
  assert.strictEqual(args.whole, false);
  assert.deepStrictEqual(args.segments, [{ in: 12.5, out: 18 }]);
  assert.strictEqual(args.importBack, false);
});

test('the encoding is the profile one, never a default of the engine', () => {
  const args = upscaleRun.upscaleClipArgs(job());
  assert.strictEqual(args.exportCodec, 'h265_main10');
  assert.strictEqual(args.container, 'mkv');
  assert.strictEqual(args.audioMode, 'copy');
  assert.strictEqual(args.encoderMode, 'gpu');
  assert.strictEqual(args.speed, 'quality');
  // Model arguments travel along: denoise only exists on the models that expose it.
  assert.strictEqual(args.model, 'light');
  assert.strictEqual(args.scale, 2);
  assert.strictEqual(args.denoise, 0.3);
});

test('the audio track chosen for the shot is the one the engine keeps', () => {
  assert.strictEqual(upscaleRun.upscaleClipArgs(job({ audioTrack: 2 })).audioTrack, 2);
  // No explicit choice: every track, like an ffmpeg export — the engines would keep only the first.
  assert.strictEqual(upscaleRun.upscaleClipArgs(job()).audioTrack, -1);
  assert.strictEqual(upscaleRun.upscaleClipArgs(job({ audioTrack: null })).audioTrack, -1);
});

test('an AI model saturates the GPU alone, Turbo shaders run two at a time', () => {
  assert.strictEqual(upscaleRun.upscaleConcurrency({ engine: 'ia' }), 1);
  assert.strictEqual(upscaleRun.upscaleConcurrency({ engine: 'turbo' }), 2);
  assert.strictEqual(upscaleRun.upscaleConcurrency(null), 1);
});

test('the AI engine is called directly, Turbo through its router', async () => {
  const calls = [];
  const upscaleMod = { runUpscale: async (_ev, args) => { calls.push(['ia', args]); return { ok: true, outputs: [args.savePath] }; } };
  const turboMod = { runTurbo: async (mod, _ev, args) => { calls.push(['turbo', args, mod === upscaleMod]); return { ok: true, outputs: [args.savePath] }; } };

  const ia = await upscaleRun.runUpscaleClip(null, job(), { upscaleMod, turboMod });
  assert.deepStrictEqual([ia.ok, ia.file], [true, 'S:/exports/plan_001.mkv']);
  assert.strictEqual(calls[0][0], 'ia');

  const turbo = await upscaleRun.runUpscaleClip(null, job({
    upscale: upscaleRun.normalizeUpscale({ enabled: true, engine: 'turbo', shader: 'artcnn_c4f32', scale: 2 }),
  }), { upscaleMod, turboMod });
  assert.strictEqual(turbo.ok, true);
  assert.strictEqual(calls[1][0], 'turbo');
  // The router needs the AI engine: two of the three Turbo entries run on ONNX weights.
  assert.strictEqual(calls[1][2], true);
});

test('a failed job reports its error instead of a file', async () => {
  const refused = await upscaleRun.runUpscaleClip(null, job(), {
    upscaleMod: { runUpscale: async () => ({ ok: false, error: 'VRAM insuffisante' }) },
  });
  assert.deepStrictEqual(refused, { ok: false, file: null, error: 'VRAM insuffisante' });

  // A thrown engine must not take the whole batch down with it.
  const crashed = await upscaleRun.runUpscaleClip(null, job(), {
    upscaleMod: { runUpscale: async () => { throw new Error('sidecar mort'); } },
  });
  assert.strictEqual(crashed.ok, false);
  assert.match(crashed.error, /sidecar mort/);
});
