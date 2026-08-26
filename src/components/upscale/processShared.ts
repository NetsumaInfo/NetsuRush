import type {
  InterpModel, DepthModel, DepthColor, SegModel, UpscaleCodec, AudioMode,
} from "@/lib/bridge";
import { DEFAULT_PROCESS_EXPORT, type ProcessExportSettings } from "./processExport";
import type { NamingTokens } from "./outputNaming";

// Tables de modèles + valeurs par défaut pour les 3 modes du hub (interpolation / depth / removeBG).
// Façon UP_MODELS d'upscaleShared : id + libellé + indice. `label` = NOM EXACT du modèle (= dépôt du
// manifeste core/models.js), `hint` = usage. Les codecs/audio sont réutilisés tels quels depuis
// upscaleShared (UP_VARIANTS / UP_CODEC_ITEMS) pour interp/depth (qui encodent une vidéo).

// ── Interpolation (RIFE) ────────────────────────────────────────────────────
export const INTERP_MODELS: { id: InterpModel; label: string; hint?: string }[] = [
  // Générations 4.15+ : PyTorch uniquement (aucun binaire ncnn ne les lit). Recommandé = 4.25, en
  // tête comme dans la sélection courante du registre (lib/modelRegistry).
  { id: "tas-rife4.25", label: "RIFE 4.25", hint: "Recommandé sur la plupart des vidéos, meilleur sur l'anime." },
  { id: "tas-rife4.25-lite", label: "RIFE 4.25 Lite", hint: "Même génération que 4.25, moins de calcul." },
  { id: "tas-gmfss", label: "GMFSS Fortuna Union", hint: "Flot optique + fusion — plus lent, meilleur sur les grands mouvements." },
  { id: "rife-v4.6", label: "RIFE v4.6", hint: "Version générale la plus récente incluse par le dépôt officiel." },
  { id: "rife-v4", label: "RIFE v4", hint: "Version générale 4.0, avec interpolation à instant arbitraire." },
  { id: "rife-anime", label: "RIFE Anime", hint: "Variante officielle dédiée aux dessins animés (RIFE 1.8)." },
  { id: "rife-HD", label: "RIFE HD", hint: "Variante officielle HD (RIFE 1.5)." },
  { id: "rife-UHD", label: "RIFE UHD", hint: "Variante officielle UHD (RIFE 1.6)." },
  { id: "tas-rife4.25-heavy", label: "RIFE 4.25 Heavy", hint: "Même génération que 4.25, plus exigeante en mémoire." },
  { id: "tas-rife4.22", label: "RIFE 4.22", hint: "Génération précédant la série 4.25." },
  { id: "tas-rife4.22-lite", label: "RIFE 4.22 Lite", hint: "Même usage que 4.22, moins de calcul." },
  { id: "tas-rife4.21", label: "RIFE 4.21", hint: "Généraliste — ralentis et hausse de fréquence." },
  { id: "tas-rife4.20", label: "RIFE 4.20", hint: "Généraliste, plus lourde que les 4.15 à 4.18." },
  { id: "tas-rife4.18", label: "RIFE 4.18", hint: "Généraliste pour augmenter le nombre d'images." },
  { id: "tas-rife4.17", label: "RIFE 4.17", hint: "Préserve mieux les textures en mouvement." },
  { id: "tas-rife4.16-lite", label: "RIFE 4.16 Lite", hint: "Interpolation légère, temps de calcul réduit." },
  { id: "tas-rife4.15", label: "RIFE 4.15", hint: "Version standard 4.15." },
  { id: "tas-rife4.15-lite", label: "RIFE 4.15 Lite", hint: "Variante légère de la 4.15." },
  { id: "tas-distildrba", label: "DistillDRBA v1", hint: "Estimation guidée par l'image voisine — contexte exact au facteur 2." },
  { id: "tas-distildrba-lite", label: "DistillDRBA v2 Lite", hint: "Même principe que la v1, moins de calcul." },
];

export const INTERP_FACTORS = [2, 3, 4] as const;
type InterpFactor = (typeof INTERP_FACTORS)[number];

// fps cible courants (utilisés quand l'option « fps cible » est activée).
export const INTERP_TARGET_FPS = [24, 25, 30, 48, 50, 60, 72, 90, 120, 144, 165, 240] as const;

