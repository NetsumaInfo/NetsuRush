// @ts-check
// Gestionnaire de modèles app-wide (backend). Télécharge à la demande, vérifie, supprime, liste le
// statut, calcule l'espace disque. Rien n'est forcé au packaging (setup.ps1 = runtime seul) : chaque
// modèle se télécharge depuis Paramètres › Modèles ou l'écran d'install, et se supprime à tout moment.
//
// Manifeste MIROIR de src/lib/modelRegistry.ts (même `id`). Trois provenances :
//  - "url"      : poids direct (Real-ESRGAN/CUGAN) → download HTTPS .tmp→rename dans le dossier que le
//                 sidecar lit DÉJÀ (NETSURUSH_REALESRGAN_DIR) → réellement câblé au moteur.
//  - "hf"       : dépôt Hugging Face → snapshot_download via le python du venv (SigLIP/Whisper/depth…).
//  - "wheelzip" : wheel Windows précompilé contenu dans une archive officielle (RIFE) → zéro build.
//  - "bundled"  : fourni par un wheel pip / cache de lib (TransNetV2/Silero) → toujours installé.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { NR_HOME, CONFIG, PYTHON, DETECT_ENV, RTX_DIR, RTX_EXE, RTX_DLLS, fsp, saveConfig } = require('./config');
const logbus = require('./logbus');
const { t } = require('./i18n');
const { resolveInstall } = require('./venvs'); // familles d'environnement + arbitrage des exclusifs

// Dossier des poids upscale : celui que upscale.py lit (env prioritaire, sinon config, sinon défaut).
const REALESRGAN_DIR = process.env.NETSURUSH_REALESRGAN_DIR || CONFIG.realesganDir || path.join(NR_HOME, 'realesrgan');
// Dossier des poids visage RÉEL (YuNet + SFace) : MÊME défaut que config.js DETECT_ENV.NETSURUSH_FACE_DIR
// → ce que le sidecar faceengines.py lit. Un download ici est donc directement utilisable.
const FACE_DIR = process.env.NETSURUSH_FACE_DIR || CONFIG.faceDir || path.join(NR_HOME, 'weights', 'face');
// Racine des modèles HF gérés par NetsuRush.
const MODELS_DIR = path.join(NR_HOME, 'models');
// Dossier Python livré avec l'app + code vendoré (fichiers .py tiers non pip-installables).
const PYTHON_DIR = process.env.NETSURUSH_PY_DIR || path.join(__dirname, '..', 'python');
const VENDOR_DIR = path.join(PYTHON_DIR, 'nrroto', 'vendor');
const RIFE_DIR = path.join(MODELS_DIR, 'interpolate', 'rife-ncnn-vulkan');
const TAS_CATALOG_DIR = path.join(MODELS_DIR, 'the-anime-scripter');
// RIFE PyTorch (4.15 → 4.25) : les poids et, à côté, les modules d'architecture. Chaque version a
// SA structure de réseau, indéductible du checkpoint — on les récupère donc au téléchargement.
const RIFE_TORCH_DIR = path.join(TAS_CATALOG_DIR, 'interpolate');
// GMFSS Fortuna : 5 réseaux + un paquet python entier (gmflow, softsplat…). Poids et code
// arrivent chacun en archive, extraits côte à côte dans ce dossier.
const GMFSS_DIR = path.join(TAS_CATALOG_DIR, 'gmfss');
// DistilDRBA : poids .pkl + les modules d'architecture, côte à côte.
const DRBA_DIR = path.join(TAS_CATALOG_DIR, 'drba');
const DRBA_ARCH_DIR = path.join(DRBA_DIR, 'arch');
const RIFE_ARCH_DIR = path.join(RIFE_TORCH_DIR, 'arch');

const GH = 'https://github.com/xinntao/Real-ESRGAN/releases/download';
const TAS = 'https://github.com/NevermindNilas/TAS-Models-Host/releases/download/main';
// AutoShot publie officiellement le checkpoint dans le dossier Google Drive lié par le README
// du dépôt wentaozhu/AutoShot. L'ID de fichier est stable et évite de tenter de télécharger la page
// Baidu (qui demande un code de partage et ne renvoie pas directement le poids).
const AUTOSHOT_WEIGHTS_URL = 'https://drive.usercontent.google.com/download?id=1UNdegddbJDT_NwoYxyOj4QB8RLff-2g3&export=download&confirm=t';
// Packages python (code) livrés en tarball GitHub NU (pas besoin de `git`, pas de name-match).
const BEN2_PIP = 'https://github.com/PramaLLC/BEN2/archive/refs/heads/main.tar.gz';
const MATANYONE_PIP = 'https://github.com/pq-yang/MatAnyone/archive/refs/heads/main.tar.gz';
const MATANYONE2_PIP = 'https://github.com/pq-yang/MatAnyone2/archive/refs/heads/main.tar.gz';
// Les deux MatAnyone déclarent les dépendances de leur DÉMO, pas de leur inférence : Gradio, PySide6,
// tensorboard, pycocotools, gdown… plus deux ÉPINGLAGES EXACTS (`huggingface_hub==0.36.2`,
// `imageio==2.25.0`) et une dépendance `git+` (thinplate) qui échoue net sur une machine sans git.
// Les installer tels quels rétrograde le hub que transformers/faster-whisper partagent — c'est la
// source des « dependency conflicts » de pip — pour ~1 Go de code jamais exécuté. On installe donc le
// package SANS ses dépendances (même stratégie que dghs-imgutils) et on déclare ici ce que la chaîne
// d'inférence importe RÉELLEMENT : matanyone2/{inference,model,utils} et rien d'autre.
//
// `--no-deps` ne suffit PAS pour le hub : le pin `==0.36.2` reste dans les MÉTADONNÉES du paquet
// installé, et pip l'honore dès la résolution SUIVANTE — installer un autre modèle rétrogradait
// alors le hub sous les pieds de transformers 5.x, qui exige `>=1.5` et importe `is_offline_mode`
// (absent en 0.36). Symptôme observé : la suppression d'objet échoue sur
// « cannot import name 'is_offline_mode' », très loin de sa cause. D'où DEUX garde-fous : un
// plancher explicite ici, et `matanyone-drop-hub-pin` qui retire le pin du pyproject avant le
// build (MatAnyone2 n'utilise du hub que `PyTorchModelHubMixin`, présent en 1.x).
const HF_HUB_FLOOR = 'huggingface_hub>=1.5';
const MATANYONE_DEPS = ['omegaconf', 'hydra-core', 'einops', 'imageio', 'imageio-ffmpeg',
  'tqdm', 'requests', 'safetensors', HF_HUB_FLOOR];
// Package python de SAM 2 (code du Roto Studio) : tarball GitHub officiel Meta (Apache-2.0). URL NUE
// (pas `sam2 @ …`) — la distribution s'appelle « SAM-2 », un préfixe `sam2 @` casserait le name-match
// et ferait retomber pip sur un fork PyPI tiers. Le MODULE importé reste `sam2` (cf. pipCheck).
const SAM2_PIP = 'https://github.com/facebookresearch/sam2/archive/refs/heads/main.tar.gz';
// SAM 3 (Meta) : le package n'est pas sur PyPI et transformers ne l'intègre pas → tarball GitHub NU,
// comme SAM 2. Le MODULE importé est `sam3`.
const SAM3_PIP = 'https://github.com/facebookresearch/sam3/archive/refs/heads/main.tar.gz';
// EdgeTAM (Meta, Apache-2.0) est un FORK de sam2 qui expose le MÊME module `sam2` : on n'installe donc
// que ses poids, chargés par le package sam2 déjà présent (l'architecture vit dans le checkpoint).
const EDGETAM_CFG = 'https://raw.githubusercontent.com/facebookresearch/EdgeTAM/main/sam2/configs/edgetam.yaml';
// SAMURAI (Apache-2.0) et SAM2Long (CC-BY-NC-4.0) sont des méthodes SANS ENTRAÎNEMENT : elles tournent
// sur les checkpoints SAM 2.1 déjà téléchargés et ne changent que la propagation. Chacune est publiée
// comme un fork du package `sam2`, sous le MÊME nom de module — d'où le groupe d'exclusivité.
const SAMURAI_PIP = 'https://github.com/yangchris11/samurai/archive/refs/heads/master.tar.gz';
const SAM2LONG_PIP = 'https://github.com/Mark12Ding/SAM2Long/archive/refs/heads/main.tar.gz';
// Nom de DISTRIBUTION pip (pas de module) des trois fournisseurs de `sam2` : `pip uninstall` prend le
// nom de distribution, et les trois déclarent le même (`SAM-2`) puisqu'ils dérivent du même pyproject.
const SAM2_DISTRIBUTION = 'SAM-2';
// Poids sur lesquels les forks tournent : au moins UN doit être installé, sinon le code seul ne
// segmente rien et l'utilisateur cherche pourquoi.
const SAM2_WEIGHT_IDS = ['sam2.1-large', 'sam2.1', 'sam2.1-small', 'sam2.1-tiny'];
// Reconnaître QUEL fork occupe `sam2` dans le venv. On ne se fie pas à un fichier d'état écrit par
// NetsuRush : un `pip install` fait à la main le rendrait faux. Chaque fork laisse une empreinte
// dans le paquet installé — SAMURAI ses configs Hydra dédiées, SAM2Long l'arbre de mémoire dont le
// prédicteur porte le paramètre `num_pathway`.
const SAM2_PROVIDERS = [
  { id: 'samurai', dir: path.join('configs', 'samurai') },
  { id: 'sam2long', file: 'sam2_video_predictor.py', marker: 'num_pathway' },
];

/** Fork occupant le module `sam2` : 'samurai' | 'sam2long' | 'stock', ou null si absent. */
function sam2Provider() {
  const sp = sitePackagesDir();
  const root = sp && path.join(sp, 'sam2');
  if (!root || !fs.existsSync(root)) return null;
  for (const provider of SAM2_PROVIDERS) {
    if (provider.dir && fs.existsSync(path.join(root, provider.dir))) return provider.id;
    if (provider.file) {
      try {
        if (fs.readFileSync(path.join(root, provider.file), 'utf8').includes(provider.marker)) return provider.id;
      } catch { /* fichier absent : ce n'est pas ce fork */ }
    }
  }
  return 'stock';
}
// OmniShotCut est livré dans l'installeur (resources/vendor) : installer ce code localement évite
// de dépendre de git sur le PC de l'utilisateur et répare aussi une installation où seuls les poids
// avaient été récupérés. En développement, le même chemin retombe sur vendor/ du dépôt.
const OMNISHOTCUT_PIP = path.join(
  process.env.NR_RESOURCE_DIR || path.join(__dirname, '..'),
  'vendor',
  'OmniShotCut',
);

// Jeton d'`installSteps` remplacé par la source pip réelle au moment de l'installation. Indispensable
// dès qu'une entrée combine `pipPatch` (la source devient une copie corrigée dans %TEMP%, dont le
// chemin n'existe pas à l'écriture du manifeste) et `installSteps`.
const PIP_TARGET = '@pipTarget';

// Runtime ONNX pour un venv qui n'en a aucun (installation sans voix/traitements/recherche). Même
// pin CUDA 12 que setup.ps1, verrouillé par packaging.test.cjs : `onnxruntime-gpu` >= 1.23 vise
// CUDA 13 et réclame une DLL absente d'un venv torch cu124.
const ONNX_RUNTIME_PIP = DETECT_ENV.NETSURUSH_ONNX_BACKEND === 'cuda'
  ? 'onnxruntime-gpu==1.20.2'
  : DETECT_ENV.NETSURUSH_ONNX_BACKEND === 'directml'
    ? 'onnxruntime-directml'
    : DETECT_ENV.NETSURUSH_ONNX_BACKEND === 'openvino'
      ? 'onnxruntime-openvino'
      : 'onnxruntime';

// Un poids `.pth` seul n'est PAS un modèle utilisable. Ces métadonnées sont partagées par tous les
// modèles du même moteur : le bouton Télécharger répare aussi le package Python manquant dans le venv.
const REAL_ESRGAN_RUNTIME = {
  pip: 'realesrgan',
  pipCheck: ['realesrgan', 'basicsr'],
  installSteps: [['realesrgan', 'basicsr']],
  // basicsr importe un ancien module torchvision : appliquer le même shim que le sidecar réel avant
  // de valider l'installation, sinon une installation saine serait faussement déclarée cassée.
  pipProbe: `import sys;sys.path.insert(0, ${JSON.stringify(PYTHON_DIR)});from upscaler.backends import _patch_basicsr;_patch_basicsr();import realesrgan, basicsr`,
};
// TorchScript : `torch.jit.load` suffit, aucun paquet d'architecture à installer.
const TORCHSCRIPT_RUNTIME = { task: 'upscale', pipCheck: 'torch' };
const SPANDREL_RUNTIME = {
  pip: 'spandrel',
  pipCheck: ['spandrel', 'spandrel_extra_arches'],
  installSteps: [['spandrel', 'spandrel-extra-arches==0.2.0']],
};
const SEARCH_RUNTIME = {
  pip: 'transformers>=4.49',
  pipCheck: ['transformers', 'sentencepiece', 'faiss', 'accelerate'],
  installSteps: [['transformers>=4.49', 'sentencepiece', 'protobuf', 'faiss-cpu', 'accelerate']],
};
// `faster-whisper` déclare `onnxruntime` SANS extra : pip pose alors la roue CPU PAR-DESSUS
// `onnxruntime-gpu` — les deux distributions écrivent dans le MÊME dossier `onnxruntime/`, donc la
// dernière installée gagne l'import. Effet mesuré : visages, Parakeet et rembg retombaient sur
// processeur (7,9× plus lent sur SFace) sans le moindre message. On installe donc `--no-deps` et on
// déclare nous-mêmes ce que l'inférence importe vraiment, le provider ONNX restant choisi par le
// setup selon le matériel. Même patron que MATANYONE_DEPS ci-dessus, même cause racine.
const WHISPER_DEPS = ['ctranslate2>=4,<5', 'tokenizers>=0.13,<1', 'av>=11', 'tqdm', HF_HUB_FLOOR];
// Lecture et rééchantillonnage du WAV de travail : `soundfile` pour la découpe des silences,
// `librosa` en plus pour les hésitations acoustiques. Ils n'appartiennent à AUCUN modèle — ils
// arrivaient donc uniquement avec le pack `voice` du premier lancement, et sur une installation qui
// n'avait pas coché ce module, « Couper les silences » échouait à l'import SANS que rien, dans
// l'application, ne sache les poser. Rattachés ici aux entrées qui les font tourner.
const AUDIO_IO_DEPS = ['soundfile', 'librosa>=0.10'];
const WHISPER_RUNTIME = {
  pip: 'faster-whisper>=1.1',
  pipCheck: ['faster_whisper', 'soundfile'],
  installSteps: [[...WHISPER_DEPS, ...AUDIO_IO_DEPS], ['--no-deps', 'faster-whisper>=1.1']],
};
const DEPTH_RUNTIME = {
  pip: 'transformers>=4.49',
  pipCheck: ['transformers', 'accelerate', 'timm', 'einops', 'kornia'],
  installSteps: [['transformers>=4.49', 'accelerate', 'timm', 'einops', 'kornia']],
};
// Modules d'architecture RIFE : vs-rife (HolyWu, MIT) publie un fichier par version, exactement les
// réseaux qu'attendent les checkpoints TheAnimeScripter. Tag ÉPINGLÉ — un `master` mouvant
// changerait l'architecture sous des poids déjà installés.
const VSRIFE = 'https://raw.githubusercontent.com/HolyWu/vs-rife/v5.7.0/vsrife';
// `warplayer.py` est importé en relatif par chacun des modules → toujours du voyage.
const RIFE_ARCH_SHARED = [{ file: 'warplayer.py', url: `${VSRIFE}/warplayer.py` }];

/** Entrée manifeste d'un RIFE PyTorch : poids TAS + son module d'architecture vs-rife. */
function rifeTorch(weightFile, archModule) {
  return {
    kind: 'url', task: 'interpolate', dir: RIFE_TORCH_DIR, file: weightFile,
    url: `${TAS}/${weightFile}`,
    pipCheck: 'torch',
    vendorDir: RIFE_ARCH_DIR,
    vendor: [...RIFE_ARCH_SHARED, { file: `${archModule}.py`, url: `${VSRIFE}/${archModule}.py` }],
  };
}

