const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('upscale frame comparison has a bounded worker request', () => {
  const source = read('core/sidecars.js');
  const frame = source.slice(source.indexOf('async function runUpscaleFrame'), source.indexOf('async function runUpscaleImage'));
  assert.match(frame, /dUpscale\.req\([\s\S]*?,\s*null,\s*\d[\d_]*\s*\)/);
  assert.match(source, /test d.upscale interrompu après/);
});

test('the model picker waits for the authoritative installed-model list', () => {
  const source = read('src/components/upscale/ModelPicker.tsx');
  assert.match(source, /if \(!coreAvailable\) return true/);
  assert.match(source, /if \(!ids\) return false/);
  assert.match(source, /m\.installed && !m\.partial/);
});

test('downloaded upscale weights are usable only with their Python engine', () => {
  const models = require('../core/models.js');
  assert.deepEqual(models.MANIFEST.anime.pipCheck, ['realesrgan', 'basicsr']);
  assert.deepEqual(models.MANIFEST.general.pipCheck, ['realesrgan', 'basicsr']);
  assert.deepEqual(models.MANIFEST.fallin.pipCheck, ['spandrel', 'spandrel_extra_arches']);
  const source = read('core/models.js');
  const urlStatus = source.slice(source.indexOf("if (m.kind === 'url')"), source.indexOf("if (m.kind === 'pip')"));
  const urlDownload = source.slice(source.indexOf("if (m.kind === 'url')", source.indexOf('async function downloadModel')), source.indexOf("if (m.kind === 'hf')", source.indexOf('async function downloadModel')));
  assert.match(urlStatus, /pipPresent\(m\)/);
  assert.match(urlDownload, /ensurePipPackage\(m, id, report(?:, ctrl)?\)/);
});

test('the complete UI catalog mirrors a verified core manifest', () => {
  const { MANIFEST } = require('../core/models.js');
  const registry = read('src/lib/modelRegistry.ts');
  const ids = [...registry.matchAll(/\{ id: "([^"]+)", label:/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(ids)].sort(), Object.keys(MANIFEST).sort());
  for (const [id, model] of Object.entries(MANIFEST)) {
    if (model.available === false) continue;
    // Un poids seul ne s'exécute pas : il doit nommer le paquet python qui le charge. Seule exception,
    // l'entrée dont l'artefact EST le moteur (le binaire natif RTX) — statusOf vérifie déjà ce fichier,
    // il n'y a aucun paquet à contrôler en plus.
    const nativeRuntime = /\.exe$/i.test(model.file || '');
    if (model.kind === 'url' && !nativeRuntime) assert.ok(model.pipCheck, `${id} must verify its runtime, not weights alone`);
  }
  for (const id of ['seedvr2', 'whisperx', 'canary-1b-v2', 'nemotron-3.5-asr', 'rvm', 'sam2matting', 'diffueraser']) {
    assert.equal(MANIFEST[id].available, false, `${id} is scaffold-only and must not be selectable`);
  }
});

test('the model installer keeps a specific description for every catalog entry', () => {
  const registry = read('src/lib/modelRegistry.ts');
  const entries = registry.split(/\r?\n/).filter((line) => line.includes('{ id: '));
  for (const line of entries) {
    const id = line.match(/id: "([^"]+)"/)?.[1] || line;
    assert.match(line, /hint: "[^"]+"/, `${id} needs a concise model-specific hint`);
  }

  const settings = read('src/components/settings/models/ModelsSettings.tsx');
  const keyBuilder = settings.slice(settings.indexOf('function modelHintKeys'), settings.indexOf('function sortModels'));
  assert.doesNotMatch(keyBuilder, /taskHint/, 'a generic task hint must not hide the model-specific fallback');
});

