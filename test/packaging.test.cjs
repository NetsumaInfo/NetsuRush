const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('Tauri packages the staged runtime tree', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.ok(config.bundle.resources.includes('resources/**/*'));
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.match(config.plugins.updater.endpoints[0], /github\.com\/NetsumaInfo\/NetsuRush\/releases\/latest\/download\/latest\.json$/);
  assert.equal(config.bundle.windows.nsis.installerHooks, 'windows/installer-hooks.nsh');
  const hooks = fs.readFileSync(path.join(root, 'src-tauri', 'windows', 'installer-hooks.nsh'), 'utf8');
  assert.match(hooks, /NSIS_HOOK_PREINSTALL/);
  assert.match(hooks, /FindWindow \$0 "" "NetsuRush"/);
  assert.match(hooks, /SendMessage \$0 \$\{WM_CLOSE\}/);
  assert.match(hooks, /netsurush-release-lock\.exe/);
  assert.match(hooks, /--release-lock/);
  const preinstall = hooks.match(/!macro NSIS_HOOK_PREINSTALL([\s\S]*?)!macroend/)?.[1] || "";
  assert.doesNotMatch(preinstall, /powershell\.exe|stop-runtime\.ps1|taskkill\.exe|Stop-Process/);
  const rust = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.match(rust, /RmRegisterResources/);
  assert.match(rust, /RmGetList/);
  assert.match(rust, /RmNoShutdown/);
  assert.match(rust, /RmForceShutdown/);
  // Le watchdog relance le core ; sans plafond, un échec permanent (port occupé, node.exe bloqué par
  // un antivirus) se rejouait toutes les 750 ms indéfiniment sur la machine du client.
  assert.match(rust, /CORE_MAX_FAST_RESTARTS/);
  assert.match(rust, /if fast_restarts >= CORE_MAX_FAST_RESTARTS/);
  const server = fs.readFileSync(path.join(root, 'core', 'server.js'), 'utf8');
  assert.match(server, /EADDRINUSE/);
});

test('NSIS uses NetsuRush icons and clear repair and update wording', () => {
  const config = fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8');
  assert.match(config, /"installerIcon": "icons\/icon\.ico"/);
  assert.match(config, /"uninstallerIcon": "icons\/icon\.ico"/);
  assert.match(config, /"customLanguageFiles"/);
  const french = fs.readFileSync(path.join(root, 'src-tauri', 'windows', 'netsurush-installer-french.nsh'), 'utf8');
  assert.match(french, /Réparer NetsuRush/);
  assert.match(french, /Mettre à jour sans désinstaller/);
  assert.match(french, /Désinstaller NetsuRush/);
});

test('the package script stages all core and Python files plus first-run setup', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'build.ps1'), 'utf8');
  assert.match(script, /Join-Path \$root 'core\\\*'/);
  assert.match(script, /Join-Path \$root 'python\\\*'/);
  assert.match(script, /Join-Path \$PSScriptRoot 'setup\.ps1'/);
  assert.match(script, /Join-Path \$PSScriptRoot 'uninstall-cleanup\.ps1'/);
});

test('adaptive runtime entrypoints exist in source before staging', () => {
  for (const relative of [
    'core/adaptiveCodec.js', 'core/compatibility.js', 'core/hardware.js',
    'python/device_probe.py', 'python/nrdevice.py', 'scripts/setup.ps1',
    'scripts/uninstall-cleanup.ps1', 'src-tauri/windows/installer-hooks.nsh',
    'python/requirements-base.txt', 'python/requirements-search.txt',
    'python/requirements-netsulab.txt', 'python/requirements-voice.txt',
    'python/requirements-interpolate.txt',
  ]) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, `${relative} missing`);
  }
});

test('the object-removal seam chain ships with everything it needs at runtime', () => {
  for (const relative of [
    'python/nrroto/harmonize.py', 'python/nrroto/cleanplate.py',
    'python/nrroto/video.py', 'python/nrroto/roi.py', 'python/nrroto/postproc.py',
  ]) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, `${relative} missing`);
  }
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup.ps1'), 'utf8');
  assert.match(setup, /import nrroto\.harmonize, nrroto\.cleanplate, nrroto\.video/);
});

test('release metadata and updater manifest generator are present', () => {
  const releases = JSON.parse(fs.readFileSync(path.join(root, 'src', 'data', 'releases.json'), 'utf8'));
  const generator = fs.readFileSync(path.join(root, 'scripts', 'create-update-manifest.mjs'), 'utf8');
  assert.ok(releases.length > 0);
  assert.ok(releases.every((release) => release.id && release.version && release.highlights.fr.length));
  assert.match(generator, /endsWith\("-setup\.exe"\)/);
  assert.match(generator, /name\.includes\(`_\$\{pkg\.version\}_`\)/);
  assert.doesNotMatch(generator, /\.nsis\.zip/);
});

test('first-run choices expose only wired defaults and isolated optional packs', () => {
  const modules = fs.readFileSync(path.join(root, 'src', 'lib', 'modules.ts'), 'utf8');
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup.ps1'), 'utf8');
  const interpolate = fs.readFileSync(path.join(root, 'python', 'requirements-interpolate.txt'), 'utf8');
  const optional = fs.readFileSync(path.join(root, 'python', 'requirements-optional.txt'), 'utf8');
  const models = fs.readFileSync(path.join(root, 'core', 'models.js'), 'utf8');
  const registry = fs.readFileSync(path.join(root, 'src', 'lib', 'modelRegistry.ts'), 'utf8');
  const picker = fs.readFileSync(path.join(root, 'src', 'components', 'upscale', 'ModelPicker.tsx'), 'utf8');

  // L'écran d'installation offre le catalogue filtré par la DISPONIBILITÉ réelle du moteur : c'est
  // elle, et non une liste tenue à la main, qui garde les entrées sans backend hors du premier choix.
  const { MANIFEST } = require('../core/models');
  assert.notEqual(MANIFEST['depth-anything-v2-small'].available, false);
  assert.equal(MANIFEST['video-depth-anything-small'].available, false);
  assert.match(modules, /modulesForModels/);
  assert.doesNotMatch(setup, /pip install[^\r\n]*requirements-interpolate/);
  assert.doesNotMatch(interpolate, /^rife-ncnn-vulkan-python$/m);
  assert.doesNotMatch(optional, /^rife-ncnn-vulkan-python$/m);
  assert.match(models, /rife-ncnn-vulkan-python-1\.2\.1-windows_3\.10\.zip/);
  assert.match(models, /kind: 'wheelzip'/);
  assert.match(registry, /id: "rife-ncnn-vulkan"/);
  assert.doesNotMatch(registry, /id: "rife-v4\.4"|id: "rife-v4\.3"/);
  assert.match(picker, /openModelsPage/);
  assert.doesNotMatch(picker, /nr\.modelsDownload\(modelId\)/);
});