// Architecture DistilDRBA (MIT), épinglée sur un COMMIT. `warplayer` est importé en relatif par
// les deux variantes → toujours du voyage.
const DRBA_ARCH = 'https://raw.githubusercontent.com/routineLife1/DistilDRBA/db51bdeb452685cba9aee227c6dba42e67753b55/models/drba';
const DRBA_ARCH_SHARED = [{ file: 'warplayer.py', url: `${DRBA_ARCH}/warplayer.py` }];

/** Entrée manifeste d'un DistilDRBA : poids + son module d'architecture. */
function drbaEntry(weightFile, archModule) {
  return {
    kind: 'url', task: 'interpolate', dir: DRBA_DIR, file: weightFile,
    url: `${TAS}/${weightFile}`, pipCheck: 'torch', vendorDir: DRBA_ARCH_DIR,
    vendor: [...DRBA_ARCH_SHARED, { file: `${archModule}.py`, url: `${DRBA_ARCH}/${archModule}.py` }],
  };
}

const RIFE_RUNTIME_ID = 'rife-ncnn-vulkan';
const RIFE_RUNTIME = {
  kind: 'wheelzip', task: 'interpolate', pipCheck: 'rife_ncnn_vulkan_python',
  package: 'rife-ncnn-vulkan-python', dir: RIFE_DIR, file: 'rife-ncnn-vulkan-python-1.2.1-windows_3.10.zip',
  url: 'https://github.com/media2x/rife-ncnn-vulkan-python/releases/download/1.2.1/rife-ncnn-vulkan-python-1.2.1-windows_3.10.zip',
  wheelMember: 'rife-ncnn-vulkan-python-1.2.1-windows/rife_ncnn_vulkan_python-1.2.1-cp310-cp310-win_amd64.whl',
};
const REMBG_RUNTIME = {
  pip: 'rembg',
  pipCheck: ['rembg', 'onnxruntime'],
  installSteps: [[...(DETECT_ENV.NETSURUSH_ONNX_BACKEND === 'cuda'
    ? ['rembg[gpu]']
    : DETECT_ENV.NETSURUSH_ONNX_BACKEND === 'directml'
      ? ['rembg', 'onnxruntime-directml']
      : DETECT_ENV.NETSURUSH_ONNX_BACKEND === 'openvino'
        ? ['rembg', 'onnxruntime-openvino']
        : ['rembg[cpu]'])]],
};
// NTIRE 2026 ESR : archs pures PyTorch, mais quelques équipes s'appuient sur einops/timm et
// huggingface_hub. basicsr (team10) vient déjà avec le runtime Real-ESRGAN.
const NTIRE_RUNTIME = {
  pip: 'einops',
  pipCheck: ['einops', 'timm', 'huggingface_hub'],
  installSteps: [['einops', 'timm', 'huggingface_hub']],
};
const NTIRE_REPO = 'https://raw.githubusercontent.com/Amazingren/NTIRE2026_ESR/main';
// id NetsuRush → équipe du dépôt. MIROIR de python/upscaler/models.py#NTIRE_TEAMS : les deux côtés
// doivent nommer les mêmes fichiers, sinon le sidecar re-télécharge ce que le gestionnaire a déjà posé.
const NTIRE_TEAMS = {
  'ntire-span': 'team00_SPAN',
  'ntire-pds': 'team01_PDS',
  'ntire-zenosr': 'team04_ZenoSR',
  'ntire-haesr': 'team06_HAESR',
  'ntire-rfdn-span': 'team09_RFDN_SPAN',
  'ntire-hfenet': 'team10_HFENet',
  'ntire-vscinet': 'team11_VSCINet',
  'ntire-dscf': 'team15_DSCF_Fused',
  'ntire-pkdsr': 'team16_PKDSR',
  'ntire-amcanet': 'team17_AMCANet',
  'ntire-disp': 'team18_DISP',
  'ntire-bviesr': 'team19_BVIESR',
  'ntire-errn2': 'team20_ERRN2',
  'ntire-safmn': 'team21_SAFMN_Deep15',
};
// Architectures communautaires absentes du registre Spandrel (SMoSR/FIGSR, MIT). Le module
// .py voyage avec les poids, comme pour NTIRE, et son URL est épinglée sur un COMMIT : sur une branche
// mouvante, une refonte amont changerait l'architecture sous des poids déjà installés.
const COMMUNITY_ARCH = {
  smosr: { file: 'smosr_arch.py', url: 'https://raw.githubusercontent.com/umzi2/SMoSR/6bfa011453c7a0ab404e7c00cd65eac6598d84bd/traiNNer/archs/smosr_arch.py' },
  figsr: { file: 'figsr_arch.py', url: 'https://raw.githubusercontent.com/enhancr/figsr/e5097dcd5849dbe5a8e0d1a045045abe97ad6e48/figsr_arch.py' },
  animesr: { file: 'vsr_arch.py', url: 'https://raw.githubusercontent.com/TencentARC/AnimeSR/80a24bf7a5270907c703158ff6affb3248bf0dc2/animesr/archs/vsr_arch.py' },
  rtmosr: { file: 'RTMoSR.py', url: 'https://raw.githubusercontent.com/JepEtau/pynnlib/d6c42c2b529b48c1d903a3471de7a8998515a95f/pynnlib/nn_pytorch/archs/RTMoSR/module/RTMoSR.py' },
};
// Ces architectures n'utilisent que torch : rien de plus à installer que le socle du venv.
const COMMUNITY_RUNTIME = { kind: 'url', pipCheck: 'torch', dir: REALESRGAN_DIR };

function ntireEntries() {
  const out = {};
  for (const [id, team] of Object.entries(NTIRE_TEAMS)) {
    out[id] = {
      kind: 'url', ...NTIRE_RUNTIME, task: 'upscale', dir: REALESRGAN_DIR,
      file: `${team}.pth`, url: `${NTIRE_REPO}/model_zoo/${team}.pth`,
      extra: [{ file: `${team}.py`, url: `${NTIRE_REPO}/models/${team}.py` }],
    };
  }
  return out;
}

