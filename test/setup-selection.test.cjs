const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeSetupOptions, quickSetupReady, SETUP_RUNTIME_VERSION } = require('../core/setup');
const { MANIFEST } = require('../core/models');
const fs = require('node:fs');
const path = require('node:path');

// L'écran d'installation propose désormais le catalogue lui-même (sélection courante par défaut,
// « Avancé » pour le reste). Un id absent du manifeste serait coché par l'utilisateur puis écarté EN
// SILENCE par sanitizeSetupOptions : l'installation se terminerait « réussie » sans le modèle demandé.
function offeredModels() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'modelRegistry.ts'), 'utf8');
  const block = source.slice(source.indexOf('MODEL_REGISTRY: ModelEntry[]'), source.indexOf('export const TASK_LABELS'));
  // Ce que l'écran affiche avant d'ouvrir « Avancé » : ni fourni par une lib (bundled/auto), ni à
  // importer à la main — ces trois-là ne se téléchargent pas depuis une case à cocher d'installation.
  return block
    .split('\n')
    .filter((line) => /^\s*\{\s*id:/.test(line) && !/(bundled|manual|autoFetch|advanced):\s*true/.test(line))
    .map((line) => line.match(/id:\s*"([^"]+)"/)[1]);
}

test('every model offered at install time is really installable', () => {
  const offered = offeredModels();
  assert.ok(offered.length > 0, 'aucun modèle proposé : le catalogue n’a pas été lu');
  for (const id of offered) {
    assert.ok(MANIFEST[id], `${id} proposé à l'installation mais absent du manifeste`);
  }
  // Les modèles sans moteur (available:false) sont retirés de l'écran à partir de `models:list` ;
  // tous les autres doivent traverser la sanitisation sans perte.
  const downloadable = offered.filter((id) => MANIFEST[id].available !== false && id !== 'transnetv2');
  assert.deepEqual(sanitizeSetupOptions({ modules: [], models: downloadable }).models, downloadable);
});

// Le pack pré-coché est ce que 99 % des utilisateurs installeront sans y toucher : s'il contenait un
// id mort, l'installation par défaut partirait sans détection fiable ni recherche.
test('the recommended pack of the install screen is installable', () => {
  const gate = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'setup', 'SetupGate.tsx'), 'utf8');
  const recommended = [...gate.slice(gate.indexOf('RECOMMENDED_MODELS')).match(/\[(.*?)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sanitizeSetupOptions({ modules: [], models: recommended }).models, recommended);
});

test('setup keeps NetsuCut and rejects unknown modules and models', () => {
  assert.deepEqual(
    sanitizeSetupOptions({ modules: ['search', 'unknown', 'search'], models: ['siglip2-base', 'unknown', 'transnetv2'] }),
    { modules: ['derush', 'search'], models: ['siglip2-base'], adobePanel: false },
  );
});

test('setup accepts an installation without optional models', () => {
  assert.deepEqual(sanitizeSetupOptions({ modules: [], models: [] }), { modules: ['derush'], models: [], adobePanel: false });
});

test('quick setup check accepts a completed install using existing paths', () => {
  const executable = process.execPath;
  assert.equal(quickSetupReady({
    setupCompletedAt: new Date().toISOString(),
    python: executable,
    ffmpeg: executable,
    ffprobe: executable,
    // Version enregistrée par setup.ps1 : le contrôle rapide la compare comme une chaîne et ne lance
    // AUCUN processus. Sans elle, il interrogerait le binaire — ici `process.execPath`, donc node,
    // qui n'annonce évidemment pas « ffmpeg version ».
    ffmpegVersion: '9.0',
    setupRuntimeVersion: SETUP_RUNTIME_VERSION,
    setupModels: [],
  }, { ignorePackageGate: true }), true);
});

test('quick setup rejects installs created before mandatory NetsuBoard link tools', () => {
  const executable = process.execPath;
  const base = {
    setupCompletedAt: new Date().toISOString(),
    python: executable,
    ffmpeg: executable,
    ffprobe: executable,
    ffmpegVersion: '9.0',
    setupModels: [],
  };
  assert.equal(quickSetupReady(base, { ignorePackageGate: true }), false);
  assert.equal(
    quickSetupReady({ ...base, setupRuntimeVersion: SETUP_RUNTIME_VERSION }, { ignorePackageGate: true }),
    true,
  );
});

// `setupStatus` lit `quickReady ? true : ffmpegReady(...)` : une version périmée doit être refusée
// ICI, sinon `ffmpegReady` n'est jamais atteint sur une installation déjà complète et la version
// épinglée ne parvient jamais aux postes existants. C'est le défaut que ce test verrouille.
test('quick setup check rejects an install whose ffmpeg version is no longer accepted', () => {
  const executable = process.execPath;
  const base = {
    setupCompletedAt: new Date().toISOString(),
    python: executable,
    ffmpeg: executable,
    ffprobe: executable,
    setupRuntimeVersion: SETUP_RUNTIME_VERSION,
    setupModels: [],
  };
  const ready = (ffmpegVersion) => quickSetupReady({ ...base, ffmpegVersion }, { ignorePackageGate: true });

  assert.equal(ready('7.1'), false, 'une 7.1 héritée doit renvoyer vers la réparation');
  assert.equal(ready('8.0'), false, 'une version hors liste doit être refusée');
  assert.equal(ready('9.0'), true, 'la version épinglée est acceptée');
  assert.equal(ready('8.1'), true, 'le repli zip est accepté sans boucler sur l\'installation');
  assert.equal(ready('9.0.1'), true, 'un correctif de la version épinglée est accepté');
});

test('quick setup check rejects missing runtime files and optional assets', () => {
  const executable = process.execPath;
  const config = {
    setupCompletedAt: new Date().toISOString(),
    python: executable,
    ffmpeg: executable,
    ffprobe: executable,
    // Version acceptée pour que le refus vienne bien des ASSETS manquants, seul objet de ce test.
    ffmpegVersion: '9.0',
    setupModels: ['omnishotcut', 'siglip2-base'],
    omnishotCkpt: path.join(__dirname, 'missing-omnishotcut.pth'),
    siglipDir: path.join(__dirname, 'missing-siglip'),
  };
  assert.equal(quickSetupReady(config, { ignorePackageGate: true }), false);
});
