const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// NR_HOME doit être posé AVANT le require de core/config (il le lit au chargement).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-prefs-'));
process.env.NR_HOME = HOME;
const { createPrefs } = require('../core/prefs');

const root = path.join(__dirname, '..');

test('shared prefs persist across core restarts and broadcast only real changes', () => {
  const sent = [];
  const prefs = createPrefs({ broadcast: (channel, payload) => sent.push({ channel, payload }) });

  // Premier lancement : sac vide → le renderer sème ses valeurs.
  assert.deepEqual(prefs.get().prefs, {});

  prefs.set({ cutModel: 'omnishotcut', cutPreset: 2 });
  assert.equal(prefs.get().prefs.cutModel, 'omnishotcut');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, 'prefs:changed');
  // Le patch (et pas tout le sac) part aux autres renderers : ils n'appliquent que ce qui a changé.
  assert.equal(sent[0].payload.patch.cutModel, 'omnishotcut');

  // Écriture identique = aucun événement : sinon deux renderers ouverts se renverraient la balle.
  prefs.set({ cutModel: 'omnishotcut', cutPreset: 2 });
  assert.equal(sent.length, 1);

  // Fusion superficielle : une clé absente du patch survit.
  prefs.set({ cutPreset: 3 });
  assert.equal(prefs.get().prefs.cutModel, 'omnishotcut');
  assert.equal(prefs.get().prefs.cutPreset, 3);

  // Persistance : un core relancé relit le fichier (écrit atomiquement, sans .tmp résiduel).
  const reloaded = createPrefs({ broadcast: () => {} });
  assert.equal(reloaded.get().prefs.cutModel, 'omnishotcut');
  assert.equal(reloaded.get().prefs.cutPreset, 3);
  assert.ok(fs.existsSync(path.join(HOME, 'prefs.json')));
  assert.ok(!fs.existsSync(path.join(HOME, 'prefs.json.tmp')));
});