// « Successfully installed » ne prouve pas qu'un paquet s'importe. Chaque pack de module retenu doit
// être sondé POUR DE VRAI avant de conclure, sinon l'utilisateur découvre un module mort au premier
// clic. Le pack NetsuLab passe par le shim torchvision, sans quoi basicsr casse à l'import.
test('first-run setup imports each selected module pack before declaring success', () => {
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup.ps1'), 'utf8');
  const probes = setup.slice(setup.indexOf('$packProbes'), setup.indexOf('Progress 72'));
  assert.match(probes, /search\s*=\s*'import transformers, sentencepiece, accelerate, faiss'/);
  assert.match(probes, /voice\s*=\s*'import faster_whisper, onnx_asr, silero_vad, soundfile, librosa'/);
  assert.doesNotMatch(probes, /reference\s*=\s*'import yt_dlp, gallery_dl'/);
  assert.match(probes, /_patch_basicsr\(\); import realesrgan, basicsr, spandrel, rembg/);
  assert.match(probes, /Fail "Le module \$moduleId est installé mais inutilisable/);
  // Sondé APRÈS la normalisation ONNX : rembg tirerait sinon le runtime qu'on s'apprête à remplacer.
  assert.ok(setup.indexOf('ONNX Runtime $OnnxBackend') < setup.indexOf('$packProbes'));
});

test('NetsuBoard link tools are mandatory and verified outside optional module packs', () => {
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup.ps1'), 'utf8');
  const mandatory = setup.slice(setup.indexOf('$boardReq'), setup.indexOf('$moduleRequirements'));
  assert.match(mandatory, /requirements-reference\.txt/);
  assert.match(mandatory, /pip install -r \$boardReq/);
  assert.match(mandatory, /import yt_dlp, gallery_dl/);
  const optional = setup.slice(setup.indexOf('$moduleRequirements'), setup.indexOf('Progress 72'));
  assert.doesNotMatch(optional, /reference\s*=\s*'requirements-reference\.txt'/);
  assert.doesNotMatch(optional, /reference\s*=\s*'import yt_dlp, gallery_dl'/);
  assert.match(setup, /setupRuntimeVersion\s*=\s*2/);
  const coreSetup = fs.readFileSync(path.join(root, 'core', 'setup.js'), 'utf8');
  assert.match(coreSetup, /import yt_dlp, gallery_dl/);
  assert.match(coreSetup, /runtime\.online/);
});

// Le paquet ONNX installé ne prouve pas que son provider existe (CUDA/cuDNN absents, roue CPU
// réinstallée par une dépendance). Sans sonde, la configuration annonçait « cuda » pour un runtime
// CPU : diagnostic trompeur et variantes [gpu] tirées inutilement aux installations suivantes.
test('first-run setup downgrades the ONNX backend when its provider is missing', () => {
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup.ps1'), 'utf8');
  // La sonde doit créer une SESSION : `get_available_providers()` énumère ce que la roue prétend
  // savoir faire, pas ce qui se charge. Mesuré — il annonçait CUDA pendant que chaque session
  // retombait sur CPU (DLL du provider introuvable), donc nr.config.json mentait sur le backend.
  assert.match(setup, /ort\.InferenceSession\(m, providers=/);
  assert.match(setup, /get_providers\(\)/);
  assert.doesNotMatch(setup, /onnxruntime\.get_available_providers\(\)/);
  // Les DLL CUDA doivent être posées avant le chargement du provider, comme le fait le runtime.
  assert.match(setup, /from nrdevice import prepare_onnx_dlls/);
  assert.match(setup, /CUDAExecutionProvider/);
  assert.match(setup, /DmlExecutionProvider/);
  assert.match(setup, /-> configuration en CPU/);
  // La sonde doit précéder l'écriture de nr.config.json, sinon elle ne corrige rien.
  assert.ok(setup.indexOf('InferenceSession') < setup.indexOf('onnxBackend   = $OnnxBackend'));
});

// La roue `onnxruntime-gpu` doit suivre le CUDA de torch : à partir de 1.23 elle est bâtie pour
// CUDA 13 et son provider réclame `cublasLt64_13.dll`, introuvable dans un venv cu124. Elle
// s'installe pourtant sans erreur et annonce CUDA — puis tout retombe sur processeur en silence.
test('first-run setup pins onnxruntime-gpu to the CUDA branch torch was built for', () => {
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup.ps1'), 'utf8');
  const pin = setup.match(/\$OnnxCuda12Pin = 'onnxruntime-gpu==(\d+)\.(\d+)\.\d+'/);
  assert.ok(pin, 'le pin onnxruntime-gpu doit être explicite');
  const [, major, minor] = pin.map(Number);
  assert.ok(major === 1 && minor <= 22, `roue CUDA 13 (${pin[1]}.${pin[2]}) incompatible avec torch cu124`);
  // Le pin n'a de sens que tant que torch est installé depuis l'index cu124.
  assert.match(setup, /download\.pytorch\.org\/whl\/cu124/);
  assert.ok(setup.indexOf('$OnnxCuda12Pin') < setup.indexOf('pip install $onnxPackage'));
});

// Le disque plein se manifestait par un échec pip opaque après une heure de téléchargement.
test('first-run setup refuses to start without enough free disk space', () => {
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup.ps1'), 'utf8');
  assert.match(setup, /\$MinFreeGb = 3/);
  assert.match(setup, /Fail "Espace disque insuffisant/);
  // Mesuré AVANT le premier téléchargement, sinon le contrôle ne sert à rien.
  assert.ok(setup.indexOf('$MinFreeGb') < setup.indexOf("Stage 'python'"));
});

test('first-run setup verifies the mandatory TransNetV2 import', () => {
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup.ps1'), 'utf8');
  assert.match(setup, /import transnetv2_pytorch; from transnetv2_pytorch import TransNetV2/);
  assert.match(setup, /TransNetV2 absent ou non importable/);
  const coreSetup = fs.readFileSync(path.join(root, 'core', 'setup.js'), 'utf8');
  assert.match(coreSetup, /function probeRuntime\(config = CONFIG\)/);
  assert.match(coreSetup, /from transnetv2_pytorch import TransNetV2/);
  assert.match(coreSetup, /ready: venv && transnet && ffmpeg && modelsReady && gpuReady/);
});

// La version de ffmpeg est ÉPINGLÉE. `ffmpeg-release-full.7z` de gyan est une cible mouvante : elle
// est passée de 7.x à 9.0 sans qu'une ligne du dépôt ne change, pendant que le repli restait sur 7.1
// — deux majeures d'écart entre deux postes pour le même commit. Ce test verrouille l'épinglage et
// l'accord entre les deux listes de versions acceptées (PowerShell provisionne, Node contrôle) ;
// sans lui elles divergent en silence et l'écran d'installation revient en boucle.
test('the ffmpeg version is pinned and agreed on by the provisioner and the gate', () => {
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup.ps1'), 'utf8');
  const pinned = /\$FfmpegVersion = '([\d.]+)'/.exec(setup);
  const fallback = /\$FfmpegFallbackVersion = '([\d.]+)'/.exec(setup);
  assert.ok(pinned, 'setup.ps1 doit déclarer $FfmpegVersion');
  assert.ok(fallback, 'setup.ps1 doit déclarer $FfmpegFallbackVersion');

  // L'URL doit porter la version, jamais l'alias « dernière version en date ».
  assert.ok(setup.includes(`ffmpeg-$FfmpegVersion-full_build.7z`), 'l\'URL gyan doit être versionnée');
  // On vise l'URL, pas le nom : le commentaire qui explique l'épinglage cite l'alias mouvant.
  assert.doesNotMatch(setup, /gyan\.dev\/ffmpeg\/builds\/ffmpeg-release-full\.7z/, 'l\'URL gyan mouvante ne doit pas revenir');
  assert.doesNotMatch(setup, /ffmpeg-master-latest/, 'un build git-master casse libplacebo (upscale Turbo)');

  // Extraction : bsdtar d'abord (livré avec Windows), 7-Zip ensuite, y compris hors PATH.
  assert.match(setup, /System32\\tar\.exe/, 'bsdtar doit être tenté en premier');
  assert.match(setup, /7-Zip\\7z\.exe/, '7-Zip doit être sondé hors PATH');
  assert.match(setup, /function Expand-SevenZip/);

  // Une installation déjà en place doit être RELUE, sinon aucun poste ne monte jamais de version.
  assert.match(setup, /function Get-FfmpegVersion/);
  assert.match(setup, /\$ffCurrent = Get-FfmpegVersion \$ffExe/);
  assert.match(setup, /if \(-not \(Test-FfmpegVersionValue \$ffCurrent \$FfmpegAccepted\)\)/);

  // La comparaison de version est PURE : elle reçoit une chaîne déjà analysée. Si elle relançait le
  // binaire, chaque test coûterait un processus — c'est ce qui menait à 4 lancements par installation.
  const compare = /function Test-FfmpegVersionValue[\s\S]*?\n}/.exec(setup);
  assert.ok(compare, 'setup.ps1 doit déclarer Test-FfmpegVersionValue');
  assert.doesNotMatch(compare[0], /&\s*\$|Get-FfmpegVersion/, 'la comparaison de version ne doit lancer aucun processus');

  // La version posée est ENREGISTRÉE : c'est elle qui permet au contrôle rapide de juger sans lancer
  // ffmpeg à chaque démarrage (cf. ffmpegVersionOk dans core/setup.js).
  assert.match(setup, /ffmpegVersion = \$ffCurrent/, 'nr.config.json doit porter la version installée');

  // Les deux listes de versions acceptées doivent coïncider, dans le même ordre.
  const psAccepted = /\$FfmpegAccepted = @\(([^)]*)\)/.exec(setup);
  assert.ok(psAccepted, 'setup.ps1 doit déclarer $FfmpegAccepted');
  assert.equal(psAccepted[1].replace(/\s/g, ''), '$FfmpegVersion,$FfmpegFallbackVersion');
  const { FFMPEG_ACCEPTED_VERSIONS, ffmpegVersionAccepted } = require(path.join(root, 'core', 'setup.js'));
  assert.deepEqual(FFMPEG_ACCEPTED_VERSIONS, [pinned[1], fallback[1]],
    'core/setup.js et setup.ps1 doivent accepter les mêmes versions');

  // Le repli DOIT rester accepté : sinon un poste sans extracteur 7z installe la version de repli,
  // la voit refusée au démarrage suivant, et retombe indéfiniment sur l'écran d'installation.
  assert.ok(ffmpegVersionAccepted(fallback[1]), 'la version de repli doit être acceptée');
  assert.ok(ffmpegVersionAccepted(pinned[1]), 'la version épinglée doit être acceptée');
  assert.ok(ffmpegVersionAccepted(`${pinned[1]}.1`), 'un correctif de la version épinglée doit être accepté');
  assert.ok(!ffmpegVersionAccepted('7.1'), 'une version héritée doit être remplacée');
  assert.ok(!ffmpegVersionAccepted(null), 'un build git sans version stable doit être remplacé');

  // `setupStatus` lit `quickReady ? true : ffmpegReady(...)`. Contrôler la version UNIQUEMENT dans
  // `ffmpegReady` la rendait inatteignable sur une installation déjà complète — donc sur toute la
  // population qu'une montée de version doit rattraper. Le contrôle rapide doit s'en charger.
  const coreSetup = fs.readFileSync(path.join(root, 'core', 'setup.js'), 'utf8');
  const quick = /function quickSetupReady\([\s\S]*?\n}/.exec(coreSetup);
  assert.ok(quick, 'core/setup.js doit déclarer quickSetupReady');
  assert.match(quick[0], /ffmpegVersionOk\(config\)/, 'le contrôle rapide doit juger la version de ffmpeg');

  // Le contrôle rapide est traversé à CHAQUE démarrage : quand la version est enregistrée dans
  // nr.config.json, il ne doit rien lancer du tout.
  const versionOk = /function ffmpegVersionOk\([\s\S]*?\n}/.exec(coreSetup);
  assert.ok(versionOk, 'core/setup.js doit déclarer ffmpegVersionOk');
  assert.match(versionOk[0], /config\.ffmpegVersion/, 'la version enregistrée doit être lue en priorité');
  assert.doesNotMatch(versionOk[0], /spawnSync/, 'le chemin nominal ne doit lancer aucun processus');

  // Une seule invocation suffit pour les DEUX informations : ffmpeg écrit ses encodeurs sur stdout et
  // son bandeau de version sur stderr. Les demander séparément coûtait 159 ms au lieu de 85 ms.
  const probe = /function ffmpegProbe\([\s\S]*?\n}/.exec(coreSetup);
  assert.ok(probe, 'core/setup.js doit déclarer ffmpegProbe');
  assert.equal((probe[0].match(/spawnSync/g) || []).length, 1, 'ffmpegProbe ne doit lancer ffmpeg qu\'une fois');
  assert.match(probe[0], /result\.stderr/, 'la version doit être lue sur stderr');
  assert.doesNotMatch(probe[0], /'-hide_banner'/, 'masquer le bandeau supprimerait la version de stderr');
  const ready = /function ffmpegReady\([\s\S]*?\n}/.exec(coreSetup);
  assert.ok(ready, 'core/setup.js doit déclarer ffmpegReady');
  assert.doesNotMatch(ready[0], /spawnSync/, 'ffmpegReady doit passer par ffmpegProbe, pas relancer ffmpeg');

  // La version épinglée a supprimé les presets NVENC dépréciés : le code doit rester sur l'API
  // moderne (p1..p7 + tune), sans quoi tout encodage matériel casserait à la montée de version.
  const encoders = ['core/proxyEncoder.js', 'core/shaderUpscale.js', 'core/export/capabilities.js', 'core/export/encodeArgs.js']
    .map((f) => fs.readFileSync(path.join(root, ...f.split('/')), 'utf8')).join('\n');
  // On ne teste QUE les noms propres à NVENC : `medium`/`slow` restent des presets x264/x265 valides.
  for (const legacy of ['llhq', 'llhp', 'vbr_hq', 'cbr_hq', 'bd']) {
    assert.ok(!encoders.includes(`'${legacy}'`), `preset/rc NVENC supprimé encore utilisé : ${legacy}`);
  }
  assert.match(encoders, /'-preset', 'p5'/, 'les presets NVENC modernes doivent être utilisés');
});

test('installed runtime is scanned, repairable, and verified before restart', () => {
  const setup = fs.readFileSync(path.join(root, 'core', 'setup.js'), 'utf8');
  const gate = fs.readFileSync(path.join(root, 'src', 'components', 'setup', 'SetupGate.tsx'), 'utf8');
  const detect = fs.readFileSync(path.join(root, 'python', 'detect.py'), 'utf8');
  assert.match(setup, /ffmpegReady\(fresh\)/);
  assert.match(setup, /verified = probeRuntime\(fresh\)/);
  assert.match(setup, /NETSURUSH_ML_BACKEND/);
  assert.match(gate, /setup:repair/);
  assert.match(gate, /GateFrame/);
  assert.match(gate, /RECOMMENDED_MODELS = \["omnishotcut", "siglip2-so400m"\]/);
  assert.match(gate, /type="search"/);
  assert.match(gate, /@tauri-apps\/plugin-process/);
  assert.match(gate, /await relaunch\(\)/);
  assert.match(detect, /dev = torch_device\(torch\)/);
  assert.match(detect, /torch\.from_numpy\(frames\.copy\(\)\)\.to\(dev\)/);
  const setupModels = fs.readFileSync(path.join(root, 'core', 'setup-models.js'), 'utf8');
  assert.match(setupModels, /siglipModel: selectedSearch/);
});

test('NetsuCut reveals detected scenes without the removed fake thumbnail loading', () => {
  const detection = fs.readFileSync(path.join(root, 'src', 'components', 'rushes', 'useShotDetection.ts'), 'utf8');
  assert.doesNotMatch(detection, /WARM_FIRST|warmFirstThumbs/);
  assert.match(detection, /setSegments\(segs\);/);
});

test('OmniShotCut is installed and verified from the bundled local package', () => {
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup.ps1'), 'utf8');
  assert.match(setup, /vendor\\OmniShotCut/);
  assert.match(setup, /import omnishotcut; import decord/);
  assert.match(setup, /Fail "OmniShotCut absent ou non importable"/);
  const models = fs.readFileSync(path.join(root, 'core', 'models.js'), 'utf8');
  assert.match(models, /OMNISHOTCUT_PIP/);
  assert.match(models, /pipCheck: \['omnishotcut', 'decord'\]/);
  assert.match(models, /--no-deps.*OMNISHOTCUT_PIP/);
  const setupModels = fs.readFileSync(path.join(root, 'core', 'setup-models.js'), 'utf8');
  assert.match(setupModels, /async function ensureOmniShotCut/);
  assert.match(setupModels, /OMNI_PACKAGE/);
  assert.match(setupModels, /'--no-deps', OMNI_PACKAGE/);
  assert.match(setupModels, /await runPython\(\['-c', 'import omnishotcut; import decord'\]\)/);
});

test('NetsuCut exposes only the three wired detection engines and option-aware caches', () => {
  const registry = fs.readFileSync(path.join(root, 'src', 'lib', 'modelRegistry.ts'), 'utf8');
  const detect = fs.readFileSync(path.join(root, 'python', 'detect.py'), 'utf8');
  const models = fs.readFileSync(path.join(root, 'core', 'models.js'), 'utf8');

  for (const id of ['transnetv2', 'omnishotcut', 'autoshot']) {
    assert.match(registry, new RegExp(`id: "${id}"`));
  }
  assert.doesNotMatch(registry, /tas-maxxvit|tas-differential|MaxxViT Scene Change|Differential Scene Change/);
  assert.match(models, /autoshot:[\s\S]*kind: 'url'/);
  assert.match(models, /drive\.usercontent\.google\.com\/download\?id=/);
  assert.doesNotMatch(models, /scenesdetect/i);
  assert.match(detect, /scene_cache_v4/);
  assert.match(detect, /overlapWindowLength/);
  assert.match(detect, /intraLabels/);
  assert.match(detect, /interLabels/);
  assert.doesNotMatch(registry, /scenesdetect/i);
});

test('first-run setup never bypasses the gate when the core is temporarily unavailable', () => {
  const gate = fs.readFileSync(path.join(root, 'src', 'components', 'setup', 'SetupGate.tsx'), 'utf8');
  assert.match(gate, /setPhase\("error"\)/);
  assert.doesNotMatch(gate, /catch\(\(\) => \{ if \(alive\) setPhase\("done"\)\}/);
  const client = fs.readFileSync(path.join(root, 'src', 'lib', 'coreClient.ts'), 'utf8');
  assert.match(client, /BOOT_GRACE_MS = 45_000/);
  assert.match(client, /const deadline = Date\.now\(\) \+ \(coreReached \? RETRY_GRACE_MS : BOOT_GRACE_MS\)/);
  assert.match(client, /if \(Date\.now\(\) >= deadline\) break/);
  assert.match(client, /core indisponible/);
});

// Le panneau CEP est une dépendance runtime du .exe au même titre que core/ ou python/ : sans le
// stage `adobe-cep`, « Installer le panneau » échoue en bundle ; sans `dist`, la vue remote (mode
// NOMINAL du panneau) n'a rien à charger puisqu'il n'y a pas de serveur Vite en production.
test('the package script stages the Adobe CEP panel and the built renderer it serves', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'build.ps1'), 'utf8');
  assert.match(script, /Join-Path \$root 'adobe-cep\\\*'/);
  assert.match(script, /Join-Path \$root 'dist\\\*'/);

  // Résolution côté core : les deux stages ne servent que s'ils sont lus sous NR_RESOURCE_DIR.
  const panelInstall = fs.readFileSync(path.join(root, 'core', 'adobePanel.js'), 'utf8');
  assert.match(panelInstall, /NR_RESOURCE_DIR/);
  assert.match(panelInstall, /'adobe-cep', 'CSXS', 'manifest\.xml'/);
  const appstatic = fs.readFileSync(path.join(root, 'core', 'appstatic.js'), 'utf8');
  assert.match(appstatic, /NR_RESOURCE_DIR, 'dist'/);

  // Assets RELATIFS obligatoires : servi sous /app/, un build en base "/" chercherait ses chunks
  // à la racine du core et le panneau resterait blanc.
  const vite = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
  assert.match(vite, /base:\s*"\.\/"/);

  // La copie posée dans %APPDATA% ne suit AUCUNE mise à jour de l'app : sans resynchronisation au
  // démarrage du core, un utilisateur qui a installé le panneau une fois reste bloqué sur sa version.
  const rpc = fs.readFileSync(path.join(root, 'core', 'rpc.js'), 'utf8');
  assert.match(rpc, /syncPanel\(\)/);

  // Manifest : plage de version OUVERTE + CSXS 7.0, sinon Adobe rejette l'extension en SILENCE.
  const manifest = fs.readFileSync(path.join(root, 'adobe-cep', 'CSXS', 'manifest.xml'), 'utf8');
  assert.match(manifest, /Host Name="PPRO" Version="\[0\.0,99\.9\]"/);
  assert.match(manifest, /Host Name="AEFT" Version="\[0\.0,99\.9\]"/);
  assert.match(manifest, /RequiredRuntime Name="CSXS" Version="7\.0"/);
});

