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
  // IPC alignée aux 3 endroits (table H côté core, NrApi + coreClient, mock).
  assert.match(bridge, /prefsGet\(\): Promise/);
  assert.match(bridge, /prefsGet: async \(\) =>/);
  assert.match(client, /prefsSet: \(patch\) => call\("prefs:set", \[patch\]\)/);
  // Repli : à défaut de correspondance exacte, on sert la découpe connue de ce modèle.
  assert.match(detection, /exact\.scenes\?\.length \? exact : \(await nr\.cachedScenes\(clipPath, model\)/);
});