// ── Depth (estimation de profondeur) ────────────────────────────────────────
export const DEPTH_MODELS: { id: DepthModel; label: string; hint?: string }[] = [
  // Tête de liste = sélection courante du registre (lib/modelRegistry) : Depth Anything 3 pour l'image,
  // Video Depth Anything pour la stabilité temporelle. Le reste sont des générations antérieures.
  { id: "da3-small", label: "Depth Anything 3 Small", hint: "Image — rapide, calculée image par image." },
  { id: "da3-large", label: "Depth Anything 3 Large", hint: "Image — carte la plus détaillée." },
  { id: "video-depth-anything-small", label: "Video Depth Anything Small", hint: "Vidéo — cohérence temporelle entre images." },
  { id: "video-depth-anything-large", label: "Video Depth Anything Large", hint: "Vidéo — cohérence temporelle, qualité max." },
  { id: "distill-any-depth-small", label: "Distill Any Depth Small", hint: "Plus net que Depth Anything V2 Small, même vitesse." },
  { id: "distill-any-depth-base", label: "Distill Any Depth Base", hint: "Compromis entre Small et Large, calculée image par image." },
  { id: "distill-any-depth-large", label: "Distill Any Depth Large", hint: "Depth map très détaillée, calculée image par image." },
  { id: "depth-anything-v2-small", label: "Depth Anything V2 Small", hint: "Rapide, par image." },
  { id: "depth-anything-v2-base", label: "Depth Anything V2 Base", hint: "Meilleur détail que Small." },
  { id: "depth-anything-v2-large", label: "Depth Anything V2 Large", hint: "Haute qualité par image." },
  { id: "video-depth-anything-base", label: "Video Depth Anything Base", hint: "Cohérence temporelle, détail intermédiaire." },
  { id: "video-depth-anything-metric-small", label: "Metric Video Depth Anything Small", hint: "Distances absolues." },
  { id: "video-depth-anything-metric-base", label: "Metric Video Depth Anything Base", hint: "Distances absolues, détail intermédiaire." },
  { id: "video-depth-anything-metric-large", label: "Metric Video Depth Anything Large", hint: "Distances absolues, qualité max." },
  { id: "depth-anything-v1-small", label: "Depth Anything V1 Small", hint: "Génération précédente — rapide, permissive." },
  { id: "depth-anything-v1-base", label: "Depth Anything V1 Base", hint: "Génération précédente, format Base." },
  { id: "depth-anything-v1-large", label: "Depth Anything V1 Large", hint: "Génération précédente, format Large." },
  { id: "da3-base", label: "Depth Anything 3 Base", hint: "Compromis qualité/vitesse." },
  { id: "da3-metric-large", label: "Depth Anything 3 Metric Large", hint: "Distances absolues." },
  { id: "da3-mono-large", label: "Depth Anything 3 Mono Large", hint: "Monoculaire dédié." },
  { id: "da3-giant", label: "Depth Anything 3 Giant", hint: "Qualité max — variante non-métrique." },
  { id: "dpt-swinv2-tiny", label: "DPT SwinV2 Tiny", hint: "Le plus léger du catalogue. 256px." },
  { id: "dpt-hybrid-midas", label: "DPT Hybrid MiDaS", hint: "Classique robuste." },
  { id: "dpt-beit-base", label: "DPT BEiT Base", hint: "384px." },
  { id: "dpt-swinv2-large", label: "DPT SwinV2 Large", hint: "384px." },
  { id: "dpt-beit-large", label: "DPT BEiT Large", hint: "512px — qualité max de la famille DPT." },
  { id: "dpt-large", label: "DPT Large" },
  { id: "glpn-kitti", label: "GLPN KITTI", hint: "Entraîné extérieur (KITTI). Très léger." },
  { id: "glpn-nyu", label: "GLPN NYU", hint: "Entraîné intérieur (NYU). Léger." },
  { id: "zoedepth-nyu-kitti", label: "ZoeDepth", hint: "Distances absolues, intérieur + extérieur." },
];

export const DEPTH_COLORS: { id: DepthColor; label: string }[] = [
  { id: "gray", label: "Niveaux de gris" },
  { id: "inferno", label: "Inferno" },
  { id: "magma", label: "Magma" },
  { id: "viridis", label: "Viridis" },
];


// ── RemoveBG (détourage / alpha) ────────────────────────────────────────────
export const SEG_MODELS: { id: SegModel; label: string; hint?: string }[] = [
  { id: "birefnet", label: "BiRefNet", hint: "Général, haute qualité, bords fins." },
  { id: "lucida", label: "Lucida", hint: "Transparence, camouflage, texte, glow et illustration. Alpha doux, image par image." },
  { id: "ben2", label: "BEN2", hint: "Image 4K, cheveux/bords très fins." },
  { id: "rvm", label: "Robust Video Matting", hint: "Matte vidéo temps réel, cohérence temporelle." },
];


