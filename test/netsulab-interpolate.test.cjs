// Interpolation RIFE : le runtime ncnn ne lit que les variantes officielles livrées avec son
// binaire. Les générations 4.15+ n'existent qu'en PyTorch, et leur architecture n'est PAS déductible
// du checkpoint — elle voyage donc à part. Ces tests verrouillent les trois maillons qui, séparés,
// rendraient un modèle installable mais inutilisable : poids, module d'architecture, routage python.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// id → module d'architecture attendu. Doit rester le miroir exact de nrproc/rife_torch.ARCHS.
const TORCH_RIFE = {
  'tas-rife4.15': 'IFNet_HDv3_v4_15',
  'tas-rife4.15-lite': 'IFNet_HDv3_v4_15_lite',
  'tas-rife4.16-lite': 'IFNet_HDv3_v4_16_lite',
  'tas-rife4.17': 'IFNet_HDv3_v4_17',
  'tas-rife4.18': 'IFNet_HDv3_v4_18',
  'tas-rife4.20': 'IFNet_HDv3_v4_20',
  'tas-rife4.21': 'IFNet_HDv3_v4_21',
  'tas-rife4.22': 'IFNet_HDv3_v4_22',
  'tas-rife4.22-lite': 'IFNet_HDv3_v4_22_lite',
  'tas-rife4.25': 'IFNet_HDv3_v4_25',
  'tas-rife4.25-lite': 'IFNet_HDv3_v4_25_lite',
  'tas-rife4.25-heavy': 'IFNet_HDv3_v4_25_heavy',
};