// La coquille n'a plus de barre à elle : Recharger/Fermer sont rendus par l'entête de l'app et
// repassent par postMessage. Sans le couple accusé `ready` / chien de garde, un iframe resté blanc
// enfermerait l'utilisateur dans un panneau vide sans aucun bouton pour en sortir.
test('the CEP shell drives the remote view from the app header, with a load watchdog', () => {
  const panel = fs.readFileSync(path.join(root, 'adobe-cep', 'js', 'panel.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'adobe-cep', 'index.html'), 'utf8');
  const remote = fs.readFileSync(path.join(root, 'src', 'lib', 'remote.ts'), 'utf8');

  assert.doesNotMatch(html, /remoteBar|btnRemoteReload|btnRemoteBack/);
  assert.match(panel, /d\.type === "nr:panel"/);
  assert.match(panel, /armReadyWatchdog/);
  assert.match(panel, /appLoadTimeout/);
  assert.match(remote, /type: "nr:panel"/);
  assert.match(remote, /signalPanelReady/);
});

// NetsuBoost sur hôte Adobe : trois modules core neufs, et un canal `boost:*` par opération. Le stage
// `core\*` les emporte déjà, mais l'affirmer explicitement est ce qui rend la règle vérifiable — un
// module déplacé hors de `core/` casserait l'onglet en bundle sans rien casser en dev.
test('the Adobe NetsuBoost modules ship and stay wired end to end', () => {
  for (const relative of ['core/adobeBoost.js', 'core/adobeCache.js', 'core/adobePrefs.js']) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, `${relative} missing`);
  }
  const script = fs.readFileSync(path.join(root, 'scripts', 'build.ps1'), 'utf8');
  assert.match(script, /Join-Path \$root 'core\\\*'/);

  // Les 12 canaux doivent rester alignés aux TROIS endroits : un canal câblé à un seul est une dette
  // immédiate — le renderer appellerait dans le vide, ou le mock navigateur planterait.
  const channels = [
    'diagnose', 'procs', 'scanCache', 'cleanCache', 'purge', 'hygiene',
    'deletePreviews', 'prefs', 'applyPrefs', 'proxyAudit', 'attachProxies', 'setEnableProxies',
  ];
  const rpc = fs.readFileSync(path.join(root, 'core', 'rpc.js'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'src', 'lib', 'coreClient.ts'), 'utf8');
  const bridge = fs.readFileSync(path.join(root, 'src', 'lib', 'bridge.ts'), 'utf8');
  for (const channel of channels) {
    const method = `boost${channel[0].toUpperCase()}${channel.slice(1)}`;
    assert.ok(rpc.includes(`"boost:${channel}"`), `boost:${channel} absent de la table H`);
    assert.ok(client.includes(`call("boost:${channel}"`), `boost:${channel} absent de coreClient`);
    assert.ok(bridge.includes(`${method}(`), `${method} absent de NrApi`);
    assert.ok(bridge.includes(`${method}: async`), `${method} absent du mock navigateur`);
  }

  // La progression de « fermer → purger → rouvrir » n'a de sens que si quelqu'un l'écoute.
  const boost = fs.readFileSync(path.join(root, 'core', 'adobeBoost.js'), 'utf8');
  assert.match(boost, /broadcast\("boost:progress"/);
  assert.match(client, /on\("boost:progress"/);

  // Les opérations envoyées à l'hôte doivent exister dans les jsx, sinon elles reviennent en
  // « opération inconnue » — visible au runtime seulement, c'est-à-dire jamais ici.
  const shared = fs.readFileSync(path.join(root, 'src', 'components', 'optimize', 'boost', 'boostShared.ts'), 'utf8');
  const aeft = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-aeft.jsx'), 'utf8');
  const ppro = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-ppro.jsx'), 'utf8');
  for (const id of ['memory', 'image', 'undo', 'snapshot', 'all']) assert.ok(shared.includes(`"${id}"`), `cible de purge ${id} absente`);
  for (const mode of ['removeUnused', 'consolidate']) assert.ok(aeft.includes(`"${mode}"`), `hygiène AE ${mode} absente du jsx`);
  assert.ok(ppro.includes('"consolidateDuplicates"'), 'hygiène Premiere absente du jsx');
});

// Le Node bundlé n'est pas celui du développeur : `node:sqlite` n'existe sans drapeau qu'à partir de
// 22.13, et en dessous TOUTES les bases du core (bibliothèque, collections, carnet, scripts, board,
// index de cache) retombaient en silence sur leur repli JSON dans l'application installée.
test('the bundled Node serves node:sqlite, verified at fetch time', () => {
  const fetchNode = fs.readFileSync(path.join(root, 'scripts', 'fetch-node.ps1'), 'utf8');
  const pinned = /\$Version\s*=\s*'(\d+)\.(\d+)\.(\d+)'/.exec(fetchNode);
  assert.ok(pinned, 'fetch-node.ps1 doit épingler une version de Node');
  const [major, minor] = [Number(pinned[1]), Number(pinned[2])];
  assert.ok(major > 22 || (major === 22 && minor >= 13), `Node ${pinned[1]}.${pinned[2]} n'expose pas node:sqlite sans drapeau`);
  assert.match(fetchNode, /require\('node:sqlite'\)\.DatabaseSync/);
  assert.match(fetchNode, /--no-warnings/);
});

// Le lecteur natif est câblé au renderer (src/lib/nativePlayer.ts → commandes player_*). libmpv et
// ses DLL sœurs sont chargées depuis <install>/resources/windows. Ces binaires ne sont PAS
// versionnés (mpv GPL-2.0+, ffmpeg LGPL/GPL — licences distinctes de l'AGPL du projet) : le test
// vérifie donc la CHAÎNE de provisionnement, pas leur présence dans l'arbre de travail, sinon il
// échouerait sur un clone neuf avant même que quiconque ait pu builder.
test('the native player runtime is provisioned where the loader looks for it', () => {
  const fetchMpv = fs.readFileSync(path.join(root, 'scripts', 'fetch-mpv.ps1'), 'utf8');
  for (const dll of ['libmpv-2.dll', 'libplacebo-360.dll']) {
    assert.ok(fetchMpv.includes(dll), `${dll} absent du contrôle de fetch-mpv.ps1`);
  }
  // avcodec porte la version majeure de la libavcodec embarquée par mpv (61 = ffmpeg 7.x). Épingler
  // ce numéro faisait juger le runtime incomplet dès qu'un build mpv plus récent arrivait.
  assert.ok(fetchMpv.includes("'avcodec-*.dll'"), 'avcodec doit être contrôlé par motif, pas par version');
  assert.doesNotMatch(fetchMpv, /avcodec-\d+\.dll/, 'aucune version d\'avcodec ne doit être épinglée');
  const script = fs.readFileSync(path.join(root, 'scripts', 'build.ps1'), 'utf8');
  assert.match(script, /fetch-mpv\.ps1/, 'build.ps1 doit provisionner le runtime mpv');
  assert.match(script, /vendor\\mpv\\\*\.dll/, 'build.ps1 doit stager vendor\\mpv vers les ressources');
  assert.match(script, /\$stageWindows = Join-Path \$res 'windows'/, 'la cible du stage doit être resources\\windows');
  const loader = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'player', 'mpv_ffi.rs'), 'utf8');
  assert.match(loader, /join\("resources"\)\.join\("windows"\)/);
});