// ── Réglages par mode ───────────────────────────────────────────────────────
// Noms en `*Settings` (pas `*Opts`) pour ne pas entrer en collision avec les types bridge
// (InterpOpts/DepthOpts/RemoveBgOpts). Codec/audio réutilisent les types bridge UpscaleCodec/AudioMode.
export interface InterpSettings extends ProcessExportSettings {
  model: InterpModel;
  factor: InterpFactor;
  targetFps: number | null;   // null = utiliser le facteur ; sinon fps de sortie cible
  slowmo: boolean;            // garder le fps source → ralenti (au lieu de fluidifier)
  dedup: boolean;            // supprimer les frames mortes (doublons) avant interp → anti-saccade
  codec: UpscaleCodec;
  quality: number;           // CRF x264/x265
  preset: string;            // veryfast..veryslow
  bitDepth: 8 | 10;          // dérivé du profil (compat legacy)
  profile: string;           // profil codec réel (-profile:v)
  audio: AudioMode;
  abr: number;               // débit audio kbps
  audioTrack: number;
}

export interface DepthSettings extends ProcessExportSettings {
  model: DepthModel;
  // La profondeur d'ÉCRITURE (8/16 bits) vit dans le bloc Sortie, partagé par toutes les ops : elle
  // ne veut rien dire tant que la sortie n'est pas une image.
  colormap: DepthColor;
  dedup: boolean;            // ne calculer la depth que sur les frames uniques (accélérateur transverse)
  codec: UpscaleCodec;
  quality: number;
  preset: string;
  bitDepth: 8 | 10;          // dérivé du profil (compat legacy)
  profile: string;           // profil codec réel (-profile:v)
  audio: AudioMode;
  abr: number;
  audioTrack: number;
}

export interface SegSettings extends ProcessExportSettings {
  model: SegModel;
  dedup: boolean;            // ne détourer que les frames uniques (accélérateur transverse)
  despeckle: number;         // intensité 0..30 (aire minimale = intensité²)
  edgeSmoothing: number;     // rayon d'adoucissement du contour
  edgeOffset: number;        // négatif = contracter, positif = étendre
}

export const DEFAULT_INTERP: InterpSettings = {
  ...DEFAULT_PROCESS_EXPORT,
  model: "tas-rife4.25",
  factor: 2,
  targetFps: null,
  slowmo: false,
  dedup: false,
  codec: "hevc_nvenc",   // encode GPU par défaut (rapide)
  quality: 18,
  preset: "slow",
  bitDepth: 8,
  profile: "main",       // HEVC · GPU → Main 8-bit 4:2:0
  audio: "copy",
  abr: 192,
  audioTrack: -1,
};

export const DEFAULT_DEPTH: DepthSettings = {
  ...DEFAULT_PROCESS_EXPORT,
  exportAudioMode: "none",
  model: "da3-small",
  colormap: "gray",
  dedup: false,
  codec: "hevc_nvenc",   // encode GPU par défaut (rapide)
  quality: 14,           // palier « Master » (dégradés de la depth map fragiles)
  preset: "slow",
  bitDepth: 8,
  profile: "main",       // HEVC · GPU → Main 8-bit 4:2:0
  audio: "none",
  abr: 192,
  audioTrack: -1,
};

export const DEFAULT_SEG: SegSettings = {
  ...DEFAULT_PROCESS_EXPORT,
  exportCodec: "prores_4444",
  encoderMode: "cpu",
  exportAudioMode: "none",
  exportContainer: "mov",
  model: "birefnet",
  dedup: false,
  despeckle: 0,
  edgeSmoothing: 0,
  edgeOffset: 0,
};

// Naming tokens of the three other ops (see upscaleTokens for the upscale side).
export const interpTokens = (settings: InterpSettings): NamingTokens =>
  ({ op: settings.slowmo ? "slowmo" : "interp", scale: `${settings.factor}x`, model: settings.model });

export const depthTokens = (settings: DepthSettings): NamingTokens =>
  ({ op: "depth", scale: "", model: settings.model });

export const segTokens = (settings: SegSettings): NamingTokens =>
  ({ op: "alpha", scale: "", model: settings.model });