// Manifeste : id → provenance + destination. `dir`/`file` pour url ; `repo` pour hf. `extra` = poids
// annexes (DNI de débruitage). `bundled` = pas de download.
const MANIFEST = /** @type {Record<string, any>} */ ({
  // -- upscale Real-ESRGAN (url direct → REALESRGAN_DIR) --
  anime:   { kind: 'url', ...REAL_ESRGAN_RUNTIME, dir: REALESRGAN_DIR, file: 'realesr-animevideov3.pth', url: `${GH}/v0.2.5.0/realesr-animevideov3.pth` },
  general: { kind: 'url', ...REAL_ESRGAN_RUNTIME, dir: REALESRGAN_DIR, file: 'RealESRGAN_x4plus.pth', url: `${GH}/v0.1.0/RealESRGAN_x4plus.pth` },
  light:   { kind: 'url', dir: REALESRGAN_DIR, file: 'realesr-general-x4v3.pth', url: `${GH}/v0.2.5.0/realesr-general-x4v3.pth`,
             ...REAL_ESRGAN_RUNTIME,
             extra: [{ file: 'realesr-general-wdn-x4v3.pth', url: `${GH}/v0.2.5.0/realesr-general-wdn-x4v3.pth` }] },
  // -- recherche par visage --
  // Réel : 2 ONNX opencv_zoo (YuNet détection 233 Ko + SFace identité 38,7 Mo) → FACE_DIR (lu par
  // faceengines.py). Permissif (BSD/Apache). Réels seuls suffisent à la recherche de visages réels.
  'face-real': { kind: 'url', dir: FACE_DIR, file: 'face_detection_yunet_2023mar.onnx',
                 url: 'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx',
                 extra: [{ file: 'face_recognition_sface_2021dec.onnx',
                           url: 'https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx' }] },
  // Animé : package pip dghs-imgutils (détecteur YOLO anime + CCIP) qui télécharge SES modèles dans
  // le cache HF au 1er usage → « installer » = pip + pré-fetch (déclenché sur une image factice).
  // INSTALL EN 2 TEMPS pour ne PAS casser le venv : (1) imgutils SANS ses deps → il n'exige donc pas
  // `opencv-contrib-python` (le venv a déjà cv2 ; réinstaller opencv échoue avec cv2.pyd verrouillé
  // par le sidecar = WinError 5) NI un numpy<2 qui rétrograderait tout le venv ; (2) ses deps PURES
  // python (helpers), qui n'impliquent ni opencv ni conflit numpy. onnxruntime-gpu/pillow/hf-hub déjà là.
  // `scikit-learn` n'est PAS optionnel : `imgutils.metrics` importe DBSCAN/OPTICS au chargement du
  // module, donc sans lui le pré-fetch meurt sur `No module named 'sklearn'`. `emoji` est borné comme
  // le paquet l'exige : non borné, pip pose une 2.15 que `pip check` signale ensuite comme dérive.
  // `onnxruntime` exécute le détecteur et CCIP : il fait partie du contrat, sinon imgutils s'en pose
  // un tout seul — ou l'installation meurt sur `No module named 'onnxruntime'`.
  'face-anime': { kind: 'pip', task: 'face', pipCheck: ['imgutils', 'onnxruntime'], prefetch: 'face',
                  installSteps: [
                    [ONNX_RUNTIME_PIP],
                    ['--no-deps', 'dghs-imgutils[gpu]'],
                    ['hbutils', 'hfutils', 'emoji<2.12', 'pilmoji', 'shapely', 'pyclipper',
                     'deprecation', 'bchlib', 'piexif', 'pyrfc6266', 'urlobject', 'scikit-learn'],
                  ] },

  // -- upscale Real-CUGAN / Spandrel (url direct → REALESRGAN_DIR) --
  fallin:        { kind: 'url', ...SPANDREL_RUNTIME, dir: REALESRGAN_DIR, file: 'Fallin_soft.pth', url: `${TAS}/Fallin_soft.pth` },
  fallin_strong: { kind: 'url', ...SPANDREL_RUNTIME, dir: REALESRGAN_DIR, file: 'Fallin_strong.pth', url: `${TAS}/Fallin_strong.pth` },
  adore:         { kind: 'url', ...SPANDREL_RUNTIME, dir: REALESRGAN_DIR, file: 'adore.pth', url: `${TAS}/adore.pth` },
  ld_anime:      { kind: 'url', ...SPANDREL_RUNTIME, dir: REALESRGAN_DIR, file: '2x-LD-Anime-Compact.pth',
                   url: 'https://objectstorage.us-phoenix-1.oraclecloud.com/n/ax6ygfvpvzka/b/open-modeldb-files/o/2x-LD-Anime-Compact.pth' },
  shufflecugan: { kind: 'url', ...SPANDREL_RUNTIME, dir: REALESRGAN_DIR, file: 'sudo_shuffle_cugan_9.584.969.pth', url: `${TAS}/sudo_shuffle_cugan_9.584.969.pth` },
  // Le dépôt mayhug/Real-CUGAN est un SPACE, pas un modèle : sans `spaces/` l'URL rend 401.
  cugan:        { kind: 'url', ...SPANDREL_RUNTIME, dir: REALESRGAN_DIR, file: 'up2x-latest-denoise3x.pth', url: 'https://huggingface.co/spaces/mayhug/Real-CUGAN/resolve/main/weights/up2x-latest-denoise3x.pth' },
  animesr:      { kind: 'url', ...REAL_ESRGAN_RUNTIME, task: 'upscale', dir: REALESRGAN_DIR, file: 'AnimeSR_v2.pth', url: `${TAS}/AnimeSR_v2.pth`, extra: [COMMUNITY_ARCH.animesr] },
  shufflespan:  { kind: 'url', ...REMBG_RUNTIME, task: 'upscale', dir: REALESRGAN_DIR, file: 'sudo_shuffle_span_op20_10.5m_1080p_fp16_op21_slim.onnx', url: `${TAS}/sudo_shuffle_span_op20_10.5m_1080p_fp16_op21_slim.onnx` },
  aniscale2:    { kind: 'url', ...SPANDREL_RUNTIME, dir: REALESRGAN_DIR, file: '2x_AniScale2S_Compact_i8_60K.pth', url: `${TAS}/2x_AniScale2S_Compact_i8_60K.pth` },
  'open-proteus': { kind: 'url', ...SPANDREL_RUNTIME, dir: REALESRGAN_DIR, file: '2x_OpenProteus_Compact_i2_70K.pth', url: `${TAS}/2x_OpenProteus_Compact_i2_70K.pth` },
  // TorchScript : le graphe voyage avec les poids → aucune archi à embarquer (cf. backends.py).
  rtmosr:       { kind: 'url', ...TORCHSCRIPT_RUNTIME, dir: REALESRGAN_DIR, file: '2x_umzi_anime_rtmosr.pth', url: `${TAS}/2x_umzi_anime_rtmosr.pth` },
  saryn:        { ...COMMUNITY_RUNTIME, task: 'upscale', file: 'Saryn-V1-Lite.pth', url: `${TAS}/Saryn-V1-Lite.pth`, extra: [COMMUNITY_ARCH.rtmosr] },
  figsr:        { ...COMMUNITY_RUNTIME, task: 'upscale', file: '2x_enhancr_da_figsr.pth', url: `${TAS}/2x_enhancr_da_figsr.pth`, extra: [COMMUNITY_ARCH.figsr] },
  smosr:        { ...COMMUNITY_RUNTIME, task: 'upscale', file: '2x_enhancr_da_smosr_v1.safetensors', url: `${TAS}/2x_enhancr_da_smosr_v1.safetensors`, extra: [COMMUNITY_ARCH.smosr] },
  span:         { kind: 'url', ...SPANDREL_RUNTIME, dir: REALESRGAN_DIR, file: '2x_ModernSpanimationV2.pth', url: `${TAS}/2x_ModernSpanimationV2.pth` },
  // -- NTIRE 2026 Efficient SR (MIT) : poids + module d'architecture, le second n'étant pas déductible
  //    du checkpoint. Voir python/upscaler/ntire.py pour les constructeurs. --
  ...ntireEntries(),

  // -- RTX Video Super Resolution : UNE entrée pour les deux moitiés. Le CLI (MIT) se télécharge, les
  //    DLL NVIDIA ne se redistribuent pas et se retrouvent sur la machine (cf. provisionSdk). Elles
  //    atterrissent dans le MÊME dossier (NGX charge les DLL depuis le répertoire de l'exe) et ne
  //    servent à rien l'une sans l'autre : les séparer n'offrait pas un choix, juste deux échecs. --
  'rtx-video': { kind: 'url', task: 'upscale', dir: RTX_DIR, file: RTX_EXE,
                 url: `https://github.com/DrC0ns0le/RTXVideoProcessor/releases/download/v1.0.0/${RTX_EXE}`,
                 sdk: { files: RTX_DLLS, page: 'https://developer.nvidia.com/rtx-video-sdk/getting-started' } },
  // -- restauration 1x : même pipeline image→image que l'upscale, sans redimensionnement. Les neuf
  // poids ci-dessous ont été sondés avec le vrai ModelLoader.
  'tas-scunet':         { kind: 'url', ...SPANDREL_RUNTIME, task: 'restore', dir: REALESRGAN_DIR, file: 'scunet_color_real_psnr.pth', url: `${TAS}/scunet_color_real_psnr.pth` },
  'tas-nafnet':         { kind: 'url', ...SPANDREL_RUNTIME, task: 'restore', dir: REALESRGAN_DIR, file: 'NAFNet-GoPro-width64.pth', url: `${TAS}/NAFNet-GoPro-width64.pth` },
  'tas-dpir':           { kind: 'url', ...SPANDREL_RUNTIME, task: 'restore', dir: REALESRGAN_DIR, file: 'drunet_deblocking_color.pth', url: `${TAS}/drunet_deblocking_color.pth` },
  'tas-real-plksr':     { kind: 'url', ...SPANDREL_RUNTIME, task: 'restore', dir: REALESRGAN_DIR, file: '1xDeJPG_realplksr_otf.pth', url: `${TAS}/1xDeJPG_realplksr_otf.pth` },
  'tas-anime1080fixer': { kind: 'url', ...SPANDREL_RUNTIME, task: 'restore', dir: REALESRGAN_DIR, file: '1x_Anime1080Fixer_SuperUltraCompact.pth', url: `${TAS}/1x_Anime1080Fixer_SuperUltraCompact.pth` },
  'tas-deh264-real':    { kind: 'url', ...SPANDREL_RUNTIME, task: 'restore', dir: REALESRGAN_DIR, file: '1xDeH264_realplksr.pth', url: `${TAS}/1xDeH264_realplksr.pth` },
  'tas-deh264-span':    { kind: 'url', ...SPANDREL_RUNTIME, task: 'restore', dir: REALESRGAN_DIR, file: '1x_DeH264_SPAN.safetensors', url: `${TAS}/1x_DeH264_SPAN.safetensors` },
  'tas-hurrdeblur':     { kind: 'url', ...SPANDREL_RUNTIME, task: 'restore', dir: REALESRGAN_DIR, file: '1x_HurrDeblur_SuperUltraCompact.pth', url: `${TAS}/1x_HurrDeblur_SuperUltraCompact.pth` },
  'tas-dehalo':         { kind: 'url', ...SPANDREL_RUNTIME, task: 'restore', dir: REALESRGAN_DIR, file: '1x_DeHalo_v1_Compact.pth', url: `${TAS}/1x_DeHalo_v1_Compact.pth` },
  // Upscale lourd diffusion (HF → MODELS_DIR/upscale/seedvr2). Moteur d'inférence à câbler.
  seedvr2:      { kind: 'hf', task: 'upscale', repo: 'ByteDance-Seed/SeedVR2-3B' },

  // -- HF (snapshot_download → MODELS_DIR/<task>/<id>). `cfg` = clé de CONFIG (chemin) provisionnée par
  //    setup.ps1 : si présente sur disque, le modèle est déjà là (installé hors NR_HOME/models). --
  'siglip2-base':            { kind: 'hf', task: 'search', repo: 'google/siglip2-base-patch16-naflex' },
  'siglip2-so400m':          { kind: 'hf', task: 'search', repo: 'google/siglip2-so400m-patch16-naflex', cfg: 'siglipDir' },
  'siglip2-giant':           { kind: 'hf', task: 'search', repo: 'google/siglip2-giant-opt-patch16-384' },
  'whisper-small':           { kind: 'hf', task: 'voice-asr', repo: 'Systran/faster-whisper-small' },
  'whisper-medium':          { kind: 'hf', task: 'voice-asr', repo: 'Systran/faster-whisper-medium' },
  'whisper-turbo':           { kind: 'hf', task: 'voice-asr', repo: 'deepdml/faster-whisper-large-v3-turbo-ct2', cfg: 'whisperDir', match: 'faster-whisper-large-v3-turbo' },
  'whisper-large-v3':        { kind: 'hf', task: 'voice-asr', repo: 'Systran/faster-whisper-large-v3' },
  'parakeet-v3':             { kind: 'hf', task: 'voice-asr', repo: 'istupakov/parakeet-tdt-0.6b-v3-onnx', cfg: 'parakeetDir' },
  'canary-1b-v2':            { kind: 'hf', task: 'voice-asr', repo: 'nvidia/canary-1b-v2' },
  // Moteur natif transcribe.cpp (GGUF) — un seul quant téléchargé (pickOne). Nécessite le binaire.
  'nemotron-3.5-asr':        { kind: 'hf', task: 'voice-asr', repo: 'handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf', engine: 'transcribe-cpp', pickOne: true },
  // WhisperX = pip (whisperx) + modèles Whisper/wav2vec2 tirés au 1er usage → géré par la lib.
  whisperx:                  { kind: 'bundled' },
  'depth-anything-v2-small': { kind: 'hf', task: 'depth', repo: 'depth-anything/Depth-Anything-V2-Small-hf' },
  'depth-anything-v2-base':  { kind: 'hf', task: 'depth', repo: 'depth-anything/Depth-Anything-V2-Base-hf' },
  'depth-anything-v2-large': { kind: 'hf', task: 'depth', repo: 'depth-anything/Depth-Anything-V2-Large-hf' },
  // Distill Any Depth (MIT) : natifs transformers (model_type=depth_anything), usage commercial OK.
  'distill-any-depth-small': { kind: 'hf', task: 'depth', repo: 'xingyang1/Distill-Any-Depth-Small-hf' },
  'distill-any-depth-large': { kind: 'hf', task: 'depth', repo: 'xingyang1/Distill-Any-Depth-Large-hf' },
  // xingyang1 ne publie pas la variante Base au format HF ; cette conversion MIT porte le même
  // modèle avec sa config et son préprocesseur, donc le pipeline depth-estimation l'ouvre tel quel.
  'distill-any-depth-base': { kind: 'hf', task: 'depth', repo: 'lc700x/Distill-Any-Depth-Base-hf' },
  // Depth Anything V1 (Apache) : génération précédente, natifs transformers.
  'depth-anything-v1-small': { kind: 'hf', task: 'depth', repo: 'LiheYoung/depth-anything-small-hf' },
  'depth-anything-v1-base':  { kind: 'hf', task: 'depth', repo: 'LiheYoung/depth-anything-base-hf' },
  'depth-anything-v1-large': { kind: 'hf', task: 'depth', repo: 'LiheYoung/depth-anything-large-hf' },
  'depth-pro':               { kind: 'hf', task: 'depth', repo: 'apple/DepthPro-hf' },
  'video-depth-anything-small': { kind: 'hf', task: 'depth', repo: 'depth-anything/Video-Depth-Anything-Small' },
  'video-depth-anything-base':  { kind: 'hf', task: 'depth', repo: 'depth-anything/Video-Depth-Anything-Base' },
  'video-depth-anything-large': { kind: 'hf', task: 'depth', repo: 'depth-anything/Video-Depth-Anything-Large' },
  // Metric Video Depth Anything (CC-BY-NC) : variante métrique (distances absolues) — même scaffold.
  'video-depth-anything-metric-small': { kind: 'hf', task: 'depth', repo: 'depth-anything/Metric-Video-Depth-Anything-Small' },
  'video-depth-anything-metric-base':  { kind: 'hf', task: 'depth', repo: 'depth-anything/Metric-Video-Depth-Anything-Base' },
  'video-depth-anything-metric-large': { kind: 'hf', task: 'depth', repo: 'depth-anything/Metric-Video-Depth-Anything-Large' },
  // DPT (Intel) : archis alternatives — SwinV2 tiny/large, BEiT base/large, Hybrid MiDaS.
  'dpt-swinv2-tiny':         { kind: 'hf', task: 'depth', repo: 'Intel/dpt-swinv2-tiny-256' },
  'dpt-swinv2-large':        { kind: 'hf', task: 'depth', repo: 'Intel/dpt-swinv2-large-384' },
  'dpt-hybrid-midas':        { kind: 'hf', task: 'depth', repo: 'Intel/dpt-hybrid-midas' },
  'dpt-beit-base':           { kind: 'hf', task: 'depth', repo: 'Intel/dpt-beit-base-384' },
  'dpt-beit-large':          { kind: 'hf', task: 'depth', repo: 'Intel/dpt-beit-large-512' },
  'dpt-large':               { kind: 'hf', task: 'depth', repo: 'Intel/dpt-large' },
  // GLPN (SegFormer, Apache) : très léger. ZoeDepth (Intel, MIT) : profondeur métrique généraliste.
  'glpn-nyu':                { kind: 'hf', task: 'depth', repo: 'vinvino02/glpn-nyu' },
  'glpn-kitti':              { kind: 'hf', task: 'depth', repo: 'vinvino02/glpn-kitti' },
  'zoedepth-nyu-kitti':      { kind: 'hf', task: 'depth', repo: 'Intel/zoedepth-nyu-kitti' },
  'da3-small':               { kind: 'hf', task: 'depth', repo: 'depth-anything/DA3-SMALL' },
  'da3-base':                { kind: 'hf', task: 'depth', repo: 'depth-anything/DA3-BASE' },
  'da3-large':               { kind: 'hf', task: 'depth', repo: 'depth-anything/DA3-LARGE-1.1' },
  'da3-metric-large':        { kind: 'hf', task: 'depth', repo: 'depth-anything/DA3METRIC-LARGE' },
  'da3-mono-large':          { kind: 'hf', task: 'depth', repo: 'depth-anything/DA3MONO-LARGE' },
  'da3-giant':               { kind: 'hf', task: 'depth', repo: 'depth-anything/DA3NESTED-GIANT-LARGE-1.1' },
  omnishotcut:               { kind: 'hf', task: 'detect', repo: 'uva-cv-lab/OmniShotCut', cfg: 'omnishotCkpt',
                               pip: OMNISHOTCUT_PIP, pipCheck: ['omnishotcut', 'decord'],
                               installSteps: [['decord'], ['--no-deps', OMNISHOTCUT_PIP]] },
  // Le README officiel renvoie vers un dossier Google Drive contenant ce fichier (57 243 097 octets).
  // URL directe HTTPS : le bouton Télécharger peut donc terminer l'installation sans import manuel.
  // `nrautoshot` (architecture officielle, code livré avec l'app) charge le checkpoint avec torch et
  // einops : le poids seul ne suffit pas, sinon « Détecter » échoue sur un modèle annoncé installé.
  autoshot:                  { kind: 'url', task: 'detect', dir: path.join(NR_HOME, 'weights'),
                               file: 'AutoShot_ckpt_0_200_0.pth', url: AUTOSHOT_WEIGHTS_URL, cfg: 'autoshotCkpt',
                               pip: 'einops', pipCheck: ['torch', 'einops'], installSteps: [['einops']] },
  // SAM2Matting : dépôt non public → download non câblé (statut absent tant que non fourni).
  sam2matting:               { kind: 'hf', task: 'matte', repo: 'facebook/sam2-hiera-base-plus' },
  // v1 porte le MÊME pin de démo que la v2 : `--no-deps` ne l'empêche pas d'entrer dans les
  // métadonnées installées, donc il rétrograderait le hub à la résolution suivante.
  matanyone:                 { kind: 'hf', task: 'matte', repo: 'PeiqingYang/MatAnyone',  pip: MATANYONE_PIP,  pipCheck: 'matanyone',
                               pipPatch: ['matanyone-drop-hub-pin'],
                               installSteps: [MATANYONE_DEPS, ['--no-deps', PIP_TARGET]] },
  matanyone2:                { kind: 'hf', task: 'matte', repo: 'kamaz01/MatAnyone2',     pip: MATANYONE2_PIP, pipCheck: 'matanyone2',
                               pipPatch: ['hatch-drop-force-include', 'matanyone-drop-hub-pin'],
                               installSteps: [MATANYONE_DEPS, ['--no-deps', PIP_TARGET]] },
  // VideoMaMa : UNet affiné sur Stable Video Diffusion, en UNE seule étape de débruitage. Ses poids
  // sont RÉPARTIS sur deux dépôts — l'UNet chez son auteur, l'auto-encodeur temporel chez Stability.
  // `only` est indispensable côté SVD : le dépôt complet pèse plusieurs gigaoctets alors que seul le
  // VAE sert, et `dino_projection_mlp.pth` du premier ne sert à aucune inférence d'ici.
  // Le pipeline est réimplémenté (nrroto/videomama.py) au-dessus des primitives diffusers : rien à
  // vendorer, contrairement à MiniMax dont le transformeur n'existe qu'en fichier de dépôt.
  videomama:                 { kind: 'hf', task: 'matte', repo: 'SammyLim/VideoMaMa',
                               only: ['unet/'],
                               also: [{ repo: 'stabilityai/stable-video-diffusion-img2vid-xt',
                                        only: ['vae/config.json', 'vae/diffusion_pytorch_model.fp16.safetensors'],
                                        into: '' }],
                               pipCheck: ['diffusers', 'safetensors', 'accelerate'],
                               installSteps: [['diffusers>=0.33.0', 'safetensors', 'accelerate']] },
  ben2:                      { kind: 'hf', task: 'matte', repo: 'PramaLLC/BEN2',          pip: BEN2_PIP,       pipCheck: 'ben2' },
  birefnet:                  { kind: 'hf', task: 'matte', repo: 'ZhengPeng7/BiRefNet_dynamic', pip: 'timm',
                               pipCheck: ['timm', 'kornia', 'einops'],
                               installSteps: [['timm', 'kornia', 'einops']] },
  // Lucida : snapshot Transformers avec code distant embarqué (BiRefNet). timm + kornia sont les
  // seules dépendances absentes du runtime ML de base ; le téléchargement les installe dans le venv.
  lucida:                    { kind: 'hf', task: 'matte', repo: 'egeorcun/lucida', pip: 'timm',
                               pipCheck: ['timm', 'kornia', 'einops'],
                               installSteps: [['timm', 'kornia', 'einops']] },
  // Segmentation (roto) : poids HF + `pip` = le PACKAGE python qui les charge (installé auto après
  // le download → « Installé » = poids ET code prêts). Tarball GitHub (pas besoin de `git`), sans
  // compilation CUDA (SAM2_BUILD_CUDA=0). `pipCheck` = module importable pour tester la présence.
  'sam2.1-large':            { kind: 'hf', task: 'segment', repo: 'facebook/sam2.1-hiera-large',      pip: SAM2_PIP, pipCheck: 'sam2' },
  'sam2.1':                  { kind: 'hf', task: 'segment', repo: 'facebook/sam2.1-hiera-base-plus', pip: SAM2_PIP, pipCheck: 'sam2' },
  'sam2.1-small':            { kind: 'hf', task: 'segment', repo: 'facebook/sam2.1-hiera-small',     pip: SAM2_PIP, pipCheck: 'sam2' },
  'sam2.1-tiny':             { kind: 'hf', task: 'segment', repo: 'facebook/sam2.1-hiera-tiny',      pip: SAM2_PIP, pipCheck: 'sam2' },
  // EdgeTAM : poids seuls (56 Mo) + le yaml Hydra du dépôt amont, que le package sam2 ne connaît pas.
  // Il est déposé DANS le dossier du modèle et référencé par chemin absolu (cf. nrroto/sam_engine).
  edgetam:                   { kind: 'hf', task: 'segment', repo: 'facebook/EdgeTAM', pip: SAM2_PIP, pipCheck: 'sam2',
                               vendorDir: path.join(MODELS_DIR, 'segment', 'edgetam'),
                               vendor: [{ file: 'edgetam.yaml', url: EDGETAM_CFG }] },
  // SAM 3.1 : un seul checkpoint (3,5 Go) + le package `sam3` du dépôt Meta. Aucune intégration
  // transformers — le predictor vidéo vient du package. Le paquet `sam3` cohabite avec `sam2` (noms
  // de module distincts) : SAM 3.1 n'entre donc dans aucun groupe d'exclusivité.
  'sam3.1':                  { kind: 'hf', task: 'segment', repo: 'facebook/sam3.1', pip: SAM3_PIP, pipCheck: 'sam3',
                               installSteps: [['hydra-core', 'omegaconf', 'iopath', 'psutil'], [SAM3_PIP]] },
  // SAMURAI / SAM2Long : aucun poids propre (ils lisent les checkpoints SAM 2.1) → seul le CODE se
  // télécharge. Installer l'un remplace le paquet `sam2` de l'autre : `exclusiveWith` le fait
  // proprement au lieu de laisser pip écraser en silence une installation qui marchait.
  // Le paquet de SAMURAI n'est PAS à la racine du dépôt (`sam2/setup.py`) → `pipSubdir`.
  samurai:                   { kind: 'pipfork', task: 'segment', pip: SAMURAI_PIP, pipSubdir: 'sam2',
                               pipCheck: 'sam2', package: SAM2_DISTRIBUTION, provider: 'samurai',
                               needs: SAM2_WEIGHT_IDS, exclusiveWith: ['sam2long'] },
  sam2long:                  { kind: 'pipfork', task: 'segment', pip: SAM2LONG_PIP,
                               pipCheck: 'sam2', package: SAM2_DISTRIBUTION, provider: 'sam2long',
                               needs: SAM2_WEIGHT_IDS, exclusiveWith: ['samurai'] },
  // MiniMax : poids (vae/transformer/scheduler) + diffusers + le CODE du pipeline (2 .py du dépôt,
  // non pip-installable → récupérés par l'app dans python/nrroto/vendor/ au download). Cf. nrroto/minimax.py.
  'minimax-remover':         { kind: 'hf', task: 'object-removal', repo: 'zibojia/minimax-remover', pip: 'diffusers>=0.33.0', pipCheck: 'diffusers',
                               vendor: [
                                 { file: 'pipeline_minimax_remover.py', url: 'https://raw.githubusercontent.com/zibojia/MiniMax-Remover/main/pipeline_minimax_remover.py' },
                                 { file: 'transformer_minimax_remover.py', url: 'https://raw.githubusercontent.com/zibojia/MiniMax-Remover/main/transformer_minimax_remover.py' },
                               ] },
  powerpaint:                { kind: 'hf', task: 'object-removal', repo: 'JunhaoZhuang/PowerPaint_v2' },
  diffueraser:               { kind: 'hf', task: 'object-removal', repo: 'lixiaowen/diffuEraser' },

  // -- Interpolation TheAnimeScripter : RIFE 4.15→4.25, GMFSS Fortuna, DistilDRBA. Ces générations
  // n'existent pas en ncnn et leur architecture n'est pas déductible du checkpoint : chaque entrée
  // emporte donc le module (ou le paquet) qui sait la reconstruire. --
  'tas-rife4.15':             rifeTorch('rife415.pth', 'IFNet_HDv3_v4_15'),
  'tas-rife4.15-lite':        rifeTorch('rife415_lite.pth', 'IFNet_HDv3_v4_15_lite'),
  'tas-rife4.16-lite':        rifeTorch('rife416_lite.pth', 'IFNet_HDv3_v4_16_lite'),
  'tas-rife4.17':             rifeTorch('rife417.pth', 'IFNet_HDv3_v4_17'),
  'tas-rife4.18':             rifeTorch('rife418.pth', 'IFNet_HDv3_v4_18'),
  'tas-rife4.20':             rifeTorch('rife420.pth', 'IFNet_HDv3_v4_20'),
  'tas-rife4.21':             rifeTorch('rife421.pth', 'IFNet_HDv3_v4_21'),
  'tas-rife4.22':             rifeTorch('rife422.pth', 'IFNet_HDv3_v4_22'),
  'tas-rife4.22-lite':        rifeTorch('rife422_lite.pth', 'IFNet_HDv3_v4_22_lite'),
  'tas-rife4.25':             rifeTorch('rife425.pth', 'IFNet_HDv3_v4_25'),
  'tas-rife4.25-lite':        rifeTorch('rife425_lite.pth', 'IFNet_HDv3_v4_25_lite'),
  'tas-rife4.25-heavy':       rifeTorch('rife425_heavy.pth', 'IFNet_HDv3_v4_25_heavy'),
  'tas-distildrba':         drbaEntry('v1.pkl', 'distilDRBA'),
  'tas-distildrba-lite':    drbaEntry('v2_lite.pkl', 'distilDRBA_v2_lite'),
  'tas-gmfss':              { kind: 'url', task: 'interpolate', dir: GMFSS_DIR, pipCheck: 'torch',
                              file: 'gmfss-fortuna-union.zip', url: `${TAS}/gmfss-fortuna-union.zip`,
                              // Archive du dépôt épinglée sur un COMMIT : le paquet `model/` compte une
                              // trentaine de fichiers qui s'importent entre eux, on ne les prend pas un à un.
                              extra: [{ file: 'GMFSS_Fortuna.zip', url: `https://github.com/98mxr/GMFSS_Fortuna/archive/0fb7ac1dc292e2615217110dd9d82557845fb919.zip` }],
                              extract: ['gmfss-fortuna-union.zip', 'GMFSS_Fortuna.zip'],
                              required: ['flownet.pkl', 'rife.pkl', `GMFSS_Fortuna-0fb7ac1dc292e2615217110dd9d82557845fb919/model/GMFSS_infer_u.py`] },

  // -- runtime RIFE Windows précompilé + variantes incluses dans ce runtime partagé --
  [RIFE_RUNTIME_ID]: RIFE_RUNTIME,

  // -- fournis par un wheel / cache de lib → toujours installé --
  transnetv2:   { kind: 'bundled' },
  'silero-vad': { kind: 'bundled' },
  // RVM : téléchargé via torch.hub au 1er usage → bundlé MAIS supprimable (cache torch.hub).
  rvm:           { kind: 'bundled', cache: { kind: 'torchhub', match: 'rvm' } },
});

