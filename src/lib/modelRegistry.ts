// Registre de modèles APP-WIDE — source de vérité UI (labels, licences, tiers, tailles) pour TOUS
// les modèles de l'application (détection, recherche, voix, upscale, interpolation, depth, matte,
// roto, object-removal). Consommé par le gestionnaire (Paramètres › Modèles) et l'écran d'install.
//
// Le fetch réel (URL/HF, sha, chemin disque) vit côté core dans `core/models.js` (manifeste miroir,
// même `id`). Contrat : tout `id` ici DOIT exister dans le manifeste core, et vice-versa.
//
// Invariant NC (stratégie délibérée, cf. prompt de refonte) : l'app payante reste PLEINEMENT
// fonctionnelle avec les seuls modèles permissifs — chaque op a un défaut permissif autonome. Les
// modèles `license:"NC"` (commercialUse:false) sont des add-ons optionnels, JAMAIS un défaut, jamais
// l'unique moteur d'une op, jamais gatés par paiement. Un build sans aucun NC = zéro perte de capacité
// cœur. (Revue juridique finale avant release payante — décision produit prise, pas de re-warn UI.)

// Tâche = regroupement dans le gestionnaire. Aligné sur les sous-systèmes réels.
export type ModelTask =
  | "detect" | "search" | "face" | "voice-asr" | "voice-vad"
  | "upscale" | "restore" | "interpolate" | "depth"
  | "matte-video" | "matte-image" | "segment" | "object-removal";

// Licence : permissive (usage commercial OK) vs NC (non-commercial, add-on optionnel badgé).
type ModelLicense =
  | "MIT" | "Apache-2.0" | "BSD" | "BSD-3-Clause" | "WTFPL"
  | "CC-BY-4.0" | "CC-BY-NC-4.0" | "CC-BY-NC-SA-4.0"
  | "CC-BY" | "OpenRAIL" | "OpenMDW" | "GPL-3.0" | "NC"
  // Stability AI Community : commercial autorisé SOUS un plafond de chiffre d'affaires, avec
  // attribution. Ni permissive, ni purement non commerciale — d'où son propre libellé.
  | "Stability-Community"
  | "bundled" | "unknown";

// Tier : light (bas VRAM, défaut sûr) / balanced (défaut recommandé) / heavy (gros GPU, opt-in).
type ModelTier = "light" | "balanced" | "heavy";

// Type de contenu préféré (pré-réglé par le sélecteur anime/réel/mix). undefined = agnostique.
type ModelContent = "anime" | "real" | "any";