// Corollaire du point précédent : ces DLL ne doivent JAMAIS revenir dans le dépôt. Un `git add -A`
// distrait les réintroduirait (elles restent sur le disque du mainteneur, qui build en local).
test('the mpv runtime stays out of version control', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^src-tauri\/resources\/windows\/$/m, 'resources/windows doit rester gitignoré');
});

// setup.ps1 provisionne certains modèles hors du dossier géré (copie offline depuis les ressources,
// ou téléchargement par la bibliothèque dans son propre cache). Sans ce contrôle, l'installation
// retéléchargeait ensuite le même dépôt Hugging Face : plusieurs Go en double.
test('first-run model setup never re-downloads what is already installed', () => {
  const setupModels = fs.readFileSync(path.join(root, 'core', 'setup-models.js'), 'utf8');
  assert.match(setupModels, /statusOf\(id\)\.installed/);
  const models = fs.readFileSync(path.join(root, 'core', 'models.js'), 'utf8');
  assert.match(models, /module\.exports = \{[^}]*statusOf/);
});

// Le daemon ASR reste chaud et sert toutes les variantes : le dossier du modèle doit voyager PAR JOB.
// Passé par variable d'environnement, le chemin provisionné à l'installation était appliqué à
// n'importe quelle variante — choisir « small » chargeait silencieusement le modèle de l'installation.
test('the voice sidecar receives the directory of the requested ASR model', () => {
  const sidecars = fs.readFileSync(path.join(root, 'core', 'sidecars.js'), 'utf8');
  assert.match(sidecars, /function asrModelDir\(model\)/);
  assert.match(sidecars, /model_dir: asrModelDir\(model\)/);
  const transcribe = fs.readFileSync(path.join(root, 'python', 'transcribe.py'), 'utf8');
  assert.match(transcribe, /req\.get\("model_dir"\)/);
  const whisper = fs.readFileSync(path.join(root, 'python', 'nrvoice', 'asr_whisper.py'), 'utf8');
  assert.match(whisper, /NETSURUSH_WHISPER_ID/);
  assert.match(whisper, /def _load\(model, model_dir=None\)/);
});

