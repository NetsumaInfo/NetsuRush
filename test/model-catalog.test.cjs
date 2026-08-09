// Le catalogue de modèles est la première chose que voit un nouvel utilisateur. Livré brut il compte
// plus de cent entrées, et une liste qu'on ne peut pas lire ne propose pas un choix : elle en empêche
// un. Ces tests verrouillent la sélection courante (ce qui s'affiche AVANT le mode avancé) et le
// contrat qui lie le registre du renderer au manifeste du core.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { MANIFEST, PIP_PATCHES } = require('../core/models.js');

// Une entrée du registre par ligne : c'est la mise en forme du fichier, et la lire ainsi évite de
// transpiler du TypeScript pour un test.
function registryEntries() {
  return [...read('src/lib/modelRegistry.ts').matchAll(/^\s*\{ id: "([^"]+)".*$/gm)].map((m) => ({
    id: m[1],
    line: m[0],
    task: (m[0].match(/task: "([^"]+)"/) || [])[1],
    advanced: m[0].includes('advanced: true'),
    isDefault: m[0].includes('default: true'),
  }));
}

// Ce qu'un utilisateur voit vraiment : ni les entrées avancées, ni celles dont le moteur n'est pas
// câblé (`available: false` côté core les retire de la liste).
function curatedByTask() {
  const byTask = {};
  for (const entry of registryEntries()) {
    if (entry.advanced || MANIFEST[entry.id].available === false) continue;
    (byTask[entry.task] = byTask[entry.task] || []).push(entry.id);
  }
  return byTask;
}

test('le registre et le manifeste déclarent exactement les mêmes modèles', () => {
  const registry = registryEntries().map((e) => e.id);
  const manifest = Object.keys(MANIFEST);
  assert.deepEqual(registry.filter((id) => !manifest.includes(id)), [],
    'modèle proposé au catalogue mais que le core ne sait pas télécharger');
  assert.deepEqual(manifest.filter((id) => !registry.includes(id)), [],
    'modèle téléchargeable mais absent du catalogue');
  assert.equal(new Set(registry).size, registry.length, 'id dupliqué dans le registre');
});

test('chaque tâche expose au plus six modèles avant le mode avancé', () => {
  const oversized = Object.entries(curatedByTask())
    .filter(([, ids]) => ids.length > 6)
    .map(([task, ids]) => `${task} (${ids.length})`);
  assert.deepEqual(oversized, [], 'la sélection courante doit rester lisible d’un coup d’œil');
});

test('aucune tâche câblée ne se retrouve sans modèle visible', () => {
  const curated = curatedByTask();
  // Une tâche dont TOUTES les entrées sont indisponibles n'a rien à afficher : c'est une feuille de
  // route, pas un trou. On ne contrôle donc que les tâches ayant au moins un moteur câblé.
  const wired = new Set(registryEntries()
    .filter((e) => MANIFEST[e.id].available !== false)
    .map((e) => e.task));
  const empty = [...wired].filter((task) => !curated[task]);
  assert.deepEqual(empty, [], 'une tâche câblée doit proposer au moins un modèle sans passer en avancé');
});

test('un modèle recommandé n’est jamais caché derrière le mode avancé', () => {
  // Sauf s'il est indisponible : RVM reste le défaut permissif de la matte vidéo (invariant NC) alors
  // que son moteur n'est pas câblé — le mettre en avant promettrait un résultat qu'il ne rend pas.
  const hidden = registryEntries()
    .filter((e) => e.isDefault && e.advanced && MANIFEST[e.id].available !== false)
    .map((e) => e.id);
  assert.deepEqual(hidden, []);
});

test('les modèles retirés du produit ne reviennent nulle part', () => {
  // PiD et Gater3 : moteurs abandonnés. Big LaMa : inpainting par image, le fond scintillait.
  // U²-Net / IS-Net : masques dépassés par BiRefNet sur les mêmes images.
  const removed = ['pid', 'tas-gater3', 'lama', 'u2net', 'isnet-anime', 'isnet-general-use'];
  const sources = [
    'src/lib/modelRegistry.ts', 'src/lib/bridge.ts',
    'src/components/upscale/upscaleShared.ts', 'src/components/upscale/processShared.ts',
    'src/components/netsulab/roto/rotoShared.ts',
  ].map(read).join('\n');
  for (const id of removed) {
    assert.equal(MANIFEST[id], undefined, `${id} est encore téléchargeable`);
    assert.doesNotMatch(sources, new RegExp(`id: "${id}"`), `${id} est encore proposé dans un sélecteur`);
  }
});

test('RTX Video Super Resolution est UNE fonctionnalité, pas deux modèles', () => {
  // Le binaire seul n'encode rien, les bibliothèques NVIDIA seules non plus : deux entrées ne
  // proposaient pas un choix, seulement deux façons d'échouer à moitié.
  const rtx = registryEntries().filter((e) => e.id.startsWith('rtx-'));
  assert.deepEqual(rtx.map((e) => e.id), ['rtx-video']);
  assert.ok(MANIFEST['rtx-video'].sdk.files.length > 0, 'l’entrée porte aussi les DLL du SDK');
  assert.equal(MANIFEST['rtx-video'].kind, 'url', 'le binaire reste téléchargeable');
});

