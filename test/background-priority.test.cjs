const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { lowerPriority } = require('../core/backgroundPriority');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('lowerPriority puts a child below normal and ignores a dead one', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  try {
    lowerPriority(child);
    assert.equal(os.getPriority(child.pid), os.constants.priority.PRIORITY_BELOW_NORMAL);
  } finally {
    child.kill();
  }
  assert.doesNotThrow(() => lowerPriority({ pid: 0 }));
  assert.doesNotThrow(() => lowerPriority(null));
});

test('grid proxies, thumbnails and detection run below the interface', () => {
  const proxy = read('core', 'proxy.js');
  assert.match(proxy, /spawn\(ffBin\('ffmpeg'\), args\);\s*lowerPriority\(ch\);/);
  assert.match(proxy, /'-threads', PROXY_DECODE_THREADS, .*'-i', input/);
  const thumbs = read('core', 'thumbs.js');
  assert.equal((thumbs.match(/background: true/g) || []).length, 3);
  assert.match(thumbs, /'-threads', '2', '-i', filePath/);
  const sidecars = read('core', 'sidecars.js');
  assert.match(sidecars, /\[DETECT_SCRIPT, 'serve'\][^\n]*\n[^\n]*\n\s*lowerPriority\(proc\);/);
  assert.match(sidecars, /\[DETECT_SCRIPT, \.\.\.args\][^\n]*\n\s*lowerPriority\(py\);/);
});

test('a thumbnail run never outranks the cards on screen', () => {
  const cache = read('src', 'components', 'rushes', 'previewCache.ts');
  assert.match(cache, /nr\.thumbnail\(shot\.path, thumbTime\(shot\.in, shot\.out\), "low"\)/);
  assert.match(cache, /throttledPublisher\(setProxyGen\)/);
  assert.match(cache, /throttledPublisher\(setThumbsGen\)/);
});

test('the detection model is locked while a run is in flight', () => {
  const hook = read('src', 'components', 'rushes', 'useShotDetection.ts');
  assert.match(hook, /if \(detectingRef\.current\) return;\s*setModelState\(next\);/);
  assert.match(hook, /if \(modelRef\.current !== runModel\) return;/);
  const menu = read('src', 'components', 'rushes', 'CutContextMenu.tsx');
  assert.match(menu, /ContextMenuSubTrigger disabled=\{p\.detecting\}/);
});

test('reading whether a rush is cut never spawns Python when SQLite answers', () => {
  const sidecars = read('core', 'sidecars.js');
  const direct = sidecars.slice(sidecars.indexOf('function readSceneCacheDirect'), sidecars.indexOf('function getCachedScenes'));
  // A miss under exact options is a definitive answer, not the `null` that falls back on detect.py.
  assert.match(direct, /if \(!row\) return \{ scenes: \[\], cached: false, model, error: null \};/);
  assert.doesNotMatch(direct, /options == null \? \{ scenes/);
});