// Une commande fenêtre non autorisée échoue SILENCIEUSEMENT (les appels sont enveloppés de catch
// muets) : le bouton d'épinglage ne redimensionnait rien dans l'application packagée. `core:default`
// ne donne que des LECTEURS — chaque mutateur appelé doit être déclaré.
test('every window command the renderer calls is granted by the capabilities', () => {
  const client = fs.readFileSync(path.join(root, 'src', 'lib', 'coreClient.ts'), 'utf8');
  const capabilities = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'capabilities', 'default.json'), 'utf8'));
  const granted = new Set(capabilities.permissions);
  const commands = {
    'setSize(': 'core:window:allow-set-size',
    'unmaximize(': 'core:window:allow-unmaximize',
    'setFullscreen(': 'core:window:allow-set-fullscreen',
    'center(': 'core:window:allow-center',
    'setAlwaysOnTop(': 'core:window:allow-set-always-on-top',
    'minimize(': 'core:window:allow-minimize',
  };
  for (const [call, permission] of Object.entries(commands)) {
    if (!client.includes(`win.${call}`) && !client.includes(`getCurrentWindow().${call}`)) continue;
    assert.ok(granted.has(permission), `${call.slice(0, -1)} appelé sans ${permission}`);
  }
});

// Windows PowerShell 5.1 lit un .ps1 SANS BOM en cp1252 : les caractères typographiques (’, →, …)
// y deviennent des apostrophes ou des guillemets et le script NE SE PARSE PLUS. Un fichier
// parfaitement valide en UTF-8 arrêtait donc le build (fetch-shaders) ou l'installation.
test('every PowerShell script is pure ASCII or carries a UTF-8 BOM', () => {
  const dir = path.join(root, 'scripts');
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.ps1'))) {
    const buffer = fs.readFileSync(path.join(dir, name));
    const bom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    const ascii = buffer.every((byte) => byte < 0x80);
    assert.ok(bom || ascii, `${name} : caractères non ASCII sans BOM → illisible par Windows PowerShell`);
  }
});

