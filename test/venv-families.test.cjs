// Familles d'environnement des modèles : classement, arbitrage des exclusifs, lecture de pip check.
// Ce que ces tests protègent : un modèle mal classé, un pin de dépendance PARTAGÉE introduit sans
// être déclaré, ou le retour du comportement d'avant — installer un exclusif désinstallait l'autre
// sans rien demander.
const test = require('node:test');
const assert = require('node:assert');

const { MANIFEST } = require('../core/models');
const {
  FAMILIES, familyOf, resolveInstall, readPipCheck, familyConstraining,
} = require('../core/venvs');

test('chaque modèle du manifeste tombe dans une famille connue', () => {
  for (const [id, entry] of Object.entries(MANIFEST)) {
    if (entry.kind === 'alias') continue;
    const family = familyOf(id, entry);
    assert.ok(FAMILIES[family], `${id} → famille inconnue « ${family} »`);
  }
});

test('les modèles qui partagent un moteur partagent leur famille', () => {
  // Si l'un de ces couples divergeait, la doc dirait qu'ils vivent dans deux piles différentes
  // alors que le même sidecar les charge.
  const pairs = [
    ['sam2.1', 'sam2.1-large'],
    ['samurai', 'sam2long'],
    ['whisper-turbo', 'parakeet-v3'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(familyOf(a, MANIFEST[a]), familyOf(b, MANIFEST[b]), `${a} et ${b}`);
  }
});

test('le seul modèle en ONNX pur est classé à part de la pile torch', () => {
  assert.equal(familyOf('face-anime', MANIFEST['face-anime']), 'anime-face');
  assert.equal(FAMILIES['anime-face'].base, 'onnx');
  // face-real est un poids en téléchargement direct SANS tâche, comme les upscalers : la règle de
  // repli le rangerait avec eux si l'exception n'était pas déclarée.
  assert.equal(familyOf('face-real', MANIFEST['face-real']), 'core');
});

test('un exclusif déjà installé bloque l’installation du concurrent', () => {
  const installed = new Set(['samurai']);
  const plan = resolveInstall('sam2long', MANIFEST.sam2long, { isInstalled: (id) => installed.has(id) });
  assert.equal(plan.mode, 'conflict');
  assert.deepEqual(plan.blockedBy, ['samurai']);
});

test('le consentement explicite lève le blocage, son absence ne le lève jamais', () => {
  const installed = new Set(['samurai']);
  const state = (replace) => ({ isInstalled: (id) => installed.has(id), replace });
  assert.equal(resolveInstall('sam2long', MANIFEST.sam2long, state(true)).mode, 'shared');
  assert.equal(resolveInstall('sam2long', MANIFEST.sam2long, state(false)).mode, 'conflict');
  assert.equal(resolveInstall('sam2long', MANIFEST.sam2long, state(undefined)).mode, 'conflict');
});

test('un modèle sans exclusivité s’installe toujours', () => {
  const plan = resolveInstall('siglip2-so400m', MANIFEST['siglip2-so400m'], { isInstalled: () => true });
  assert.equal(plan.mode, 'shared');
});

test('pip check : les deux plaintes attendues sont marquées comme telles', () => {
  // Mesuré sur une installation SAINE : faster-whisper réclame `onnxruntime` (posé sous le nom
  // `onnxruntime-gpu` par la voie explicite) et dghs-imgutils réclame la variante non-headless
  // d'opencv. Les présenter comme des pannes apprendrait à ignorer le diagnostic entier.
  const findings = readPipCheck([
    'faster-whisper 1.2.1 requires onnxruntime, which is not installed.',
    'dghs-imgutils 0.19.0 requires opencv-contrib-python, which is not installed.',
    'dghs-imgutils 0.19.0 has requirement numpy<2, but you have numpy 2.4.6.',
    'matanyone2 1.0.0 has requirement huggingface-hub==0.36.2, but you have huggingface-hub 1.26.1.',
  ].join('\n'));
  assert.equal(findings.length, 4);
  assert.deepEqual(findings.filter((f) => f.expected).map((f) => f.requirement),
    ['onnxruntime', 'opencv-contrib-python']);
  const numpy = findings.find((f) => f.requirement === 'numpy<2');
  assert.equal(numpy.package, 'dghs-imgutils');
  assert.equal(numpy.found, '2.4.6');
});

test('pip check : une sortie vide ne produit aucun constat', () => {
  assert.deepEqual(readPipCheck(''), []);
  assert.deepEqual(readPipCheck('No broken requirements found.'), []);
});

test('chaque paquet partagé contraint est rattaché à une famille', () => {
  // Le diagnostic nomme le coupable par sa famille : un pin déclaré nulle part rendrait le message
  // muet exactement quand il sert.
  for (const spec of ['numpy<2', 'huggingface_hub>=1.5', 'onnxruntime', 'diffusers>=0.33.0']) {
    const name = spec.split(/[<>=!]/)[0];
    assert.ok(familyConstraining(name), `aucune famille ne déclare ${name}`);
  }
  assert.equal(familyConstraining('numpy'), 'anime-face');
  assert.equal(familyConstraining('onnxruntime'), 'voice');
});