test('every PyTorch RIFE ships its architecture next to its weights', () => {
  const { MANIFEST, RIFE_ARCH_DIR } = require('../core/models.js');
  for (const [id, module] of Object.entries(TORCH_RIFE)) {
    const entry = MANIFEST[id];
    assert.ok(entry, `${id} missing from the manifest`);
    assert.equal(entry.catalogOnly, undefined, `${id} must be runnable, not catalog-only`);
    assert.equal(entry.task, 'interpolate');
    assert.equal(entry.pipCheck, 'torch', `${id} must verify its runtime, not weights alone`);
    assert.equal(entry.vendorDir, RIFE_ARCH_DIR, `${id} architecture must land where the sidecar reads it`);
    const vendored = (entry.vendor || []).map((v) => v.file);
    assert.ok(vendored.includes(`${module}.py`), `${id} must fetch ${module}.py`);
    // Chaque module fait `from .warplayer import warp` : sans lui, l'import échoue au chargement.
    assert.ok(vendored.includes('warplayer.py'), `${id} must fetch the shared warp helper`);
    for (const v of entry.vendor) {
      // Tag ÉPINGLÉ : sur `master`, une refonte amont changerait l'architecture sous des poids déjà
      // installés — le checkpoint ne chargerait plus, sans qu'aucun téléchargement n'ait eu lieu.
      assert.match(v.url, /HolyWu\/vs-rife\/v\d+\.\d+\.\d+\//, `${v.file} must come from a pinned tag`);
    }
  }
});

test('the python engine mirrors the manifest and routes only the PyTorch versions', () => {
  const { MANIFEST } = require('../core/models.js');
  const engine = read('python/nrproc/rife_torch.py');
  const runner = read('python/nrproc/runner.py');
  const declared = [...engine.matchAll(/"(tas-rife[\w.-]+)":\s*\("(\w+)",\s*"([\w.]+)",\s*(\d+)\)/g)];
  assert.deepEqual(
    declared.map((m) => m[1]).sort(), Object.keys(TORCH_RIFE).sort(),
    'python ARCHS and the manifest must list the same versions',
  );
  for (const [, id, module, weightFile, modulo] of declared) {
    assert.equal(module, TORCH_RIFE[id], `${id} architecture module diverged`);
    assert.equal(weightFile, MANIFEST[id].file, `${id} weight file diverged from the manifest`);
    // Le padding vient du nombre d'étages de l'architecture : une image non alignée décale le flot.
    assert.ok([32, 64, 128].includes(Number(modulo)), `${id} padding modulo looks wrong`);
  }
  assert.match(runner, /is_torch_model\(model\)/, 'get_rife must dispatch on the runtime, not on a name prefix');
  assert.match(runner, /RifeEngine\(model\)/, 'the ncnn path must stay for the bundled variants');
});

test('the interpolation picker exposes exactly the wired versions', () => {
  const bridge = read('src/lib/bridge.ts');
  const shared = read('src/components/upscale/processShared.ts');
  const union = bridge.match(/export type InterpModel =([\s\S]*?);/)[1];
  for (const id of Object.keys(TORCH_RIFE)) {
    assert.ok(union.includes(`"${id}"`), `${id} missing from the InterpModel union`);
    assert.ok(shared.includes(`id: "${id}"`), `${id} missing from INTERP_MODELS`);
  }
  // Les autres interpolateurs ont désormais leur moteur : GMFSS (flot + fusion) et DistilDRBA
  // (estimation guidée par l'image voisine). Chacun doit être dans le sélecteur ET dans le manifeste.
  const { MANIFEST } = require('../core/models.js');
  for (const id of ['tas-gmfss', 'tas-distildrba', 'tas-distildrba-lite']) {
    assert.ok(shared.includes(`id: "${id}"`), `${id} must be selectable`);
    assert.ok(union.includes(`"${id}"`), `${id} missing from the InterpModel union`);
    assert.equal(MANIFEST[id].catalogOnly, undefined, `${id} must be runnable`);
  }
  // RIFE Elexor n'existe que dans des dépôts GPL/AGPL : pas d'architecture réutilisable ici.
  assert.equal(MANIFEST['tas-rife-elexor'], undefined, 'Elexor has no permissively licensed architecture');
});

test('no weight is offered without an engine that can run it', () => {
  const { MANIFEST } = require('../core/models.js');
  // Un poids se téléchargeait sans jamais apparaître dans un sélecteur ni être connu d'un moteur :
  // de l'espace disque déguisé en fonctionnalité. Vérifier un drapeau ne prouvait rien — on vérifie
  // les deux bouts de la chaîne, sélecteur ET moteur, pour chaque tâche qui a une liste de modèles.
  const pickers = read('src/components/upscale/processShared.ts') + read('src/components/upscale/upscaleShared.ts');
  const upscalers = read('python/upscaler/models.py') + read('python/upscaler/ntire.py');
  const interpolators = read('python/nrproc/rife_torch.py') + read('python/nrproc/drba.py') + read('python/nrproc/gmfss.py');
  const depths = read('python/nrproc/runner.py');
  const ENGINE = {
    upscale: (id) => upscalers.includes(`"${id}":`),
    restore: (id) => upscalers.includes(`"${id}":`),
    // GMFSS n'a qu'un modèle : son moteur le nomme en constante (`MODEL_ID`), pas en clé de table.
    interpolate: (id) => interpolators.includes(`"${id}":`) || interpolators.includes(`= "${id}"`),
    depth: (id) => depths.includes(`"${id}":`),
  };
  // Composants de RUNTIME, pas des modèles : le wheel ncnn porte ses propres variantes, et l'entrée
  // RTX (binaire + DLL NVIDIA) sert le shader `rtx_vsr` — ni l'un ni l'autre n'est un choix de la liste.
  const RUNTIME_PARTS = new Set(['rife-ncnn-vulkan', 'rtx-video']);
  const orphans = [];
  for (const [id, entry] of Object.entries(MANIFEST)) {
    if (entry.available === false || RUNTIME_PARTS.has(id) || !ENGINE[entry.task]) continue;
    if (!pickers.includes(`id: "${id}"`)) orphans.push(`${id} (absent des sélecteurs)`);
    else if (!ENGINE[entry.task](id)) orphans.push(`${id} (aucun moteur ${entry.task})`);
  }
  assert.deepEqual(orphans, [], 'every downloadable weight must be selectable and have a wired engine');
});

test('the interpolated stream is declared at its own frame rate', () => {
  const media = read('python/nrproc/media.py');
  const interp = read('python/nrproc/interp.py');
  // Déclarer l'entrée brute à la cadence SOURCE ferait croire à ffmpeg que la séquence dure factor×
  // plus longtemps ; le `-r` de sortie la ramènerait en DUPLIQUANT les images (vidéo 2× trop longue).
  assert.match(media, /in_fps = str\(out_fps\) if out_fps else fps_str/);
  assert.match(media, /"-r", in_fps, "-i", "pipe:0"/);
  // Cadence NTSC : la fraction exacte survit à la multiplication (24000/1001 → 48000/1001).
  assert.match(interp, /out_fps_str = _scaled_fps\(fps_str, factor\)/);
  assert.match(interp, /open_encoder_video\(args\.out, w, h, fps_str, args, out_fps=out_fps_str\)/);
});