test('the renderer shares the settings that make a rush read as "already cut"', () => {
  const hook = fs.readFileSync(path.join(root, 'src', 'hooks', 'useSharedPrefs.ts'), 'utf8');
  const bridge = fs.readFileSync(path.join(root, 'src', 'lib', 'bridge.ts'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'src', 'lib', 'coreClient.ts'), 'utf8');
  const detection = fs.readFileSync(path.join(root, 'src', 'components', 'rushes', 'useShotDetection.ts'), 'utf8');

  // Le cache de plans est indexé sur (fichier, modèle, seuil, options) : ces trois-là DOIVENT être
  // partagés, sinon le panneau CEP redemande une détection déjà faite dans l'app.
  for (const key of ['cutModel', 'cutPreset', 'detectionOptions', 'exportProfiles', 'timelineInsertions']) {
    assert.match(hook, new RegExp(`${key}: state\\.${key}`), key);
  }
  // Même raison pour les aperçus : format, hauteur et cran entrent dans les clés de cache proxy et
  // vignette, donc un panneau resté aux défauts ré-encodait tout ce que l'app avait déjà produit.
  assert.match(hook, /previewSettings: state\.previewSettings/);
  // Chaque envoi porte l'instantané ENTIER, et ce setter vide les vignettes de toutes les grilles :
  // il ne s'applique que sur une vraie différence.
  assert.match(hook, /JSON\.stringify\(patch\.previewSettings\) !== JSON\.stringify\(state\.previewSettings\)/);
  // Un fichier antérieur à la clé la reçoit de l'APP ; le panneau ne sème jamais.
  assert.match(hook, /if \(!IS_REMOTE && Object\.keys\(local\)\.some\(\(key\) => !\(key in stored\)\)\)/);
  // IPC alignée aux 3 endroits (table H côté core, NrApi + coreClient, mock).
  assert.match(bridge, /prefsGet\(\): Promise/);
  assert.match(bridge, /prefsGet: async \(\) =>/);
  assert.match(client, /prefsSet: \(patch\) => call\("prefs:set", \[patch\]\)/);
  // Repli : à défaut de correspondance exacte, on sert la découpe connue de ce modèle.
  assert.match(detection, /exact\.scenes\?\.length \? exact : \(await nr\.cachedScenes\(path, model\)/);
});

// Le hook tourne pour de vrai, avec un store et un core factices : ce sont les écritures qui
// comptent (qui sème, qui écrase), et une regex sur la source ne les voit pas.
function runHook({ remote, stored }) {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(root, 'src', 'hooks', 'useSharedPrefs.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const pushed = [];
  const applied = [];
  let onChanged = null;
  let onStore = null;
  const state = {
    cutModel: 'transnetv2', cutPreset: 1, detectionOptions: {}, exportProfiles: [],
    activeExportProfileId: '', cardActionProfileId: '', timelineInsertions: {},
    searchPerf: {}, searchFrames: 8,
    previewSettings: { proxy: { format: 'hevc', height: 360 }, thumbnail: { format: 'webp', preset: 'light' } },
    setCutModel: (v) => { state.cutModel = v; },
    setCutPreset: (v) => { state.cutPreset = v; },
    setDetectionOptions: () => {},
    replaceExportProfiles: () => {},
    setSearchPerf: () => {},
    setSearchFrames: () => {},
    setTimelineInsertion: () => {},
    setPreviewSettings: (v) => { applied.push(v); state.previewSettings = v; },
  };
  const modules = {
    react: { useEffect: (fn) => fn(), useRef: (current) => ({ current }) },
    '@/lib/bridge': { nr: {
      prefsGet: async () => ({ prefs: stored }),
      prefsSet: async (p) => { pushed.push(p); },
      onPrefsChanged: (cb) => { onChanged = cb; return () => {}; },
    } },
    '@/lib/remote': { IS_REMOTE: remote },
    '@/store': { useApp: { getState: () => state, subscribe: (fn) => { onStore = fn; return () => {}; } } },
    '@/features/timeline/insertion': { DEFAULT_TIMELINE_INSERTIONS: {} },
  };
  const exports = {};
  // Push debounce runs at once: the test is about what leaves, not when.
  const timers = { setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {} };
  new Function('exports', 'require', 'setTimeout', 'clearTimeout', js)(exports, (id) => modules[id], timers.setTimeout, timers.clearTimeout);
  exports.useSharedPrefs();
  // A user edit: the store mutates, then notifies its subscribers.
  const edit = (patch) => { Object.assign(state, patch); onStore(state); };
  return { pushed, applied, state, edit, emit: (patch) => onChanged({ patch }) };
}

const tick = () => new Promise((r) => setImmediate(r));
const OLD_BAG = { cutModel: 'transnetv2', cutPreset: 1 };

test('the app seeds preview settings into a prefs file that predates them', async () => {
  const app = runHook({ remote: false, stored: OLD_BAG });
  await tick();
  assert.equal(app.pushed.length, 1);
  assert.deepEqual(app.pushed[0].previewSettings, app.state.previewSettings);
});

test('the panel never seeds, and adopts the app settings when they arrive', async () => {
  const panel = runHook({ remote: true, stored: OLD_BAG });
  await tick();
  assert.equal(panel.pushed.length, 0);
  const fromApp = { proxy: { format: 'h264', height: 480 }, thumbnail: { format: 'jpeg', preset: 'sharp' } };
  panel.emit({ previewSettings: fromApp });
  assert.deepEqual(panel.applied, [fromApp]);
});

test('an unchanged preview setting in a pushed snapshot leaves the grids alone', async () => {
  const app = runHook({ remote: false, stored: {} });
  await tick();
  app.emit({ cutModel: 'autoshot', previewSettings: JSON.parse(JSON.stringify(app.state.previewSettings)) });
  assert.equal(app.state.cutModel, 'autoshot');
  assert.deepEqual(app.applied, []);
});

test('a complete prefs file is read, never rewritten at startup', async () => {
  const app = runHook({ remote: false, stored: {} });
  await tick();
  const complete = app.pushed[0];
  const again = runHook({ remote: false, stored: complete });
  await tick();
  assert.equal(again.pushed.length, 0);
});

test('the panel writes only the keys the core already holds', async () => {
  const panel = runHook({ remote: true, stored: OLD_BAG });
  await tick();
  panel.edit({ cutPreset: 4 });
  assert.equal(panel.pushed.length, 1);
  assert.deepEqual(Object.keys(panel.pushed[0]).sort(), ['cutModel', 'cutPreset']);
  assert.equal(panel.pushed[0].cutPreset, 4);

  // On an empty file the panel keeps its edit to itself until the app has seeded.
  const fresh = runHook({ remote: true, stored: {} });
  await tick();
  fresh.edit({ cutPreset: 4 });
  assert.equal(fresh.pushed.length, 0);
});

test('the echo of a push does not revert a newer choice', async () => {
  const app = runHook({ remote: false, stored: OLD_BAG });
  await tick();
  const sent = app.pushed[0];
  const newer = { proxy: { format: 'h264', height: 720 }, thumbnail: { format: 'webp', preset: 'sharp' } };
  app.state.previewSettings = newer;
  app.emit(JSON.parse(JSON.stringify(sent)));
  assert.deepEqual(app.applied, []);
  assert.equal(app.state.previewSettings, newer);
});

test('an echo is used once: a later return to the same values still applies', async () => {
  const app = runHook({ remote: false, stored: OLD_BAG });
  await tick();
  const s1 = JSON.parse(JSON.stringify(app.pushed[0]));
  app.emit(s1);
  const s2 = { ...s1, previewSettings: { proxy: { format: 'h264', height: 720 }, thumbnail: { format: 'webp', preset: 'sharp' } } };
  app.emit(s2);
  app.emit(JSON.parse(JSON.stringify(s1)));
  assert.deepEqual(app.applied, [s2.previewSettings, s1.previewSettings]);
});
