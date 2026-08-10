// @ts-check
// Process isolé lancé après setup.ps1 : il recharge la configuration fraîche du venv puis réutilise
// le gestionnaire de modèles normal. Ainsi l'installation initiale et Paramètres › Modèles suivent
// exactement le même manifeste, les mêmes téléchargements atomiques et les mêmes destinations.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadModel, modelDir, statusOf, MANIFEST } = require('./models');
const { saveConfig, NR_HOME, CONFIG, PYTHON } = require('./config');

// OmniShotCut ne passe pas par le téléchargement HF générique : son code et son checkpoint sont
// déjà dans les resources de l'installeur. Cette seconde installation côté core est volontaire :
// setup.ps1 peut avoir été interrompu ou exécuté avec une sélection de modèles mal transmise.
const RESOURCE_DIR = process.env.NR_RESOURCE_DIR || path.join(__dirname, '..');
const OMNI_PACKAGE = path.join(RESOURCE_DIR, 'vendor', 'OmniShotCut');
const OMNI_BUNDLED_CHECKPOINT = path.join(RESOURCE_DIR, 'vendor', 'weights', 'OmniShotCut_ckpt.pth');
const OMNI_DEFAULT_CHECKPOINT = path.join(NR_HOME, 'weights', 'OmniShotCut_ckpt.pth');

function emit(payload) {
  process.stdout.write(`SETUPMODEL:${JSON.stringify(payload)}\n`);
}

function allRequestedModels() {
  try {
    const parsed = JSON.parse(process.env.NR_SETUP_MODELS || '[]');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(String))].filter((id) => MANIFEST[id] && id !== 'transnetv2');
  } catch {
    return [];
  }
}

function allRequestedModules() {
  try {
    const parsed = JSON.parse(process.env.NR_SETUP_MODULES || '[]');
    if (!Array.isArray(parsed)) return ['derush'];
    return [...new Set(['derush', ...parsed.map(String)])];
  } catch {
    return ['derush'];
  }
}

function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let output = '';
    const append = (chunk) => { output = `${output}${chunk}`.slice(-2400); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(output.trim() || `Python exited with code ${code}`));
    });
  });
}

async function ensureOmniShotCut(index, count) {
  const checkpoint = CONFIG.omnishotCkpt || OMNI_DEFAULT_CHECKPOINT;
  if (!fs.existsSync(OMNI_PACKAGE)) {
    throw new Error(`Paquet OmniShotCut introuvable dans les resources : ${OMNI_PACKAGE}`);
  }
  if (!fs.existsSync(checkpoint)) {
    if (!fs.existsSync(OMNI_BUNDLED_CHECKPOINT)) {
      throw new Error(`Poids OmniShotCut introuvables dans les resources : ${OMNI_BUNDLED_CHECKPOINT}`);
    }
    await fs.promises.mkdir(path.dirname(checkpoint), { recursive: true });
    await fs.promises.copyFile(OMNI_BUNDLED_CHECKPOINT, checkpoint);
  }

  emit({ id: 'omnishotcut', index, count, pct: 0, stage: 'verify' });
  try {
    await runPython(['-c', 'import omnishotcut; import decord']);
  } catch (_) {
    // Le dépôt local est la source de vérité : jamais de `git+https` sur le PC d'un utilisateur.
    emit({ id: 'omnishotcut', index, count, pct: 35, stage: 'install' });
    await runPython(['-m', 'pip', 'install', '--no-input', 'decord']);
    await runPython(['-m', 'pip', 'install', '--no-input', '--no-deps', OMNI_PACKAGE]);
    emit({ id: 'omnishotcut', index, count, pct: 80, stage: 'verify' });
    await runPython(['-c', 'import omnishotcut; import decord']);
  }
  saveConfig({ omnishotCkpt: checkpoint });
  emit({ id: 'omnishotcut', index, count, pct: 100, stage: 'done' });
}

async function main() {
  const selected = allRequestedModels();
  const selectedModules = allRequestedModules();
  const hasOmniShotCut = selected.includes('omnishotcut');
  const ids = selected.filter((id) => id !== 'omnishotcut');
  const count = ids.length + (hasOmniShotCut ? 1 : 0);
  if (hasOmniShotCut) await ensureOmniShotCut(0, count);
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const current = index + (hasOmniShotCut ? 1 : 0);
    // setup.ps1 provisionne déjà certains modèles autrement : copie offline depuis les ressources de
    // l'installeur, ou téléchargement par la bibliothèque elle-même dans son propre cache (Whisper
    // CTranslate2, Parakeet ONNX, profondeur via le cache Hugging Face). Sans ce contrôle, la même
    // installation retéléchargeait le dépôt complet dans le dossier géré — plusieurs Go en double.
    if (statusOf(id).installed) {
      emit({ id, index: current, count, pct: 100, stage: 'done' });
      continue;
    }
    emit({ id, index: current, count, pct: 0, stage: 'download' });
    const result = await downloadModel(id, (progress) => emit({ ...progress, id, index: current, count }));
    if (!result.ok) throw new Error(result.error || `download failed: ${id}`);
  }

  const selectedSearch = ids.find((id) => id.startsWith('siglip2-'));
  if (selectedSearch) {
    const dir = modelDir(selectedSearch);
    if (dir) saveConfig({ siglipDir: dir, siglipModel: selectedSearch, siglipModelId: selectedSearch });
  }
  saveConfig({ setupModules: selectedModules, setupModels: selected, setupCompletedAt: new Date().toISOString() });
  emit({ pct: 100, stage: 'done', count });
}

main().catch((error) => {
  emit({ pct: null, stage: 'error', error: String(error && error.message || error) });
  process.exitCode = 1;
});