export interface ModelEntry {
  id: string;
  // NOM EXACT du modèle (celui du fichier de poids / dépôt HF du manifeste core), jamais son usage :
  // « Real-ESRGAN AnimeVideo v3 », pas « Anime ». L'usage vit dans `hint`.
  label: string;
  task: ModelTask;
  engine: string;              // moteur/backend logique (real-esrgan, rife, siglip, whisper, sam…)
  license: ModelLicense;
  commercialUse: boolean;      // false ⇒ badge NC, jamais défaut
  sizeBytes: number;           // taille approximative sur disque (octets), pour la barre + total
  tier: ModelTier;
  vramGB: number;              // VRAM approx requise (0 = CPU/négligeable) — grise si GPU trop faible
  content?: ModelContent;
  // Info de CHOIX seulement (usage, licence, contrainte). Absent quand il n'y a rien à dire que le
  // label ne dise déjà — pas de remplissage.
  hint?: string;
  // Défaut recommandé pour sa tâche (au + un `default:true` par (task, content)). Toujours permissif.
  default?: boolean;
  // Inclus dans le socle obligatoire. Seul TransNetV2 porte ce flag : tous les autres modèles sont
  // optionnels, même quand leur module est visible.
  minBase?: boolean;
  // Fourni par un wheel pip / cache de lib (pas de download NetsuRush) → statut dérivé, delete masqué.
  bundled?: boolean;
  // Fourni par une lib mais téléchargé dans un cache au 1er usage (rembg, torch.hub) : supprimable pour
  // libérer le disque, re-fetch AUTO au prochain usage → pas de bouton Télécharger manuel.
  autoFetch?: boolean;
  // Checkpoint à importer depuis le disque (la source officielle ne fournit pas d'URL directe).
  manual?: boolean;
  // Groupe d'exclusivité : ces modèles remplacent le MÊME paquet Python (SAMURAI et SAM2Long sont
  // publiés comme forks de `sam2` et portent son nom de module). Ils ne peuvent donc pas cohabiter :
  // installer l'un désinstalle l'autre. Le catalogue le dit AVANT le clic, et le core l'applique.
  exclusive?: string;
  // Hors sélection courante : variantes, générations antérieures, soumissions de benchmark, moteurs
  // expérimentaux. Masqué tant que le gestionnaire n'est pas en mode avancé. Un catalogue complet
  // noie le choix — chaque tâche n'expose que 2 à 6 modèles qui couvrent des situations DIFFÉRENTES,
  // le reste reste accessible d'un clic. Un modèle `default` n'est JAMAIS avancé.
  advanced?: boolean;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

// Catalogue. Les entrées « à venir » (P2/P3 : Video Depth Anything, SAM, matte, removal) seront
// ajoutées quand leur backend atterrit — le manifeste core doit suivre le même id.
export const MODEL_REGISTRY: ModelEntry[] = [
  // ---- Détection de plans ----
  { id: "transnetv2", label: "TransNetV2", task: "detect", engine: "transnetv2", license: "MIT", commercialUse: true, sizeBytes: 40 * MB, tier: "light", vramGB: 1, hint: "Rapide, sur processeur. Coupes franches ; sensibilité réglée au curseur de précision.", default: true, minBase: true, bundled: true },
  { id: "omnishotcut", label: "OmniShotCut", task: "detect", engine: "omnishotcut", license: "MIT", commercialUse: true, sizeBytes: 164 * MB, tier: "balanced", vramGB: 2, hint: "Le plus fiable sur fondus, volets et transitions progressives. Automatique, GPU." },
  { id: "autoshot", label: "AutoShot", task: "detect", engine: "autoshot", license: "MIT", commercialUse: true, sizeBytes: 57243097, tier: "balanced", vramGB: 2, hint: "Bon sur montages rapides et plans très animés. Seuil réglable en avancé, GPU.", advanced: true },

  // ---- Recherche visuelle ----
  { id: "siglip2-base", label: "SigLIP 2 Base", task: "search", engine: "siglip", license: "Apache-2.0", commercialUse: true, sizeBytes: 400 * MB, tier: "light", vramGB: 2, hint: "768-dim. ⚠️ changer de variante = ré-indexer tout." },
  { id: "siglip2-so400m", label: "SigLIP 2 so400m", task: "search", engine: "siglip", license: "Apache-2.0", commercialUse: true, sizeBytes: 1800 * MB, tier: "balanced", vramGB: 3, hint: "1152-dim, multilingue. ⚠️ changer de variante = ré-indexer tout.", default: true },
  { id: "siglip2-giant", label: "SigLIP 2 Giant", task: "search", engine: "siglip", license: "Apache-2.0", commercialUse: true, sizeBytes: 3600 * MB, tier: "heavy", vramGB: 8, hint: "1536-dim, qualité max. ⚠️ changer de variante = ré-indexer tout.", advanced: true },

  // ---- Recherche par visage (personnages) ----
  { id: "face-real", label: "YuNet + SFace", task: "face", engine: "opencv-face", license: "Apache-2.0", commercialUse: true, sizeBytes: 40 * MB, tier: "light", vramGB: 0, content: "real", hint: "Visages réels : détection + identité. Requis pour les indexer/chercher." },
  { id: "face-anime", label: "imgutils + CCIP", task: "face", engine: "ccip", license: "OpenRAIL", commercialUse: true, sizeBytes: 120 * MB, tier: "light", vramGB: 1, content: "anime", hint: "Visages animés : détection + identité. Poids tirés au 1er usage." },

  // ---- Voix : ASR ---- (push-to-talk : Whisper Small/Medium/Turbo/Large + Parakeet)
  { id: "whisper-small", label: "Whisper Small", task: "voice-asr", engine: "faster-whisper", license: "MIT", commercialUse: true, sizeBytes: 500 * MB, tier: "light", vramGB: 1, hint: "Faible VRAM — dictée courte." },
  { id: "whisper-medium", label: "Whisper Medium", task: "voice-asr", engine: "faster-whisper", license: "MIT", commercialUse: true, sizeBytes: 1500 * MB, tier: "balanced", vramGB: 2, hint: "Compromis vitesse/qualité.", advanced: true },
  { id: "whisper-turbo", label: "Whisper large-v3-turbo", task: "voice-asr", engine: "faster-whisper", license: "MIT", commercialUse: true, sizeBytes: 1600 * MB, tier: "balanced", vramGB: 3, hint: "Timestamps mot fiables.", default: true },
  { id: "whisper-large-v3", label: "Whisper large-v3", task: "voice-asr", engine: "faster-whisper", license: "MIT", commercialUse: true, sizeBytes: 3100 * MB, tier: "heavy", vramGB: 5, hint: "Qualité max, plus lente.", advanced: true },
  { id: "parakeet-v3", label: "Parakeet TDT 0.6b v3", task: "voice-asr", engine: "onnx-asr", license: "MIT", commercialUse: true, sizeBytes: 700 * MB, tier: "balanced", vramGB: 2, hint: "Multilingue, ONNX — alternative rapide à Whisper." },
  { id: "whisperx", label: "WhisperX", task: "voice-asr", engine: "whisperx", license: "BSD", commercialUse: true, sizeBytes: 3100 * MB, tier: "heavy", vramGB: 6, hint: "Alignement précis mot à mot pour les sous-titres SRT/VTT. Moteur non connecté.", advanced: true },
  { id: "canary-1b-v2", label: "NVIDIA Canary-1B-v2", task: "voice-asr", engine: "canary", license: "CC-BY", commercialUse: true, sizeBytes: 4000 * MB, tier: "heavy", vramGB: 6, hint: "25 langues EU. Pas de timestamps mot natifs.", advanced: true },
  // Moteur natif transcribe.cpp (GGUF) — nécessite le binaire transcribe-cli (fourni, voir carte moteur).
  { id: "nemotron-3.5-asr", label: "Nemotron 3.5 ASR Streaming 0.6B", task: "voice-asr", engine: "transcribe-cpp", license: "OpenMDW", commercialUse: true, sizeBytes: 700 * MB, tier: "balanced", vramGB: 2, hint: "40 langues (FR), ponctuation/casse auto. GGUF — binaire transcribe-cli requis.", advanced: true },

  // ---- Voix : VAD ----
  { id: "silero-vad", label: "Silero VAD v5", task: "voice-vad", engine: "silero", license: "MIT", commercialUse: true, sizeBytes: 2 * MB, tier: "light", vramGB: 0, hint: "Repère les passages parlés pour démarrer et arrêter la dictée. Rapide sur processeur.", default: true, bundled: true },

  // ---- Upscale — sélection courante : un modèle par situation (anime rapide, anime vidéo, réel,
  //      débruitage intégré, qualité maximale). Le reste du catalogue est en avancé. ----
  { id: "anime", label: "Real-ESRGAN AnimeVideo v3", task: "upscale", engine: "real-esrgan", license: "BSD-3-Clause", commercialUse: true, sizeBytes: 18 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime vidéo, 4×.", default: true },
  { id: "general", label: "Real-ESRGAN x4plus", task: "upscale", engine: "real-esrgan", license: "BSD-3-Clause", commercialUse: true, sizeBytes: 64 * MB, tier: "balanced", vramGB: 3, content: "real", hint: "Photo/réel, 4×." },
  { id: "cugan", label: "Real-CUGAN up2x denoise3x", task: "upscale", engine: "spandrel", license: "Apache-2.0", commercialUse: true, sizeBytes: 5 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 2×, débruitage intégré (Bilibili)." },
  { id: "animesr", label: "AnimeSR v2", task: "upscale", engine: "animesr", license: "Apache-2.0", commercialUse: true, sizeBytes: 6 * MB, tier: "light", vramGB: 3, content: "anime", hint: "Anime 4× vidéo — garde une mémoire d'une image à l'autre, donc moins de scintillement." },
  { id: "shufflecugan", label: "sudo ShuffleCUGAN", task: "upscale", engine: "spandrel", license: "MIT", commercialUse: true, sizeBytes: 10 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 2× — le plus rapide." },
  { id: "seedvr2", label: "SeedVR2 3B", task: "upscale", engine: "seedvr2", license: "Apache-2.0", commercialUse: true, sizeBytes: 8 * GB, tier: "heavy", vramGB: 18, content: "any", hint: "Restauration vidéo par diffusion en une étape. Demande beaucoup de VRAM. Moteur non connecté." },

  // ---- Upscale avancé : variantes communautaires (Spandrel/ONNX/TorchScript) ----
  { id: "light", label: "Real-ESRGAN General x4 v3", task: "upscale", engine: "real-esrgan", license: "BSD-3-Clause", commercialUse: true, sizeBytes: 5 * MB, tier: "light", vramGB: 1, content: "any", hint: "Polyvalent, 4×, débruitage réglable.", advanced: true },
  { id: "fallin", label: "Fallin Soft", task: "upscale", engine: "spandrel", license: "MIT", commercialUse: true, sizeBytes: 12 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 2× doux, anti-artefacts.", advanced: true },
  { id: "fallin_strong", label: "Fallin Strong", task: "upscale", engine: "spandrel", license: "MIT", commercialUse: true, sizeBytes: 12 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 2× net, traits marqués.", advanced: true },
  { id: "adore", label: "Adore", task: "upscale", engine: "spandrel", license: "MIT", commercialUse: true, sizeBytes: 12 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 2× rapide, image propre.", advanced: true },
  { id: "ld_anime", label: "LD-Anime Compact 2x", task: "upscale", engine: "spandrel", license: "CC-BY-NC-SA-4.0", commercialUse: false, sizeBytes: 5 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Vieux DVD/VHS abîmés : bruit, halos, artefacts et bavures de couleur.", advanced: true },
  { id: "shufflespan", label: "sudo Shuffle SPAN 10.5M", task: "upscale", engine: "onnx", license: "MIT", commercialUse: true, sizeBytes: 4 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 2× — ONNX, traité par fenêtres 1080p.", advanced: true },
  { id: "aniscale2", label: "AniScale-2 Compact", task: "upscale", engine: "spandrel", license: "CC-BY-NC-4.0", commercialUse: false, sizeBytes: 3 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 2× compact : restauration de compression WEB/DVD et raffinement des traits.", advanced: true },
  { id: "open-proteus", label: "OpenProteus Compact", task: "upscale", engine: "spandrel", license: "unknown", commercialUse: false, sizeBytes: 3 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 2× compact.", advanced: true },
  { id: "rtmosr", label: "umzi Anime RTMoSR", task: "upscale", engine: "torchscript", license: "unknown", commercialUse: false, sizeBytes: 12 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 2× — traits fins préservés.", advanced: true },
  { id: "saryn", label: "Saryn V1 Lite", task: "upscale", engine: "community", license: "MIT", commercialUse: true, sizeBytes: 11 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 2× — léger et rapide.", advanced: true },
  { id: "figsr", label: "FIGSR 2x", task: "upscale", engine: "community", license: "MIT", commercialUse: true, sizeBytes: 8 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 2× — reconstruction fréquentielle (FFT).", advanced: true },
  { id: "smosr", label: "SMoSR v1 2x", task: "upscale", engine: "community", license: "MIT", commercialUse: true, sizeBytes: 22 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 2× — mélange d'experts, traits nets.", advanced: true },
  { id: "span", label: "ModernSpanimation V2", task: "upscale", engine: "spandrel", license: "unknown", commercialUse: false, sizeBytes: 9 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 2× SPAN.", advanced: true },

  // ---- NTIRE 2026 Efficient SR (MIT) — TOUS en avancé : ce sont des soumissions de benchmark ×4
  //      sur dégradation bicubique propre. Elles ne corrigent ni bruit ni compression et n'ont aucun
  //      retour d'usage vidéo ; les proposer au même rang que Real-ESRGAN induirait en erreur. ----
  { id: "ntire-span", label: "SPAN", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 1 * MB, tier: "light", vramGB: 2, content: "real", hint: "Images réelles propres en 4×. Modèle de référence, équilibré.", advanced: true },
  { id: "ntire-pds", label: "PDS", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 1 * MB, tier: "light", vramGB: 2, content: "real", hint: "Images réelles propres en 4×. Rapide et très léger.", advanced: true },
  { id: "ntire-zenosr", label: "ZenoSR", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 1 * MB, tier: "light", vramGB: 2, content: "real", hint: "Images réelles propres en 4×. Très peu de paramètres, mais plus lent.", advanced: true },
  { id: "ntire-haesr", label: "HAESR", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 3 * MB, tier: "light", vramGB: 3, content: "real", hint: "Images réelles propres en 4×. Le plus fidèle du lot, mais lent.", advanced: true },
  { id: "ntire-rfdn-span", label: "RFDN-SPAN", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 3 * MB, tier: "light", vramGB: 3, content: "real", hint: "Images réelles propres en 4×. Plus lourd que SPAN, sans gain net.", advanced: true },
  { id: "ntire-hfenet", label: "HFENet", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 1 * MB, tier: "light", vramGB: 2, content: "real", hint: "Images réelles propres en 4×. Préserve bien les détails, calcul plus lent.", advanced: true },
  { id: "ntire-vscinet", label: "VSCINet", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 1 * MB, tier: "light", vramGB: 2, content: "real", hint: "Images réelles propres en 4×. Très compact, mais lent.", advanced: true },
  { id: "ntire-dscf", label: "DSCF-Fused", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 1 * MB, tier: "light", vramGB: 2, content: "real", hint: "Images réelles propres en 4×. Proche de SPAN, un peu plus rapide.", advanced: true },
  { id: "ntire-pkdsr", label: "PKDSR", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 1 * MB, tier: "light", vramGB: 2, content: "real", hint: "Images réelles propres en 4×. Rapide, avec un réseau allégé.", advanced: true },
  { id: "ntire-amcanet", label: "AMCANet", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 1 * MB, tier: "light", vramGB: 2, content: "real", hint: "Images réelles propres en 4×. Compact, avec un bon niveau de détail.", advanced: true },
  { id: "ntire-disp", label: "DISP", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 1 * MB, tier: "light", vramGB: 2, content: "real", hint: "Images réelles propres en 4×. Le plus rapide parmi les modèles testés.", advanced: true },
  { id: "ntire-bviesr", label: "BVI-SRF", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 1 * MB, tier: "light", vramGB: 2, content: "real", hint: "Images réelles propres en 4×. Modèle compact orienté efficacité.", advanced: true },
  { id: "ntire-errn2", label: "ERRN2", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 1 * MB, tier: "light", vramGB: 2, content: "real", hint: "Images réelles propres en 4×. Équilibre simple entre vitesse et détail.", advanced: true },
  { id: "ntire-safmn", label: "SAFMN-Deep15", task: "upscale", engine: "ntire", license: "MIT", commercialUse: true, sizeBytes: 1 * MB, tier: "light", vramGB: 2, content: "real", hint: "Images réelles propres en 4×. Réseau profond, nettement plus lent.", advanced: true },

  // ---- RTX Video Super Resolution : UNE seule entrée. Le CLI (MIT) et les bibliothèques NVIDIA
  //      forment une fonctionnalité indivisible — n'en avoir qu'une moitié ne produit rien, donc les
  //      exposer séparément ne proposait pas un choix, seulement deux façons d'échouer. ----
  { id: "rtx-video", label: "NVIDIA RTX Video Super Resolution", task: "upscale", engine: "rtx", license: "MIT", commercialUse: true, sizeBytes: 42 * MB, tier: "light", vramGB: 2, content: "any", hint: "Agrandissement temps réel 2× sur GPU NVIDIA. Installe le moteur et les bibliothèques NVIDIA d'un seul tenant.", advanced: true },

  // ---- Restauration 1× (même moteur que l'upscale, sans agrandissement) ----
  { id: "tas-anime1080fixer", label: "Anime1080Fixer", task: "restore", engine: "spandrel", license: "unknown", commercialUse: false, sizeBytes: 1 * MB, tier: "light", vramGB: 1, content: "anime", hint: "Anime 1× — défauts d'encodage et détails fins." },
  { id: "tas-deh264-real", label: "DeH264 Real-PLKSR", task: "restore", engine: "spandrel", license: "CC-BY-4.0", commercialUse: true, sizeBytes: 29 * MB, tier: "light", vramGB: 2, content: "real", hint: "Réel 1× — artefacts H.264.", default: true },
  { id: "tas-scunet", label: "SCUNet Color Real PSNR", task: "restore", engine: "spandrel", license: "Apache-2.0", commercialUse: true, sizeBytes: 69 * MB, tier: "balanced", vramGB: 3, hint: "Réel 1× — débruitage photographique." },
  { id: "tas-nafnet", label: "NAFNet GoPro width64", task: "restore", engine: "spandrel", license: "MIT", commercialUse: true, sizeBytes: 259 * MB, tier: "balanced", vramGB: 4, hint: "Réel 1× — défloutage de mouvement." },
  { id: "tas-dpir", label: "DRUNet Deblocking Color", task: "restore", engine: "spandrel", license: "MIT", commercialUse: true, sizeBytes: 125 * MB, tier: "balanced", vramGB: 3, hint: "1× — déblocage de compression.", advanced: true },
  { id: "tas-real-plksr", label: "Real-PLKSR DeJPEG", task: "restore", engine: "spandrel", license: "CC-BY-4.0", commercialUse: true, sizeBytes: 29 * MB, tier: "light", vramGB: 2, hint: "1× — artefacts JPEG et ringing.", advanced: true },
  { id: "tas-deh264-span", label: "DeH264 SPAN", task: "restore", engine: "spandrel", license: "unknown", commercialUse: false, sizeBytes: 10 * MB, tier: "light", vramGB: 2, content: "anime", hint: "Anime 1× — blocs et bavures H.264.", advanced: true },
  { id: "tas-hurrdeblur", label: "HurrDeblur SuperUltraCompact", task: "restore", engine: "spandrel", license: "WTFPL", commercialUse: true, sizeBytes: 1 * MB, tier: "light", vramGB: 1, hint: "1× — défloutage compact et rapide.", advanced: true },
  { id: "tas-dehalo", label: "DeHalo v1 Compact", task: "restore", engine: "spandrel", license: "WTFPL", commercialUse: true, sizeBytes: 5 * MB, tier: "light", vramGB: 2, hint: "1× — halos autour des contours.", advanced: true },

  // ---- Interpolation — sélection courante : la génération RIFE recommandée, sa variante légère, et
  //      le moteur à flot optique pour les grands mouvements. Les générations antérieures (4.15→4.22,
  //      runtime ncnn, DRBA) restent en avancé : ce sont des historiques, pas des situations. ----
  { id: "tas-rife4.25", label: "RIFE 4.25", task: "interpolate", engine: "rife-torch", license: "MIT", commercialUse: true, sizeBytes: 22 * MB, tier: "balanced", vramGB: 3, hint: "Recommandé sur la plupart des vidéos, meilleur sur l’anime.", default: true },
  { id: "tas-rife4.25-lite", label: "RIFE 4.25 Lite", task: "interpolate", engine: "rife-torch", license: "MIT", commercialUse: true, sizeBytes: 22 * MB, tier: "light", vramGB: 2, hint: "Variante légère de la 4.25, plus rapide." },
  { id: "tas-gmfss", label: "GMFSS Fortuna Union", task: "interpolate", engine: "gmfss", license: "MIT", commercialUse: true, sizeBytes: 230 * MB, tier: "heavy", vramGB: 6, hint: "Flot optique + fusion — plus lent que RIFE, meilleur sur les grands mouvements." },

  { id: "rife-ncnn-vulkan", label: "RIFE ncnn Vulkan 1.2.1", task: "interpolate", engine: "rife", license: "MIT", commercialUse: true, sizeBytes: 447 * MB, tier: "light", vramGB: 2, hint: "Runtime Vulkan partagé. Inclut RIFE v4.6, v4, Anime, HD et UHD.", advanced: true },
  { id: "tas-rife4.25-heavy", label: "RIFE 4.25 Heavy", task: "interpolate", engine: "rife-torch", license: "MIT", commercialUse: true, sizeBytes: 83 * MB, tier: "heavy", vramGB: 5, hint: "Variante lourde de la 4.25, plus exigeante en mémoire.", advanced: true },
  { id: "tas-rife4.22", label: "RIFE 4.22", task: "interpolate", engine: "rife-torch", license: "MIT", commercialUse: true, sizeBytes: 36 * MB, tier: "balanced", vramGB: 3, hint: "Génération précédant la série 4.25.", advanced: true },
  { id: "tas-rife4.22-lite", label: "RIFE 4.22 Lite", task: "interpolate", engine: "rife-torch", license: "MIT", commercialUse: true, sizeBytes: 19 * MB, tier: "light", vramGB: 2, hint: "Même usage que la 4.22, avec moins de calcul.", advanced: true },
  { id: "tas-rife4.21", label: "RIFE 4.21", task: "interpolate", engine: "rife-torch", license: "MIT", commercialUse: true, sizeBytes: 36 * MB, tier: "balanced", vramGB: 3, hint: "Généraliste — ralentis et hausse de fréquence.", advanced: true },
  { id: "tas-rife4.20", label: "RIFE 4.20", task: "interpolate", engine: "rife-torch", license: "MIT", commercialUse: true, sizeBytes: 59 * MB, tier: "balanced", vramGB: 3, hint: "Généraliste, plus lourde que les 4.15 à 4.18.", advanced: true },
  { id: "tas-rife4.18", label: "RIFE 4.18", task: "interpolate", engine: "rife-torch", license: "MIT", commercialUse: true, sizeBytes: 21 * MB, tier: "light", vramGB: 2, hint: "Généraliste pour augmenter le nombre d’images.", advanced: true },
  { id: "tas-rife4.17", label: "RIFE 4.17", task: "interpolate", engine: "rife-torch", license: "MIT", commercialUse: true, sizeBytes: 21 * MB, tier: "light", vramGB: 2, hint: "Préserve mieux les textures en mouvement.", advanced: true },
  { id: "tas-rife4.16-lite", label: "RIFE 4.16 Lite", task: "interpolate", engine: "rife-torch", license: "MIT", commercialUse: true, sizeBytes: 11 * MB, tier: "light", vramGB: 2, hint: "Interpolation légère, temps de calcul réduit.", advanced: true },
  { id: "tas-rife4.15", label: "RIFE 4.15", task: "interpolate", engine: "rife-torch", license: "MIT", commercialUse: true, sizeBytes: 21 * MB, tier: "light", vramGB: 2, hint: "Version standard 4.15.", advanced: true },
  { id: "tas-rife4.15-lite", label: "RIFE 4.15 Lite", task: "interpolate", engine: "rife-torch", license: "MIT", commercialUse: true, sizeBytes: 11 * MB, tier: "light", vramGB: 2, hint: "Variante légère de la 4.15 : moins de calcul.", advanced: true },
  { id: "tas-distildrba", label: "DistillDRBA v1", task: "interpolate", engine: "drba", license: "MIT", commercialUse: true, sizeBytes: 23 * MB, tier: "balanced", vramGB: 3, hint: "Estimation guidée par l'image voisine — contexte exact au facteur 2.", advanced: true },
  { id: "tas-distildrba-lite", label: "DistillDRBA v2 Lite", task: "interpolate", engine: "drba", license: "MIT", commercialUse: true, sizeBytes: 21 * MB, tier: "light", vramGB: 2, hint: "Même principe que la v1, avec moins de calcul.", advanced: true },

  // ---- Profondeur — sélection courante : deux familles, deux tailles. `Video Depth Anything` calcule
  //      une profondeur STABLE dans le temps (une vidéo ne scintille pas), `Depth Anything 3` donne la
  //      carte la plus détaillée image par image. Tout le reste (générations antérieures, variantes
  //      métriques, DPT/GLPN/ZoeDepth) est en avancé. ----
  { id: "video-depth-anything-small", label: "Video Depth Anything Small", task: "depth", engine: "video-depth-anything", license: "Apache-2.0", commercialUse: true, sizeBytes: 120 * MB, tier: "balanced", vramGB: 3, hint: "Vidéo — cohérence temporelle entre images, la plus rapide.", default: true },
  { id: "video-depth-anything-large", label: "Video Depth Anything Large", task: "depth", engine: "video-depth-anything", license: "NC", commercialUse: false, sizeBytes: 1400 * MB, tier: "heavy", vramGB: 6, hint: "Vidéo — cohérence temporelle, qualité max." },
  { id: "da3-small", label: "Depth Anything 3 Small", task: "depth", engine: "da3", license: "Apache-2.0", commercialUse: true, sizeBytes: 100 * MB, tier: "light", vramGB: 2, hint: "Image — rapide, calculée image par image." },
  { id: "da3-large", label: "Depth Anything 3 Large", task: "depth", engine: "da3", license: "Apache-2.0", commercialUse: true, sizeBytes: 1400 * MB, tier: "heavy", vramGB: 6, hint: "Image — carte la plus détaillée, calculée image par image." },

  { id: "video-depth-anything-base", label: "Video Depth Anything Base", task: "depth", engine: "video-depth-anything", license: "NC", commercialUse: false, sizeBytes: 420 * MB, tier: "balanced", vramGB: 4, hint: "Cohérence temporelle, détail intermédiaire.", advanced: true },
  { id: "video-depth-anything-metric-small", label: "Metric Video Depth Anything Small", task: "depth", engine: "video-depth-anything", license: "NC", commercialUse: false, sizeBytes: 120 * MB, tier: "balanced", vramGB: 3, hint: "Distances absolues.", advanced: true },
  { id: "video-depth-anything-metric-base", label: "Metric Video Depth Anything Base", task: "depth", engine: "video-depth-anything", license: "NC", commercialUse: false, sizeBytes: 420 * MB, tier: "balanced", vramGB: 4, hint: "Distances absolues, détail intermédiaire.", advanced: true },
  { id: "video-depth-anything-metric-large", label: "Metric Video Depth Anything Large", task: "depth", engine: "video-depth-anything", license: "NC", commercialUse: false, sizeBytes: 1400 * MB, tier: "heavy", vramGB: 6, hint: "Distances absolues, qualité max.", advanced: true },
  { id: "distill-any-depth-small", label: "Distill Any Depth Small", task: "depth", engine: "distill-any-depth", license: "MIT", commercialUse: true, sizeBytes: 100 * MB, tier: "light", vramGB: 2, hint: "Plus net que Depth Anything V2 Small, même vitesse.", advanced: true },
  { id: "distill-any-depth-base", label: "Distill Any Depth Base", task: "depth", engine: "distill-any-depth", license: "MIT", commercialUse: true, sizeBytes: 390 * MB, tier: "balanced", vramGB: 3, hint: "Compromis entre Small et Large, calculée image par image.", advanced: true },
  { id: "distill-any-depth-large", label: "Distill Any Depth Large", task: "depth", engine: "distill-any-depth", license: "MIT", commercialUse: true, sizeBytes: 1400 * MB, tier: "heavy", vramGB: 6, hint: "Depth map très détaillée, calculée image par image.", advanced: true },
  { id: "depth-anything-v2-small", label: "Depth Anything V2 Small", task: "depth", engine: "depth-anything", license: "Apache-2.0", commercialUse: true, sizeBytes: 100 * MB, tier: "light", vramGB: 2, hint: "Rapide, par image.", advanced: true },
  { id: "depth-anything-v2-base", label: "Depth Anything V2 Base", task: "depth", engine: "depth-anything", license: "NC", commercialUse: false, sizeBytes: 390 * MB, tier: "balanced", vramGB: 3, hint: "Meilleur détail que Small.", advanced: true },
  { id: "depth-anything-v2-large", label: "Depth Anything V2 Large", task: "depth", engine: "depth-anything", license: "NC", commercialUse: false, sizeBytes: 1400 * MB, tier: "heavy", vramGB: 6, hint: "Haute qualité par image.", advanced: true },
  { id: "depth-anything-v1-small", label: "Depth Anything V1 Small", task: "depth", engine: "depth-anything", license: "Apache-2.0", commercialUse: true, sizeBytes: 100 * MB, tier: "light", vramGB: 2, hint: "Génération précédente — rapide, permissive.", advanced: true },
  { id: "depth-anything-v1-base", label: "Depth Anything V1 Base", task: "depth", engine: "depth-anything", license: "Apache-2.0", commercialUse: true, sizeBytes: 390 * MB, tier: "balanced", vramGB: 3, hint: "Génération précédente, format Base.", advanced: true },
  { id: "depth-anything-v1-large", label: "Depth Anything V1 Large", task: "depth", engine: "depth-anything", license: "Apache-2.0", commercialUse: true, sizeBytes: 1340 * MB, tier: "heavy", vramGB: 5, hint: "Génération précédente, format Large.", advanced: true },
  { id: "da3-base", label: "Depth Anything 3 Base", task: "depth", engine: "da3", license: "Apache-2.0", commercialUse: true, sizeBytes: 390 * MB, tier: "balanced", vramGB: 3, hint: "Compromis qualité/vitesse.", advanced: true },
  { id: "da3-metric-large", label: "Depth Anything 3 Metric Large", task: "depth", engine: "da3", license: "Apache-2.0", commercialUse: true, sizeBytes: 1400 * MB, tier: "heavy", vramGB: 6, hint: "Distances absolues.", advanced: true },
  { id: "da3-mono-large", label: "Depth Anything 3 Mono Large", task: "depth", engine: "da3", license: "Apache-2.0", commercialUse: true, sizeBytes: 1400 * MB, tier: "heavy", vramGB: 6, hint: "Monoculaire dédié.", advanced: true },
  { id: "da3-giant", label: "Depth Anything 3 Giant", task: "depth", engine: "da3", license: "NC", commercialUse: false, sizeBytes: 5 * GB, tier: "heavy", vramGB: 12, hint: "Qualité max — variante non-métrique.", advanced: true },
  { id: "depth-pro", label: "Depth Pro", task: "depth", engine: "depth-pro", license: "NC", commercialUse: false, sizeBytes: 1900 * MB, tier: "balanced", vramGB: 4, content: "real", hint: "Distances absolues, contours nets (Apple).", advanced: true },
  { id: "dpt-swinv2-tiny", label: "DPT SwinV2 Tiny", task: "depth", engine: "dpt", license: "MIT", commercialUse: true, sizeBytes: 164 * MB, tier: "light", vramGB: 2, hint: "Le plus léger du catalogue. 256px.", advanced: true },
  { id: "dpt-hybrid-midas", label: "DPT Hybrid MiDaS", task: "depth", engine: "dpt", license: "Apache-2.0", commercialUse: true, sizeBytes: 490 * MB, tier: "balanced", vramGB: 3, hint: "Classique robuste.", advanced: true },
  { id: "dpt-beit-base", label: "DPT BEiT Base", task: "depth", engine: "dpt", license: "MIT", commercialUse: true, sizeBytes: 443 * MB, tier: "balanced", vramGB: 3, hint: "384px.", advanced: true },
  { id: "dpt-swinv2-large", label: "DPT SwinV2 Large", task: "depth", engine: "dpt", license: "MIT", commercialUse: true, sizeBytes: 848 * MB, tier: "heavy", vramGB: 5, hint: "384px.", advanced: true },
  { id: "dpt-beit-large", label: "DPT BEiT Large", task: "depth", engine: "dpt", license: "MIT", commercialUse: true, sizeBytes: 1376 * MB, tier: "heavy", vramGB: 6, hint: "512px — qualité max de la famille DPT.", advanced: true },
  { id: "dpt-large", label: "DPT Large", task: "depth", engine: "dpt", license: "Apache-2.0", commercialUse: true, sizeBytes: 1300 * MB, tier: "heavy", vramGB: 5, hint: "Profondeur relative à partir d’une seule image. Robuste sur des scènes variées.", advanced: true },
  { id: "glpn-kitti", label: "GLPN KITTI", task: "depth", engine: "glpn", license: "Apache-2.0", commercialUse: true, sizeBytes: 245 * MB, tier: "light", vramGB: 2, hint: "Entraîné extérieur (KITTI). Très léger.", advanced: true },
  { id: "glpn-nyu", label: "GLPN NYU", task: "depth", engine: "glpn", license: "Apache-2.0", commercialUse: true, sizeBytes: 490 * MB, tier: "light", vramGB: 2, hint: "Entraîné intérieur (NYU). Léger.", advanced: true },
  { id: "zoedepth-nyu-kitti", label: "ZoeDepth", task: "depth", engine: "zoedepth", license: "MIT", commercialUse: true, sizeBytes: 1380 * MB, tier: "heavy", vramGB: 5, hint: "Distances absolues, intérieur + extérieur.", advanced: true },


  // ---- Matte VIDÉO (cohérence temporelle) ----
  { id: "matanyone", label: "MatAnyone", task: "matte-video", engine: "matanyone", license: "NC", commercialUse: false, sizeBytes: 141 * MB, tier: "balanced", vramGB: 6, hint: "Suivi par mémoire — cheveux et bords fins." },
  { id: "matanyone2", label: "MatAnyone 2", task: "matte-video", engine: "matanyone2", license: "NC", commercialUse: false, sizeBytes: 282 * MB, tier: "balanced", vramGB: 6, hint: "Détails fins et robustesse améliorée par rapport à la v1." },
  // Licence Stability AI Community (usage commercial plafonné en chiffre d'affaires, attribution
  // exigée) : ce n'est pas permissif, donc `commercialUse: false` comme les autres NC — mieux vaut
  // un badge trop prudent qu'un utilisateur qui livre sans savoir. Les 4,5 Go = UNet affiné + VAE
  // temporel de SVD ; il traite par lots au lieu de propager une mémoire, donc il demande plus de
  // VRAM que MatAnyone mais ne dérive pas sur un plan long.
  { id: "videomama", label: "VideoMaMa", task: "matte-video", engine: "videomama", license: "Stability-Community", commercialUse: false, sizeBytes: 4500 * MB, tier: "heavy", vramGB: 10, hint: "Diffusion par lots — bords très fins, plus lent et plus gourmand." },
  // RVM reste le DÉFAUT permissif de la tâche (invariant NC en tête de fichier) même en avancé : son
  // moteur est un scaffold, le proposer au premier rang promettrait un résultat qu'il ne rend pas.
  { id: "rvm", label: "Robust Video Matting", task: "matte-video", engine: "rvm", license: "MIT", commercialUse: true, sizeBytes: 60 * MB, tier: "light", vramGB: 2, content: "real", hint: "Temps réel, cohérence temporelle.", default: true, autoFetch: true, advanced: true },
  // SAM2Matting = matte vidéo qualité MAIS licence NON vérifiée (dépôt non public) → badgé NC par prudence.
  { id: "sam2matting", label: "SAM2Matting", task: "matte-video", engine: "sam2matting", license: "unknown", commercialUse: false, sizeBytes: 900 * MB, tier: "heavy", vramGB: 8, hint: "Matte vidéo expérimental.", advanced: true },

  // ---- Détourage (image et vidéo, calculé par image) ----
  { id: "birefnet", label: "BiRefNet", task: "matte-image", engine: "birefnet", license: "MIT", commercialUse: true, sizeBytes: 950 * MB, tier: "balanced", vramGB: 4, content: "real", hint: "Haute qualité, bords fins.", default: true },
  { id: "lucida", label: "Lucida", task: "matte-image", engine: "lucida", license: "MIT", commercialUse: true, sizeBytes: 884_975_803, tier: "balanced", vramGB: 6, content: "any", hint: "Détourage des transparences, détails fins, textes et effets lumineux. Alpha doux à 1024 px." },
  { id: "ben2", label: "BEN2", task: "matte-image", engine: "ben2", license: "MIT", commercialUse: true, sizeBytes: 220 * MB, tier: "balanced", vramGB: 3, content: "real", hint: "4K, cheveux/bords très fins." },

  // ---- Segmentation interactive (Roto Studio) ----
  // Libellés = nom publié par le DÉPÔT qui livre le modèle, même quand il ne fait que reprendre les
  // poids d'un autre (SAMURAI et SAM2Long tournent sur les checkpoints SAM 2.1).
  { id: "sam3.1", label: "SAM 3.1", task: "segment", engine: "sam3", license: "NC", commercialUse: false, sizeBytes: 3_502_755_717, tier: "heavy", vramGB: 12, hint: "Génération la plus récente, nettement meilleure que SAM 2.1 sur les objets qui se croisent ou disparaissent. GPU NVIDIA obligatoire.", default: true },
  { id: "sam2.1-large", label: "SAM 2.1 Hiera Large", task: "segment", engine: "sam", license: "Apache-2.0", commercialUse: true, sizeBytes: 900 * MB, tier: "heavy", vramGB: 10, hint: "Meilleure qualité de masque, plus de VRAM." },
  { id: "sam2.1", label: "SAM 2.1 Hiera Base+", task: "segment", engine: "sam", license: "Apache-2.0", commercialUse: true, sizeBytes: 350 * MB, tier: "balanced", vramGB: 5, hint: "Repli rapide, bas VRAM." },
  { id: "samurai", label: "SAMURAI", task: "segment", engine: "sam", license: "Apache-2.0", commercialUse: true, sizeBytes: 12 * MB, tier: "balanced", vramGB: 5, hint: "Tient l'objet quand il passe derrière autre chose : mémoire guidée par le mouvement. Tourne sur les poids SAM 2.1 déjà installés.", exclusive: "sam2-package", advanced: true },
  { id: "sam2long", label: "SAM2Long", task: "segment", engine: "sam", license: "CC-BY-NC-4.0", commercialUse: false, sizeBytes: 12 * MB, tier: "balanced", vramGB: 5, hint: "Pour les plans longs : garde plusieurs pistes en parallèle et élague les mauvaises, donc l'erreur ne s'accumule pas. Tourne sur les poids SAM 2.1 déjà installés.", exclusive: "sam2-package", advanced: true },
  { id: "edgetam", label: "EdgeTAM", task: "segment", engine: "sam", license: "Apache-2.0", commercialUse: true, sizeBytes: 56_116_523, tier: "light", vramGB: 2, hint: "Le plus léger : 56 Mo, ~20× plus rapide que SAM 2 sur petite carte. Masques moins fins.", advanced: true },
  { id: "sam2.1-small", label: "SAM 2.1 Hiera Small", task: "segment", engine: "sam", license: "Apache-2.0", commercialUse: true, sizeBytes: 184 * MB, tier: "light", vramGB: 3, hint: "Variante intermédiaire entre EdgeTAM et Base+.", advanced: true },
  { id: "sam2.1-tiny", label: "SAM 2.1 Hiera Tiny", task: "segment", engine: "sam", license: "Apache-2.0", commercialUse: true, sizeBytes: 156 * MB, tier: "light", vramGB: 2, hint: "La plus petite variante SAM 2.1.", advanced: true },

  // ---- Suppression d'objet ----
  // ⚠️ Plus AUCUN moteur permissif depuis le retrait de Big LaMa : la tâche entière est non-commerciale
  // (MiniMax câblé, PowerPaint/DiffuEraser à câbler). C'est la seule exception à l'invariant NC.
  { id: "minimax-remover", label: "MiniMax-Remover", task: "object-removal", engine: "minimax", license: "NC", commercialUse: false, sizeBytes: 5 * GB, tier: "balanced", vramGB: 6, hint: "Diffusion ~6 pas, cohérente dans le temps — plus propre sur fond animé.", default: true },
  { id: "powerpaint", label: "PowerPaint v2", task: "object-removal", engine: "powerpaint", license: "Apache-2.0", commercialUse: true, sizeBytes: 5 * GB, tier: "heavy", vramGB: 8, content: "any", hint: "Inpainting génératif IMAGE (SD), piloté par masque. Moteur à câbler.", advanced: true },
  { id: "diffueraser", label: "DiffuEraser", task: "object-removal", engine: "diffueraser", license: "NC", commercialUse: false, sizeBytes: 5 * GB, tier: "heavy", vramGB: 16, hint: "Inpainting vidéo haute qualité. Moteur à câbler.", advanced: true },
];

// --- Sélecteurs utilitaires (consommés par le gestionnaire + l'install) ---

export const TASK_LABELS: Record<ModelTask, string> = {
  detect: "Détection de plans",
  search: "Recherche visuelle",
  face: "Recherche par visage",
  "voice-asr": "Voix — transcription",
  "voice-vad": "Voix — silences",
  upscale: "Upscale",
  restore: "Restauration",
  interpolate: "Interpolation",
  depth: "Profondeur",
  "matte-video": "Matte vidéo",
  "matte-image": "Détourage",
  segment: "Segmentation (roto)",
  "object-removal": "Suppression d'objet",
};

// Ordre d'affichage des groupes.
export const TASK_ORDER: ModelTask[] = [
  "upscale", "restore", "interpolate", "depth", "matte-video", "matte-image", "segment", "object-removal",
  "detect", "search", "face", "voice-asr", "voice-vad",
];

export const modelById = (id: string): ModelEntry | undefined => MODEL_REGISTRY.find((m) => m.id === id);
export const modelsForTask = (task: ModelTask): ModelEntry[] => MODEL_REGISTRY.filter((m) => m.task === task);

export const fmtSize = (bytes: number): string =>
  bytes >= GB ? `${(bytes / GB).toFixed(1)} Go` : `${Math.round(bytes / MB)} Mo`;