// Un modèle installé doit être CHARGÉ depuis le disque. Les moteurs de profondeur prennent un dépôt
// Hugging Face : sans la table publiée par le core, transformers retéléchargeait le modèle dans son
// propre cache alors que Paramètres › Modèles venait de l'installer.
test('managed depth models load from disk instead of a second download', () => {
  const sidecars = fs.readFileSync(path.join(root, 'core', 'sidecars.js'), 'utf8');
  assert.match(sidecars, /env\.NETSURUSH_MODEL_DIRS = JSON\.stringify\(localModelDirs\)/);
  assert.match(sidecars, /entry\.task !== 'depth'/);
  const runner = fs.readFileSync(path.join(root, 'python', 'nrproc', 'runner.py'), 'utf8');
  assert.match(runner, /def local_model_dir\(model\)/);
  assert.match(runner, /local_model_dir\(m\) or HF_ID\.get/);
  assert.match(runner, /local_model_dir\(m\) or DA3_ID\[m\]/);
});

// Le modèle de recherche est choisi à l'installation puis changeable : les embeddings sont indexés
// par TAG de variante, donc basculer n'écrase rien mais impose une ré-indexation complète. Le canal
// doit rester aligné aux trois endroits, et le compteur de plans doit suivre la variante ACTIVE.
test('the search model stays switchable after the install, wired end to end', () => {
  const rpc = fs.readFileSync(path.join(root, 'core', 'rpc.js'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'src', 'lib', 'coreClient.ts'), 'utf8');
  const bridge = fs.readFileSync(path.join(root, 'src', 'lib', 'bridge.ts'), 'utf8');
  for (const channel of ['modelState', 'setModel']) {
    assert.ok(rpc.includes(`"search:${channel}"`), `search:${channel} absent de la table H`);
    assert.ok(client.includes(`call("search:${channel}"`), `search:${channel} absent de coreClient`);
  }
  for (const method of ['searchModelState', 'searchSetModel']) {
    assert.ok(bridge.includes(`${method}(`), `${method} absent de NrApi`);
    assert.ok(bridge.includes(`${method}: async`), `${method} absent du mock navigateur`);
  }
  // La bascule doit relancer les daemons (l'env SigLIP est lu au spawn) et réécrire la configuration.
  const searchModel = fs.readFileSync(path.join(root, 'core', 'searchModel.js'), 'utf8');
  assert.match(searchModel, /DETECT_ENV\.NETSURUSH_SIGLIP_DIR = dir/);
  assert.match(searchModel, /saveConfig\(\{ siglipDir: dir, siglipModel: wanted, siglipModelId: wanted \}\)/);
  assert.match(rpc, /restart: \(\) => sidecars\.killSearch\(\)/);
  // Compteurs : un tag figé au require aurait continué de compter l'ancienne variante après bascule.
  const catalog = fs.readFileSync(path.join(root, 'core', 'searchCatalog.js'), 'utf8');
  assert.match(catalog, /function modelTag\(\)/);
  assert.match(catalog, /const tag = modelTag\(\);/);
  assert.match(catalog, /function indexedByModel\(\)/);
});

