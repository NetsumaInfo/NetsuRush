// Processing pass shared by the profile export and by a collection's archive: one shot range -> one
// file, produced by an AI engine instead of ffmpeg. What matters here is the wiring, because a wrong
// argument only shows up minutes into a GPU job: the destination is imposed, the cut is a single
// segment, and the encoding settings come from the export profile.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const processRun = require('../core/processRun');

const PROFILE = {
  workflow: 'video_encode', codec: 'h265_main10', container: 'mkv',
  audioMode: 'copy', encoderMode: 'gpu', speed: 'quality',
};

const UPSCALE = { enabled: true, mode: 'upscale', engine: 'ia', model: 'light', scale: 2, denoise: 0.3 };

const job = (extra = {}) => ({
  process: processRun.normalizeProcess('upscale', UPSCALE),
  profile: PROFILE,
  input: 'S:/rushes/rush-01.mkv',
  out: 'S:/exports/plan_001.mkv',
  start: 12.5,
  end: 18,
  ...extra,
});

test('an unusable pass produces nothing to run', () => {
  assert.strictEqual(processRun.normalizeProcess('upscale', null), null);
  // No model and no shader: the engine would have nothing to load.
  assert.strictEqual(processRun.normalizeProcess('upscale', { model: '' }), null);
  assert.strictEqual(processRun.normalizeProcess('interpolate', { model: '' }), null);
  assert.strictEqual(processRun.normalizeProcess('depth', {}), null);
  // Cutout is not offered by an export profile: its alpha needs a codec a profile may not carry.
  assert.strictEqual(processRun.normalizeProcess('removebg', { model: 'birefnet' }), null);
});

test('the settings of the Traitements panel are read as they are', () => {
  const ia = processRun.normalizeProcess('upscale', { mode: 'upscale', engine: 'ia', model: 'light', scale: 4 });
  assert.strictEqual(ia.engine, 'ia');
  assert.strictEqual(ia.model, 'light');
  assert.strictEqual(ia.scale, 4);
  // Restoration models work at 1x whatever the picked scale says.
  assert.strictEqual(processRun.normalizeProcess('upscale', { mode: 'restore', model: 'codeformer', scale: 4 }).scale, 1);
  // Turbo is identified by its shader, not by a model.
  const turbo = processRun.normalizeProcess('upscale', { mode: 'upscale', engine: 'turbo', shader: 'artcnn_c4f32', scale: 2 });
  assert.strictEqual(turbo.engine, 'turbo');
  assert.strictEqual(turbo.model, 'artcnn_c4f32');
});

test('interpolation and depth carry their own options', () => {
  const interp = processRun.normalizeProcess('interpolate', {
    model: 'tas-rife4.25', factor: 4, targetFps: 60, slowmo: true, dedup: true,
  });
  assert.strictEqual(interp.model, 'tas-rife4.25');
  // The factor IS the scale of an interpolation: it multiplies the frames, not the pixels.
  assert.strictEqual(interp.scale, 4);
  assert.deepStrictEqual(interp.args, { model: 'tas-rife4.25', factor: 4, targetFps: 60, slowmo: true, dedup: true });
  // No target fps → the factor alone drives the output rate.
  assert.strictEqual(processRun.normalizeProcess('interpolate', { model: 'tas-rife4.25' }).args.targetFps, undefined);

  const depth = processRun.normalizeProcess('depth', { model: 'da3-small', colormap: 'inferno', dedup: true });
  assert.strictEqual(depth.scale, 1);
  assert.deepStrictEqual(depth.args, { model: 'da3-small', colormap: 'inferno', dedup: true });
});

