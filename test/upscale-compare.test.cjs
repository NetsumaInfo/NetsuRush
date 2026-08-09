const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadCompareState() {
  const filename = path.join(__dirname, '..', 'src', 'components', 'upscale', 'upscaleCompareState.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', output)(module.exports, module, require);
  return module.exports;
}

const { mergeUpscaleModelResult, upscaleTestConfigKey } = loadCompareState();

const settings = {
  engine: 'ia', shader: 'lanczos', tDeband: 'none', tGrain: 0, tSharp: 'sharp',
  tSigmoid: true, tDither: true, model: 'anime', scale: 2, codec: 'hevc_nvenc',
  denoise: 0.5, tile: 0, tilePad: 10, prePad: 0, fp32: false, quality: 18,
  preset: 'slow', bitDepth: 8, profile: 'main', audio: 'copy', abr: 192, audioTrack: 0,
};

function result(model, overrides = {}) {
  return {
    sourceKey: 'source-a', configKey: upscaleTestConfigKey(settings), time: 1.25,
    origUrl: 'original.png', outUrl: `${model}.png`, width: 1920, height: 1080,
    variant: { id: `model:${model}`, label: model, url: `${model}.png`, model },
    ...overrides,
  };
}

test('keeps the comparison bank across model changes but invalidates inference config changes', () => {
  assert.equal(upscaleTestConfigKey(settings), upscaleTestConfigKey({ ...settings, model: 'general' }));
  assert.equal(upscaleTestConfigKey(settings), upscaleTestConfigKey({ ...settings, codec: 'x264', audio: 'none' }));
  assert.notEqual(upscaleTestConfigKey(settings), upscaleTestConfigKey({ ...settings, scale: 4 }));
  assert.notEqual(upscaleTestConfigKey(settings), upscaleTestConfigKey({ ...settings, fp32: true }));
  assert.notEqual(upscaleTestConfigKey(settings), upscaleTestConfigKey({ ...settings, cleanupNoise: 0.5 }));
  assert.notEqual(upscaleTestConfigKey(settings), upscaleTestConfigKey({ ...settings, cleanupEdges: 0.5 }));
});

test('compares model A directly with model B without adding the original as a variant', () => {
  const a = mergeUpscaleModelResult(null, result('anime'));
  const ab = mergeUpscaleModelResult(a, result('general'));

  assert.deepEqual(ab.variants.map((variant) => variant.id), ['model:anime', 'model:general']);
  assert.equal(ab.leftId, 'model:anime');
  assert.equal(ab.rightId, 'model:general');
  assert.equal(ab.variants.some((variant) => variant.id === 'original'), false);
});

test('drops stale variants when source, frame or shared config changes', () => {
  const a = mergeUpscaleModelResult(null, result('anime'));
  const changedSource = mergeUpscaleModelResult(a, result('general', { sourceKey: 'source-b' }));
  const changedFrame = mergeUpscaleModelResult(a, result('general', { time: 2 }));
  const changedConfig = mergeUpscaleModelResult(a, result('general', { configKey: 'different' }));

  for (const next of [changedSource, changedFrame, changedConfig]) {
    assert.deepEqual(next.variants.map((variant) => variant.id), ['model:general']);
    assert.equal(next.leftId, 'model:general');
    assert.equal(next.rightId, 'model:general');
    assert.equal(next.revision, 1);
  }
});

test('retesting the same model replaces its result instead of duplicating it', () => {
  const first = mergeUpscaleModelResult(null, result('anime'));
  const second = mergeUpscaleModelResult(first, result('anime', { outUrl: 'anime-v2.png', variant: {
    id: 'model:anime', label: 'anime', url: 'anime-v2.png', model: 'anime',
  } }));

  assert.equal(second.variants.length, 1);
  assert.equal(second.variants[0].url, 'anime-v2.png');
});
