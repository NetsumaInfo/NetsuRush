const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'reference', 'useBoardIngest.ts'), 'utf8');
const actions = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'reference', 'boardMediaActions.ts'), 'utf8');
const persistence = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'reference', 'useScenePersistence.ts'), 'utf8');
const recoveryFile = path.join(__dirname, '..', 'src', 'components', 'reference', 'boardMediaRecovery.ts');

function loadRecoveryModule() {
  const compiled = ts.transpileModule(fs.readFileSync(recoveryFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = new Module(recoveryFile, module);
  mod.filename = recoveryFile;
  mod.paths = module.paths;
  mod._compile(compiled, recoveryFile);
  return mod.exports;
}

test('online ingestion passes the global linked/download choice to the generic resolver', () => {
  assert.match(source, /resolveMedia\(url,\s*\{\s*download:\s*useBoard\.getState\(\)\.prefs\.autoDownloadOnline,?\s*\}\)/);
  assert.match(source, /res\.path\s*\?\?\s*res\.url/);
});

test('YouTube downloads only in automatic mode and AMVNews stays generic', () => {
  assert.match(source, /if\s*\(yt\s*&&\s*!prefs\.autoDownloadOnline\)/);
  assert.match(source, /if\s*\(yt\s*&&\s*prefs\.autoDownloadOnline\)/);
  assert.doesNotMatch(source, /amvnews/i);
});

test('every remote image and video keeps the user-entered source URL', () => {
  assert.match(source, /place\("image",\s*url,\s*url,\s*nat,\s*undefined,\s*at,\s*\{\s*sourceUrl\s*\}\)/);
  assert.match(source, /place\("video",\s*url,\s*url,\s*nat,\s*undefined,\s*at,\s*\{\s*sourceUrl\s*\}\)/);
  assert.match(source, /place\(res\.kind,\s*res\.path,\s*src,\s*nat,\s*undefined,\s*at,\s*\{\s*sourceUrl\s*\}\)/);
  assert.match(source, /addRemoteMedia\(gif,\s*"image",\s*at,\s*text\)/);
});

test('only missing web-backed images, videos, and sequences are recoverable', async () => {
  const { recoverableOnlineItems } = loadRecoveryModule();
  const items = [
    { id: 'image', kind: 'image', ref: '', sourceUrl: 'https://example.test/image' },
    { id: 'video-ok', kind: 'video', ref: 'C:/media/video.mp4', sourceUrl: 'https://example.test/video' },
    { id: 'sequence', kind: 'sequence', ref: '', frames: ['', ''], sourceUrl: 'https://example.test/post' },
    { id: 'local', kind: 'image', ref: '', missing: { name: 'local.png', size: 1, kind: 'image' } },
  ];
  assert.deepEqual(recoverableOnlineItems(items).map((item) => item.id), ['image', 'sequence']);
});

test('bulk recovery is sequential and reports success and failure counts', async () => {
  const { runSequentialRecovery } = loadRecoveryModule();
  let active = 0;
  let maxActive = 0;
  const progress = [];
  const result = await runSequentialRecovery(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return item.id !== 'b';
    },
    (current, total) => progress.push([current, total]),
  );
  assert.equal(maxActive, 1);
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(result, { total: 3, recovered: 2, failed: 1 });
});

test('opening a project automatically recovers missing web media and saves replacements', () => {
  assert.match(actions, /export async function recoverAllOnlineMedia/);
  assert.match(actions, /sourceUrl:\s*url/);
  assert.match(actions, /frames:\s*undefined/);
  assert.match(persistence, /recoverAllOnlineMedia\(\)/);
  assert.match(persistence, /if \(result\.recovered > 0\) await saveProject\(\)/);
});