test('SAM 3.1 a son propre moteur : il ne parle pas l’API de SAM 2', () => {
  const engine = read('python/nrroto/sam3_engine.py');
  const session = read('python/nrroto/session.py');
  // SAM 3 tient ses sessions lui-même et se pilote par requêtes ; appeler `init_state` /
  // `add_new_points_or_box` dessus n'existe tout simplement pas.
  for (const call of ['"start_session"', '"add_prompt"', '"propagate_in_video"', '"close_session"']) {
    assert.ok(engine.includes(call), `sam3_engine doit émettre la requête ${call}`);
  }
  assert.match(engine, /build_sam3_video_predictor/);
  // Le prédicteur amont appelle `.cuda()` en dur : sans refus explicite, l'erreur remontée serait
  // une trace torch illisible au lieu d'une consigne.
  assert.match(engine, /sam3_cuda_required/);
  // Le choix du moteur se fait sur l'ID du modèle : un dossier de poids ne dit pas sa génération.
  assert.match(session, /SAM3_MODELS = \{"sam3\.1"\}/);
  assert.match(read('core/roto.js'), /o\.samModel = opts\.model/);
});

test('les forks de SAM 2 s’excluent et le catalogue le dit', () => {
  const registry = read('src/lib/modelRegistry.ts');
  for (const id of ['samurai', 'sam2long']) {
    const entry = MANIFEST[id];
    assert.equal(entry.kind, 'pipfork', `${id} remplace un paquet partagé, ce n'est pas un poids`);
    assert.ok(entry.needs.length, `${id} ne sert à rien sans poids SAM 2.1`);
    assert.ok(entry.exclusiveWith.length, `${id} doit déclarer ce qu'il remplace`);
    assert.match(registry, new RegExp(`id: "${id}"[^\\n]*exclusive: "sam2-package"`),
      `${id} doit porter le groupe d'exclusivité côté catalogue`);
  }
  assert.deepEqual(MANIFEST.samurai.exclusiveWith, ['sam2long']);
  assert.deepEqual(MANIFEST.sam2long.exclusiveWith, ['samurai']);
  // Le paquet de SAMURAI vit dans un sous-dossier du dépôt : sans `pipSubdir`, pip ne trouve pas de
  // setup.py à la racine du tarball et l'installation échoue.
  assert.equal(MANIFEST.samurai.pipSubdir, 'sam2');
});

test('MatAnyone s’installe sans les dépendances de sa démo', () => {
  // Les deux dépôts déclarent Gradio, PySide6, tensorboard, une dépendance `git+` et deux épinglages
  // exacts (huggingface_hub, imageio) : les résoudre rétrograde le venv partagé — c'est la source des
  // « dependency conflicts » de pip — pour ~1 Go de code jamais exécuté.
  for (const id of ['matanyone', 'matanyone2']) {
    const steps = MANIFEST[id].installSteps;
    assert.ok(Array.isArray(steps) && steps.length === 2, `${id} doit installer deps puis package`);
    assert.ok(steps[1].includes('--no-deps'), `${id} ne doit pas résoudre les dépendances amont`);
    assert.ok(steps[0].includes('omegaconf') && steps[0].includes('hydra-core'),
      `${id} doit déclarer lui-même ce que son inférence importe`);
  }
});

test('le pin huggingface_hub de MatAnyone est retiré ET son plancher déclaré', () => {
  // `--no-deps` ne protège PAS du pin `huggingface_hub==0.36.2` : il entre dans les métadonnées du
  // paquet installé, donc pip le fait respecter à la résolution SUIVANTE et rétrograde le hub.
  // transformers 5.x exige `>=1.5` et importe `is_offline_mode`, absent en 0.36 → diffusers ne
  // charge plus l'autoencodeur Wan et la suppression d'objet échoue sur une erreur qui ne nomme
  // jamais MatAnyone. Bug réel, mis des heures à remonter jusqu'à sa cause.
  for (const id of ['matanyone', 'matanyone2']) {
    assert.ok((MANIFEST[id].pipPatch || []).includes('matanyone-drop-hub-pin'),
      `${id} doit retirer le pin exact du hub avant le build`);
    const floor = MANIFEST[id].installSteps[0].find((d) => /^huggingface[-_]hub/i.test(d));
    assert.match(floor, />=\s*1\.5/, `${id} doit déclarer un plancher de hub compatible transformers 5`);
    assert.ok(MANIFEST[id].installSteps[1].includes('@pipTarget'),
      `${id} doit installer la copie CORRIGÉE, pas l'archive amont`);
  }
});

test('le correctif de pin est idempotent et ne touche que le hub', () => {
  const patch = PIP_PATCHES['matanyone-drop-hub-pin'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-pin-'));
  const file = path.join(dir, 'pyproject.toml');
  try {
    fs.writeFileSync(file, [
      '[project]',
      'dependencies = [',
      '  "huggingface_hub==0.36.2",',
      '  "imageio==2.25.0",',
      '  "gradio",',
      ']',
    ].join('\n'));
    assert.equal(patch(dir), true, 'le pin présent doit être retiré');
    const out = fs.readFileSync(file, 'utf8');
    assert.match(out, /"huggingface_hub"/, 'la dépendance reste, seul le pin part');
    assert.doesNotMatch(out, /huggingface[-_]hub\s*==/i);
    // Les autres épinglages ne sont PAS l'affaire de ce correctif : `imageio==2.25.0` est géré par
    // l'installation `--no-deps`, et l'élargir masquerait ce que ce patch corrige vraiment.
    assert.match(out, /"imageio==2\.25\.0"/);
    assert.equal(patch(dir), false, 'sans pin, le correctif ne réécrit rien');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