// Contrats runtime partagés. Le catalogue UI peut contenir beaucoup de variantes de poids, mais une
// variante n'est déclarée utilisable que si SON moteur Python réel est présent. Les entrées encore
// scaffoldées restent dans le registre (roadmap) mais ne sont ni téléchargeables ni sélectionnables.
for (const id of ['siglip2-base', 'siglip2-so400m', 'siglip2-giant']) Object.assign(MANIFEST[id], SEARCH_RUNTIME);
for (const id of ['whisper-small', 'whisper-medium', 'whisper-turbo', 'whisper-large-v3']) Object.assign(MANIFEST[id], WHISPER_RUNTIME);
Object.assign(MANIFEST['parakeet-v3'], {
  pip: 'onnx-asr[hub]>=0.6', pipCheck: ['onnx_asr', 'onnxruntime', 'soundfile'],
  installSteps: [[DETECT_ENV.NETSURUSH_ONNX_BACKEND === 'cuda' ? 'onnx-asr[gpu,hub]>=0.6' : 'onnx-asr[cpu,hub]>=0.6',
                  ...AUDIO_IO_DEPS]],
});
for (const id of [
  'depth-anything-v2-small', 'depth-anything-v2-base', 'depth-anything-v2-large',
  'distill-any-depth-small', 'distill-any-depth-base', 'distill-any-depth-large',
  'depth-anything-v1-small', 'depth-anything-v1-base', 'depth-anything-v1-large',
  'dpt-swinv2-tiny', 'dpt-swinv2-large', 'dpt-hybrid-midas', 'dpt-beit-base',
  'dpt-beit-large', 'dpt-large', 'glpn-nyu', 'glpn-kitti', 'zoedepth-nyu-kitti',
]) Object.assign(MANIFEST[id], DEPTH_RUNTIME);
Object.assign(MANIFEST['face-real'], {
  pip: 'opencv-contrib-python-headless', pipCheck: 'cv2', installSteps: [['opencv-contrib-python-headless']],
});
Object.assign(MANIFEST['minimax-remover'], {
  // scipy est importé par le pipeline vendoré (nrroto/vendor/pipeline_minimax_remover.py) : il n'est
  // présent qu'en transitive du pack NetsuLab, à déclarer ici pour ne pas dépendre de cet accident.
  pipCheck: ['diffusers', 'transformers', 'accelerate', 'safetensors', 'scipy'],
  installSteps: [['diffusers>=0.33.0', 'transformers', 'accelerate', 'safetensors', 'scipy']],
});
for (const id of ['birefnet', 'lucida']) {
  Object.assign(MANIFEST[id], {
    pipCheck: ['transformers', 'accelerate', 'timm', 'kornia', 'einops'],
    installSteps: [['transformers', 'accelerate', 'timm', 'kornia', 'einops']],
  });
}
Object.assign(MANIFEST.transnetv2, {
  pip: 'transnetv2-pytorch', pipCheck: 'transnetv2_pytorch', installSteps: [['transnetv2-pytorch']],
});
Object.assign(MANIFEST['silero-vad'], {
  // `soundfile` voyage avec : `vad_silero` lit le WAV de travail par lui, donc un Silero seul
  // n'aurait pas suffi à faire marcher « Couper les silences ». `librosa` sert aux hésitations
  // acoustiques, servies par le même sidecar.
  pip: 'silero-vad', pipCheck: ['silero_vad', 'soundfile', 'librosa'],
  installSteps: [['silero-vad', ...AUDIO_IO_DEPS]],
});
// Depth Anything 3 : package PyPI officiel (Apache-2.0). Ce n'est PAS un modèle transformers — les
// dépôts DA3 déclarent `library_name: depth-anything-3` et `pipeline('depth-estimation')` échoue
// dessus. Le poids seul ne sert donc à rien : le téléchargement installe aussi le package.
for (const id of ['da3-small', 'da3-base', 'da3-large', 'da3-metric-large', 'da3-mono-large', 'da3-giant']) {
  Object.assign(MANIFEST[id], {
    pip: 'depth-anything-3', pipCheck: ['depth_anything_3', 'torch'],
    installSteps: [['depth-anything-3']],
  });
}

// Moteur Python encore absent : le modèle reste au catalogue (feuille de route) mais n'est ni
// téléchargeable ni sélectionnable — mieux vaut une entrée muette qu'un téléchargement de plusieurs
// gigaoctets qui ne produira aucune image.
for (const id of [
  'seedvr2', 'whisperx', 'canary-1b-v2', 'nemotron-3.5-asr', 'rvm', 'sam2matting',
  'diffueraser', 'powerpaint', 'depth-pro',
  'video-depth-anything-small', 'video-depth-anything-base', 'video-depth-anything-large',
  'video-depth-anything-metric-small', 'video-depth-anything-metric-base', 'video-depth-anything-metric-large',
]) MANIFEST[id].available = false;

// Destination disque d'un modèle HF géré par NetsuRush.
function hfDir(id, m) { return path.join(MODELS_DIR, m.task || 'misc', id); }

// Racine du cache rembg (ONNX auto-téléchargés au 1er usage). DETECT_ENV porte la valeur RÉELLEMENT
// passée au sidecar (config `rembgDir`) : la lire ici est la seule façon de mesurer/effacer le même
// dossier que celui où rembg écrit — sinon le gestionnaire regardait ~/.u2net pendant que les ONNX
// vivaient dans le dossier de poids du packaging (modèle indélébile côté UI).
function rembgHome() { return DETECT_ENV.U2NET_HOME || process.env.U2NET_HOME || path.join(os.homedir(), '.u2net'); }
// Racine du cache torch.hub (checkpoints + repos clonés).
function torchHubRoot() { return path.join(process.env.TORCH_HOME || path.join(os.homedir(), '.cache', 'torch'), 'hub'); }

// Fichiers sur disque d'un modèle bundlé « cache de lib » (rembg/torch.hub). Renvoie les chemins
// EXISTANTS à supprimer / mesurer. `[]` si rien de téléchargé (pas encore utilisé, ou déjà effacé).
function cachePaths(m) {
  const c = m && m.cache;
  if (!c) return [];
  const out = [];
  if (c.kind === 'rembg') {
    const p = path.join(rembgHome(), c.file);
    if (fs.existsSync(p)) out.push(p);
  } else if (c.kind === 'torchhub') {
    const needle = String(c.match || '').toLowerCase();
    const ck = path.join(torchHubRoot(), 'checkpoints');
    try { for (const n of fs.readdirSync(ck)) { if (n.toLowerCase().includes(needle)) out.push(path.join(ck, n)); } } catch { /* */ }
    // Dossier(s) de repo clonés par torch.hub (ex. PeterL1n_RobustVideoMatting_master).
    try { for (const n of fs.readdirSync(torchHubRoot())) { if (n.toLowerCase().includes('robustvideomatting')) out.push(path.join(torchHubRoot(), n)); } } catch { /* */ }
  }
  return out;
}

// Racine du cache Hugging Face (là où transformers / faster-whisper / hf_hub écrivent réellement).
function hfCacheRoot() {
  return process.env.HF_HOME || CONFIG.procHfHome || path.join(os.homedir(), '.cache', 'huggingface');
}
// Le dépôt `repo` est-il présent dans le cache HF ? (dossier hub/models--org--name non vide)
function hfCachedDir(repo) {
  const d = path.join(hfCacheRoot(), 'hub', 'models--' + String(repo).replace(/\//g, '--'));
  try { return fs.existsSync(d) ? d : null; } catch { return null; }
}
// Repli : cherche un dossier de cache HF contenant `substr` (variantes de repo — ex. faster-whisper
// tiré depuis mobiuslabsgmbh/… ≠ Systran/…). Renvoie le 1er dossier hub qui matche.
function hfCachedAny(substr) {
  if (!substr) return null;
  const hub = path.join(hfCacheRoot(), 'hub');
  const needle = String(substr).toLowerCase().replace(/\//g, '--');
  try {
    for (const name of fs.readdirSync(hub)) {
      if (name.startsWith('models--') && name.toLowerCase().includes(needle)) return path.join(hub, name);
    }
  } catch { /* */ }
  return null;
}

// Taille d'un dossier (récursif, best-effort).
function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p);
      else total += fs.statSync(p).size;
    } catch { /* ignore */ }
  }
  return total;
}

// Un téléchargement interrompu laisse des fichiers `.tmp` (jamais renommés) → dossier INCOMPLET.
// Sans ce test, dirSize>0 ferait passer un modèle à moitié téléchargé pour « installé ».
function hasPartial(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of ents) {
    if (e.isDirectory()) { if (hasPartial(path.join(dir, e.name))) return true; }
    else if (e.name.endsWith('.tmp')) return true;
  }
  return false;
}

// Efface les `.tmp` restants avant un (re)téléchargement. downloadUrl ouvre toujours son .tmp en
// écriture tronquante : rien n'en reprend jamais le contenu. Un .tmp dont le fichier a disparu du dépôt
// (changement de repo/format) resterait sinon éternellement là et figerait le modèle en « partial ».
function purgeTmp(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let n = 0;
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += purgeTmp(p);
    else if (e.name.endsWith('.tmp')) { try { fs.unlinkSync(p); n++; } catch { /* */ } }
  }
  return n;
}

// Le CODE vendoré requis par le modèle (2 .py MiniMax) est-il présent sur disque ? Un modèle dont les
// poids sont là mais le code manque n'est PAS utilisable → à re-télécharger (le re-DL saute les poids
// déjà complets et ne refait que le vendor/pip manquant).
function vendorPresent(m) {
  if (!m.vendor || !m.vendor.length) return true;
  const dir = m.vendorDir || VENDOR_DIR;
  return m.vendor.every((v) => { try { return fs.existsSync(path.join(dir, v.file)); } catch { return false; } });
}

// Un modèle livré en ARCHIVE dépose bien plus que les fichiers nommés par le manifeste (GMFSS pose un
// paquet python entier). Ni la taille ni la suppression ne peuvent se contenter de `file` + `extra` :
// il faut prendre le dossier. Encore faut-il qu'il n'appartienne qu'à ce modèle — les douze RIFE
// PyTorch partagent le leur, y effacer le dossier emporterait les onze autres.
function ownsDir(id, m) {
  if (!m.dir) return false;
  const mine = path.resolve(m.dir).toLowerCase();
  for (const [other, entry] of Object.entries(MANIFEST)) {
    if (other !== id && entry.dir && path.resolve(entry.dir).toLowerCase() === mine) return false;
  }
  return true;
}

// Fichiers attendus d'une entrée à import manuel. `files` couvre les runtimes qui en exigent
// plusieurs (les deux DLL du RTX Video SDK) ; `file` reste la forme courte à un seul checkpoint.
function manualFiles(m) {
  return Array.isArray(m.files) && m.files.length ? m.files : [m.file];
}

// Bibliothèques d'un SDK propriétaire attachées à une entrée téléchargeable (`sdk`). Elles vivent
// dans le MÊME dossier que le binaire et complètent la même fonctionnalité : le statut, la taille et
// la suppression les traitent comme des fichiers de l'entrée, pas comme un second modèle.
function sdkFiles(m) {
  return m && m.sdk && Array.isArray(m.sdk.files) ? m.sdk.files : [];
}

