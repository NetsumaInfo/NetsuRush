// @ts-check
// core/venvs.js
// Familles d'environnement des modèles : quelle pile python chaque modèle occupe, quels paquets
// PARTAGÉS il contraint, et que faire quand deux modèles ne peuvent pas cohabiter.
//
// Pourquoi ce fichier existe : un modèle installe une dépendance partagée et écrase celle d'un
// autre, en silence. C'est arrivé trois fois — le pin `huggingface_hub==0.36.2` de MatAnyone a tué
// la recherche entière (`cannot import name 'is_offline_mode'`), `faster-whisper` a reposé
// `onnxruntime` CPU par-dessus la version GPU, et `dghs-imgutils` exige `numpy<2` que le reste du
// venv ne supporte pas. Chaque fois, rien ne le disait : ni à l'installation, ni au premier échec.
//
// UN SEUL environnement. Le venv principal reste la seule pile python de l'application : isoler un
// modèle demanderait soit de reproduire l'installation torch CUDA hors de `setup.ps1` (~6 Go et
// deux installeurs à tenir), soit de sortir un moteur du sidecar qui l'importe EN PROCESS
// (`nrsearch/faceengines.py` charge imgutils à côté de SigLIP). Les familles servent donc à
// DÉCRIRE et à DÉTECTER, pas à séparer : un conflit se règle en choisissant un modèle, pas en
// multipliant les environnements.
//
// Module PUR côté décision (`familyOf`, `resolveInstall`, `readPipCheck`) : testable sans rien
// installer, et sans importer `core/models.js` — ce serait un cycle, models.js appelant d'ici.

/**
 * Familles = piles python distinctes. `constrains` liste les paquets PARTAGÉS que la famille borne
 * réellement ; toute nouvelle borne doit y apparaître, faute de quoi le prochain conflit sera de
 * nouveau découvert par l'utilisateur (verrouillé par test/venv-families.test.cjs).
 * @type {Record<string, { base: 'torch' | 'onnx' | 'none', constrains: string[] }>}
 */
const FAMILIES = {
  // torch + transformers : recherche SigLIP, profondeur, détourage, matte fin.
  core: { base: 'torch', constrains: ['huggingface_hub>=1.5', 'transformers>=4.49'] },
  // torch + basicsr/spandrel/realesrgan.
  upscale: { base: 'torch', constrains: [] },
  // torch + architectures vendorées (RIFE, GMFSS, DRBA).
  interpolation: { base: 'torch', constrains: [] },
  // torch + le paquet `sam2` (ou `sam3`). Les forks se disputent la MÊME distribution pip.
  sam: { base: 'torch', constrains: ['SAM-2'] },
  // torch + diffusers : MiniMax-Remover, VideoMaMa, PowerPaint, DiffuEraser.
  diffusion: { base: 'torch', constrains: ['diffusers>=0.33.0'] },
  // ONNX Runtime + ctranslate2 : whisper, parakeet, canary. `onnxruntime` est POSÉ PAR LA VOIE
  // EXPLICITE (setup.ps1, selon NETSURUSH_ONNX_BACKEND) et jamais par une dépendance transitive.
  voice: { base: 'onnx', constrains: ['onnxruntime'] },
  // ONNX pur : dghs-imgutils (détection de visage animé + CCIP). Installé `--no-deps` EXPRÈS.
  'anime-face': { base: 'onnx', constrains: ['numpy<2', 'opencv-contrib-python'] },
  // Livré avec l'application ou téléchargé sans dépendance python propre.
  bundled: { base: 'none', constrains: [] },
};

/**
 * Famille déduite de la TÂCHE du modèle — une tâche = une pile. Écrire la famille sur chacune des
 * 123 entrées du manifeste ferait 123 occasions de se tromper pour une information qui se déduit.
 * @type {Record<string, string>}
 */
const FAMILY_BY_TASK = {
  search: 'core',
  depth: 'core',
  matte: 'core',
  face: 'core',
  segment: 'sam',
  'object-removal': 'diffusion',
  upscale: 'upscale',
  restore: 'upscale',
  interpolate: 'interpolation',
  'voice-asr': 'voice',
  detect: 'bundled',
};

/**
 * Exceptions à la déduction, chacune justifiée : le modèle n'occupe pas la pile de sa tâche.
 * @type {Record<string, string>}
 */
const FAMILY_OVERRIDES = {
  // Seul modèle de visage à passer par dghs-imgutils (ONNX) plutôt que par les .onnx d'opencv_zoo.
  'face-anime': 'anime-face',
  // Poids en téléchargement direct SANS tâche, mais ce n'est pas un upscaler : les deux .onnx
  // opencv_zoo (YuNet + SFace) sont chargés par le sidecar de recherche.
  'face-real': 'core',
  // Le matte fin de VideoMaMa est un UNet diffusers, pas la pile transformers des autres mattes.
  videomama: 'diffusion',
};

