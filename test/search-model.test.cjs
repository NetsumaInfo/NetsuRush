const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// NR_HOME est posé AVANT le require de core/config : la configuration est figée au chargement du
// module. Un dossier de modèle factice suffit : la bascule exige un dossier chargeable, pas un vrai
// poids SigLIP (c'est l'interface, pas transformers, qui est testée ici).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-search-model-'));
process.env.NR_HOME = home;
const baseDir = path.join(home, 'models', 'search', 'siglip2-base');
fs.mkdirSync(baseDir, { recursive: true });
fs.writeFileSync(path.join(baseDir, 'config.json'), '{}');

const { CONFIG_PATH, DETECT_ENV } = require('../core/config');
const { modelTag } = require('../core/searchCatalog');
const { activeSearchModelId, searchModelState, setSearchModel } = require('../core/searchModel');

test.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });

test('the search variant switch rewrites the config, the sidecar env and restarts the daemons', () => {
  assert.equal(activeSearchModelId(), 'siglip2-so400m');
  let restarts = 0;
  const result = setSearchModel('siglip2-base', { restart: () => { restarts += 1; } });
  assert.equal(result.ok, true);
  assert.equal(result.active, 'siglip2-base');
  assert.equal(restarts, 1, 'les daemons de recherche doivent être relancés : ils lisent l’env au spawn');
  assert.equal(activeSearchModelId(), 'siglip2-base');
  assert.equal(DETECT_ENV.NETSURUSH_SIGLIP_DIR, baseDir);
  // Le tag est ce qui sépare les index : il doit suivre la bascule DANS la même session.
  assert.equal(modelTag(), 'siglip2-base');
  const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  assert.equal(saved.siglipModelId, 'siglip2-base');
  assert.equal(saved.siglipDir, baseDir);
});

test('the switch refuses an unknown id and a variant that is not on disk', () => {
  const unknown = setSearchModel('siglip3-xxl');
  assert.equal(unknown.ok, false);
  const missing = setSearchModel('siglip2-giant');
  assert.equal(missing.ok, false);
  assert.equal(missing.needsDownload, true);
  // Un refus ne doit jamais laisser une configuration à moitié écrite.
  assert.equal(activeSearchModelId(), 'siglip2-base');
});

test('the state lists every variant with its own index', () => {
  const state = searchModelState({ indexedByModel: () => ({ 'siglip2-so400m': { clips: 4, frames: 120 } }) });
  assert.deepEqual(state.models.map((m) => m.id), ['siglip2-base', 'siglip2-so400m', 'siglip2-giant']);
  const previous = state.models.find((m) => m.id === 'siglip2-so400m');
  const current = state.models.find((m) => m.id === 'siglip2-base');
  // L'index de l'ancienne variante reste comptabilisé : la bascule ne détruit rien.
  assert.equal(previous.indexedClips, 4);
  assert.equal(current.active, true);
  assert.equal(current.indexedClips, 0);
});