// --- Provisionnement du RTX Video SDK -------------------------------------------------------
// NVIDIA place son SDK derrière un compte développeur (l'URL du zip redirige vers /login) et en
// interdit la redistribution : NetsuRush ne PEUT pas le télécharger à la place de l'utilisateur.
// Tout le reste est automatisé — on retrouve seul les DLL déjà présentes sur la machine, ou l'archive
// du SDK là où un navigateur la dépose, et on en extrait ce qu'il faut. L'utilisateur n'a donc jamais
// à copier un fichier à la main : au pire il télécharge le zip, et le bouton fait le reste.
const SDK_SCAN_DEPTH = 3;
const SDK_SCAN_MAX_ENTRIES = 20000;  // borne dure : ces dossiers peuvent être énormes (DriverStore)

function sdkScanRoots() {
  const home = os.homedir();
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const roots = [
    RTX_DIR,
    path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Documents'),
    NR_HOME, os.tmpdir(),
    path.join(programFiles, 'NVIDIA Corporation'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'DriverStore', 'FileRepository'),
  ];
  return roots.filter((dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } });
}

// UN SEUL parcours, borné en profondeur et en nombre d'entrées : ces dossiers sont énormes
// (DriverStore) et deux passes doublaient la seconde d'attente sur le clic. `classify(nom)` renvoie
// la clé du seau où ranger le fichier, ou null pour l'ignorer.
function scanFiles(roots, classify) {
  const found = {};
  let budget = SDK_SCAN_MAX_ENTRIES;
  const walk = (dir, depth) => {
    if (depth > SDK_SCAN_DEPTH || budget <= 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (--budget <= 0) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      const bucket = classify(entry.name);
      if (bucket) (found[bucket] = found[bucket] || []).push(full);
    }
  };
  for (const root of roots) walk(root, 0);
  return found;
}

// Extrait des membres d'un zip par NOM DE FICHIER : l'arborescence interne du SDK change d'une
// version à l'autre (`bin/Windows/x64/rel/`), un chemin en dur casserait à la prochaine.
function extractZipByBasename(archive, outDir, names) {
  return new Promise((resolve) => {
    // Écriture en .tmp puis rename : une extraction interrompue ne laisse pas une DLL tronquée que
    // le statut compterait comme installée.
    const code = [
      'import pathlib, shutil, sys, zipfile',
      'archive, out = sys.argv[1], pathlib.Path(sys.argv[2])',
      'wanted = {n.lower() for n in sys.argv[3:]}',
      'out.mkdir(parents=True, exist_ok=True)',
      'zf = zipfile.ZipFile(archive)',
      'done = []',
      'for name in zf.namelist():',
      '    base = pathlib.PurePosixPath(name).name',
      '    if base.lower() not in wanted:',
      '        continue',
      '    target = out / base',
      '    with zf.open(name) as src, open(str(target) + ".tmp", "wb") as dst:',
      '        shutil.copyfileobj(src, dst)',
      '    shutil.move(str(target) + ".tmp", str(target))',
      '    done.append(base)',
      'print("|".join(done))',
    ].join('\n');
    const p = spawn(PYTHON, ['-c', code, archive, outDir, ...names], { env: DETECT_ENV, windowsHide: true });
    let stdout = '', tail = '';
    p.stdout.on('data', (b) => { stdout += b.toString(); });
    p.stderr.on('data', (b) => { const s = b.toString(); logbus.py('models', s); tail = (tail + s).slice(-600); });
    p.on('close', (exitCode) => resolve(exitCode === 0
      ? { ok: true, extracted: stdout.trim().split('|').filter(Boolean) }
      : { ok: false, error: tail.trim().split(/\r?\n/).pop() || `zip code ${exitCode}` }));
    p.on('error', (e) => resolve({ ok: false, error: String(e) }));
  });
}

async function copyInto(dir, sources) {
  await fsp.mkdir(dir, { recursive: true });
  for (const src of sources) {
    const dest = path.join(dir, path.basename(src));
    if (path.resolve(src).toLowerCase() === path.resolve(dest).toLowerCase()) continue;
    await fsp.copyFile(src, `${dest}.tmp`);
    await fsp.rename(`${dest}.tmp`, dest);
  }
}

const sdkWanted = (m) => (sdkFiles(m).length ? sdkFiles(m) : manualFiles(m));

const missingSdkFiles = (m) => sdkWanted(m).filter((name) => {
  try { return fs.statSync(path.join(m.dir, name)).size <= 0; } catch { return true; }
});

// Rend les DLL manquantes sans rien demander quand c'est possible ; sinon dit précisément quoi faire.
// `announce` = false quand le SDK n'est qu'une ÉTAPE d'un téléchargement plus large (entrée fusionnée
// RTX) : émettre `done` ici ferait croire l'installation terminée avant la vérification finale.
async function provisionSdk(id, m, emit, announce = true) {
  const report = (patch) => { if (emit) emit({ id, ...patch }); };
  const done = () => { if (announce) report({ pct: 100, stage: 'done' }); return { ok: true, id }; };
  let missing = missingSdkFiles(m);
  if (!missing.length) return done();

  report({ pct: null, stage: 'install' });
  const wanted = new Set(missing.map((name) => name.toLowerCase()));
  const found = scanFiles(sdkScanRoots(), (name) => {
    if (wanted.has(name.toLowerCase())) return 'dll';
    return /rtx.*video.*sdk.*\.zip$/i.test(name) ? 'archive' : null;
  });

  // DLL déjà posées quelque part sur la machine (SDK décompressé, autre application) : on les reprend.
  if (found.dll) {
    await copyInto(m.dir, found.dll);
    missing = missingSdkFiles(m);
    if (!missing.length) return done();
  }

  // Sinon, l'archive du SDK laissée par le navigateur : on l'ouvre et on prend les DLL dedans.
  for (const archive of found.archive || []) {
    const r = await extractZipByBasename(archive, m.dir, missing).catch(() => ({ ok: false }));
    if (!r.ok) continue;
    missing = missingSdkFiles(m);
    if (!missing.length) return done();
  }

  return { ok: false, id, needsSource: true, url: (m.sdk && m.sdk.page) || m.page, error: t('sdkArchiveMissing') };
}

// site-packages du venv des sidecars (déduit de PYTHON=…/.venv/Scripts/python.exe). Best-effort,
// null si layout inconnu → on n'en tire alors AUCUNE conclusion négative (évite un faux « incomplet »).
let _spDir; // mémoïsé
function sitePackagesDir() {
  if (_spDir !== undefined) return _spDir;
  _spDir = null;
  try {
    const base = path.dirname(path.dirname(PYTHON)); // .venv
    const win = path.join(base, 'Lib', 'site-packages');
    if (fs.existsSync(win)) { _spDir = win; return _spDir; }
    const lib = path.join(base, 'lib'); // posix : lib/pythonX.Y/site-packages
    for (const n of (fs.existsSync(lib) ? fs.readdirSync(lib) : [])) {
      const sp = path.join(lib, n, 'site-packages');
      if (fs.existsSync(sp)) { _spDir = sp; return _spDir; }
    }
  } catch { /* */ }
  return _spDir;
}

// Le PACKAGE python requis (m.pipCheck) est-il installé dans le venv ? Test CHEAP (fs, pas de spawn
// python) : dossier du module, module .py isolé, ou *.dist-info. Un modèle dont les poids sont là mais
// le code pip absent (sam2/matanyone/ben2/diffusers…) n'est PAS utilisable → à re-télécharger.
function pipPresent(m) {
  if (!m.pipCheck) return true;
  const sp = sitePackagesDir();
  if (!sp) return false; // layout inconnu : ne jamais afficher un moteur non vérifié
  try {
    const names = fs.readdirSync(sp).map((n) => n.toLowerCase());
    const checks = Array.isArray(m.pipCheck) ? m.pipCheck : [m.pipCheck];
    return checks.every((check) => {
      if (fs.existsSync(path.join(sp, check))) return true;
      const needle = String(check).toLowerCase();
      return names.some((low) => low === needle + '.py' || (low.startsWith(needle) && low.endsWith('.dist-info')));
    });
  } catch { /* */ }
  return false;
}

// Statut installé + taille pour un id.
function statusOf(id) {
  const m = MANIFEST[id];
  if (!m) return { id, installed: false };
  if (m.available === false) return { id, installed: false, available: false };
  if (m.kind === 'alias') return { ...statusOf(m.target), id };
  if (m.kind === 'wheelzip') {
    const ready = pipPresent(m);
    const sp = sitePackagesDir();
    const moduleBytes = sp ? dirSize(path.join(sp, m.pipCheck)) : 0;
    let managedBytes = 0;
    try { managedBytes = dirSize(m.dir); } catch { /* */ }
    return {
      id,
      installed: ready,
      sizeBytes: (moduleBytes || managedBytes) || undefined,
      partial: (!ready && managedBytes > 0) || undefined,
    };
  }
  if (m.kind === 'manual') {
    // Une entrée peut porter PLUSIEURS fichiers : elle n'est installée que lorsqu'ils sont tous là,
    // sinon elle est partielle et l'action reste proposée pour le fichier manquant.
    let present = 0, bytes = 0;
    for (const name of manualFiles(m)) {
      try {
        const stat = fs.statSync(path.join(m.dir, name));
        if (stat.isFile() && stat.size > 0) { present += 1; bytes += stat.size; }
      } catch { /* fichier pas encore déposé */ }
    }
    const all = manualFiles(m).length;
    return { id, installed: present === all, sizeBytes: bytes || undefined, partial: (present > 0 && present < all) || undefined };
  }
  if (m.kind === 'bundled') {
    // Bundlé « cache de lib » (rembg/torch.hub) : statut RÉEL (fichier présent ou non) + taille.
    if (m.cache) {
      const files = cachePaths(m);
      const bytes = files.reduce((s, p) => { try { const st = fs.statSync(p); return s + (st.isDirectory() ? dirSize(p) : st.size); } catch { return s; } }, 0);
      const runtimeReady = pipPresent(m);
      return { id, installed: files.length > 0 && runtimeReady, sizeBytes: bytes || undefined, partial: (files.length > 0 && !runtimeReady) || undefined };
    }
    // Wheel/vendor : installé seulement si le module du moteur est réellement présent.
    const runtimeReady = pipPresent(m);
    return { id, installed: runtimeReady, partial: !runtimeReady || undefined };
  }
  if (m.kind === 'pipfork') {
    // Fork d'un paquet partagé : « installé » ne peut pas se réduire à « le module est là », puisque
    // les trois fournisseurs de `sam2` portent le même nom de module ET la même distribution. Seule
    // l'empreinte du paquet réellement posé répond.
    const installed = sam2Provider() === m.provider;
    const sp = sitePackagesDir();
    return { id, installed, sizeBytes: (installed && sp ? dirSize(path.join(sp, m.pipCheck)) : 0) || undefined };
  }
  if (m.kind === 'url') {
    // Installé = TOUS les fichiers présents (le principal + les extra, ex. les 2 ONNX visage, et les
    // bibliothèques d'un SDK propriétaire quand l'entrée en porte un — cf. `sdk`).
    const files = [{ file: m.file }, ...(m.extra || []), ...sdkFiles(m).map((file) => ({ file }))];
    let bytes = 0, allThere = true;
    for (const f of files) {
      const p = path.join(m.dir, f.file);
      try {
        const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
        if (size > 0) bytes += size; else allThere = false;
      } catch { allThere = false; }
    }
    const runtimeReady = pipPresent(m) && vendorPresent(m);
    // Le contenu extrait pèse bien plus que les archives : sans cela « Stockage » sous-estime de moitié.
    if (m.extract && ownsDir(id, m)) bytes = dirSize(m.dir) || bytes;
    // Une archive téléchargée mais pas encore extraite n'est pas un modèle utilisable : le statut
    // suit les fichiers ATTENDUS après extraction, pas la seule présence du zip.
    if (m.required && allThere) {
      const missing = m.required.some((rel) => !fs.existsSync(path.join(m.dir, rel)));
      if (missing) return { id, installed: false, sizeBytes: bytes || undefined, partial: true };
    }
    return { id, installed: allThere && runtimeReady, sizeBytes: bytes || undefined, partial: (bytes > 0 && !allThere) || (allThere && !runtimeReady) || undefined };
  }
  if (m.kind === 'pip') {
    // Package pip qui télécharge ses modèles dans le cache HF au 1er usage → « installé » = modèles
    // présents dans le cache (le pip doit l'être aussi, la lib les y a écrits). Best-effort.
    const cache = hfCachedAny('deepghs');
    if (cache) { const cs = dirSize(cache); const runtimeReady = pipPresent(m); return { id, installed: runtimeReady, sizeBytes: cs || undefined, partial: !runtimeReady || undefined }; }
    return { id, installed: false };
  }
  // hf : présent s'il vit DANS L'UN de : dossier géré NetsuRush, chemin de config (setup.ps1), ou cache
  // Hugging Face de la lib. Corrige le faux « absent » sur des modèles déjà provisionnés.
  let bytes = 0, present = false;
  const managed = hfDir(id, m);
  const mSize = dirSize(managed);
  if (mSize > 0) {
    // DL interrompu (.tmp restant) dans NOTRE dossier → incomplet (les chemins config/cache sont écrits
    // atomiquement par setup.ps1 / snapshot_download, pas concernés).
    if (hasPartial(managed)) return { id, installed: false, sizeBytes: mSize, partial: true };
    present = true; bytes = mSize;
  }
  if (!present && m.cfg && CONFIG[m.cfg]) {
    try { if (fs.existsSync(CONFIG[m.cfg])) { const st = fs.statSync(CONFIG[m.cfg]); present = true; bytes = st.isDirectory() ? dirSize(CONFIG[m.cfg]) : st.size; } } catch { /* */ }
  }
  if (!present) {
    const cache = hfCachedDir(m.repo) || hfCachedAny(m.match);
    if (cache) { const cs = dirSize(cache); if (cs > 0) { present = true; bytes = cs; } }
  }
  if (!present) return { id, installed: false };
  // Poids sur disque MAIS code manquant (vendor .py ou package pip) → inutilisable → re-DL le complète
  // (il saute les poids déjà là et ne refait que le code manquant).
  if (!vendorPresent(m) || !pipPresent(m)) return { id, installed: false, sizeBytes: bytes || undefined, partial: true };
  return { id, installed: true, sizeBytes: bytes || undefined };
}

function listModels() {
  return {
    ok: true,
    models: Object.keys(MANIFEST).map((id) => {
      const status = statusOf(id);
      const active = activeDownloads.get(id);
      return active
        ? { ...status, downloading: true, progress: active.progress?.pct ?? null }
        : status;
    }),
  };
}

function diskUsage() {
  let total = 0;
  const byTask = /** @type {Record<string, number>} */ ({});
  for (const id of Object.keys(MANIFEST)) {
    if (MANIFEST[id].kind === 'alias') continue;
    const s = statusOf(id);
    if (s.installed && s.sizeBytes) {
      total += s.sizeBytes;
      const t = MANIFEST[id].task || (MANIFEST[id].kind === 'url' ? 'upscale' : 'misc');
      byTask[t] = (byTask[t] || 0) + s.sizeBytes;
    }
  }
  return { ok: true, totalBytes: total, byTask };
}

// Téléchargements en cours par id → permet l'ANNULATION (bouton UI). `ctrl` = { canceled,
// cancelCurrent, cancels }: `cancelCurrent` holds the current child process (pip, extraction),
// `cancels` every network stream in flight — an HF repo is pulled over several connections at once.
const activeDownloads = new Map();

// Attempts per file before giving up. Each one RESUMES the partial, so they cost no re-downloaded
// bytes.
const DOWNLOAD_ATTEMPTS = 4;

// Files of one HF repo pulled in parallel. The CDN throttles per connection: a single sequential
// stream left the link half idle, and repos made of many small files paid a full round-trip each.
// Past 4 the gain flattens while disk contention grows.
const HF_PARALLEL = 4;

// Registers a concurrent cancellation point. A single slot was enough while one file came down at a
// time; in parallel each new stream would overwrite the previous one and cancelling would only ever
// reach the last.
function addCancel(ctrl, fn) {
  if (!ctrl) return () => {};
  if (!ctrl.cancels) ctrl.cancels = new Set();
  ctrl.cancels.add(fn);
  if (ctrl.canceled) { try { fn(); } catch { /* */ } }
  return () => { if (ctrl.cancels) ctrl.cancels.delete(fn); };
}