// NOVA-VAD n'est pas un modèle sélectionnable (aucun poids public) : son CODE est livré dans
// l'installeur et posé avec le module voix. Le chemin doit être écrit dès que le code est là, sinon
// déposer les poids plus tard n'activerait rien sans relancer l'installation.
test('the NOVA-VAD confirmation layer installs with the voice module, weights optional', () => {
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup.ps1'), 'utf8');
  assert.doesNotMatch(setup, /HasModel 'nova-vad'/);
  const novaBlock = setup.slice(setup.indexOf('$novaDir = Join-Path'), setup.indexOf('── 4b.'));
  assert.match(novaBlock, /if \(HasModule 'voice'\) \{/);
  assert.match(novaBlock, /scikit-learn joblib/);
  assert.doesNotMatch(novaBlock, /git clone|snapshot_download/);
  assert.match(setup, /if \(Test-Path \(Join-Path \$novaDir 'src\\classifier\.py'\)\) \{ \$cfg\.novaDir = \$novaDir \}/);
  const { MANIFEST } = require('../core/models.js');
  assert.equal(MANIFEST['nova-vad'], undefined, 'nova-vad ne doit pas être un modèle du catalogue');
});

test('uninstall cleanup preserves personal data unless explicitly selected', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'uninstall-cleanup.ps1'), 'utf8');
  const runtimeBlock = script.slice(script.indexOf('if ($Runtime) {'), script.indexOf('if ($UserData) {'));
  const userDataBlock = script.slice(script.indexOf('if ($UserData) {'), script.indexOf('if ($Runtime -and $UserData) {'));

  assert.doesNotMatch(runtimeBlock, /Remove-Tree \$localRoot/);
  assert.doesNotMatch(runtimeBlock, /snapshots/);
  // La base porte le roster de personnages nommés (saisi à la main) : elle suit les données
  // personnelles, jamais le nettoyage des caches. L'index FAISS, lui, est régénérable.
  assert.doesNotMatch(runtimeBlock, /netsurush\.db/);
  assert.match(runtimeBlock, /faiss_\*/);
  assert.match(userDataBlock, /Remove-Tree \$dataRoot/);
  assert.match(userDataBlock, /Join-Path \$localRoot 'snapshots'/);
  assert.match(script, /if \(\$Runtime -and \$UserData\) \{\s*Remove-Tree \$localRoot/);
});