test('one shot = one segment, written exactly where the export planned it', () => {
  const args = processRun.processClipArgs(job());
  assert.strictEqual(args.input, 'S:/rushes/rush-01.mkv');
  assert.strictEqual(args.savePath, 'S:/exports/plan_001.mkv');
  assert.strictEqual(args.outDir, path.dirname('S:/exports/plan_001.mkv'));
  assert.strictEqual(args.outputName, 'plan_001');
  assert.strictEqual(args.whole, false);
  assert.deepStrictEqual(args.segments, [{ in: 12.5, out: 18 }]);
  assert.strictEqual(args.importBack, false);
});

test('the encoding is the profile one, never a default of the engine', () => {
  const args = processRun.processClipArgs(job());
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

test('the resolution class of the profile reaches the engine', () => {
  const up = processRun.normalizeProcess('upscale', { ...UPSCALE, targetHeight: 2160 });
  assert.strictEqual(up.target, 2160);
  assert.strictEqual(processRun.processClipArgs(job({ process: up })).targetHeight, 2160);
  const turbo = processRun.normalizeProcess('upscale', { mode: 'upscale', engine: 'turbo', shader: 'artcnn_c4f32', targetHeight: 1440 });
  assert.strictEqual(turbo.args.targetHeight, 1440);
  // No class: the factor applies. Restoration keeps the source size, RTX VSR has its x2 imposed.
  assert.strictEqual(processRun.normalizeProcess('upscale', UPSCALE).target, 0);
  assert.strictEqual(processRun.normalizeProcess('upscale', { mode: 'restore', model: 'codeformer', targetHeight: 2160 }).args.targetHeight, 0);
  assert.strictEqual(processRun.normalizeProcess('upscale', { engine: 'turbo', shader: 'rtx_vsr', targetHeight: 2160 }).target, 0);
  // Other ops have no class.
  assert.strictEqual(processRun.normalizeProcess('interpolate', { model: 'tas-rife4.25' }).target, 0);
});

test('the audio track chosen for the shot is the one the engine keeps', () => {
  assert.strictEqual(processRun.processClipArgs(job({ audioTrack: 2 })).audioTrack, 2);
  // No explicit choice: every track, like an ffmpeg export — the engines would keep only the first.
  assert.strictEqual(processRun.processClipArgs(job()).audioTrack, -1);
  assert.strictEqual(processRun.processClipArgs(job({ audioTrack: null })).audioTrack, -1);
});

test('a model saturates the GPU alone, Turbo shaders run two at a time', () => {
  assert.strictEqual(processRun.processConcurrency({ kind: 'upscale', engine: 'ia' }), 1);
  assert.strictEqual(processRun.processConcurrency({ kind: 'upscale', engine: 'turbo' }), 2);
  assert.strictEqual(processRun.processConcurrency({ kind: 'interpolate', engine: 'ia' }), 1);
  assert.strictEqual(processRun.processConcurrency(null), 1);
});

test('each op reaches its own engine, Turbo through its router', async () => {
  const calls = [];
  const record = (name) => async (_ev, args) => { calls.push([name, args]); return { ok: true, outputs: [args.savePath] }; };
  const sidecars = { runUpscale: record('upscale'), runInterpolate: record('interpolate'), runDepth: record('depth') };
  const turbo = { runTurbo: async (mod, _ev, args) => { calls.push(['turbo', args, mod === sidecars]); return { ok: true, outputs: [args.savePath] }; } };
  const deps = { sidecars, turbo };

  const ia = await processRun.runProcess(null, job(), deps);
  assert.deepStrictEqual([ia.ok, ia.file], [true, 'S:/exports/plan_001.mkv']);
  assert.strictEqual(calls[0][0], 'upscale');

  await processRun.runProcess(null, job({
    process: processRun.normalizeProcess('interpolate', { model: 'tas-rife4.25', factor: 2 }),
  }), deps);
  assert.strictEqual(calls[1][0], 'interpolate');

  await processRun.runProcess(null, job({
    process: processRun.normalizeProcess('depth', { model: 'da3-small' }),
  }), deps);
  assert.strictEqual(calls[2][0], 'depth');

  await processRun.runProcess(null, job({
    process: processRun.normalizeProcess('upscale', { engine: 'turbo', shader: 'artcnn_c4f32', scale: 2 }),
  }), deps);
  assert.strictEqual(calls[3][0], 'turbo');
  // The router needs the AI engine: two of the three Turbo entries run on ONNX weights.
  assert.strictEqual(calls[3][2], true);
});

test('two passes run in order, the first one alone owning the cut', async () => {
  const seen = [];
  const engine = (name) => async (_ev, args) => { seen.push({ name, args }); return { ok: true, outputs: [args.savePath] }; };
  const deps = { sidecars: { runUpscale: engine('upscale'), runInterpolate: engine('interpolate') } };

  const r = await processRun.runProcess(null, job({
    process: [
      processRun.normalizeProcess('upscale', UPSCALE),
      processRun.normalizeProcess('interpolate', { model: 'tas-rife4.25', factor: 2 }),
    ],
  }), deps);

  assert.deepStrictEqual([r.ok, r.steps], [true, 2]);
  assert.deepStrictEqual(seen.map((c) => c.name), ['upscale', 'interpolate']);

  // 1re passe : la plage du plan, l'audio du profil, une sortie temporaire.
  assert.deepStrictEqual(seen[0].args.segments, [{ in: 12.5, out: 18 }]);
  assert.strictEqual(seen[0].args.whole, false);
  assert.strictEqual(seen[0].args.audioMode, 'copy');
  assert.notStrictEqual(seen[0].args.savePath, 'S:/exports/plan_001.mkv');
  assert.ok(seen[0].args.savePath.endsWith('.mkv'), seen[0].args.savePath);

  // 2e passe : le fichier entier écrit par la 1re, et la destination réelle.
  assert.strictEqual(seen[1].args.input, seen[0].args.savePath);
  assert.strictEqual(seen[1].args.whole, true);
  assert.strictEqual(seen[1].args.segments, undefined);
  assert.strictEqual(seen[1].args.savePath, 'S:/exports/plan_001.mkv');
  assert.strictEqual(r.file, 'S:/exports/plan_001.mkv');
});

test('a chain is only as parallel as its strictest pass', () => {
  const turbo = processRun.normalizeProcess('upscale', { engine: 'turbo', shader: 'artcnn_c4f32', scale: 2 });
  const interp = processRun.normalizeProcess('interpolate', { model: 'tas-rife4.25', factor: 2 });
  assert.strictEqual(processRun.processConcurrency([turbo]), 2);
  assert.strictEqual(processRun.processConcurrency([turbo, interp]), 1);
});

test('a pass that fails stops the chain there', async () => {
  const seen = [];
  const deps = { sidecars: {
    runUpscale: async () => ({ ok: false, error: 'VRAM insuffisante' }),
    runInterpolate: async (_ev, args) => { seen.push(args); return { ok: true, outputs: [args.savePath] }; },
  } };
  const r = await processRun.runProcess(null, job({
    process: [
      processRun.normalizeProcess('upscale', UPSCALE),
      processRun.normalizeProcess('interpolate', { model: 'tas-rife4.25', factor: 2 }),
    ],
  }), deps);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'VRAM insuffisante');
  assert.strictEqual(seen.length, 0, 'la 2e passe n’a rien à traiter');
});

test('a failed job reports its error instead of a file', async () => {
  const refused = await processRun.runProcess(null, job(), {
    sidecars: { runUpscale: async () => ({ ok: false, error: 'VRAM insuffisante' }) },
  });
  assert.deepStrictEqual(refused, { ok: false, file: null, error: 'VRAM insuffisante', steps: 1 });

  // A thrown engine must not take the whole batch down with it.
  const crashed = await processRun.runProcess(null, job(), {
    sidecars: { runUpscale: async () => { throw new Error('sidecar mort'); } },
  });
  assert.strictEqual(crashed.ok, false);
  assert.match(crashed.error, /sidecar mort/);
});