// Annule un téléchargement en cours. L'appelant reçoit `stage:'canceled'` via le SSE de progression.
function cancelDownload(id) {
  const manifest = MANIFEST[id];
  if (manifest?.kind === 'alias') id = manifest.target;
  const ctrl = activeDownloads.get(id);
  if (!ctrl) return { ok: false, id, error: t('noDownload') };
  ctrl.canceled = true;
  if (ctrl.cancels) for (const fn of [...ctrl.cancels]) { try { fn(); } catch { /* */ } }
  try { if (ctrl.cancelCurrent) ctrl.cancelCurrent(); } catch { /* */ }
  return { ok: true, id };
}

// Opens the HTTP stream of a URL, following redirects (GitHub → S3, HF → CDN). `headers` carries the
// resume Range; it must survive the redirects, otherwise every resume starts over from zero.
function httpsStream(url, headers, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 6) return reject(new Error('trop de redirections'));
    const req = https.get(url, { headers }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        try { req.destroy(); } catch { /* */ }
        return resolve(httpsStream(next, headers, depth + 1));
      }
      resolve({ req, res, code });
    });
    req.on('error', reject);
  });
}

// One download attempt, optionally resumed at `from` bytes. Appends to the existing .tmp when the
// server honours the Range (206), overwrites it otherwise.
function downloadAttempt(url, tmp, from, onProg, ctrl) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'NetsuRush' };
    if (from > 0) headers.Range = `bytes=${from}-`;
    httpsStream(url, headers).then(({ req, res, code }) => {
      if (code !== 200 && code !== 206) {
        res.resume();
        const err = /** @type {Error & { fatal?: boolean }} */ (new Error(`HTTP ${code} sur ${url}`));
        // A client error does not heal by retrying: dead URL, private repo, quota. 408/429 do —
        // the server is explicitly asking to wait. So does 416: the partial overshoots the
        // resource, and the next attempt starts from zero since this one gained nothing.
        if (code >= 400 && code < 500 && code !== 408 && code !== 429 && code !== 416) err.fatal = true;
        return reject(err);
      }
      // Range asked but 200 answered = the server ignores it and sends the WHOLE file. Appending to
      // the partial would yield a corrupt file of plausible size, so start over from zero.
      const resumed = from > 0 && code === 206;
      const start = resumed ? from : 0;
      const len = parseInt(res.headers['content-length'] || '0', 10) || 0;
      const total = len ? start + len : 0;
      let done = start;
      const out = fs.createWriteStream(tmp, { flags: resumed ? 'a' : 'w' });
      const unbind = addCancel(ctrl, () => {
        try { req.destroy(); } catch { /* */ }
        try { out.destroy(); } catch { /* */ }
      });
      const fail = (e) => { unbind(); try { out.destroy(); } catch { /* */ } reject(ctrl && ctrl.canceled ? new Error('CANCELED') : e); };
      res.on('data', (c) => { done += c.length; if (onProg) onProg(done, total); });
      res.on('error', fail);
      out.on('error', fail);
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        unbind();
        if (ctrl && ctrl.canceled) return reject(new Error('CANCELED'));
        // Silent drop: the stream closes before the announced length. Without this check the
        // truncated .tmp would be renamed into a "valid" file and the model would fail at load.
        if (total && done < total) return reject(new Error(`flux tronqué (${done}/${total} octets)`));
        resolve();
      }));
    }, reject);
  });
}

// Télécharge une URL vers `dest`, .tmp → rename atomique. `onProg(done, total)` en octets. Résout
// dest, rejette sur erreur HTTP. `ctrl` = annulation optionnelle.
// Network drops are retried by RESUMING the partial (Range): on multi-gigabyte weights, restarting
// from zero on every reset turned an unstable link into a download that never finished.
async function downloadUrl(url, dest, onProg, depth = 0, ctrl) {
  const tmp = dest + '.tmp';
  let lastErr = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    if (ctrl && ctrl.canceled) throw new Error('CANCELED');
    let from = 0;
    try { from = fs.statSync(tmp).size; } catch { from = 0; }
    try {
      await downloadAttempt(url, tmp, from, onProg, ctrl);
      fs.renameSync(tmp, dest);
      return dest;
    } catch (e) {
      if (ctrl && ctrl.canceled) { try { fs.unlinkSync(tmp); } catch { /* */ } throw new Error('CANCELED'); }
      lastErr = e;
      let after = 0;
      try { after = fs.statSync(tmp).size; } catch { after = 0; }
      // No byte gained (Range refused, 416, immediate drop): the partial is useless and would make
      // every retry resume at the same dead point. Start clean instead.
      if (after <= from) { try { fs.unlinkSync(tmp); } catch { /* */ } }
      if (e && e.fatal) break;
      if (attempt < DOWNLOAD_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* */ }
  throw lastErr;
}

// GET JSON (suit les redirections). Sert à lire l'arbre de fichiers d'un dépôt HF (tailles).
function httpsJson(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 6) return reject(new Error('trop de redirections'));
    https.get(url, { headers: { 'User-Agent': 'NetsuRush' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) { res.resume(); return resolve(httpsJson(new URL(res.headers.location, url).toString(), depth + 1)); }
      if (code !== 200) { res.resume(); return reject(new Error(`HTTP ${code} sur ${url}`)); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Télécharge un dépôt HF en Node (pas de dépendance python) → VRAIE barre de progression : lit l'arbre
// de fichiers (API HF /tree → tailles), somme le total, télécharge chaque fichier via resolve/main avec
// suivi octet-par-octet, et émet un pct CUMULÉ sur l'ensemble du dépôt.
// Fichiers d'un dépôt HF, éventuellement restreints à des préfixes de chemin. Un modèle bâti sur
// une base de diffusion n'a souvent besoin que d'UN sous-dossier : tirer le dépôt entier coûterait
// plusieurs gigaoctets de poids qu'aucune inférence ne chargera.
async function hfTreeFiles(repo, only) {
  const tree = await httpsJson(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`);
  const files = (Array.isArray(tree) ? tree : []).filter((f) => f && f.type === 'file' && f.path);
  if (!only || !only.length) return files;
  return files.filter((f) => only.some((p) => f.path === p || f.path.startsWith(p)));
}

async function downloadHf(id, m, emit, ctrl) {
  const dest = hfDir(id, m);
  try { await fsp.mkdir(dest, { recursive: true }); } catch { /* */ }
  purgeTmp(dest);
  // Un modèle peut être RÉPARTI sur plusieurs dépôts (poids affinés d'un côté, encodeur de la base
  // de l'autre) : `also` les range dans le même dossier, chacun avec son filtre et son sous-dossier.
  const sources = [{ repo: m.repo, only: m.only, into: '' }, ...(m.also || [])];
  let files;
  try {
    const groups = await Promise.all(sources.map(async (src) => (await hfTreeFiles(src.repo, src.only))
      .map((f) => ({ ...f, repo: src.repo, out: src.into ? `${src.into}/${f.path}` : f.path }))));
    files = groups.flat();
  } catch (e) {
    return { ok: false, id, error: `${t('unreadableFile')} (${m.repo}) : ${e}` };
  }
  if (!files.length) return { ok: false, id, error: `${t('notFound')}: ${m.repo}` };
  // pickOne : dépôt GGUF multi-quantisations (transcribe.cpp) → ne prendre QU'UN fichier (préférence de
  // quant, sinon le plus petit .gguf) au lieu de télécharger toutes les variantes (plusieurs Go).
  if (m.pickOne) {
    const ggufs = files.filter((f) => /\.gguf$/i.test(f.path));
    const pool = ggufs.length ? ggufs : files;
    const pref = ['q8_0', 'q6_k', 'q5_k', 'q5_0', 'q4_k', 'q4_0', 'f16'];
    const rank = (p) => { const i = pref.findIndex((q) => p.toLowerCase().includes(q)); return i < 0 ? pref.length : i; };
    pool.sort((a, b) => (rank(a.path) - rank(b.path)) || ((a.size || 0) - (b.size || 0)));
    files = [pool[0]];
  }
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  // Cumulative progress over CONCURRENT files: `done` counts the finished ones, `live` holds the
  // advance of each download in flight. A single counter no longer holds — files do not progress
  // one after the other any more.
  let done = 0;
  const live = new Map();
  let lastPct = -1;
  const bump = () => {
    let cur = done;
    for (const v of live.values()) cur += v;
    const pct = total ? Math.min(99, Math.round((cur / total) * 100)) : null;
    // Network chunks land far faster than React can paint them. One event per percent avoids
    // hundreds of identical rerenders on big models — all the more so with four streams at once.
    if (pct !== null && pct === lastPct) return;
    if (pct !== null) lastPct = pct;
    emit({ id, pct, done: cur, total, stage: 'download' });
  };
  emit({ id, pct: 0, done, total, stage: 'download' });

  let next = 0;
  /** @type {string|null} */
  let failure = null;
  const worker = async () => {
    for (;;) {
      if (failure || (ctrl && ctrl.canceled)) return;
      const i = next++;
      if (i >= files.length) return;
      const f = files[i];
      const out = path.join(dest, f.out || f.path);
      try { await fsp.mkdir(path.dirname(out), { recursive: true }); } catch { /* */ }
      if (fs.existsSync(out) && f.size && fs.statSync(out).size === f.size) { done += f.size; bump(); continue; }
      const url = `https://huggingface.co/${f.repo || m.repo}/resolve/main/${f.path.split('/').map(encodeURIComponent).join('/')}`;
      try {
        await downloadUrl(url, out, (fileDone) => { live.set(i, fileDone); bump(); }, 0, ctrl);
        live.delete(i);
        done += (f.size || 0);
        bump();
      } catch (e) {
        live.delete(i);
        if (ctrl && ctrl.canceled) return;
        // First failure wins: the other workers stop on their next turn instead of going on pulling
        // bytes for a model that is already lost.
        if (!failure) failure = `${t('downloadFailed')} (${f.path}) : ${e}`;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HF_PARALLEL, files.length) }, () => worker()));
  if (ctrl && ctrl.canceled) return { ok: false, id, canceled: true };
  if (failure) return { ok: false, id, error: failure };
  return { ok: true, id };
}

// Récupère le CODE vendoré d'un modèle (fichiers .py que le dépôt ne publie pas en package pip).
// L'app le fait au download (déclenché par l'utilisateur), comme l'auto-install pip. Best-effort.
async function ensureVendor(m, id, emit) {
  if (!m.vendor || !m.vendor.length) return { ok: true };
  const dir = m.vendorDir || VENDOR_DIR;
  try { await fsp.mkdir(dir, { recursive: true }); } catch { /* */ }
  const missing = m.vendor.filter((v) => !fs.existsSync(path.join(dir, v.file)));
  if (!missing.length) return { ok: true };
  emit({ id, pct: null, stage: 'install' });
  for (const v of missing) {
    try { await downloadUrl(v.url, path.join(dir, v.file)); }
    catch (e) { return { ok: false, error: `${t('notFound')}: ${v.file} : ${e}` }; }
  }
  return { ok: true };
}

// Un `import` a TROIS issues, pas deux : présent, absent, ou présent MAIS INCHARGEABLE (ABI torch
// cassée, DLL CUDA absente → [WinError 127]). Les deux dernières confondues, l'app réinstalle un
// paquet déjà là — et la réinstallation retire justement la roue correcte : « pas installé » →
// installe → toujours « pas installé ». `find_spec` sépare les deux : distribution absente = MISSING,
// import qui lève = BROKEN, avec le message python remonté tel quel pour le diagnostic.
const PY_IMPORT_PROBE = 'import importlib,importlib.util,sys\n'
  + 'for n in sys.argv[1:]:\n'
  + '    try: spec = importlib.util.find_spec(n)\n'
  + '    except Exception: spec = None\n'
  + '    if spec is None: sys.exit(3)\n'
  + '    try: importlib.import_module(n)\n'
  + '    except Exception as e: print(f"{n}: {type(e).__name__}: {e}"); sys.exit(4)\n';

/** @param {string[]} mods @returns {Promise<{ state: 'ok'|'missing'|'broken', detail: string }>} */
function pyImportState(mods) {
  return new Promise((resolve) => {
    let done = false;
    let out = '';
    const finish = (state, detail = '') => { if (!done) { done = true; resolve({ state, detail }); } };
    const p = spawn(PYTHON, ['-c', PY_IMPORT_PROBE, ...mods], { env: DETECT_ENV });
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.on('close', (code) => finish(code === 0 ? 'ok' : code === 4 ? 'broken' : 'missing', out.trim()));
    p.on('error', () => finish('missing'));
  });
}

// Le module python `mod` est-il importable dans le venv des sidecars ? (test rapide, ~1 s).
function pyHasModules(mods) {
  return pyImportState(mods).then((r) => r.state === 'ok');
}

function pyRuntimeReady(m, checks) {
  if (!checks.length) return Promise.resolve(true);
  if (!m.pipProbe) return pyHasModules(checks);
  return new Promise((resolve) => {
    let done = false;
    const p = spawn(PYTHON, ['-c', m.pipProbe], { env: DETECT_ENV });
    const timer = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch {} resolve(false); } }, 60_000);
    p.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve(code === 0); } });
    p.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(false); } });
  });
}

function killChildTree(p) {
  try {
    if (process.platform === 'win32' && p.pid) {
      const killer = spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => { try { p.kill(); } catch { /* */ } });
    } else p.kill();
  } catch { /* */ }
}

function bindCancelable(ctrl, p) {
  if (!ctrl) return () => {};
  const cancel = () => killChildTree(p);
  ctrl.cancelCurrent = cancel;
  if (ctrl.canceled) cancel();
  return () => { if (ctrl.cancelCurrent === cancel) ctrl.cancelCurrent = null; };
}

// Deux familles de paquets ne se choisissent PAS au coup par coup, parce qu'une roue mal assortie ne
// casse pas le modèle qu'on installe mais un AUTRE, plus tard :
//   · torch / torchvision / torchaudio = une seule ABI. `silero-vad` demande `torchaudio>=0.12`, pip
//     prend la dernière de PyPI, et l'import lève [WinError 127].
//   · onnxruntime, onnxruntime-gpu, onnxruntime-directml écrivent dans le MÊME dossier `onnxruntime/`.
//     `rembg[gpu]` et `onnx-asr[gpu,hub]` réclament `onnxruntime-gpu` sans borne : la roue posée est
//     la branche CUDA 13, son provider réclame une DLL absente d'un venv cu124, et TOUTE l'inférence
//     ONNX (visages, Parakeet, détourage) repasse sur processeur sans un seul message.
// Chaque `pip install` de modèle est donc contraint aux versions DÉJÀ posées : pip garde la roue en
// place, ou échoue en le disant. Fichier écrit une fois par démarrage du core, à partir du venv réel.
let torchConstraint;
async function torchConstraintFile() {
  if (torchConstraint !== undefined) return torchConstraint;
  torchConstraint = null;
  const code = 'import importlib.metadata as m\n'
    + 'for n in ("torch","torchvision","torchaudio",'
    + '"onnxruntime","onnxruntime-gpu","onnxruntime-directml","onnxruntime-openvino"):\n'
    + '    try: print(n+"=="+m.version(n))\n'
    + '    except Exception: pass\n';
  const pins = await new Promise((resolve) => {
    let out = '';
    const p = spawn(PYTHON, ['-c', code], { env: DETECT_ENV, windowsHide: true });
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.on('close', (c) => resolve(c === 0 ? out.trim() : ''));
    p.on('error', () => resolve(''));
  });
  if (!pins) return torchConstraint;
  const file = path.join(os.tmpdir(), 'nr-pip-constraints.txt');
  try { await fsp.writeFile(file, `${pins}\n`, 'utf8'); torchConstraint = file; } catch (_) {}
  return torchConstraint;
}