// Le panier « temps réel » et les modèles NTIRE ajoutent trois provenances distinctes : shaders GLSL
// livrés avec l'app, runtime RTX téléchargé/déposé, poids + architecture NTIRE téléchargés. Chacune
// se casse silencieusement si un seul des maillons (fetch, manifeste, registre, sidecar) diverge.
test('real-time upscale basket and NTIRE weights stay wired end to end', () => {
  const fetchShaders = fs.readFileSync(path.join(root, 'scripts', 'fetch-shaders.ps1'), 'utf8');
  const shaderUpscale = fs.readFileSync(path.join(root, 'core', 'shaderUpscale.js'), 'utf8');
  const shared = fs.readFileSync(path.join(root, 'src', 'components', 'upscale', 'upscaleShared.ts'), 'utf8');
  const registry = fs.readFileSync(path.join(root, 'src', 'lib', 'modelRegistry.ts'), 'utf8');
  const pyModels = fs.readFileSync(path.join(root, 'python', 'upscaler', 'models.py'), 'utf8');
  const pyNtire = fs.readFileSync(path.join(root, 'python', 'upscaler', 'ntire.py'), 'utf8');
  const { MANIFEST } = require('../core/models.js');

  // ArtCNN : les six shaders publiés (deux tailles × neutre/DS/DN) sont récupérés ET routés.
  assert.match(fetchShaders, /foreach \(\$net in @\("C4F32", "C4F16"\)\)/);
  assert.match(fetchShaders, /foreach \(\$suffix in @\("", "_DS", "_DN"\)\)/);
  for (const net of ['C4F32', 'C4F16']) {
    for (const suffix of ['', '_DS', '_DN']) {
      assert.match(shaderUpscale, new RegExp(`ArtCNN_${net}${suffix}\.glsl`), `shader ArtCNN_${net}${suffix} non routé`);
      const id = `artcnn_${net.toLowerCase()}${suffix.toLowerCase()}`;
      assert.match(shared, new RegExp(`id: "${id}"`), `${id} absent du sélecteur temps réel`);
    }
  }

  // RTX VSR : le CLI se télécharge, les DLL propriétaires s'importent — jamais l'inverse.
  assert.equal(MANIFEST['rtx-video'].kind, 'url');
  assert.match(MANIFEST['rtx-video'].url, /RTXVideoProcessor\/releases\/download\/.+\/RTXVideoProcessor\.exe$/);
  // Le SDK ne se télécharge pas depuis nos serveurs (NVIDIA l'interdit et le met derrière un compte) :
  // il se provisionne en local, sans jamais demander à l'utilisateur de copier un fichier à la main.
  // Une SEULE entrée porte les deux moitiés : le binaire seul n'encode rien, les DLL seules non plus.
  assert.deepEqual(MANIFEST['rtx-video'].sdk.files, ['nvngx_vsr.dll', 'nvngx_truehdr.dll']);
  assert.match(MANIFEST['rtx-video'].sdk.page, /^https:\/\/developer\.nvidia\.com\//);
  assert.equal(MANIFEST['rtx-video-sdk'], undefined, 'le SDK n’est plus une entrée séparée');
  assert.doesNotMatch(registry, /id: "rtx-video-sdk"/, 'le catalogue n’expose qu’une seule entrée RTX');
  assert.match(shared, /id: "rtx_vsr"/);
  assert.match(registry, /id: "rtx-video"/);

  // NTIRE : mêmes équipes des deux côtés, poids ET module d'architecture téléchargés ensemble.
  const teams = [...pyNtire.matchAll(/"(ntire-[\w-]+)":/g)].map((m) => m[1]);
  assert.equal(teams.length, 14);
  for (const id of teams) {
    const entry = MANIFEST[id];
    assert.ok(entry, `${id} absent du manifeste core`);
    assert.equal(entry.kind, 'url');
    assert.equal(entry.extra.length, 1, `${id} doit aussi tirer son module d'architecture`);
    assert.match(entry.extra[0].url, /NTIRE2026_ESR\/main\/models\/.+\.py$/);
    assert.match(entry.url, /NTIRE2026_ESR\/main\/model_zoo\/.+\.pth$/);
    assert.deepEqual(entry.installSteps, [['einops', 'timm', 'huggingface_hub']]);
    assert.match(registry, new RegExp(`id: "${id}"`), `${id} absent du registre UI`);
    assert.match(shared, new RegExp(`id: "${id}"`), `${id} absent du sélecteur de modèles`);
    assert.match(pyModels, new RegExp(`"${id}":`), `${id} absent du registre sidecar`);
  }
  // Mamba et l'opérateur CUDA maison exigeraient une chaîne de build sur le poste : aucune de ces
  // trois équipes ne doit se retrouver dans la table des poids servis.
  const served = [...pyModels.matchAll(/"(team\d+_\w+)"/g)].map((m) => m[1]);
  assert.equal(served.length, 14);
  for (const excluded of ['team05', 'team12', 'team22']) {
    assert.ok(!served.some((team) => team.startsWith(excluded)), `${excluded} exige une compilation CUDA`);
  }
});

// TrueHDR est actif PAR DÉFAUT dans le CLI : la ligne de commande est le seul endroit où l'opt-in se
// joue. Un `--no-thdr` oublié convertirait tous les upscales en HDR10 sans que personne le demande.
test('RTX VSR only converts to HDR when TrueHDR is explicitly enabled', () => {
  const { buildArgs } = require('../core/rtxUpscale.js');
  const base = { input: 'in.mp4', out: 'out.mp4', start: null, end: null, quality: 21, preset: 'p6', audio: 'copy', abr: 192, vsrQuality: 4 };

  const sdr = buildArgs({ ...base, hdr: false });
  assert.ok(sdr.includes('--no-thdr'));
  assert.ok(!sdr.some((arg) => arg.startsWith('--thdr-')));
  assert.deepEqual(sdr.slice(0, 3), ['-y', '-i', 'in.mp4']);
  assert.equal(sdr[sdr.length - 1], 'out.mp4');

  const hdr = buildArgs({ ...base, hdr: { contrast: 150, saturation: 75, midGray: 20, nits: 4000 } });
  assert.ok(!hdr.includes('--no-thdr'));
  for (const [flag, value] of [['--thdr-contrast', '150'], ['--thdr-saturation', '75'],
    ['--thdr-middle-gray', '20'], ['--thdr-max-luminance', '4000']]) {
    assert.equal(hdr[hdr.indexOf(flag) + 1], value, `${flag} mal transmis`);
  }

  // Une plage passe par -ss/-t : le mode simple du CLI ne sait pas chercher dans le fichier.
  const ranged = buildArgs({ ...base, start: 12, end: 30, hdr: false });
  assert.equal(ranged[ranged.indexOf('-ss') + 1], '12');
  assert.equal(ranged[ranged.indexOf('-t') + 1], '18');

  // Le réglage n'est pas activé par défaut côté UI non plus.
  const shared = fs.readFileSync(path.join(root, 'src', 'components', 'upscale', 'upscaleShared.ts'), 'utf8');
  assert.match(shared, /rtxHdr: false/);
});