const DEFAULT_FAMILY = 'core';

/**
 * @param {string} id
 * @param {{ task?: string, kind?: string }} entry
 * @returns {string}
 */
function familyOf(id, entry) {
  if (FAMILY_OVERRIDES[id]) return FAMILY_OVERRIDES[id];
  if (entry && entry.kind === 'bundled') return 'bundled';
  if (entry && entry.task) return FAMILY_BY_TASK[entry.task] || DEFAULT_FAMILY;
  // Un poids en téléchargement direct SANS tâche est un upscaler : même convention que
  // `core/models.js` pour ranger ses fichiers (`m.task || (kind === 'url' ? 'upscale' : 'misc')`).
  // Deux règles divergentes classeraient le même modèle à deux endroits.
  if (entry && entry.kind === 'url') return 'upscale';
  return DEFAULT_FAMILY;
}

/**
 * Décide si un modèle peut s'installer. PURE : l'état installé est fourni par l'appelant, donc la
 * décision se teste sans venv, sans réseau et sans manifeste.
 *
 * `replace` est le CONSENTEMENT de l'utilisateur, jamais un défaut : sans lui, un conflit est
 * refusé. Avant, `installPipFork` désinstallait le modèle concurrent sans rien demander — on
 * perdait une installation qui marchait pour une autre qu'on n'avait pas encore essayée.
 *
 * @param {string} id
 * @param {{ exclusiveWith?: string[], task?: string, kind?: string }} entry
 * @param {{ isInstalled: (id: string) => boolean, replace?: boolean }} state
 * @returns {{ mode: 'shared' | 'conflict', family: string, blockedBy: string[] }}
 */
function resolveInstall(id, entry, state) {
  const family = familyOf(id, entry);
  const peers = (entry && entry.exclusiveWith) || [];
  const blockedBy = peers.filter((peer) => state.isInstalled(peer));
  if (!blockedBy.length || state.replace) return { mode: 'shared', family, blockedBy: [] };
  return { mode: 'conflict', family, blockedBy };
}

// `pip check` : « <paquet> <version> has requirement <spec>, but you have <installé> » et
// « <paquet> <version> requires <dep>, which is not installed ».
const HAS_REQUIREMENT = /^(\S+) (\S+) has requirement (\S+), but you have (\S+) (\S+)\.$/;
const REQUIRES_MISSING = /^(\S+) (\S+) requires (\S+), which is not installed\.$/;

/**
 * Traduit la sortie de `pip check` en constats exploitables. PURE.
 *
 * Trois lignes sont ATTENDUES sur une installation saine : `faster-whisper` réclame `onnxruntime`
 * (posé sous le nom `onnxruntime-gpu`, cf. Partie A), `dghs-imgutils` réclame `opencv-contrib-python`
 * et `omnishotcut` réclame `opencv-python` — le venv porte une SEULE distribution cv2, la variante
 * `contrib-headless`, qui est le surensemble des deux. Les signaler comme des pannes apprendrait à
 * l'utilisateur à ignorer le diagnostic entier.
 *
 * @param {string} output
 * @returns {{ package: string, requirement: string, found: string | null, expected: boolean, line: string }[]}
 */
function readPipCheck(output) {
  const expectedMissing = new Set(['onnxruntime', 'opencv-contrib-python', 'opencv-python']);
  const findings = [];
  for (const raw of String(output || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const conflict = HAS_REQUIREMENT.exec(line);
    if (conflict) {
      findings.push({ package: conflict[1], requirement: conflict[3], found: conflict[5], expected: false, line });
      continue;
    }
    const missing = REQUIRES_MISSING.exec(line);
    if (missing) {
      findings.push({
        package: missing[1], requirement: missing[3], found: null,
        expected: expectedMissing.has(missing[3]), line,
      });
    }
  }
  return findings;
}

/** Nom de distribution pip → famille qui la contraint, pour nommer le coupable dans le diagnostic. */
function familyConstraining(pkg) {
  const needle = String(pkg || '').toLowerCase();
  for (const [family, def] of Object.entries(FAMILIES)) {
    if (def.constrains.some((spec) => spec.toLowerCase().split(/[<>=!]/)[0] === needle)) return family;
  }
  return null;
}

module.exports = {
  FAMILIES, FAMILY_BY_TASK, FAMILY_OVERRIDES, DEFAULT_FAMILY,
  familyOf, resolveInstall, readPipCheck, familyConstraining,
};