// Lance UN `pip install --no-input <args...>` dans le venv. Le process ET ses enfants CMake sont
// rattachés au contrôleur pour que « Annuler » fonctionne aussi pendant une compilation/installation.
function pipInstall(id, args, env, ctrl) {
  return new Promise((resolve) => {
    const p = spawn(PYTHON, ['-m', 'pip', 'install', '--no-input', ...args], { env, windowsHide: true });
    const unbind = bindCancelable(ctrl, p);
    let tail = '';
    const cap = (b) => { const s = b.toString(); logbus.py('models', s); tail = (tail + s).slice(-600); };
    p.stdout.on('data', cap);
    p.stderr.on('data', cap);
    p.on('close', (code) => {
      unbind();
      resolve(ctrl?.canceled ? { ok: false, canceled: true, error: 'CANCELED' } : code === 0
        ? { ok: true }
        : { ok: false, error: (tail.trim().split('\n').pop() || 'code ' + code) });
    });
    p.on('error', (e) => { unbind(); resolve({ ok: false, error: `pip: ${t('unavailable')} : ${e}` }); });
  });
}

function pipUninstall(packageName) {
  return new Promise((resolve) => {
    const p = spawn(PYTHON, ['-m', 'pip', 'uninstall', '--yes', packageName], { env: DETECT_ENV, windowsHide: true });
    let tail = '';
    const cap = (b) => { const s = b.toString(); logbus.py('models', s); tail = (tail + s).slice(-600); };
    p.stdout.on('data', cap); p.stderr.on('data', cap);
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: tail.trim().split(/\r?\n/).pop() || `pip code ${code}` }));
    p.on('error', (e) => resolve({ ok: false, error: String(e) }));
  });
}

function extractZipMember(archive, member, outDir, ctrl) {
  return new Promise((resolve) => {
    const code = 'import pathlib,sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);n=sys.argv[2];d=pathlib.Path(sys.argv[3]);d.mkdir(parents=True,exist_ok=True);p=z.extract(n,d);print(p)';
    const p = spawn(PYTHON, ['-c', code, archive, member, outDir], { env: DETECT_ENV, windowsHide: true });
    const unbind = bindCancelable(ctrl, p);
    let stdout = '', tail = '';
    p.stdout.on('data', (b) => { stdout += b.toString(); });
    p.stderr.on('data', (b) => { const s = b.toString(); logbus.py('models', s); tail = (tail + s).slice(-600); });
    p.on('close', (code) => {
      unbind();
      resolve(ctrl?.canceled ? { ok: false, canceled: true } : code === 0
        ? { ok: true, path: stdout.trim().split(/\r?\n/).pop() }
        : { ok: false, error: tail.trim().split(/\r?\n/).pop() || `zip code ${code}` });
    });
    p.on('error', (e) => { unbind(); resolve({ ok: false, error: String(e) }); });
  });
}

function extractZipArchive(archive, outDir, ctrl) {
  return new Promise((resolve) => {
    // `extractall` brut accepte ../. On résout chaque membre sous la destination avant extraction.
    const code = [
      'import pathlib,sys,zipfile',
      'a=pathlib.Path(sys.argv[1]);d=pathlib.Path(sys.argv[2]).resolve();d.mkdir(parents=True,exist_ok=True)',
      'z=zipfile.ZipFile(a)',
      '[(lambda p: (_ for _ in ()).throw(ValueError("unsafe zip member")) if d not in p.parents and p!=d else None)((d/n).resolve()) for n in z.namelist()]',
      'z.extractall(d)',
    ].join(';');
    const p = spawn(PYTHON, ['-c', code, archive, outDir], { env: DETECT_ENV, windowsHide: true });
    const unbind = bindCancelable(ctrl, p);
    let tail = '';
    p.stderr.on('data', (b) => { const s = b.toString(); logbus.py('models', s); tail = (tail + s).slice(-600); });
    p.on('close', (exitCode) => {
      unbind();
      resolve(ctrl?.canceled ? { ok: false, canceled: true } : exitCode === 0
        ? { ok: true }
        : { ok: false, error: tail.trim().split(/\r?\n/).pop() || `zip code ${exitCode}` });
    });
    p.on('error', (e) => { unbind(); resolve({ ok: false, error: String(e) }); });
  });
}