test('missing selected models redirect to downloads and successful installs require restart', () => {
  const picker = read('src/components/upscale/ModelPicker.tsx');
  const manager = read('src/components/settings/models/useModelManager.ts');
  const settings = read('src/components/settings/models/ModelsSettings.tsx');
  const roto = read('src/components/netsulab/roto/RotoPanels.tsx');
  const voice = read('src/components/voice/VoiceControls.tsx');
  const core = read('core/models.js');
  assert.match(picker, /useRequireModel/);
  assert.match(picker, /openModelsPage\(\)/);
  assert.match(manager, /restartRequired/);
  assert.match(manager, /@tauri-apps\/plugin-process/);
  assert.match(manager, /await relaunch\(\)/);
  assert.match(settings, /mgr\.restartRequired/);
  assert.match(settings, /mgr\.restart/);
  assert.match(roto, /useRequireModel\(model\)/);
  assert.match(roto, /useRequireModel\(eng,/);
  assert.match(voice, /useRequireModel\(asrModel\)/);
  assert.match(core, /return done\(\)/);
  assert.match(core, /await pyRuntimeReady\(m, checks\)/);
});

test('cleanup controls reach both frame comparison and final upscale', () => {
  const hook = read('src/components/upscale/useUpscale.ts');
  const sidecars = read('core/sidecars.js');
  assert.match(hook, /cleanupNoise: settings\.cleanupNoise/);
  assert.match(hook, /cleanupEdges: settings\.cleanupEdges/);
  assert.match(sidecars, /cleanup_noise: cleanupNoise/);
  assert.match(sidecars, /cleanup_edges: cleanupEdges/);
});

test('comparison loading state follows image URLs instead of resetting after onLoad', () => {
  const source = read('src/components/upscale/UpscaleCompare.tsx');
  assert.match(source, /loadedUrls\.has\(left\.url\)/);
  assert.match(source, /loadedUrls\.has\(right\.url\)/);
  assert.doesNotMatch(source, /setOrigLoaded\(false\)|setUpLoaded\(false\)/);
});

test('remove background tests retain model variants and send matte cleanup settings', () => {
  const hook = read('src/components/upscale/useRemoveBg.ts');
  assert.match(hook, /mergeUpscaleModelResult/);
  assert.match(hook, /variant:\s*\{\s*id:\s*`model:\$\{modelId\}`/);
  assert.match(hook, /despeckle: settings\.despeckle/);
  assert.match(hook, /edgeSmoothing: settings\.edgeSmoothing/);
  assert.match(hook, /edgeOffset: settings\.edgeOffset/);
});

test('matte cleanup uses the same compact sliders as Roto Studio', () => {
  const source = read('src/components/upscale/RemoveBgSettings.tsx');
  assert.match(source, /import \{ Slider \}/);
  assert.match(source, /<Slider min=\{min\} max=\{max\}/);
  assert.doesNotMatch(source, /matteNoiseNote|matteSmoothingNote|matteOffsetNote/);
});

test('completed NetsuLab renders become persistent source/result reviews in the center viewer', () => {
  const sources = read('src/components/upscale/useProcSources.ts');
  const preview = read('src/components/upscale/UpscalePreview.tsx');
  const review = read('src/components/upscale/RenderedReview.tsx');
  const hooks = [
    'src/components/upscale/useUpscale.ts',
    'src/components/upscale/useInterpolate.ts',
    'src/components/upscale/useDepth.ts',
    'src/components/upscale/useRemoveBg.ts',
    'src/components/netsulab/useChainRun.ts',
  ].map(read).join('\n');
  assert.match(sources, /nr\.netsulab\.renders\.v1/);
  assert.match(sources, /recordRenders/);
  assert.match(sources, /renderedForActive/);
  assert.match(preview, /<RenderedReview/);
  assert.match(review, /review\.outputPath/);
  assert.match(review, /value=\{\[side\]\}/);
  assert.match(review, /compareRenderFrames/);
  assert.match(hooks, /makeRenderReviews/);
  assert.equal((hooks.match(/recordRenders\(/g) || []).length, 5);
});

test('restoration is a verified 1x sub-mode of the existing upscale workflow', () => {
  const { MANIFEST } = require('../core/models.js');
  const python = read('python/upscaler/models.py');
  const shared = read('src/components/upscale/upscaleShared.ts');
  // Le bloc de réglages de modèle est PARTAGÉ avec l'upscale à l'archivage des collections : il vit
  // dans UpscaleModelSettings, que UpscaleSettings et le panneau d'archivage rendent tous deux.
  const settings = read('src/components/upscale/UpscaleModelSettings.tsx');
  const verified = [
    'tas-scunet', 'tas-nafnet', 'tas-dpir', 'tas-real-plksr', 'tas-anime1080fixer',
    'tas-deh264-real', 'tas-deh264-span', 'tas-hurrdeblur', 'tas-dehalo',
  ];
  for (const id of verified) {
    assert.equal(MANIFEST[id].catalogOnly, undefined, `${id} must be runnable`);
    assert.equal(MANIFEST[id].task, 'restore');
    assert.match(python, new RegExp(`"${id}"`));
  }
  assert.match(shared, /RESTORE_MODELS/);
  assert.match(shared, /mode: "upscale" \| "restore"/);
  assert.match(settings, /settings\.mode === "restore"/);
  assert.match(settings, /scale: 1/);
});

test('architectures outside the Spandrel registry ship their own module', () => {
  const { MANIFEST } = require('../core/models.js');
  const python = read('python/upscaler/models.py');
  const community = read('python/upscaler/community.py');
  const backends = read('python/upscaler/backends.py');
  // Spandrel déduit l'archi d'un state_dict : ces trois-là n'y sont pas, leur module .py doit donc
  // voyager avec les poids — et son URL être épinglée sur un COMMIT, sinon une refonte amont
  // changerait l'architecture sous des poids déjà installés.
  for (const id of ['smosr', 'figsr', 'saryn']) {
    assert.equal(MANIFEST[id].catalogOnly, undefined, `${id} must be runnable`);
    assert.equal(MANIFEST[id].pipCheck, 'torch');
    const arch = MANIFEST[id].extra || [];
    assert.equal(arch.length, 1, `${id} needs exactly one architecture module`);
    assert.match(arch[0].url, /raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//,
      `${id} architecture URL must be pinned to a commit`);
    assert.match(python, new RegExp(`"${id}": \{`));
    assert.match(community, new RegExp(`"${id}": \{`));
  }
  // Un jeu d'hyperparamètres faux rendrait des images plausibles mais fausses : le chargement doit
  // échouer plutôt que deviner.
  assert.match(community, /net\.load_state_dict\(state, strict=True\)/);
  // ShuffleSPAN est exporté à dimensions figées : sans découpage en fenêtres, tout format autre que
  // 1080p serait refusé par le graphe.
  assert.equal(MANIFEST.shufflespan.catalogOnly, undefined);
  assert.match(python, /"backend": "onnx_fixed"/);
  assert.match(backends, /class FixedOnnxUpsampler/);
});

test('a TorchScript checkpoint runs without any embedded architecture', () => {
  const { MANIFEST } = require('../core/models.js');
  const python = read('python/upscaler/models.py');
  const backends = read('python/upscaler/backends.py');
  const shared = read('src/components/upscale/upscaleShared.ts');
  // RTMoSR est publié en TorchScript : le graphe est sérialisé AVEC les poids, donc Spandrel (qui
  // déduit l'archi d'un state_dict) ne peut pas le lire et n'a pas à le faire.
  assert.equal(MANIFEST.rtmosr.catalogOnly, undefined, 'rtmosr must be runnable');
  assert.equal(MANIFEST.rtmosr.pipCheck, 'torch');
  assert.equal(MANIFEST.rtmosr.dir, MANIFEST.span.dir, 'weights must land where the sidecar looks');
  assert.match(python, /"file": "2x_umzi_anime_rtmosr\.pth", "backend": "torchscript", "netscale": 2/);
  assert.match(backends, /class TorchScriptUpsampler\(TorchUpsampler\)/);
  assert.match(backends, /torch\.jit\.load\(model_path, map_location="cpu"\)/);
  // Le facteur d'échelle n'est PAS dans le fichier TorchScript : il doit venir du registre.
  assert.match(backends, /TorchScriptUpsampler\(model_path, spec\["netscale"\]/);
  assert.match(shared, /id: "rtmosr"/);
});

test('render review frame comparison is implemented across the real bridge and browser mock', () => {
  const ffmpeg = read('core/ffmpeg.js');
  const rpc = read('core/rpc.js');
  const client = read('src/lib/coreClient.ts');
  const bridge = read('src/lib/bridge.ts');
  assert.match(ffmpeg, /async function compareFrames/);
  assert.match(ffmpeg, /-c:v.*png/);
  assert.match(rpc, /ffmpeg:compareFrames/);
  assert.match(client, /compareRenderFrames:.*ffmpeg:compareFrames/);
  assert.match(bridge, /compareRenderFrames\(opts:/);
  assert.match(bridge, /compareRenderFrames: async/);
});

test('NetsuLab video modes share the general export profile taxonomy', async () => {
  const { resolveProcessEncoding } = require('../core/processEncoding.js');
  const resolved = await resolveProcessEncoding({
    exportCodec: 'h265_main10', encoderMode: 'cpu', speed: 'quality',
    audioMode: 'aac_320', container: 'mkv',
  });
  assert.equal(resolved.ext, 'mkv');
  assert.ok(resolved.videoArgs.includes('libx265'));
  assert.ok(resolved.videoArgs.includes('slow'));
  assert.ok(resolved.audioArgs.includes('320k'));

  // Le hub, l'éditeur de profil et l'archivage d'une collection posent les mêmes questions : les
  // garde-fous vivent dans UN module, chaque écran ne garde que sa mise en page.
  const shared = read('src/components/upscale/procSettingsParts.tsx');
  assert.match(shared, /useExportEncodingFields/);
  const fields = read('src/features/export/encodingFields.ts');
  assert.match(fields, /supportedEncoderModes/);
  assert.match(fields, /supportedCodecGroups/);
  assert.match(fields, /compatibleContainersForExportCodec/);
  assert.match(fields, /compatibleAudioForContainer/);
  for (const file of ['export/ProfileEditor.tsx', 'collections/FolderEditor.tsx']) {
    assert.match(read(`src/components/${file}`), /useExportEncodingFields/);
  }
  for (const file of ['UpscaleSettings.tsx', 'InterpSettings.tsx', 'DepthSettings.tsx', 'RemoveBgSettings.tsx']) {
    assert.match(read(`src/components/upscale/${file}`), /<ProcessEncodingRows/);
  }
});
