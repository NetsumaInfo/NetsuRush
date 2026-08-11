const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'reference', 'useBoardIngest.ts'), 'utf8');
const actions = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'reference', 'boardMediaActions.ts'), 'utf8');
const persistence = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'reference', 'useScenePersistence.ts'), 'utf8');
const toolbar = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'reference', 'Toolbar.tsx'), 'utf8');
const prefs = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'reference', 'boardPrefs.ts'), 'utf8');
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
  assert.match(source, /resolveMedia\(url,\s*\{[^}]*download:\s*useBoard\.getState\(\)\.prefs\.autoDownloadOnline/s);
  assert.match(source, /projectPath:\s*useBoard\.getState\(\)\.filePath\s*\|\|\s*undefined/);
  assert.match(source, /res\.path\s*\?\?\s*res\.url/);
});

test('YouTube stays linked while AMVNews stays generic', () => {
  assert.match(source, /if \(yt\) \{\s*place\("youtube"/s);
  assert.doesNotMatch(source, /yt\s*&&\s*prefs\.autoDownloadOnline/);
  assert.doesNotMatch(source, /amvnews/i);
});

test('online media downloads by default while YouTube stays linked', () => {
  assert.match(prefs, /autoDownloadOnline:\s*true/);
  assert.match(prefs, /onlineDefaultsVersion:\s*1/);
});

test('Instagram video extraction falls back to its embed instead of an OpenGraph thumbnail', () => {
  assert.match(source, /e\.provider !== "instagram"\s*&&\s*await resolvePageAndPlace\(text, at\)/);
  assert.match(source, /const fb = e \?\?/);
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
  assert.match(persistence, /if \(result\.recovered > 0 && !res\.readonly\) await saveProject\(\)/);
});

// Un board reçu s'ouvre sur des liens morts : la remise en état part seule, jamais sur un bouton.
test('importing an archive recovers its web media without waiting for a button', () => {
  const importBoard = persistence.slice(persistence.indexOf('const importBoard'));
  assert.match(importBoard, /recoverAllOnlineMedia\(\)/);
  assert.ok(importBoard.indexOf('recoverAllOnlineMedia()') < importBoard.indexOf('prefs.autoDownloadOnline'));
});

// Un plan YouTube perdu revient en CARTE, pas en téléchargement : même état que si le lien venait
// d'être reposé sur le board, et zéro octet transféré pour l'afficher.
test('a missing YouTube-sourced item returns to its YouTube card', () => {
  const recover = actions.slice(actions.indexOf('export async function recoverMedia'), actions.indexOf('export async function recoverAllOnlineMedia'));
  assert.match(recover, /const yt = youtubeId\(link\)/);
  assert.match(recover, /kind: "youtube", ref: yt, src: yt/);
  assert.match(recover, /it\.kind !== "sequence"/);
  assert.ok(recover.indexOf('const yt = youtubeId(link)') < recover.indexOf('extractMedia'));
});

test('project recovery downloads directly into its companion folder', () => {
  assert.match(actions, /const target = \{ projectPath: st\.filePath \|\| undefined, title:/);
  assert.match(actions, /extractMedia\?\.\(link,\s*target\)/);
  assert.match(actions, /resolveMedia\?\.\(link,\s*target\)/);
  assert.match(actions, /extractFrames\(\{[^}]*projectPath:\s*st\.filePath \|\| undefined,[^}]*title:/s);
});

test('the toolbar offers a compact retry action beside recovery notices', () => {
  assert.match(toolbar, /recoverableOnlineItems\(items\)\.length/);
  assert.match(toolbar, /recoverAllOnlineMedia\(\)/);
  assert.match(toolbar, /notice\.redownloadAll/);
  assert.match(toolbar, /<RotateCw/);
  assert.match(toolbar, /if \(result\.recovered > 0\) onSave\?\.\(\)/);
});