const PIP_PATCHES = {
  // Le pyproject amont de MatAnyone2 déclare `packages = ["matanyone2"]` (qui embarque déjà
  // `matanyone2/config/`, yaml compris) PUIS un `force-include` du MÊME dossier vers le MÊME chemin :
  // hatchling voit chaque fichier deux fois et refuse de construire le wheel
  // (« A second file is being added to the wheel archive at the same path »). La table est redondante,
  // la retirer suffit — vérifié : le wheel se construit et config/ y est toujours.
  // Idempotent : sans la table (amont corrigé), ne touche à rien.
  // MatAnyone2 épingle `huggingface_hub==0.36.2` (contrainte de sa DÉMO). Ce pin survit à
  // `--no-deps` : il entre dans les métadonnées installées, donc pip le fait respecter à chaque
  // résolution ultérieure et rétrograde le hub. transformers 5.x exige `>=1.5` et importe
  // `is_offline_mode`, absent en 0.36 → diffusers ne charge plus l'autoencodeur Wan et la
  // suppression d'objet meurt sur une erreur qui ne nomme jamais MatAnyone. Le paquet n'utilise du
  // hub que `PyTorchModelHubMixin`, stable en 1.x : le pin est retiré, la dépendance reste.
  // Idempotent : sans pin (amont corrigé), ne touche à rien.
  'matanyone-drop-hub-pin': (dir) => {
    const f = path.join(dir, 'pyproject.toml');
    let s;
    try { s = fs.readFileSync(f, 'utf8'); } catch { return false; }
    const out = s.replace(/(["'])huggingface[-_]hub\s*==\s*[^"']+\1/gi, '"huggingface_hub"');
    if (out === s) return false;
    fs.writeFileSync(f, out);
    return true;
  },
  'hatch-drop-force-include': (dir) => {
    const f = path.join(dir, 'pyproject.toml');
    let s;
    try { s = fs.readFileSync(f, 'utf8'); } catch { return false; }
    const out = s.replace(/\[tool\.hatch\.build\.targets\.wheel\.force-include\]\r?\n(?:\s*"[^"]*"\s*=\s*"[^"]*"\r?\n)+/g, '');
    if (out === s) return false;
    fs.writeFileSync(f, out);
    return true;
  },
};

// Récupère un tarball GitHub, l'extrait, applique un correctif au source, et renvoie le dossier à
// installer. `tar` est fourni par Windows (System32) comme par POSIX — même outil que setup.ps1.
async function preparePatchedPip(url, patchName, id, subdir) {
  const work = path.join(os.tmpdir(), `nr-pip-${id}-${Date.now()}`);
  await fsp.mkdir(work, { recursive: true });
  const tgz = path.join(work, 'src.tar.gz');
  await downloadUrl(url, tgz, null);
  const untar = await new Promise((resolve) => {
    const p = spawn('tar', ['-xf', tgz, '-C', work]);
    p.on('close', (c) => resolve(c === 0));
    p.on('error', () => resolve(false));
  });
  if (!untar) throw new Error('extraction du tarball impossible (tar)');
  const roots = (await fsp.readdir(work, { withFileTypes: true })).filter((e) => e.isDirectory());
  if (!roots.length) throw new Error('tarball vide');
  // Le paquet n'est pas toujours à la racine du dépôt : SAMURAI publie le sien dans `sam2/`, et une
  // URL de tarball ne sait pas désigner un sous-dossier (le `#subdirectory=` de pip exige git).
  const root = subdir ? path.join(work, roots[0].name, subdir) : path.join(work, roots[0].name);
  if (!fs.existsSync(path.join(root, 'setup.py')) && !fs.existsSync(path.join(root, 'pyproject.toml'))) {
    throw new Error(`aucun paquet python dans ${subdir || '.'} (ni setup.py ni pyproject.toml)`);
  }
  for (const name of Array.isArray(patchName) ? patchName : [patchName]) {
    const patch = PIP_PATCHES[name];
    if (patch) patch(root);
  }
  return { dir: root, work };
}

// Installe le PACKAGE python d'un modèle (ex. sam2) dans le venv si absent. `emit` → stage 'install'
// (barre indéterminée côté UI). Sans compilation CUDA (Windows). Best-effort : renvoie {ok, error?}.
// `m.installSteps` = suite de commandes pip (ex. imgutils : --no-deps puis ses deps pures) pour ne pas
// perturber opencv/numpy déjà en place ; sinon `m.pip` = une seule commande.
async function ensurePipPackage(m, id, emit, ctrl) {
  if (!m.pip && !m.installSteps) return { ok: true };
  const checks = Array.isArray(m.pipCheck) ? m.pipCheck : (m.pipCheck ? [m.pipCheck] : []);
  if (await pyRuntimeReady(m, checks)) return { ok: true, skipped: true };
  // Paquet en place mais inchargeable : réinstaller ne répare pas la cause (une ABI voisine cassée)
  // et fait perdre la roue correcte. On s'arrête en NOMMANT l'erreur python.
  if (checks.length && !m.pipProbe) {
    const probe = await pyImportState(checks);
    if (probe.state === 'broken') return { ok: false, error: `${t('pyRuntimeBroken')} : ${probe.detail}` };
  }
  emit({ id, pct: null, stage: 'install' });
  const constraint = await torchConstraintFile();
  const env = {
    ...DETECT_ENV, SAM2_BUILD_CUDA: '0', SAM2_BUILD_ALLOW_ERRORS: '1',
    ...(constraint ? { PIP_CONSTRAINT: constraint } : {}),
  };
  let pipTarget = m.pip;
  let preparedWork = null;
  // Une source à corriger (pyproject cassé) ou dont le paquet vit dans un sous-dossier doit être
  // récupérée et préparée avant l'installation : pip ne sait faire ni l'un ni l'autre depuis un
  // tarball nu.
  if (m.pip && (m.pipPatch || m.pipSubdir)) {
    try {
      const prepared = await preparePatchedPip(m.pip, m.pipPatch, id, m.pipSubdir);
      pipTarget = prepared.dir;
      preparedWork = prepared.work;
    }
    catch (e) { return { ok: false, error: `${t('preparationFailed')} (${checks.join(', ') || id}): ${e}` }; }
  }
  try {
    const steps = m.installSteps || [[pipTarget]];
    for (const step of steps) {
      const args = step.map((arg) => (arg === PIP_TARGET ? pipTarget : arg));
      const r = await pipInstall(id, args, env, ctrl);
      if (!r.ok) return { ok: false, error: `${t('installationFailed')} (${checks.join(', ')}): ${r.error}` };
    }
    if (!(await pyRuntimeReady(m, checks))) return { ok: false, error: `${t('installationFailed')} (${checks.join(', ')})` };
    return { ok: true };
  } finally {
    // Le tarball et sa copie patchée ne servent qu'à `pip install`. Une installation réussie ou
    // échouée ne doit jamais laisser ce dépôt temporaire dans %TEMP%.
    if (preparedWork) {
      try { await fsp.rm(preparedWork, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

// Pré-fetch des modèles d'un package auto-téléchargeant (imgutils visage) : appelle la lib sur une
// image factice → elle écrit ses ONNX dans le cache HF (même résolution qu'au runtime). Best-effort.
// `import onnxruntime` D'ABORD, jamais par confort : à l'import, imgutils fait `pip install
// onnxruntime-gpu` tout seul quand le module manque, ce qui pose la DERNIÈRE roue (branche CUDA 13)
// par-dessus celle bâtie pour le CUDA de torch — l'`CUDAExecutionProvider` disparaît alors sans autre
// trace qu'un log, et toute l'inférence ONNX repasse sur le CPU. Import préalable = l'étape échoue au
// lieu de saboter le venv.
const PREFETCH_SNIPPETS = {
  face: "import onnxruntime;from PIL import Image;from imgutils.detect import detect_faces;from imgutils.metrics import "
      + "ccip_extract_feature;i=Image.new('RGB',(64,64));detect_faces(i,level='s',version='v1.4');ccip_extract_feature(i)",
};

// Code python qui force le téléchargement des poids d'un modèle dont la LIB gère le cache. Pour une
// session rembg, l'id du catalogue EST le nom de session (isnet-anime, u2net…) : `new_session` écrit
// l'ONNX dans U2NET_HOME. Sans cela le bouton « Télécharger » de ces entrées n'aurait rien à faire.
function prefetchCode(m, id) {
  if (m.prefetch) return PREFETCH_SNIPPETS[m.prefetch] || null;
  if (m.cache && m.cache.kind === 'rembg') return `from rembg import new_session; new_session(${JSON.stringify(id)})`;
  return null;
}

function prefetchModels(code, emit, id) {
  if (!code) return Promise.resolve({ ok: true });
  emit({ id, pct: null, stage: 'install' });
  return new Promise((resolve) => {
    const p = spawn(PYTHON, ['-c', code], { env: DETECT_ENV });
    let tail = '';
    const cap = (b) => { const s = b.toString(); logbus.py('models', s); tail = (tail + s).slice(-600); };
    p.stdout.on('data', cap); p.stderr.on('data', cap);
    p.on('close', (c) => resolve(c === 0 ? { ok: true } : { ok: false, error: `${t('downloadFailed')} (${tail.trim().split('\n').pop() || 'code ' + c})` }));
    p.on('error', (e) => resolve({ ok: false, error: `Python: ${t('unavailable')} : ${e}` }));
  });
}

// Installe un fork qui REMPLACE un paquet partagé (SAMURAI / SAM2Long sur `sam2`). Le passage par
// `ensurePipPackage` ne convient pas : il court-circuite dès que le module s'importe, or les trois
// fournisseurs de `sam2` s'importent tous — c'est justement le fork posé qu'il faut changer.
async function installPipFork(id, m, report, ctrl) {
  const fail = (error) => { report({ id, pct: null, stage: 'error', error }); return { ok: false, id, error }; };
  // Le fork n'apporte que du code : sans checkpoint SAM 2.1 il ne segmente rien, et l'utilisateur
  // chercherait longtemps pourquoi une installation « réussie » ne produit aucun masque.
  if ((m.needs || []).length && !m.needs.some((need) => statusOf(need).installed)) {
    return fail(t('sam2WeightsFirst'));
  }
  report({ id, pct: null, stage: 'install' });
  // Désinstaller d'abord : pip poserait le nouveau paquet PAR-DESSUS l'ancien, laissant cohabiter
  // deux jeux de fichiers et un `sam2` dont on ne saurait plus dire de quelle version il vient.
  await pipUninstall(m.package);
  if (ctrl.canceled) return { ok: false, id, canceled: true };
  let prepared = null;
  try {
    prepared = await preparePatchedPip(m.pip, m.pipPatch, id, m.pipSubdir);
    const env = { ...DETECT_ENV, SAM2_BUILD_CUDA: '0', SAM2_BUILD_ALLOW_ERRORS: '1' };
    const r = await pipInstall(id, ['--no-deps', prepared.dir], env, ctrl);
    if (ctrl.canceled || r.canceled) return { ok: false, id, canceled: true };
    if (!r.ok) return fail(`${t('installationFailed')} (${id}): ${r.error}`);
  } catch (e) {
    return fail(`${t('preparationFailed')} (${id}): ${e}`);
  } finally {
    if (prepared) { try { await fsp.rm(prepared.work, { recursive: true, force: true }); } catch (_) {} }
  }
  if (sam2Provider() !== m.provider) return fail(`${t('installationFailed')} (${id})`);
  report({ id, pct: 100, stage: 'done' });
  return { ok: true, id };
}

// Télécharge un modèle par id. `emit(progress)` = SSE models:progress.
async function downloadModel(id, emit, replace = false) {
  let m = MANIFEST[id];
  if (!m) return { ok: false, id, error: `${t('unknownModel')}: ${id}` };
  if (m.kind === 'alias') {
    id = m.target;
    m = MANIFEST[id];
  }
  if (m.available === false) return { ok: false, id, error: `${t('unavailable')}: ${id}` };
  if (m.kind === 'manual') return { ok: false, id, error: 'Importez ckpt_0_200_0.pth depuis le lien officiel AutoShot.' };
  // Deux modèles exclusifs occupent la MÊME distribution pip : installer le second efface le
  // premier. `installPipFork` le faisait sans rien demander — on perdait une installation qui
  // marchait pour une autre qu'on n'avait pas encore essayée. On refuse donc, en nommant le
  // concurrent, tant que l'utilisateur n'a pas confirmé le remplacement (`replace`).
  const plan = resolveInstall(id, m, { isInstalled: (peer) => statusOf(peer).installed === true, replace });
  if (plan.mode === 'conflict') {
    // `error` en plus de `conflict` : un appelant qui ne connaît pas encore le cas (le gestionnaire
    // de modèles, lui, ouvre une boîte de dialogue) afficherait sinon un échec MUET.
    return {
      ok: false, id, error: `${t('exclusiveInstalled')} (${plan.blockedBy.join(', ')})`,
      conflict: { family: plan.family, blockedBy: plan.blockedBy },
    };
  }
  if (m.kind === 'bundled' && !m.pip && !m.installSteps) return { ok: true, id };
  // La vue Paramètres peut être démontée/remontée pendant un téléchargement. Dans ce cas un clic
  // tardif sur « Reprendre » rejoint simplement l'opération réelle au lieu d'afficher une erreur.
  if (activeDownloads.has(id)) return { ok: true, id, active: true };
  const ctrl = { canceled: false, cancels: new Set(), cancelCurrent: null, progress: { pct: 0, stage: 'download' } };
  activeDownloads.set(id, ctrl);
  const report = (progress) => {
    ctrl.progress = progress;
    emit(progress);
  };
  // Fin annulée = stage 'canceled' (l'UI efface la barre sans afficher d'erreur).
  const canceled = () => { report({ id, pct: null, stage: 'canceled' }); return { ok: false, id, canceled: true }; };
  try {
    const verified = async () => {
      const checks = Array.isArray(m.pipCheck) ? m.pipCheck : (m.pipCheck ? [m.pipCheck] : []);
      if (!(await pyRuntimeReady(m, checks))) return false;
      return statusOf(id).installed === true;
    };
    const done = async () => {
      if (!(await verified())) {
        const error = `${t('installationFailed')} (${id})`;
        report({ id, pct: null, stage: 'error', error });
        return { ok: false, id, error };
      }
      report({ id, pct: 100, stage: 'done' });
      return { ok: true, id };
    };
    if (m.kind === 'bundled') {
      const pip = await ensurePipPackage(m, id, report, ctrl);
      if (ctrl.canceled || pip.canceled) return canceled();
      if (!pip.ok) { report({ id, pct: null, stage: 'error', error: pip.error }); return { ok: false, id, error: pip.error }; }
      if (ctrl.canceled) return canceled();
      // Cache de lib (session rembg) : le runtime pip ne suffit pas, il faut aussi tirer les poids.
      const pf = await prefetchModels(prefetchCode(m, id), report, id);
      if (!pf.ok) { report({ id, pct: null, stage: 'error', error: pf.error }); return { ok: false, id, error: pf.error }; }
      return done();
    }
    if (m.kind === 'pipfork') return installPipFork(id, m, report, ctrl);
    if (m.kind === 'wheelzip') {
      await fsp.mkdir(m.dir, { recursive: true });
      const archive = path.join(m.dir, m.file);
      if (!fs.existsSync(archive)) {
        report({ id, pct: 0, stage: 'download' });
        try {
          await downloadUrl(m.url, archive, (bytes, total) => {
            report({ id, pct: total ? Math.round((bytes / total) * 100) : null, done: bytes, total, stage: 'download' });
          }, 0, ctrl);
        } catch (e) {
          if (ctrl.canceled) return canceled();
          throw e;
        }
      }
      if (ctrl.canceled) return canceled();
      report({ id, pct: null, stage: 'install' });
      const wheelName = path.basename(m.wheelMember);
      let wheel = path.join(m.dir, m.wheelMember);
      if (!fs.existsSync(wheel)) {
        const extracted = await extractZipMember(archive, m.wheelMember, m.dir, ctrl);
        if (ctrl.canceled || extracted.canceled) return canceled();
        if (!extracted.ok) {
          report({ id, pct: null, stage: 'error', error: extracted.error });
          return { ok: false, id, error: extracted.error };
        }
        wheel = extracted.path || wheel;
      }
      const installed = await pipInstall(id, ['--no-deps', '--force-reinstall', wheel], DETECT_ENV, ctrl);
      if (ctrl.canceled || installed.canceled) return canceled();
      if (!installed.ok) {
        report({ id, pct: null, stage: 'error', error: installed.error });
        return { ok: false, id, error: installed.error };
      }
      // L'archive et le wheel ne servent plus après installation ; le package installé contient déjà
      // le runtime et toutes les variantes. Un échec les conserve pour permettre « Reprendre ».
      try { await fsp.rm(archive, { force: true }); } catch { /* */ }
      try { await fsp.rm(path.join(m.dir, m.wheelMember.split('/')[0]), { recursive: true, force: true }); } catch { /* */ }
      try { await fsp.rm(path.join(m.dir, wheelName), { force: true }); } catch { /* */ }
      return done();
    }
    if (m.kind === 'url') {
      await fsp.mkdir(m.dir, { recursive: true });
      const files = [{ file: m.file, url: m.url }, ...(m.extra || [])];
      for (const f of files) {
        if (ctrl.canceled) return canceled();
        const dest = path.join(m.dir, f.file);
        if (fs.existsSync(dest)) continue;
        report({ id, pct: 0, stage: 'download' });
        try {
          await downloadUrl(f.url, dest, (done, total) => {
            report({ id, pct: total ? Math.round((done / total) * 100) : null, done, total, stage: 'download' });
          }, 0, ctrl);
        } catch (e) {
          if (ctrl.canceled) return canceled();
          throw e;
        }
      }
      // Certains sidecars lisent un chemin provisionné dans la configuration (AutoShot notamment).
      // Garder cette valeur synchronisée après un téléchargement atomique, comme pour un import.
      if (m.cfg) saveConfig({ [m.cfg]: path.join(m.dir, m.file) });
      // Archives déclarées : un modèle peut arriver en zip (poids groupés, paquet python complet).
      // On extrait sur place ; l'archive est conservée pour que « Reprendre » ne retélécharge rien.
      for (const name of m.extract || []) {
        if (ctrl.canceled) return canceled();
        report({ id, pct: null, stage: 'install' });
        const zipped = await extractZipArchive(path.join(m.dir, name), m.dir, ctrl);
        if (ctrl.canceled || zipped.canceled) return canceled();
        if (!zipped.ok) { report({ id, pct: null, stage: 'error', error: zipped.error }); return { ok: false, id, error: zipped.error }; }
      }
      // Code vendoré à côté des poids (modules d'architecture RIFE) : sans lui le checkpoint n'est
      // qu'un tas de tenseurs, donc il compte dans le statut « installé » (cf. vendorPresent).
      if (m.vendor) {
        const v = await ensureVendor(m, id, report);
        if (!v.ok) { report({ id, pct: null, stage: 'error', error: v.error }); return { ok: false, id, error: v.error }; }
      }
      // Les poids URL (Real-ESRGAN/Spandrel) ont aussi besoin de leur moteur Python. Les fichiers déjà
      // présents sont conservés : sur une ancienne installation, « Reprendre » ne réinstalle que le code.
      if (m.pip || m.installSteps) {
        const pip = await ensurePipPackage(m, id, report, ctrl);
        if (ctrl.canceled || pip.canceled) return canceled();
        if (!pip.ok) { report({ id, pct: null, stage: 'error', error: pip.error }); return { ok: false, id, error: pip.error }; }
      }
      // Bibliothèques propriétaires du même runtime (RTX Video SDK) : NetsuRush n'a pas le droit de les
      // redistribuer, mais il sait les retrouver sur la machine. Sans elles le binaire téléchargé
      // n'encode rien — l'installation n'est donc pas terminée tant qu'elles manquent.
      if (m.sdk) {
        const sdk = await provisionSdk(id, m, report, false);
        if (!sdk.ok) return sdk;
      }
      return done();
    }
    if (m.kind === 'hf') {
      report({ id, pct: null, stage: 'download' });
      const r = await downloadHf(id, m, report, ctrl);
      if (r.canceled) return canceled();
      // Poids OK → s'assurer que le PACKAGE python (ex. sam2) est là avant de dire « terminé ».
      if (r.ok && (m.pip || m.installSteps)) {
        const pip = await ensurePipPackage(m, id, report, ctrl);
        if (ctrl.canceled || pip.canceled) return canceled();
        if (!pip.ok) { report({ id, pct: null, stage: 'error', error: pip.error }); return { ok: false, id, error: pip.error }; }
      }
      // Code vendoré (ex. pipeline MiniMax) récupéré par l'app.
      if (r.ok && m.vendor) {
        const v = await ensureVendor(m, id, report);
        if (!v.ok) { report({ id, pct: null, stage: 'error', error: v.error }); return { ok: false, id, error: v.error }; }
      }
      if (!r.ok) { report({ id, pct: null, stage: 'error', error: r.error }); return r; }
      return done();
    }
    if (m.kind === 'pip') {
      // Package auto-fetch (imgutils visage) : installer le pip puis pré-télécharger ses modèles.
      const pip = await ensurePipPackage(m, id, report, ctrl);
      if (ctrl.canceled || pip.canceled) return canceled();
      if (!pip.ok) { report({ id, pct: null, stage: 'error', error: pip.error }); return { ok: false, id, error: pip.error }; }
      if (ctrl.canceled) return canceled();
      const pf = await prefetchModels(prefetchCode(m, id), report, id);
      if (!pf.ok) { report({ id, pct: null, stage: 'error', error: pf.error }); return { ok: false, id, error: pf.error }; }
      return done();
    }
    return { ok: false, id, error: `${t('unsupportedSource')}: ${m.kind}` };
  } catch (e) {
    if (ctrl.canceled) return canceled();
    report({ id, pct: null, stage: 'error', error: String(e) });
    return { ok: false, id, error: String(e) };
  } finally {
    activeDownloads.delete(id);
  }
}

async function importModel(id, source) {
  const m = MANIFEST[id];
  if (!m || m.kind !== 'manual') return { ok: false, id, error: `${t('unsupportedSource')}: ${id}` };
  try {
    const stat = await fsp.stat(source);
    if (!stat.isFile() || stat.size <= 0) return { ok: false, id, error: 'Checkpoint vide ou introuvable' };
    // Le fichier déposé décide de sa destination : sur une entrée multi-fichiers (DLL du SDK) on ne
    // peut pas deviner lequel des deux l'utilisateur vient de choisir autrement que par son nom.
    const expected = manualFiles(m);
    const picked = expected.find((name) => name.toLowerCase() === path.basename(source).toLowerCase())
      || (expected.length === 1 && path.extname(source).toLowerCase() === path.extname(expected[0]).toLowerCase() ? expected[0] : null);
    if (!picked) return { ok: false, id, error: `Fichier attendu : ${expected.join(' ou ')}` };
    await fsp.mkdir(m.dir, { recursive: true });
    const dest = path.join(m.dir, picked);
    const tmp = `${dest}.tmp`;
    await fsp.copyFile(source, tmp);
    await fsp.rename(tmp, dest);
    if (m.cfg) saveConfig({ [m.cfg]: dest });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, id, error: String(e) };
  }
}

async function deleteModel(id) {
  let m = MANIFEST[id];
  if (!m) return { ok: false, id, error: `${t('unknownModel')}: ${id}` };
  if (m.kind === 'alias') {
    id = m.target;
    m = MANIFEST[id];
  }
  if (m.kind === 'wheelzip') {
    const removed = await pipUninstall(m.package);
    if (!removed.ok) return { ok: false, id, error: removed.error };
    try { await fsp.rm(m.dir, { recursive: true, force: true }); } catch { /* */ }
    return { ok: true, id };
  }
  if (m.kind === 'pipfork') {
    // Retirer le fork sans rien remettre couperait la segmentation entière : les poids SAM 2.1 sont
    // toujours là mais plus rien ne sait les charger. On repose donc le paquet d'origine.
    const removed = await pipUninstall(m.package);
    if (!removed.ok) return { ok: false, id, error: removed.error };
    const env = { ...DETECT_ENV, SAM2_BUILD_CUDA: '0', SAM2_BUILD_ALLOW_ERRORS: '1' };
    const restored = await pipInstall(id, ['--no-deps', SAM2_PIP], env, null);
    if (!restored.ok) return { ok: false, id, error: `${t('installationFailed')} (${SAM2_DISTRIBUTION}): ${restored.error}` };
    return { ok: true, id };
  }
  if (m.kind === 'manual') {
    try { for (const name of manualFiles(m)) await fsp.rm(path.join(m.dir, name), { force: true }); }
    catch (e) { return { ok: false, id, error: String(e) }; }
    if (m.cfg) saveConfig({ [m.cfg]: null });
    return { ok: true, id };
  }
  if (m.kind === 'bundled') {
    // Cache de lib (rembg/torch.hub) : effacer les fichiers pour libérer le disque (re-fetch au 1er
    // usage). Sans cache = inclus dans le wheel → non supprimable.
    if (!m.cache) return { ok: false, id, error: t('libraryModelLocked') };
    for (const p of cachePaths(m)) { try { await fsp.rm(p, { recursive: true, force: true }); } catch { /* */ } }
    return { ok: true, id };
  }
  if (m.kind === 'pip') {
    // Efface les modèles auto-téléchargés du cache HF (libère le disque ; re-fetch au 1er usage).
    // Laisse le package pip installé (partagé, réinstall coûteuse).
    const hub = path.join(hfCacheRoot(), 'hub');
    try {
      for (const n of fs.readdirSync(hub)) {
        if (n.startsWith('models--') && n.toLowerCase().includes('deepghs')) {
          try { await fsp.rm(path.join(hub, n), { recursive: true, force: true }); } catch { /* */ }
        }
      }
    } catch { /* */ }
    return { ok: true, id };
  }
  try {
    if (m.kind === 'url') {
      // Archive extraite sur place : le manifeste ne nomme que les zips, pas ce qu'ils ont déposé.
      // N'effacer que les fichiers listés laisserait tout l'extrait sur le disque.
      if (m.extract && ownsDir(id, m)) {
        await fsp.rm(m.dir, { recursive: true, force: true });
        return { ok: true, id };
      }
      for (const name of [m.file, ...(m.extra || []).map((f) => f.file), ...sdkFiles(m)]) {
        try { await fsp.rm(path.join(m.dir, name), { force: true }); } catch { /* */ }
      }
      // Modules d'architecture propres à CE modèle. Ceux de `RIFE_ARCH_SHARED` (warplayer) servent à
      // toutes les versions : les effacer casserait les modèles restants.
      const shared = new Set(RIFE_ARCH_SHARED.map((v) => v.file));
      for (const v of m.vendor || []) {
        if (shared.has(v.file)) continue;
        try { await fsp.rm(path.join(m.vendorDir || VENDOR_DIR, v.file), { force: true }); } catch { /* */ }
      }
    } else if (m.kind === 'hf') {
      // Efface partout où le modèle peut vivre : dossier géré, chemin de config, cache HF.
      await fsp.rm(hfDir(id, m), { recursive: true, force: true });
      if (m.cfg && CONFIG[m.cfg]) { try { await fsp.rm(CONFIG[m.cfg], { recursive: true, force: true }); } catch (_) {} }
      const cache = hfCachedDir(m.repo);
      if (cache) { try { await fsp.rm(cache, { recursive: true, force: true }); } catch (_) {} }
    }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, id, error: String(e) };
  }
}

// Dossier disque d'un modèle HF géré (pour les moteurs qui lisent le fichier eux-mêmes, ex. GGUF).
function modelDir(id) { const m = MANIFEST[id]; return m ? hfDir(id, m) : null; }
// Premier fichier d'extension `ext` (ex '.gguf') trouvé dans le dossier d'un modèle, sinon null.
function findModelFile(id, ext) {
  const dir = modelDir(id);
  if (!dir) return null;
  const walk = (d) => {
    let out = [];
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) out = out.concat(walk(p));
      else if (e.name.toLowerCase().endsWith(ext.toLowerCase())) out.push(p);
    }
    return out;
  };
  return walk(dir)[0] || null;
}

module.exports = { listModels, diskUsage, statusOf, downloadModel, importModel, cancelDownload, deleteModel, modelDir, findModelFile, MANIFEST, PIP_PATCHES, RIFE_TORCH_DIR, RIFE_ARCH_DIR, GMFSS_DIR, DRBA_DIR, DRBA_ARCH_DIR };
