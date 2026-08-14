// Typed bridge. Trois transports possibles, même interface NrApi :
//  1. window.nr  — preload Electron (plugin historique dans Resolve)
//  2. core HTTP/SSE — app Tauri standalone (service Node "core"), cf. coreClient.ts
//  3. mock no-op  — vite dev dans un navigateur nu (l'UI rend quand même)

import { makeCoreClient, coreAvailable } from "./coreClient";
import { basename } from "./utils";
import type { SamplingFrames } from "./sampling";
import i18n from "@/i18n";
import type {
  AudioSelect, ExportAudioMode, ExportCodec, ExportContainer, ExportEncoderMode, ExportProfile, ExportSpeed,
} from "@/features/export/profiles";
import type { NotebookMeta, PageMeta, NotebookPage, Database, NotebookKind, NotebookLanguage } from "@/components/notebook/notebookShared";

export interface ResolveInfo {
  connected: boolean;
  project?: string | null;
  timeline?: string | null;
  version?: string | null;
  error?: string | null;
}

export interface Clip {
  name: string;
  path: string;
  duration: string | null;
  fps: string | null;
  resolution: string | null;
  format: string | null;
  bin: string | null;
  // "local" = vidéo importée du disque, hors Media Pool Resolve (timeline indispo).
  source?: "mediapool" | "local";
}

export interface MediaList {
  connected: boolean;
  project?: string | null;
  clips: Clip[];
  // Servi depuis le snapshot projet (hôte fermé) → l'UI reste peuplée hors ligne.
  cached?: boolean;
  error?: string | null;
}

// État du snapshot projet (cache offline) exposé au renderer pour un badge « hors-ligne (cache) ».
export interface SnapshotState {
  project: string | null;
  at: number;
  clips: number;
  timelines: number;
  cuts?: number; // nb de timelines dont les plans sont cachés (ouvrables hors ligne)
}

// Changements Resolve détectés par le poller core (diff de signature) → refetch ciblé côté renderer.
export interface ResolveChange {
  status?: boolean;      // connexion / projet / timeline ouverte
  mediaPool?: boolean;   // clips ajoutés/retirés du Media Pool
  timelines?: boolean;   // timelines créées/supprimées
}

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
}

export interface Scene {
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
  intraLabel?: OmniIntraLabel | null;
  interLabel?: OmniInterLabel | null;
}

export type DetectModel = "transnetv2" | "omnishotcut" | "autoshot";
export type OmniShotMode = "clean_shot" | "default";
export type OmniIntraLabel = "General" | "Dissolve" | "Wipes" | "Push" | "Slide" | "Zoom" | "Fade" | "Doorway";
export type OmniInterLabel = "New_Start" | "Hard_Cut" | "Transition_Source" | "Transition" | "Sudden_Jump";

export interface DetectOptions {
  minSceneFrames?: number;
  omnishotcut?: {
    mode?: OmniShotMode;
    overlapWindowLength?: number;
    intraLabels?: OmniIntraLabel[];
    interLabels?: OmniInterLabel[];
  };
  autoshot?: {
    threshold?: number;
  };
}

// Une plage éditée du Découpage : l'étendue couverte par des plans fusionnés OU retirés, gardée
// « pour toujours » et réappliquée à la réouverture/re-détection (recalage par chevauchement de frames).
export interface CutSpan {
  in: number;
  out: number;
  inFrame?: number;
  outFrame?: number;
}

// Les édits d'un rush pour UN modèle de détection : unions de plans et plans écartés de la découpe.
export interface CutEdits {
  merges: CutSpan[];
  removed: CutSpan[];
}

export interface SceneResult {
  scenes: Scene[];
  duration?: number | null;
  fps?: number | null;
  frames?: number | null;
  threshold?: number | null;
  model?: DetectModel | string | null;
  optionsKey?: string | null;
  cached?: boolean;
  error?: string | null;
}

export interface ExportResult {
  ok: boolean;
  output?: string;
  error?: string;
}

// --- Export piloté par profil : bouton « Télécharger » → profil actif ---
export interface ExportClipInput {
  input: string;   // chemin source
  start: number;   // début (secondes)
  end: number;     // fin (secondes)
  label?: string;
  audioTrack?: number | null; // piste audio à garder (index relatif a:N ; null = auto ffmpeg)
}
export interface ExportClipsOpts {
  clips: ExportClipInput[];
  dir?: string;        // dossier de sortie (per-clip)
  savePath?: string;   // chemin complet (fusion ou clip unique)
  baseName?: string;
  profile: ExportProfile;
  merge?: boolean;     // fusionner en un seul fichier (concat)
  concurrency?: number; // encodes simultanés (défaut auto : remux 4, GPU 3, CPU 2)
  // Identifie le job dans `export:progress` : plusieurs rendus en vol (lot NetsuTalk) ne se
  // volent plus la barre de progression. Absent = ancien comportement (un seul rendu global).
  jobId?: string;
}
export interface ExportClipsResult {
  ok: boolean;
  files?: string[];
  failed?: number;
  error?: string;
}
// Aperçu du nommage : `name` = un plan du lot, `merged` = le fichier fusionné (gabarit résolu sans
// index), `tokens` = les jetons connus du core (source unique du menu « Insérer »).
export interface ExportNamePreview {
  name: string;
  merged: string;
  tokens: string[];
}
// Capacités d'encodage RÉELLES de la machine (sonde ffmpeg côté core). `codecs` = ids d'ExportCodec
// qui encodent vraiment ici ; `ok:false` = sonde indisponible → le renderer ne filtre rien.
export interface ExportCapabilitiesResult {
  ok: boolean;
  codecs: string[];
  cpuCodecs: string[];
  hasGpuEncoder: boolean;
  hwEncoders: string[];
  codecEncoderOptions: Record<string, string[]>;
  error?: string;
}
export interface ExportProgress {
  jobId?: string;
  file?: string;
  done: number;
  total: number;
  pct: number;
  phase: string;
}

// --- Module voix (silences + sous-titres + montage par texte) ---
// Moteurs : ASR rapide (Parakeet v3) / précis (Whisper turbo) ; VAD Silero (NOVA-VAD différé).
export type AsrModel = "whisper-turbo" | "parakeet-v3" | "whisperx" | "canary-1b-v2";
export type VadModel = "silero" | "nova";
// Un mot horodaté (secondes). Unité commune des 4 features (silences/sous-titres/montage/fillers).
export interface VoiceWord {
  start: number;
  end: number;
  word: string;
  conf: number;
  // Marqué « mot de remplissage » (euh/bah…) par le sidecar fillers (P3).
  filler?: boolean;
}
// Hit de recherche dans les transcriptions en cache : `start` = début du 1er mot trouvé (in-point).
export interface TranscriptHit {
  file: string;
  start: number;
  end: number;
  snippet: string;
  matchStart: number; // index du 1er mot trouvé dans le snippet
  matchLen: number;
  duration: number;
  model: string;
}
export interface TranscriptResult {
  ok: boolean;
  words: VoiceWord[];
  text?: string;
  lang?: string;
  duration?: number;
  model?: string;
  cached?: boolean;
  error?: string | null;
}
// Curseurs (millisecondes pour les durées) pilotant Silero VAD.
export interface SilenceParams {
  threshold?: number;      // 0..1, sensibilité de détection de parole
  min_silence_ms?: number; // durée mini d'un silence pour le couper
  min_speech_ms?: number;  // durée mini d'un segment parlé conservé
  pad_ms?: number;         // marge ajoutée AVANT la parole conservée (attaques)
  pad_end_ms?: number;     // marge ajoutée APRÈS (on garde plus d'air en fin de phrase qu'en début)
  snap_ms?: number;        // recale chaque frontière sur le creux d'énergie le plus proche (coupe propre)
  noise_gate?: number;     // 0..1 : écarte les COURTES régions trop faibles pour être de la voix (0 = off)
  nova_confirm?: boolean;  // passe NOVA-VAD : confirme que la parole détectée est bien de la voix (anti-bruit)
  nova_min_conf?: number;  // 0..1, confiance mini « pas de voix » pour écarter une région (défaut 0.6)
}
// Réglages de détection d'hésitations (3 méthodes mélangeables). `sensitivity` 0..1 : plus haut =
// plus agressif (attrape plus, faux positifs barrables). `min_ms` : durée mini d'un son tenu/mot
// traîné. `monotone` 0..1 : tolérance de stabilité du pitch côté audio (haut = accepte plus de
// variation → attrape plus). `lexical`/`prolongation`/`acoustic` : activer/désactiver chaque méthode.
export interface HesitationParams {
  sensitivity: number;
  min_ms: number;
  max_ms?: number;        // durée MAXI d'un son tenu (au-dessus = vrai mot, pas une hésitation)
  monotone?: number;
  lexical?: boolean;      // mots d'hésitation (euh, heu, hmm…)
  prolongation?: boolean; // mots traînés/étirés
  acoustic?: boolean;     // sons tenus détectés au signal
  markers?: boolean;      // tics de langage (du coup, en fait, genre…) — ambigu, OFF par défaut
  extraWords?: string;    // mots perso (séparés par virgule) ajoutés au lexique d'hésitation
  wordTypes?: Record<string, boolean>; // catégories de mots d'hésitation activées (euh/nasal/interj/tics/en)
}
// Mode d'écoute : quel(s) type(s) de coupe la lecture saute. « none » = brut, « all » = tout coupé,
// sinon un seul type → entendre le rendu à la carte (un bouton, choix unique).
export type PreviewMode = "none" | "all" | "silences" | "fillers" | "repeats";
// Une plage temporelle (secondes) : segment de parole ou de silence.
export interface VoiceSpan { start: number; end: number }
// Hésitation détectée acoustiquement (dans un trou inter-mots) : plage + confiance (score 0..1).
export interface FillerSpan { start: number; end: number; conf: number }
export interface SilenceResult {
  ok: boolean;
  speech: VoiceSpan[];
  silence: VoiceSpan[];
  duration?: number;
  model?: string;
  cached?: boolean;
  error?: string | null;
}
export interface VoiceProgress { phase: string; pct: number }
export type SubtitleFormat = "srt" | "vtt";
export interface SubtitleResult { ok: boolean; path?: string; lines?: number; error?: string }

export type UpscaleModel =
  | "anime" | "general" | "light"
  | "fallin" | "fallin_strong" | "adore" | "shufflecugan" | "cugan" | "ld_anime"
  | "aniscale2" | "open-proteus" | "span" | "rtmosr" | "smosr" | "figsr" | "saryn" | "shufflespan" | "animesr"
  | "tas-scunet" | "tas-nafnet" | "tas-dpir" | "tas-real-plksr" | "tas-anime1080fixer"
  | "tas-deh264-real" | "tas-deh264-span" | "tas-hurrdeblur" | "tas-dehalo"
  | "artcnn_r16f96" | "artcnn_r8f64"
  | "ntire-span" | "ntire-pds" | "ntire-zenosr" | "ntire-haesr" | "ntire-rfdn-span"
  | "ntire-hfenet" | "ntire-vscinet" | "ntire-dscf" | "ntire-pkdsr" | "ntire-amcanet"
  | "ntire-disp" | "ntire-bviesr" | "ntire-errn2" | "ntire-safmn";
export type UpscaleCodec =
  | "x264" | "x265"
  | "h264_gpu" | "hevc_gpu"
  | "h264_nvenc" | "h264_amf" | "h264_qsv"
  | "hevc_nvenc" | "hevc_amf" | "hevc_qsv"
  | "prores_proxy" | "prores_lt" | "prores_422" | "prores_hq" | "prores_4444" | "prores_4444xq"
  | "dnxhr_lb" | "dnxhr_sq" | "dnxhr_hq" | "dnxhr_hqx" | "dnxhr_444";
export type AudioMode = "copy" | "aac" | "ac3" | "flac" | "pcm" | "none";

export interface AudioTrack {
  index: number;           // index relatif parmi les pistes audio (a:N)
  codec: string;
  channels: number;
  lang?: string | null;
  title?: string | null;   // titre libre de piste (« Japanese », « VF »…) — 2e signal de langue
  langCode?: string | null; // langue normalisée depuis lang/title (core/audioLang) ; null = non étiquetée
}

// Réglages d'encodage NetsuLab alignés sur les profils d'export généraux.
export interface ProcessExportOpts {
  exportCodec?: string;
  encoderMode?: "gpu" | "nvenc" | "amf" | "qsv" | "cpu";
  speed?: "fast" | "balanced" | "quality" | "max";
  audioMode?: string;
  container?: "mp4" | "mkv" | "mov" | "webm";
}

export interface UpscaleOpts extends ProcessExportOpts {
  input: string;
  model: UpscaleModel;
  scale: 1 | 2 | 4;        // 1 = restauration taille d'origine ; 2/4 = agrandissement
  codec: UpscaleCodec;
  denoise?: number;        // 0..1, modèle léger uniquement (DNI avec la variante débruitée)
  tile?: number;           // 0 = auto ; 256/512/1024 anti-OOM en 4K
  tilePad?: number;        // recouvrement entre tuiles (tile_pad RealESRGAN, défaut 10)
  prePad?: number;         // padding de bord (pre_pad RealESRGAN, défaut 0)
  fp32?: boolean;          // true = précision (plus lent), false = fp16 GPU (défaut)
  cleanupNoise?: number;   // 0..1, nettoyage post-upscale du bruit fin
  cleanupEdges?: number;   // 0..1, réduction post-upscale des halos/contours durs
  quality?: number;        // CRF x264/x265 (bas = meilleure qualité), ignoré ProRes/DNxHR
  preset?: string;         // preset x264/x265 (veryfast..slow)
  bitDepth?: 8 | 10;       // profondeur (dérivée du profil, compat legacy)
  profile?: string;        // profil codec réel (-profile:v) : main/high/high10/high422…
  audio?: AudioMode;       // copier / réencoder (aac, ac3, flac, pcm) / aucune
  abr?: number;            // débit audio kbps (aac/ac3)
  audioTrack?: number;     // piste audio à conserver (index relatif)
  outDir: string;
  whole?: boolean;         // rush entier
  segments?: { in: number; out: number }[];   // plage (1) ou plans sélectionnés (N)
  importBack?: boolean;    // AddItemListToMediaPool des sorties
  baseName?: string;       // nom de base du fichier (sinon dérivé de input)
  outputName?: string;     // nom final choisi par l'utilisateur, sans extension ni suffixe automatique
}

export interface UpscaleResult {
  ok: boolean;
  outputs?: string[];
  imported?: number;
  total?: number;
  failed?: number;
  error?: string | null;
}

// Moteur Turbo : upscale par shader GLSL (ffmpeg libplacebo, GPU temps réel) — pas d'IA.
export type ShaderModel =
  | "artcnn_r16f96" | "artcnn_r8f64"
  | "artcnn_c4f32" | "artcnn_c4f32_ds" | "artcnn_c4f32_dn"
  | "artcnn_c4f16" | "artcnn_c4f16_ds" | "artcnn_c4f16_dn"
  | "anime4k_aa_hq" | "anime4k_bb_hq" | "rtx_vsr" | "lanczos"
  // Valeurs persistées historiques : toujours acceptées par le core, mais retirées du sélecteur.
  | "artcnn_quality" | "anime4k";

export interface UpscaleShaderOpts extends ProcessExportOpts {
  input: string;
  shader: ShaderModel;
  scale: 1 | 2 | 4;
  codec: UpscaleCodec;
  deband?: "none" | "light" | "medium" | "strong";  // anti-aplats (libplacebo deband)
  grain?: number;                                     // grain de débanding (masque les bandes résiduelles)
  sharp?: "soft" | "sharp";                          // noyau de redimensionnement (spline36 / lanczossharp)
  sigmoid?: boolean;                                  // anti-ringing/halos sur agrandissement
  dither?: boolean;                                   // tramage (réduit le banding 8-bit)
  // RTX Video SDK (shader `rtx_vsr`) — ignorés par les shaders libplacebo.
  vsrQuality?: 1 | 2 | 3 | 4;
  hdr?: boolean;                                      // TrueHDR : conversion SDR → HDR10
  hdrContrast?: number;
  hdrSaturation?: number;
  hdrMidGray?: number;
  hdrNits?: number;                                   // luminance crête du master HDR
  quality?: number;
  preset?: string;
  bitDepth?: 8 | 10;                                  // profondeur (dérivée du profil, compat legacy)
  profile?: string;                                   // profil codec réel (-profile:v)
  audio?: AudioMode;
  abr?: number;
  audioTrack?: number;
  outDir: string;
  whole?: boolean;
  segments?: { in: number; out: number }[];
  importBack?: boolean;
  baseName?: string;
  outputName?: string;
  parallel?: boolean;
  concurrency?: 2 | 3 | 4;
}

export interface UpscaleProgress {
  file: string;
  pct: number | null;
  done: number;
  total: number;
  phase: string;
}

// Test d'upscale sur UNE frame : compare avant/après sans encoder tout le clip.
export interface UpscaleFrameOpts {
  input: string;
  time: number;            // seconde de la frame à tester
  // Même aiguillage que l'encodage : sans ces deux champs l'aperçu montrerait le rendu du moteur IA
  // pendant que le fichier final sortirait d'un shader Turbo.
  engine?: "ia" | "turbo";
  shader?: ShaderModel;
  model: UpscaleModel;
  scale: 1 | 2 | 4;
  denoise?: number;
  tile?: number;
  tilePad?: number;
  prePad?: number;
  fp32?: boolean;
  cleanupNoise?: number;
  cleanupEdges?: number;
}

export interface UpscaleFrameResult {
  ok: boolean;
  orig?: string;           // PNG frame source (chemin disque)
  out?: string;            // PNG frame upscalée
  width?: number;
  height?: number;
  black?: boolean;         // frame quasi noire (fondu) → l'UI invite à déplacer la tête
  error?: string | null;
}

// ---- Hub Traitements vidéo (interpolation / depth / removeBG) ---------------
// Modes du hub : upscale (existant) + 3 nouveaux moteurs ; sortie = fichier importé au Media Pool.
export type ProcMode = "upscale" | "interpolate" | "depth" | "removebg";
// Deux runtimes derrière ce type : ncnn-vulkan (variantes officielles livrées avec le binaire) et
// PyTorch (`tas-rife*`, checkpoints 4.15+ qui n’existent pas en ncnn). Le routage est côté python.
export type InterpModel =
  | "rife-v4.6" | "rife-v4" | "rife-anime" | "rife-HD" | "rife-UHD"
  | "tas-rife4.15" | "tas-rife4.15-lite" | "tas-rife4.16-lite" | "tas-rife4.17" | "tas-rife4.18"
  | "tas-rife4.20" | "tas-rife4.21" | "tas-rife4.22" | "tas-rife4.22-lite"
  | "tas-rife4.25" | "tas-rife4.25-lite" | "tas-rife4.25-heavy"
  | "tas-gmfss" | "tas-distildrba" | "tas-distildrba-lite";
export type DepthModel =
  | "depth-anything-v2-small" | "depth-anything-v2-base" | "depth-anything-v2-large"
  | "depth-anything-v1-small" | "depth-anything-v1-base" | "depth-anything-v1-large"
  | "distill-any-depth-small" | "distill-any-depth-base" | "distill-any-depth-large"
  | "video-depth-anything-small" | "video-depth-anything-base" | "video-depth-anything-large"
  | "video-depth-anything-metric-small" | "video-depth-anything-metric-base" | "video-depth-anything-metric-large"
  | "da3-small" | "da3-base" | "da3-large" | "da3-giant" | "da3-metric-large" | "da3-mono-large"
  | "dpt-swinv2-tiny" | "dpt-swinv2-large" | "dpt-hybrid-midas" | "dpt-beit-base" | "dpt-beit-large" | "dpt-large"
  | "glpn-nyu" | "glpn-kitti" | "zoedepth-nyu-kitti"
  | "depth-pro";
export type DepthColor = "gray" | "inferno" | "magma" | "viridis";
export type SegModel = "birefnet" | "lucida" | "ben2" | "rvm";
export type AlphaFormat = "prores_4444" | "png_seq" | "webm_alpha";

export interface InterpOpts extends ProcessExportOpts {
  input: string; model: InterpModel; factor: 2 | 3 | 4; targetFps?: number; slowmo?: boolean; dedup?: boolean;
  codec: UpscaleCodec; quality?: number; preset?: string; bitDepth?: 8 | 10; profile?: string;
  audio?: AudioMode; abr?: number; audioTrack?: number;
  outDir: string; whole?: boolean; segments?: { in: number; out: number }[]; importBack?: boolean; baseName?: string; outputName?: string;
}
export interface DepthOpts extends ProcessExportOpts {
  input: string; model: DepthModel; bits?: 8 | 16; colormap?: DepthColor; dedup?: boolean;
  codec: UpscaleCodec; quality?: number; preset?: string; bitDepth?: 8 | 10; profile?: string;
  audio?: AudioMode; abr?: number; audioTrack?: number;
  outDir: string; whole?: boolean; segments?: { in: number; out: number }[]; importBack?: boolean; baseName?: string; outputName?: string;
}
export interface RemoveBgOpts extends ProcessExportOpts {
  input: string; model: SegModel; format: AlphaFormat; dedup?: boolean;
  despeckle?: number; edgeSmoothing?: number; edgeOffset?: number;
  audioTrack?: number;
  outDir: string; whole?: boolean; segments?: { in: number; out: number }[]; importBack?: boolean; baseName?: string; outputName?: string;
}
export interface ProcessResult { ok: boolean; outputs?: string[]; imported?: number; total?: number; failed?: number; error?: string | null; }
export interface ProcessProgress { file: string; pct: number | null; done: number; total: number; phase: string; }
export interface ProcessFrameOpts {
  input: string; time: number; mode: ProcMode; model: string;
  despeckle?: number; edgeSmoothing?: number; edgeOffset?: number;
}
export interface ProcessFrameResult { ok: boolean; orig?: string; out?: string; width?: number; height?: number; error?: string | null; }
export interface RenderCompareOpts {
  beforePath: string;
  afterPath: string;
  beforeTime: number;
  afterTime: number;
}
export interface RenderCompareResult {
  ok: boolean;
  before?: string;
  after?: string;
  width?: number;
  height?: number;
  error?: string | null;
}

// ---- Gestionnaire de modèles app-wide --------------------------------------
// Statut d'installation d'un modèle (id aligné sur src/lib/modelRegistry.ts + core/models.js).
export interface ModelStatus {
  id: string;
  installed: boolean;
  available?: boolean;
  sizeBytes?: number;
  partial?: boolean;
  downloading?: boolean;
  progress?: number | null;
}
export interface ModelListResult { ok: boolean; models: ModelStatus[]; error?: string; }
export interface ModelDiskUsage { ok: boolean; totalBytes: number; byTask?: Record<string, number>; error?: string; }
// Progression de téléchargement (SSE models:progress). done/total en octets si connus.
export interface ModelProgress { id: string; pct: number | null; done?: number; total?: number; stage?: string; error?: string; }
// `needsSource` = le runtime existe mais NetsuRush n'a pas le droit de le récupérer (SDK propriétaire
// derrière un compte) ; `url` est alors la page officielle à ouvrir pour que l'utilisateur le fasse.
// `conflict` : le modèle occupe la même distribution pip qu'un autre DÉJÀ installé. L'installation
// est refusée tant que l'utilisateur n'a pas confirmé le remplacement (cf. core/venvs.js).
export interface ModelConflict { family: string; blockedBy: string[]; }
export interface ModelOpResult { ok: boolean; id?: string; error?: string; needsSource?: boolean; url?: string; conflict?: ModelConflict; }
// VRAM de la carte (nvidia-smi). null = pas de GPU NVIDIA mesurable → on n'avertit sur rien.
export interface GpuVram { name: string; totalMB: number; freeMB: number; }

// ---- Pipeline ordonné (chaîne de transforms) -------------------------------
// Ops chaînables (vidéo→vidéo). Depth/matte sont DÉRIVÉS → hors chaîne.
export type PipelineOpKind = "upscale" | "interpolate";
// settings = les réglages de l'op (UpscaleOpts/UpscaleShaderOpts/InterpOpts sans input/outDir, fusionnés côté core).
export interface PipelineOp { kind: PipelineOpKind; settings: Record<string, unknown>; }
export interface PipelineOpts { input: string; ops: PipelineOp[]; outDir: string; importBack?: boolean; baseName?: string; outputName?: string; }
export interface PipelineProgress { file: string; pct: number | null; done: number; total: number; phase: string; opIndex: number; opCount: number; }

// ---- Roto Studio (segmentation interactive + suppression d'objet) ----------
// framesDir = dossier des JPEG extraites (une par frame, %05d.jpg) — le studio les affiche via
// /media : scrub instantané, agnostique codec, pixel-exact avec l'index de frames SAM.
// ready:false = extraction encore en cours (thread python) — frames = estimation, corrigée par le
// SSE roto:progress {extracted}. cached:true = session restaurée du cache (points + suivi compris).
export interface RotoOpenResult {
  ok: boolean; frames?: number; w?: number; h?: number; fps?: number; framesDir?: string;
  work?: string; ready?: boolean; cached?: boolean; tracked?: boolean; deduped?: boolean;
  refined?: boolean;                // un matte fin est déjà en cache pour ce suivi
  points?: { frame: number; obj: number; x: number; y: number; label: 0 | 1 }[];   // px SOURCE
  names?: Record<string, string>;   // noms d'objets persistés (id -> nom)
  error?: string;
}
// mask = data-URI PNG du rendu (overlay teinté en mode edit ; image PLEINE en matte/alpha/bgcolor,
// signalée par full:true — le viewer remplace alors la frame au lieu de superposer).
export interface RotoMaskResult { ok: boolean; mask?: string; frame?: number; full?: boolean; error?: string; }
// preview = data-URI PNG d'un TEST sur une seule image (refine/objectRemove avec `frame`) — rien
// n'est écrit sur disque, l'UI l'affiche dans un aperçu.
// liveDir = dossier des mattes que le matte fin vient d'écrire (le renderer y pointe l'aperçu
// live) ; refined/scopes = ce qui a été calculé et pour quels objets.
export interface RotoResult {
  ok: boolean; output?: string; frames?: number; canceled?: boolean; preview?: string;
  refined?: boolean; scopes?: string[]; liveDir?: string; useRefined?: boolean; error?: string;
}
// frame = frame en cours pendant la propagation (suivi live du slider) ; extracted = fin d'extraction ;
// stage = phase textuelle (load/roi/refine/export/remove/dedupe/extractwait).
export interface RotoProgress { pct?: number | null; stage?: string; frame?: number; extracted?: number; }
// Post-traitement non destructif du masque (appliqué à l'overlay ET cuit à l'export).
// border = correction de bord d'image ; smooth = lissage du contour ; gamma = densité d'alpha.
export interface RotoPost {
  grow?: number; feather?: number; holes?: number; dots?: number;
  border?: number; smooth?: number; gamma?: number;
}
// Mode d'affichage du masque : edit (overlay teinté) / matte (N&B) / alpha (découpe RGBA sur
// damier) / bgcolor (composite sur couleur unie). outline = contours colorés par objet.
export type RotoViewMode = "edit" | "matte" | "alpha" | "bgcolor";
export interface RotoView { mode?: RotoViewMode; outline?: boolean; bg?: string; }
// Suivi : all = complet (avant+arrière depuis les frames annotées) ; forward/backward = re-propagation
// partielle depuis `frame` (correction locale). inF/outF = bornes de plage (poignées in/out).
// count = nombre MAX de frames propagées (pas-à-pas : count=1 avance d'une seule image).
export interface RotoPropagateOpts { mode?: "all" | "forward" | "backward"; frame?: number; inF?: number; outF?: number; count?: number; }
// Dédup animation : frames quasi identiques (ORB, zone masquée) → même matte. restore = annuler.
export interface RotoDedupeResult { ok: boolean; groups?: number; changed?: number; error?: string; }
// Suppression d'objet. grow = marge d'effacement (px) ; steps/quality = propres à la diffusion
// MiniMax (quality = palier de résolution en px, plus haut = remplissage plus net, plus de VRAM).
// plate = plaque propre (récupérer le fond réellement filmé dans les images voisines avant de
// laisser le modèle inventer) ; harmonize/grain = raccord de la zone reconstruite sur son
// voisinage, en pourcentage. frame = TEST sur cette seule image (renvoie `preview`).
// Deux familles distinctes : les réglages du MASQUE (grow/plate/harmonize/grain) et ceux du
// MODÈLE (steps/quality/seed/window/overlap/vaeTiling/cpuOffload). seed rend le tirage
// reproductible ; window/overlap arbitrent cohérence temporelle contre VRAM, le recouvrement
// effaçant la couture entre deux fenêtres de diffusion.
export interface RotoRemoveOpts {
  engine?: string; out?: string; steps?: number; grow?: number; frame?: number;
  plate?: boolean; harmonize?: number; grain?: number; quality?: number;
  seed?: number; window?: number; overlap?: number; vaeTiling?: boolean; cpuOffload?: boolean;
}
// Matte fin : obj = affiner CET objet seul ; combined = une passe unique sur l'union (rapide) ;
// warmup = passes de stabilisation sur chaque image d'amorçage ; maxSize = plafond du petit côté
// envoyé au modèle (0 = pleine résolution) ; frame = essai sur cette seule image.
export interface RotoRefineOpts {
  engine?: string; obj?: number; combined?: boolean; warmup?: number; maxSize?: number; frame?: number;
  // Moteurs par LOTS (VideoMaMa) : ils n'ont pas de graine, ils découpent le plan. `overlap` fond
  // la jonction entre deux lots, qui sauterait sans lui.
  batch?: number; overlap?: number;
}

// ---- Export After Effects --------------------------------------------------
// VIDÉO : copy = lien fichiers source (trim dans AE) · remux = -c copy conteneur propre · reencode = ProRes/DNxHR par plan.
export type AeVideoMode = "copy" | "remux" | "reencode";
// AUDIO (pistes son dédiées + audio embarqué) : copy = lien tel quel · remux = conteneur propre
// (-c:a copy) · aac/pcm = réencode · none = sans audio. (Compatible After Effects uniquement.)
export type AeAudioMode = "copy" | "remux" | "aac" | "pcm" | "none";
// Conteneurs importables par After Effects uniquement (pas de MKV/MKA/FLAC/AAC brut).
export type AeVideoContainer = "mov" | "mp4";
export type AeAudioContainer = "m4a" | "wav" | "aiff";
export type AePrecompNaming = "file" | "number";
export type AePrecompTarget = "video" | "image" | "both";
// none = rush brut · ae = transforms+vitesse posés sur le calque AE · bake = vitesse cuite (réencode).
export type AeTransformMode = "none" | "ae" | "bake";
// Timeline imbriquée : flatten = ses plans dans la comp · comp = précompo dédiée · render = 1 fichier réencodé (rendu Resolve).
export type AeNestedMode = "flatten" | "comp" | "render";
// Format du rendu quand la timeline imbriquée est audio seule (conteneurs importables AE).
export type AeAudioRenderFmt = "wav" | "aiff" | "aac";

export interface AeExportOpts {
  timelineName?: string | null;   // null = timeline ouverte
  compName?: string | null;       // nom de la comp AE (défaut = nom de la timeline)
  videoMode: AeVideoMode;
  codec?: UpscaleCodec;           // mode reencode uniquement (ProRes/DNxHR/x264/x265)
  audio: AeAudioMode;             // traitement audio (indépendant du mode vidéo)
  abr?: number;                   // débit audio kbps (aac/ac3)
  handleSec?: number;             // poignées en secondes (réellement extraites en reencode)
  precomp?: boolean;              // chaque plan vidéo dans sa propre précomposition
  precompNaming?: AePrecompNaming; // nom des précomps : fichier ou numéro
  precompTarget?: AePrecompTarget; // quoi précomposer : vidéos / images / les deux
  folders?: boolean;             // ranger en dossiers AE (Rushes/Précomps/Audio/Images)
  transformMode?: AeTransformMode; // transforms + vitesse : aucune / dans AE / cuite
  nestedMode?: AeNestedMode;       // timeline imbriquée : contenu aplati ou précompo dédiée
  audioRenderFmt?: AeAudioRenderFmt; // format du rendu si timeline imbriquée audio seule
  videoContainer?: AeVideoContainer;  // conteneur vidéo (remux/reencode)
  audioContainer?: AeAudioContainer;  // conteneur audio des pistes son dédiées
  outDir?: string;                // dossier des fichiers produits (remux/reencode) ; défaut = tmp
  upscale?: TransferUpscale;      // agrandir les plans au passage (impose le réencodage)
  deliver?: AeDeliver;            // comment le .jsx atteint After Effects
}

// Agrandissement pendant un transfert = EXACTEMENT les réglages de modèle de NetsuLab
// (`UpSettings`), comme à l'archivage d'une collection : les trois écrans doivent se comporter
// pareil. Import de TYPE seulement : rien de `upscaleShared` n'atterrit dans le bundle du bridge.
export interface TransferUpscale extends Partial<import("@/components/upscale/upscaleShared").UpSettings> {
  enabled?: boolean;
}

// auto = panneau CEP si AE est joignable (script joué dans le projet OUVERT), sinon AfterFX.exe -r.
export type AeDeliver = "auto" | "panel" | "launch";

export interface AeExportResult {
  ok: boolean;
  comp?: string;                  // nom de la comp / timeline source
  clips?: number;                 // nb de calques posés
  outDir?: string | null;
  script?: string;                // chemin du .jsx généré
  missing?: string[];             // plans ignorés (sans fichier : titres, générateurs)
  animated?: number;              // plans dont les images clés ont été lues dans l'export FCP7 XML
  containerFallbacks?: number;    // fichiers écrits en MOV faute d'un MP4 capable de porter les flux
  aeRunning?: boolean;            // AE déjà ouvert (import immédiat) vs lancé (import au démarrage)
  delivered?: AeDeliver;          // voie réellement empruntée
  log?: string;                   // fin du journal du script (livraison par le panneau)
  error?: string;
}

export interface AeProgress {
  phase: string;
  done: number;
  total: number;
  pct: number;
}

// ---- Transfert de timeline entre hôtes (Resolve ⇄ Premiere ⇄ After Effects) ----
// Un lecteur et un écrivain par hôte, reliés par un document neutre côté core : le renderer ne voit
// que le couple source → cible, l'aperçu de ce qui a été lu, et le résultat du montage.
export type TransferHost = "resolve" | "ppro" | "aeft";

export interface TransferSourceList {
  ok: boolean;
  timelines: { name: string; current: boolean }[];
  current?: string | null;
  error?: string;
}

export type TransferCapability = "exact" | "approx" | "bake" | "unsupported";
export type TransferAssessmentStatus = "expected" | "approximated" | "baked" | "bakeAvailable" | "unsupported" | "deferred";
export type TransferReportStatus = "applied" | "approximated" | "baked" | "unsupported" | "deferred" | "readbackMismatch";

export interface TransferAssessmentItem {
  clip: number | null;
  property: string;
  capability: TransferCapability;
  status: TransferAssessmentStatus;
  reason?: string;
}

export interface TransferAssessment {
  target: TransferHost;
  total: number;
  exact: number;
  approximated: number;
  baked: number;
  unsupported: number;
  deferred: number;
  bakeAvailable: number;
  faithful: boolean;
  items: TransferAssessmentItem[];
}

export interface TransferReportItem {
  clip: number | null;
  property: string;
  status: TransferReportStatus;
  reason?: string;
  expected?: unknown;
  actual?: unknown;
  readback?: boolean;
}

export interface TransferFidelity {
  expected: TransferAssessment;
  actual: {
    applied: number;
    approximated: number;
    baked: number;
    unsupported: number;
    deferred: number;
    readbackMismatch: number;
    declaredIssues: number;
    readbackCovered: number;
  };
  verified: boolean;
  coherent: boolean;
  reason?: "readbackIncomplete" | "writerReportedLoss";
  items: TransferReportItem[];
}

/** Aperçu chiffré d'une timeline lue, AVANT montage. */
export interface TransferPreview {
  ok: boolean;
  timeline?: string;
  fps?: number;
  clips?: number;
  video?: number;
  audio?: number;
  videoTracks?: number;
  audioTracks?: number;
  durationFrames?: number;
  animated?: number;
  transformed?: number;
  mixedAudio?: number;
  retimed?: number;
  missing?: string[];
  /** Éléments SANS média dont rien n'est recréable (cache, calque d'effet). */
  mediaLess?: string[];
  /** Titres lus : recréés chez la cible depuis leur texte et leur style, jamais copiés. */
  graphics?: number;
  fidelity?: TransferAssessment;
  /** Provenance des images clés. `available: false` = l'export Resolve qui les porte a échoué. */
  animation?: { available: boolean; clips?: number; unpaired?: number; reason?: string };
  error?: string;
}

// Traitement des médias transférés : copy = liens vers les fichiers d'origine (aucun transcode) ·
// remux = réencapsulage sans perte (-c copy) · reencode = réencodage en codec de montage.
export type TransferMediaMode = "copy" | "remux" | "reencode";

export interface TransferOpts {
  from: TransferHost;
  to: TransferHost;
  timelineName?: string;          // timeline / séquence / comp SOURCE ; défaut = celle ouverte
  name?: string;                  // nom de la timeline créée sur la cible
  mode?: "new" | "append";
  target?: string;                // timeline CIBLE en mode append ; défaut = celle ouverte
  videoOnly?: boolean;
  // Encodage dans le vocabulaire des profils d'export (même table de codecs que le bouton Télécharger).
  mediaMode?: TransferMediaMode;
  codec?: ExportCodec;            // mode reencode uniquement
  audio?: ExportAudioMode;
  container?: ExportContainer;
  encoderMode?: ExportEncoderMode;
  speed?: ExportSpeed;
  outDir?: string;                // obligatoire dès que des fichiers sont produits
  upscale?: TransferUpscale;      // agrandir les plans au passage (impose le réencodage)
  ae?: AeExportOpts;              // Resolve → AE : bascule sur le pipeline riche (transforms, précompos…)
}

export interface TransferResult {
  ok: boolean;
  timeline?: string;
  count?: number;
  created?: boolean;
  /** Voie d'écriture réellement empruntée : `import` = l'hôte cible a lu le fichier d'échange
   *  (il applique lui-même images clés, niveaux audio et vitesse) ; `api` = pose plan par plan. */
  vehicle?: "import" | "api";
  /** Fichier d'échange conservé quand l'hôte a refusé de l'importer par script : il s'ouvre à la main. */
  exchangeFile?: string;
  from?: TransferHost;
  to?: TransferHost;
  source?: string;                // timeline lue côté source
  failed?: number | string[];     // plans refusés par l'hôte cible
  skipped?: number | string[];    // sources absentes du disque
  tracksClamped?: boolean;        // pistes rabattues (l'hôte n'a pas pu en créer assez)
  missing?: string[];             // fichiers absents du disque
  mediaLess?: string[];           // éléments sans média non recréables : cache, calque d'effet
  titles?: number;                // titres recréés chez la cible
  titlesRetimed?: number;         // titres dont la durée du modèle diffère de l'originale
  titlesFailed?: number;          // titres que l'hôte a refusé de poser
  animated?: number;              // plans dont les images clés ont traversé (pipeline AE avancé)
  containerFallbacks?: number;    // fichiers écrits en MOV faute d'un MP4 capable de porter les flux
  fidelity?: TransferFidelity;
  error?: string;
}

export interface TransferProgress {
  phase: string;
  done: number;
  total: number;
  pct: number;
}

// --- Pont Adobe (panneau CEP Premiere/AE ↔ core) — temps en SECONDES ---
export type AdobeApp = "ppro" | "aeft";

export interface AdobeClip {
  name: string;
  path: string | null;          // null = item synthétique (titre, solide…)
  tlStart: number | null;       // position timeline (s)
  tlEnd: number | null;
  srcIn: number | null;         // trim source (s)
  srcOut: number | null;
  // ---- Vérité en FRAMES (Timeline Live). Optionnels : un panneau CEP plus ancien que ces champs
  // envoie encore un snapshot valide, et le mapping retombe alors sur les secondes × fps.
  srcFps?: number | null;       // fps de la SOURCE (≠ fps séquence/comp) — base des frames ci-dessous
  direct?: boolean;             // false = bornes reportées en secondes depuis une séquence imbriquée
  srcInFrame?: number | null;   // frames source INCLUSIVES (même convention que Resolve)
  srcOutFrame?: number | null;
  srcFrames?: number | null;    // longueur totale de la source ; null = inconnue (Premiere ne l'expose pas)
  tlStartFrame?: number | null; // position timeline en frames de la séquence/comp
}

export interface AdobeSequence {
  name: string;
  fps: number | null;
  w: number | null;
  h: number | null;
  // `name` = nom BRUT de la piste côté hôte (`Track.name`, lecture seule). Optionnel : un panneau
  // CEP antérieur à ce champ envoie encore un snapshot valide, la piste garde alors son numéro.
  tracks: { kind: "video" | "audio"; index: number; name?: string; clips: AdobeClip[] }[];
}

export interface AdobeSnapshot {
  ok: boolean;
  app: AdobeApp;
  appVersion: string;
  project: string;
  projectPath: string | null;
  // Séquence Premiere / comp AE OUVERTE au moment du scan : l'équivalent Adobe de la « timeline
  // ouverte » de Resolve. Optionnel (panneau antérieur à ce champ → aucune destination par défaut).
  activeSequence?: string | null;
  at: number;
  rushes: { path: string; name: string; fps: number | null; dur: number | null; w: number | null; h: number | null }[];
  sequences: AdobeSequence[];
}

export interface AdobeAppStatus {
  installed: boolean;
  exe: string | null;
  running: boolean;
  panelConnected: boolean;      // heartbeat du panneau < 12 s
  lastSnapshotAt: number | null;
}

export interface AdobeBridgeStatus {
  ok: boolean;
  ppro: AdobeAppStatus;
  aeft: AdobeAppStatus;
  panelInstalled: boolean;      // manifest présent dans %APPDATA%\Adobe\CEP\extensions
  panelDir?: string;            // chemin d'installation du panneau (dossier extensions CEP)
  panelVersion?: string | null;          // version livrée avec cette version de NetsuRush
  panelInstalledVersion?: string | null; // version réellement posée dans Adobe
  panelBuild?: string | null;            // empreinte COURTE du contenu livré : identifie le build
  panelAutoUpdate?: boolean;             // réinstallation auto quand le panneau livré change
  panelOutdated?: boolean;               // copie installée ≠ copie livrée (auto-update coupé)
  panelUpdatedAt?: number | null;        // dernière mise à jour automatique
  panelRestartApps?: AdobeApp[];         // apps ouvertes pendant l'installation → à redémarrer
}

// Diagnostic d'installation du panneau CEP (bouton « Diagnostic » de l'onglet Adobe).
export interface AdobeDiagnostic {
  ok: boolean;
  panelDir: string | null;
  manifestExists: boolean;
  files: string[];
  manifestHead: string | null;                 // 500 premiers caractères du manifest sur disque
  playerDebug: Record<string, string>;          // CSXS.9..15 → "1" | "absent" | "défini≠1"
  cepLogs: { file: string; lines: string[] }[]; // lignes du log CEP mentionnant NetsuRush
}

// Montage vers un hôte Adobe (aller-retour job via le panneau). Segments en secondes (le jsx
// convertit depuis les frames au besoin). fps = fps du clip (repli frame→sec si secondes absentes).
export interface AdobeBuildOpts {
  app: AdobeApp;
  name: string;
  input: string;                // chemin du clip source
  mode?: "new" | "append";
  // Séquence / comp visée en mode append (nom exact). Absent → celle ouverte dans l'hôte.
  timelineName?: string;
  fps?: number;
  whole?: boolean;              // rush entier (ignore segments)
  videoOnly?: boolean;          // ne pose pas l'audio du média source
  insertion?: "insert" | "overwrite" | "replace" | "fit" | "above" | "end" | "ripple_overwrite";
  // `path` par segment : un montage issu de Timeline Live enchaîne des plans de sources DIFFÉRENTES.
  // Absent → le segment est pris sur `input` (Derush, Recherche, Voix : une seule source).
  segments: { in: number; out: number; inFrame?: number; outFrame?: number; path?: string }[];
}
export interface AdobeBuildResult {
  ok: boolean;
  timeline?: string;            // nom de la séquence créée / complétée
  count?: number;               // plans insérés
  created?: boolean;
  skipped?: number;             // plans écartés (média absent du disque)
  error?: string;
}

export interface SearchHit {
  file_path: string;
  scene_index: number;
  start_frame: number;
  end_frame: number;
  mid_frame: number;
  start_sec: number;
  end_sec: number;
  fps: number;
  src_frames: number;
  score: number;           // pertinence calibrée 0..1 (sigmoïde SigLIP), sinon cosinus brut
  aesthetic?: number;      // netteté/qualité zero-shot : cos(net)−cos(flou) (>0 = net), si demandé
  char?: { id: number; name: string; color?: string } | null;  // personnage reconnu (recherche visage), si étiqueté
}

export interface SearchResult {
  hits: SearchHit[];
  error?: string | null;
  // Avertissement qui n'empêche PAS d'afficher les hits (ex. intersection @perso dégradée) — déjà
  // traduit par le sidecar (NR_LANG), le renderer ne fait que l'afficher.
  notice?: string | null;
}

// Référence de recherche : image externe (path) OU plan déjà indexé (file_path + scene_index).
export interface SearchRef {
  path?: string;
  file_path?: string;
  scene_index?: number;
  face_index?: number;     // visage précis d'un plan indexé (galerie de visages détectés)
  thumb?: string | null;   // vignette pour l'affichage du bac de références (renderer)
  bbox?: [number, number, number, number]; // visage choisi au picker (x,y,w,h) — recherche visage
  domain?: "anime" | "real";               // domaine du visage choisi (moteur d'identité)
}

export interface SearchOpts {
  text?: string;
  negText?: string;        // requête négative ("plages SANS personne")
  lang?: string;           // langue de l'interface : a priori quand la requête est trop courte pour être reconnue
  refs?: SearchRef[];      // 1 réf = image→image, N réfs = moodboard (mean-pool re-normalisé)
  topK?: number;
  minScore?: number;       // 0..1 : n'afficher que les hits ≥ ce seuil calibré
  beta?: number;           // pondération de la requête négative (défaut 0.4)
  aesthetic?: boolean;     // attache un score netteté/qualité par hit
  charId?: number;         // filtre personnage (compat) : un seul perso
  charIds?: number[];      // mentions @perso : restreint au pool de plans de CES persos (intersection)
  filePaths?: string[];    // périmètre projet ; absent = tous les rush indexés
}

export interface SceneKey {
  file_path: string;
  scene_index: number;
}

export interface DedupGroup {
  anchor: SearchHit;       // plan le plus central du groupe (meilleure prise)
  members: SearchHit[];    // toutes les prises (ancre en tête)
  size: number;
}
export interface DedupResult {
  groups: DedupGroup[];
  truncated?: boolean;     // base entière échantillonnée (trop volumineuse)
  error?: string | null;
}

export interface ClusterGroup {
  label: string;
  size: number;
  rep: SearchHit;          // représentant (plus proche du centroïde)
  members: SearchHit[];
}
export interface ClusterResult {
  clusters: ClusterGroup[];
  error?: string | null;
}

export interface IndexResult {
  ok: boolean;
  file?: string;
  indexed?: number;
  total?: number;
  cached?: boolean;
  error?: string | null;
}

export interface SearchStatus {
  clips: number;
  frames: number;
  model?: string;
  error?: string | null;
}

// Variantes SigLIP 2 et leur index respectif. `ready` = dossier du modèle réellement chargeable ;
// `indexedClips` = ce que CETTE variante a déjà indexé (les index ne sont pas partagés entre variantes).
export interface SearchModelEntry {
  id: string;
  active: boolean;
  installed: boolean;
  ready: boolean;
  indexedClips: number;
  indexedFrames: number;
}

export interface SearchModelState {
  ok: boolean;
  active: string;
  models: SearchModelEntry[];
}

export interface IndexedInfo {
  frames: number;
  stale: boolean;                       // mtime fichier ≠ mtime indexé → à ré-indexer
  complete: boolean;                    // traité jusqu'au bout (faux = interrompu → à re-traiter)
  failed: number;                       // plans tentés mais non embeddés (frames sautées) → réessai
  legacy: boolean;                      // format d'index inconnu (antérieur au marqueur) → ré-index possible
  // Format d'indexation, du plus pauvre au plus riche (cf. lib/sampling) ; « image » = image fixe.
  mode: "single" | "adaptive" | "precise" | "image" | null;
}

export interface IndexedResult {
  indexed: Record<string, IndexedInfo>; // clé = file_path
  error?: string | null;
}

export interface ShotsResult {
  shots: SearchHit[];                   // plans indexés d'un clip (vignette + temps) pour choisir une référence
  error?: string | null;
}

export interface FaceStatus {
  faces: number;                        // nb de visages indexés
  clips: number;                        // nb de clips avec visages indexés
  anime?: number;                       // visages du domaine animé (CCIP)
  real?: number;                        // visages du domaine réel (SFace)
  error?: string | null;
}

// Visage détecté dans une image de référence (picker « qui chercher ? »).
export interface FaceDet {
  index: number;
  domain: "anime" | "real";
  bbox: [number, number, number, number];  // x,y,w,h dans l'image source
  conf?: number;
  thumb: string | null;                    // data URI JPEG du crop
}

export interface FaceDetectResult {
  faces: FaceDet[];
  error?: string | null;
}

// Personnage nommé de la bibliothèque (roster). avatar = data URI de la 1re vignette.
export interface Character {
  id: number;
  name: string;
  notes: string;
  tags: string[];
  color: string;
  avatar: string | null;
  samples: { anime: number; real: number };
  total: number;
  // Plans étiquetés DANS la portée de recherche (null = portée entière → aucun filtrage).
  scopeShots?: number | null;
  scope_shots?: number | null;   // graphie du sidecar python (repli quand SQLite Node est absent)
}

// Suggestion d'identité pour un visage détecté (auto-suggestion au picker).
export interface CharMatch {
  index: number;         // position du visage de référence
  char_id: number;
  name: string;
  color?: string;
  score: number;         // calibré 0..1
  domain?: "anime" | "real";
}

// Paire de personnages qui se ressemblent (probablement le même individu à fusionner).
export interface DuplicatePair {
  a: { id: number; name: string; color?: string };
  b: { id: number; name: string; color?: string };
  score: number;
}

// Un visage de la galerie : groupe d'identité (visage représentatif + occurrences + réf de recherche).
export interface GalleryFace {
  domain: "anime" | "real";
  count: number;                 // nb d'occurrences de ce visage dans l'index
  thumb: string | null;          // vignette du visage représentatif (data URI)
  ref: { file_path: string; scene_index: number; face_index: number; domain: "anime" | "real" };
  char?: { id: number; name: string; color?: string } | null;   // nom si l'index a été « reconnu »
}

// Référence de visage à enregistrer / identifier : image (path[+bbox+domain]) OU visage indexé.
export interface CharRef {
  path?: string;
  bbox?: [number, number, number, number];
  domain?: "anime" | "real";
  file_path?: string;
  scene_index?: number;
  face_index?: number;
}

// Échantillon enregistré d'un personnage (vignette + provenance si pris dans l'index).
export interface CharSample {
  id: number;
  domain: "anime" | "real";
  thumb: string | null;          // data URI
  created_at: number;
  file_path: string | null;      // null = réf image externe
  scene_index: number | null;
}

export interface GpuStatus {
  features?: Record<string, string>;   // ex. { video_decode: "enabled", webgpu: "enabled", ... }
  gpu?: unknown;
  error?: string;
}

// ---- Provisionnement 1er lancement (app packagée) -------------------------
export interface SetupItem {
  id: string;        // "ffmpeg" | "venv" | "transnet"
  label: string;
  done: boolean;
}
export interface SetupStatus {
  ready: boolean;    // ffmpeg + venv présents → fonctions cœur opérationnelles
  venv: boolean;
  transnet?: boolean;
  ffmpeg: boolean;
  weights: boolean;
  hardware?: {
    gpus: Array<{ name: string; vendor: "nvidia" | "amd" | "intel" | "other"; driverVersion: string | null; pnpDeviceId?: string | null; role?: "igpu" | "dgpu" | "unknown" }>;
    cpus: string[];
    vendors: Array<"nvidia" | "amd" | "intel" | "other">;
    primaryVendor: "nvidia" | "amd" | "intel" | "other" | "cpu";
    initialMlBackend: "cuda" | "rocm" | "xpu" | "cpu";
    initialOnnxBackend: "cuda" | "directml" | "cpu";
    windowsBuild: number;
    label: string;
  };
  mlBackend?: string;
  onnxBackend?: string;
  installedModules?: string[];
  installedModels?: string[];
  runtime?: { ok?: boolean; actual?: string; gpu?: boolean; omnishotcut?: boolean; siglip?: boolean; error?: string | null } | true;
  home: string;      // dossier de données écrivable (NR_HOME)
  items: SetupItem[];
}
// Suivi d'UN élément téléchargé (archive, roue pip, modèle). `total: 0` = taille inconnue :
// l'interface montre alors une barre indéterminée plutôt qu'un pourcentage inventé.
export interface SetupDownload {
  name: string;
  state: "download" | "work" | "retry" | "error" | "done" | "skip";
  done: number;   // octets reçus
  total: number;  // octets attendus, 0 si le serveur ne l'annonce pas
}

export interface SetupProgress {
  pct?: number;      // 0..100
  stage?: string;    // python | venv | torch | deps | ffmpeg | weights | config | done | error
  label?: string;    // libellé lisible de l'étape
  line?: string;     // ligne brute (sortie pip/ffmpeg) hors marqueurs
  dl?: SetupDownload; // état vivant d'un téléchargement, hors journal
}

export interface CompatibilityStatus {
  ok: boolean;
  hardware: NonNullable<SetupStatus["hardware"]>;
  configured: { torch: string; onnx: string; transcribe: string };
  runtime: {
    torch: null | { configured: string; actual: string; device: string; deviceName: string | null; version: string; accelerated: boolean };
    onnx: null | { configured: string; availableProviders: string[]; selectedProviders: string[]; version: string; accelerated: boolean };
    errors: string[];
  };
  encoding: { h264: string | null; h265: string | null; av1: string | null; webp: boolean; hardwareEncoders: string[]; codecEncoders: Record<string, string | null>; codecEncoderOptions: Record<string, string[]>; upscaleProfileEncoderOptions: Record<string, string[]>; codecs: string[]; error: string | null };
}

export type PreviewProxyFormat = "hevc" | "h264" | "webm";
export type PreviewProxyEngine = "auto" | "nvenc" | "amf" | "qsv" | "cpu";
export type PreviewProxyPreset = "level1" | "level2" | "level3";
export type PreviewHeight = 360 | 480 | 520 | 720;
// Cran de qualité des miniatures. Un cran pilote hauteur ET compression : la table numérique vit
// côté core (`core/thumbPresets.js`), seule source de vérité — le renderer n'en connaît que les ids.
export type ThumbPreset = "light" | "balanced" | "sharp";
export interface PreviewGenerationSettings {
  proxy: {
    format: PreviewProxyFormat;
    engine: PreviewProxyEngine;
    preset: PreviewProxyPreset;
    height: PreviewHeight;
    audio: boolean;
  };
  thumbnail: {
    format: "jpeg" | "webp";
    preset: ThumbPreset;
  };
}
export interface SetupRunResult {
  ok: boolean;
  error?: string;
  needsRestart?: boolean;   // redémarrer l'app pour recharger les chemins (config figée au boot)
  verified?: boolean;
}
export interface SetupRunOptions {
  modules: string[];
  models: string[];
  adobePanel?: boolean;   // poser l'extension CEP Premiere/After Effects (et la garder à jour)
}

export interface PlayInfo {
  duration: number;
  codec: string;
  pix: string;
  fps: number;       // images/s exact (avg_frame_rate) → plage frame-accurate
  native: boolean;   // décodable nativement par <video> → lecture remux copie
  error?: string;
}

// ---- Rich Presence Discord (Paramètres › Compte) --------------------------
// Réglages persistés CÔTÉ CORE (NR_HOME/discord-rpc.json) : une seule source de vérité, le renderer
// les lit au montage. Les gabarits acceptent {module} et {projet} ; vides = lignes automatiques.
export interface DiscordPrefs {
  enabled: boolean;
  showModule: boolean;   // ligne « Derush », « Recherche »… selon l'onglet ouvert
  showProject: boolean;  // nom du projet/rush — off par défaut (un nom peut trahir un client)
  showElapsed: boolean;  // « 12:34 écoulées » depuis l'ouverture de l'app
  detailsTpl: string;
  stateTpl: string;
}
// L'activité telle que Discord la reçoit. Les lignes absentes sont OMISES (une string vide est
// rejetée), d'où les champs optionnels — l'aperçu doit refléter cette omission.
export interface DiscordActivity {
  details?: string;
  state?: string;
  timestamps?: { start?: number }; // secondes Unix
  assets?: { large_image?: string; large_text?: string };
}
export interface DiscordState {
  enabled: boolean;
  connected: boolean;                                       // handshake abouti avec le client Discord
  user: { username?: string; global_name?: string } | null; // compte Discord qui affiche la présence
  appId: boolean;                                           // App ID renseignée (sinon rien n'est possible)
  prefs: DiscordPrefs;
  error?: string | null;
  preview?: DiscordActivity | null;                         // rendu réel calculé par le core, toggle ignoré
  // Nom + vignette que Discord affichera vraiment (info publique de l'app, résolue par le core).
  // `imageUrl` = l'asset `nr_logo` s'il est publié, sinon l'icône de l'app — le repli de Discord.
  app?: { name: string; imageUrl: string | null } | null;
}

// ---- Board de référence (mood-board) -------------------------------------
// Les items/vue transitent en `unknown` (frontière IPC) ; le module renderer les re-type.
export interface RefSceneMeta {
  id: string;
  name: string;
  updatedAt: number;
}
export interface RefSceneIn {
  id?: string;
  name: string;
  items: unknown[];
  view?: unknown;
}
export interface RefSceneOut {
  id: string;
  name: string;
  items: unknown[];
  view: unknown | null;
  updatedAt: number;
}
// ---- Partage « .netsu » (board → conteneur SQLite type-routé) ----
// Le NIVEAU dit ce qu'on garde du média, du plus léger au plus lourd. La qualité et la marge sont
// des réglages du niveau, pas des niveaux : voir core/netsu/levels.js, source unique des règles.
export type NetsuLevel =
  | "link"      // rien du média : chemin/lien + bornes + une image de poster
  | "preview"   // la plage jouée, réencodée petit (défaut)
  | "margin"    // la plage jouée ÉLARGIE : bornes réajustables plus tard sans l'original
  | "full";     // le fichier source entier
export type NetsuQuality = "eco" | "standard" | "high";
/** Modes de l'archive v1, encore acceptés en entrée et ramenés à un niveau côté core. */
export type NetsuMode = "full" | "light" | "links";
export interface NetsuEmbed {
  level: NetsuLevel;
  quality?: NetsuQuality;
  marginSec?: number;
}
export interface NetsuExportOpts extends Partial<NetsuEmbed> {
  mode?: NetsuMode;         // rétrocompat : full→level "full", light→"preview", links→"link"
  freezeLinks?: boolean;    // télécharge les liens distants (image/gif) en assets → board pérenne
}
export interface NetsuCounts { items: number; bundled: number; referenced: number; bytes?: number }
export interface NetsuExportResult {
  ok: boolean;
  path?: string;
  bytes?: number;           // taille du fichier produit
  counts?: NetsuCounts;
  mode?: string;
  level?: NetsuLevel;
  error?: string;
}
/** Estimation de poids AVANT export — ordre de grandeur, jamais une promesse (débits moyens). */
export interface NetsuWeight {
  ok: boolean;
  level?: NetsuLevel;
  total?: number;                             // poids au niveau demandé
  perLevel?: Record<NetsuLevel, number>;      // poids du board à chacun des 4 niveaux
  items?: { id: string; kind: string; bytes: number; long: boolean }[];
  error?: string;
}
// `retain` = localisateurs que le board peut encore réclamer sans qu'ils soient posés : médias
// retenus par l'historique d'annulation. Le core les met à l'abri de son ménage de fin
// d'enregistrement — sans quoi supprimer un item effacerait ses octets avant le Ctrl+Z suivant.
export interface NetsuScene { name: string; items: unknown[]; view?: unknown; retain?: string[] }
export interface NetsuImportResult {
  ok: boolean;
  scene?: { name: string; items: unknown[]; view: unknown | null };
  counts?: NetsuCounts | null;
  type?: string;            // type du conteneur si non pris en charge
  error?: string;
}

// ---- Projet .netsu : le fichier comme document de travail ----------------------------------------
/** Lecture d'un projet. `readonly` = archive v1 (lisible, pas modifiable en place). */
export interface NetsuProjectRead extends NetsuImportResult {
  path?: string;
  rev?: number;
  readonly?: boolean;
}
/** Compteurs d'un enregistrement : `changed` dit combien de lignes ont VRAIMENT bougé. */
export interface NetsuProjectSave {
  ok: boolean;
  path?: string;
  rev?: number;
  bytes?: number;
  sidecarDir?: string;      // dossier compagnon des médias, à côté du fichier
  counts?: { items: number; changed: number; removed: number; adopted: number; missing: number; freed: number };
  sourceSceneId?: string;
  sourceCleanup?: { ok: boolean; error?: string };
  error?: string;
}
/** Un projet récemment ouvert. `missing` = le fichier n'est plus à ce chemin (disque débranché…). */
export interface NetsuRecent {
  path: string;
  title: string;
  type: string;
  openedAt: number;
  modifiedAt?: number;
  missing: boolean;
  sourceSceneId?: string;
}

export interface ResolvedOnlineMedia {
  ok: boolean;
  path?: string;
  url?: string;
  kind?: "image" | "video";
  error?: string;
}

/** Une entrée de la bibliothèque de fonds d'écran, telle que la renvoie le core. */
export interface WallpaperEntry {
  id: string;
  name: string;
  kind: "still" | "animated";
  width: number;
  height: number;
  duration: number;
  fps: number;
  baseWidth: number;
  createdAt: number;
  /** Variante de base (boucle mp4 si animé, sinon webp) et image figée — chemins disque. */
  base: string;
  poster: string;
}

export interface WallpaperApi {
  /** Copie le fichier dans la bibliothèque (dédup par hash) et cuit la variante de base. */
  import(srcPath: string, opts?: { quality?: "hd" | "fhd" | "qhd" }): Promise<{ ok: boolean; entry?: WallpaperEntry; reused?: boolean; error?: string }>;
  list(): Promise<{ ok: boolean; entries?: WallpaperEntry[]; error?: string }>;
  /** Chemin d'une marche de flou, encodée à la demande puis conservée. `blur` = INDICE de marche. */
  variant(id: string, opts: { blur?: number; animated?: boolean }): Promise<{ ok: boolean; path?: string; step?: number; radius?: number; animated?: boolean; error?: string }>;
  remove(id: string): Promise<{ ok: boolean; removed?: boolean; error?: string }>;
}

export interface RefApi {
  listScenes(): Promise<RefSceneMeta[]>;
  storagePath(): Promise<string>;
  loadScene(id: string): Promise<RefSceneOut | null>;
  saveScene(scene: RefSceneIn): Promise<{ ok: boolean; id?: string; updatedAt?: number; error?: string }>;
  deleteScene(id: string): Promise<{ ok: boolean; error?: string }>;
  saveAsset(bytes: ArrayBuffer, ext: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  fetchAsset(url: string, options?: { projectPath?: string; title?: string }): Promise<{ ok: boolean; path?: string; kind?: "image" | "video"; error?: string }>;
  // Résout le vrai média de N'IMPORTE quel lien (fichier direct, ou page web via OpenGraph) → asset
  // disque. Catch-all générique : GIF (giphy/tenor), imgur, articles, CDN sans extension propre.
  resolveMedia(url: string, options?: { download?: boolean; projectPath?: string; title?: string }): Promise<ResolvedOnlineMedia>;
  // Upscale un item média (image/vidéo locale) → nouveau fichier asset. NON destructif : ne supprime
  // jamais l'ancien fichier (le board garde de quoi revenir en arrière).
  upscaleItem(opts: { path: string; kind: "image" | "video"; in?: number; out?: number; engine?: "ia" | "turbo"; model: UpscaleModel; shader?: ShaderModel; scale: 1 | 2 | 4; denoise?: number }): Promise<{ ok: boolean; path?: string; width?: number; height?: number; error?: string }>;
  // Supprime un fichier UNIQUEMENT s'il est un asset de l'app (cleanup d'un upscale annulé). Sûr.
  dropAsset(path: string): Promise<{ ok: boolean; removed?: boolean; error?: string }>;
  // Ménage du magasin d'assets : ce que plus aucune scène ne réclame et qui a passé le délai de
  // grâce s'en va. `graceMs` n'est là que pour les tests — l'app utilise le défaut du core.
  sweepAssets(opts?: { graceMs?: number }): Promise<{ ok: boolean; removed: number; bytes: number; kept: number; error?: string }>;
  // Dossier déposé sur le board : médias trouvés récursivement, avec leur sous-dossier RELATIF pour
  // que l'import reconstruise un cadre par dossier. `truncated` quand le plafond a coupé la liste.
  scanFolder(dir: string, opts?: { cap?: number }): Promise<{ ok: boolean; root: string; name: string; files: { path: string; rel: string; name: string; kind: "image" | "video" }[]; truncated: boolean; count: number }>;
  // Écrit un export du board (PNG/JPG en base64, SVG en texte) vers un chemin choisi par l'utilisateur.
  writeFile(path: string, data: string, encoding: "base64" | "utf8"): Promise<{ ok: boolean; path?: string; bytes?: number; error?: string }>;
  // Un cadre d'un média (image, GIF, vidéo) rendu par le core en PNG base64, lu SUR LE DISQUE.
  // Seule source de pixels relisible par le renderer : le protocole d'asset teinte le canvas.
  sampleFrame(path: string, opts?: { at?: number; side?: number }): Promise<{ ok: boolean; png?: string; error?: string }>;
  extractMedia(url: string, options?: { projectPath?: string; title?: string }): Promise<{ ok: boolean; items?: { path: string; kind: "image" | "video" }[]; error?: string }>;
  // Décompose une vidéo locale en frames image (assets disque) pour bâtir une séquence d'images.
  // `in/out` = plage de boucle (s), `fps` = cadence d'échantillonnage, `max` = plafond de frames.
  // `fps` omis ou ≤ 0 = cadence de la source ; la réponse renvoie celle réellement employée.
  extractFrames(opts: { path: string; fps?: number; max?: number; height?: number; in?: number; out?: number; projectPath?: string; title?: string }): Promise<{ ok: boolean; frames?: string[]; fps?: number; error?: string }>;
  // Partage « .netsu » : exporte la scène (items + vue) dans une archive à `destPath` selon `opts`
  // (mode complet / léger / liens, seuil d'embarquement, gel des liens distants). Importe une archive
  // → scène reconstruite (tokens d'assets → chemins locaux ; gros médias non retrouvés = placeholders).
  exportBoard(scene: NetsuScene, destPath: string, opts: NetsuExportOpts): Promise<NetsuExportResult>;
  importBoard(srcPath: string): Promise<NetsuImportResult>;
  // Avancement d'un partage, item par item : un board fourni encode ses clips pendant des minutes.
  onShareProgress(cb: (p: { done: number; total: number; title: string }) => void): () => void;
  // Relocalisation EN LOT : un dossier, et tous les médias manquants qu'on y reconnaît sans
  // ambiguïté (même nom, même taille). Les homonymes de même taille ne sont jamais devinés.
  relocateFrom(dirPath: string, wanted: { id: string; name: string; size?: number }[]): Promise<{ ok: boolean; found: { id: string; path: string }[]; scanned: number; error?: string }>;
  // Poids estimé du board à chaque niveau, sans rien encoder → l'utilisateur voit ce qu'il fabrique
  // avant de lancer l'export.
  weigh(scene: NetsuScene, opts: NetsuExportOpts): Promise<NetsuWeight>;
  // Dialogues fichier dédiés au format .netsu (filtre d'extension) : choisir une archive à importer,
  // choisir une destination d'export. null = annulé / hors application.
  chooseNetsu(): Promise<string | null>;
  saveNetsuPath(defaultName: string): Promise<string | null>;
  // Projet .netsu : le fichier EST le document. `openProject` le tient ouvert côté core et rend la
  // scène ; `saveProject` réécrit CE fichier de façon incrémentale (aucun réencodage) ; `saveProjectAs`
  // le fait déménager. `readonly` = archive v1, lisible mais pas modifiable en place.
  openProject(srcPath: string): Promise<NetsuProjectRead>;
  previewProject(srcPath: string): Promise<NetsuImportResult>;
  saveProject(filePath: string, scene: NetsuScene): Promise<NetsuProjectSave>;
  saveProjectAs(opts: { scene: NetsuScene; destPath: string; fromPath?: string | null; sourceSceneId?: string | null }): Promise<NetsuProjectSave>;
  closeProject(filePath: string): Promise<{ ok: boolean; closed?: boolean }>;
  recentProjects(type?: string): Promise<NetsuRecent[]>;
  forgetProject(filePath: string): Promise<NetsuRecent[]>;
  deleteProject(filePath: string): Promise<{ ok: boolean; projectRemoved?: boolean; mediaRemoved?: boolean; recents: NetsuRecent[]; error?: string }>;
  setDirty(unsaved: boolean): void;
  detach(): void;
  attach(): void;
  setAlwaysOnTop(on: boolean): void;
  push(payload: unknown): void;
  onPush(cb: (payload: unknown) => void): () => void;
}

// ---- Module Script -----------------------------------
// Document = 1+ par projet Resolve. Bloc = paragraphe = futur segment de timeline. Média = référence
// d'un MediaPoolItem (par chemin) + in/out frames (out INCLUSIF, invariant frame-accurate).
export type ScriptBlockType = "text" | "heading" | "note" | "todo" | "storyboard" | "bullet" | "numbered" | "callout" | "divider";
// Piste de montage : V* = vidéo (chips en gouttière), A* = audio (chips sous le texte).
export type MediaTrack = "V1" | "V2" | "V3" | "A1" | "A2" | "A3";
// Couleur de LIAISON : un média et le surlignage de texte qu'il illustre partagent la même couleur.
export type MediaColor = "blue" | "green" | "purple" | "orange" | "pink" | "cyan";
export interface ScriptBlockMedia {
  id?: string;
  kind: "video" | "audio"; // vidéo = plan monté ; audio = voix off / musique / sfx
  track: MediaTrack;       // piste (ordre + emplacement gouttière/bas)
  color: MediaColor;       // couleur de liaison chip ↔ surlignage texte
  filePath: string;
  resolveItemId?: string | null;
  inFrame: number;
  outFrame: number | null; // null = clip entier
  fps: number;             // 0 pour l'audio (pas de cadence)
  label: string;
  source?: "mediapool" | "folder" | "recording";
  side?: "left" | "block"; // placement de la vignette : flottante à GAUCHE du texte, ou bloc pleine largeur (défaut)
  mini?: boolean;          // miniature compacte : très petite vignette, sans nom ni durée (mode aperçu discret)
}
export interface ScriptBlock {
  id: string;
  type: ScriptBlockType;
  text: string;            // HTML ; les surlignages = <span class="nr-hl nr-hl-{color}">…</span>
  level?: number;          // heading : niveau 1-3 (défaut 2)
  tags: string[];
  checked?: boolean;       // todo : case cochée (persistée)
  data?: string;           // storyboard : document vectoriel JSON (PNG data-URI legacy accepté)
  order: number;
  media: ScriptBlockMedia[]; // plusieurs plans/sons par bloc (multi-piste)
}
// Réglages PAR DOCUMENT (JSON libre, colonne script_doc.settings) : surcharge partielle des
// préférences globales + état de vue persistant (sections repliées).
export interface ScriptDocSettings {
  prefs?: Record<string, unknown>; // Partial<ScriptPrefs> (composant scriptPrefs.ts)
  foldedIds?: string[];            // ids des titres repliés (repli de section)
}
export interface ScriptDoc {
  id: string;
  title: string;
  resolveProject: string | null;
  blocks: ScriptBlock[];
  settings?: ScriptDocSettings | null;
  updatedAt?: number;
}
// Chiffres d'un document sans le charger (cartes de l'accueil) : calculés côté core avec les mêmes
// règles que la barre de stats de l'éditeur. Optionnels — un backend qui ne les fournit pas laisse
// l'accueil masquer la ligne de stats plutôt qu'afficher des zéros mensongers.
export interface ScriptDocStats {
  blocks: number;
  words: number;
  seconds: number;
  media: number;
  sections: number;
}
export interface ScriptDocMeta {
  id: string;
  title: string;
  resolveProject: string | null;
  updatedAt: number;
  stats?: ScriptDocStats;
}
export interface ScriptBuildResult {
  ok: boolean;
  timeline?: string;
  count?: number;
  mode?: string;
  created?: boolean;
  fpsMismatch?: boolean;
  timelineFps?: number | null;
  missing?: string[];
  markersAdded?: number;
  error?: string;
}
export interface ScriptVersionMeta {
  id: string;
  docId: string;
  label: string;
  createdAt: number;
}
export interface ScriptRecording {
  path: string;
  name: string;
  folder: string;
  mtime: number;
  size: number;
}
export interface ScriptApi {
  // Dossier d'enregistrements voix off (configuré côté renderer) : fichiers audio, récents d'abord.
  recordings(dir: string): Promise<{ ok: boolean; error?: string; files: ScriptRecording[] }>;
  // Media Pool complet pour NetsuDraft : vidéos + audios (la vue NetsuCut garde son flux vidéo seul).
  mediaPool(): Promise<MediaList>;
  // Importe des fichiers ou dossiers en conservant l'arborescence dans les bins du Media Pool.
  importMedia(paths: string[]): Promise<{ ok: boolean; count?: number; skipped?: number; error?: string }>;
  listDocs(resolveProject?: string | null): Promise<ScriptDocMeta[]>;
  loadDoc(id: string): Promise<ScriptDoc | null>;
  saveDoc(doc: ScriptDoc): Promise<{ ok: boolean; id?: string; updatedAt?: number; error?: string }>;
  deleteDoc(id: string): Promise<{ ok: boolean; error?: string }>;
  // Historique de versions : points de contrôle manuels (snapshot complet du doc) + restauration.
  listVersions(docId: string): Promise<ScriptVersionMeta[]>;
  saveVersion(docId: string, label: string, doc: ScriptDoc): Promise<{ ok: boolean; id?: string; createdAt?: number; error?: string }>;
  getVersion(id: string): Promise<{ id: string; docId: string; label: string; createdAt: number; doc: ScriptDoc | null } | null>;
  deleteVersion(id: string): Promise<{ ok: boolean; error?: string }>;
  // Build natif : blocs ordonnés (sources multiples) → AppendToTimeline frame-accurate. out INCLUSIF,
  // outFrame null = clip entier. mode "new" (défaut) crée une timeline, "append" ajoute à la courante.
  // markers = commentaires exportés : marqueur Resolve posé au début du clip issu de blocks[index].
  buildTimeline(opts: {
    name?: string;
    mode?: "new" | "append";
    timelineName?: string;   // mode append : timeline existante ciblée (sinon la timeline ouverte)
    insertion?: "insert" | "overwrite" | "replace" | "fit" | "above" | "end" | "ripple_overwrite";
    dest?: "timeline" | "bin";
    binName?: string;
    videoOnly?: boolean;
    blocks: { filePath: string; inFrame?: number; outFrame?: number | null; fps?: number }[];
    markers?: { index: number; name?: string; note?: string; color?: string }[];
  }): Promise<ScriptBuildResult>;
}

// ---- Carnet (Notebook) : carnets multi → pages imbriquées → databases -----
export interface NotebookApi {
  // Carnets (liste sidebar). save = crée (id absent) ou met à jour la méta.
  list(): Promise<NotebookMeta[]>;
  saveNotebook(nb: { id?: string; title: string; icon?: string | null; scriptId?: string | null; kind?: NotebookKind; language?: NotebookLanguage }): Promise<{ ok: boolean; id?: string; updatedAt?: number; error?: string }>;
  deleteNotebook(id: string): Promise<{ ok: boolean; error?: string }>;
  // Carnet lié à un script (bouton « Carnet » du module Script) : renvoie l'existant ou en crée un.
  forScript(scriptId: string, title?: string): Promise<{ ok: boolean; notebook?: NotebookMeta; created?: boolean; error?: string }>;
  // Carnet + arbre de pages (métas seules, sans les docs de blocs).
  load(id: string): Promise<{ notebook: NotebookMeta; pages: PageMeta[] } | null>;
  // Page complète (document de blocs) + databases de la page (map dbId → Database).
  loadPage(id: string): Promise<{ page: NotebookPage; databases: Record<string, Database> } | null>;
  savePage(page: { id?: string; notebookId: string; parentId?: string | null; title: string; icon?: string | null; cover?: string | null; orderIdx?: number; blocks: unknown[] }): Promise<{ ok: boolean; id?: string; updatedAt?: number; error?: string }>;
  deletePage(id: string): Promise<{ ok: boolean; removed?: string[]; error?: string }>;
  // Duplique la page + sa descendance (+ databases, références internes remappées).
  duplicatePage(id: string): Promise<{ ok: boolean; id?: string; error?: string }>;
  // Corbeille : deletePage = suppression DOUCE (restaurable) ; purge = définitive.
  trashList(notebookId: string): Promise<PageMeta[]>;
  restorePage(id: string): Promise<{ ok: boolean; restored?: string[]; error?: string }>;
  purgePage(id: string): Promise<{ ok: boolean; removed?: string[]; error?: string }>;
  emptyTrash(notebookId: string): Promise<{ ok: boolean; removed?: number; error?: string }>;
  // Recherche plein-texte (titres + blocs) ; blockId = ancre du 1er bloc contenant le terme.
  search(notebookId: string, query: string): Promise<NbSearchHit[]>;
  saveDatabase(db: Database & { pageId: string }): Promise<{ ok: boolean; id?: string; updatedAt?: number; error?: string }>;
  deleteDatabase(id: string): Promise<{ ok: boolean; error?: string }>;
  // Rétroliens : pages du carnet qui mentionnent la page cible (@mention).
  backlinks(notebookId: string, pageId: string): Promise<PageMeta[]>;
  // Média uploadé/collé (uploadFile BlockNote) → écrit sur disque, renvoie une URL d'affichage prête.
  // `notebookId` route le fichier : dans un carnet-DOCUMENT il va au dossier compagnon du .netsu.
  saveAsset(bytes: ArrayBuffer, ext: string, notebookId?: string): Promise<{ ok: boolean; path?: string; url?: string; error?: string }>;
  // Carnet-DOCUMENT : le .netsu ouvert fait foi (mêmes tables, médias dans le dossier compagnon).
  // `openProject` le tient ouvert côté core et rend l'id du carnet qu'il contient ; la frappe y va
  // ensuite directement. `saveProjectAs` fait DÉMÉNAGER le carnet (il quitte la bibliothèque interne).
  openProject(filePath: string): Promise<{ ok: boolean; path?: string; notebookId?: string; reused?: boolean; error?: string }>;
  saveProjectAs(opts: { notebookId: string; destPath: string }): Promise<{ ok: boolean; path?: string; notebookId?: string; pages?: number; error?: string }>;
  closeProject(filePath: string): Promise<{ ok: boolean; closed?: boolean }>;
  projectOf(notebookId: string): Promise<{ path: string } | null>;
  // Lit un asset local en base64 (le renderer ne peut pas fetch /media : cross-origin sans CORS) → aperçu PDF/texte.
  readAsset(path: string): Promise<{ ok: boolean; b64?: string; error?: string }>;
  // Preview d'un lien collé (signet) : OpenGraph → carte titre/description/image/favicon.
  linkMeta(url: string): Promise<{ ok: boolean; meta?: LinkMeta; error?: string }>;
  // Export d'une page (Markdown/HTML) : écrit le texte au chemin donné (.md/.html/.txt seulement).
  writeExport(filePath: string, text: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  // Partage commun .netsu : archive type-routée fidèle (blocs, databases, métadonnées, assets).
  // rootId absent/null = carnet entier ; sinon page + sous-arbre. importFile : notebookId absent =
  // nouveau carnet, parentId = page d'accueil des racines importées.
  exportFile(opts: { notebookId: string; rootId?: string | null; dest: string; embedAssets?: boolean }): Promise<{ ok: boolean; path?: string; bytes?: number; counts?: { pages: number; databases: number; assets: number }; error?: string }>;
  importFile(opts: { bytes: ArrayBuffer; notebookId?: string | null; parentId?: string | null }): Promise<{ ok: boolean; notebookId?: string; pages?: number; databases?: number; rootIds?: string[]; error?: string }>;
  push(payload: unknown): void;
  onPush(cb: (payload: unknown) => void): () => void;
  // Fenêtre OS détachée du Carnet (2e WebviewWindow, hash #notebook — mécano du board Référence) :
  // écrire dans le Carnet À CÔTÉ de NetsuDraft/du reste de l'app. attach = depuis la détachée.
  detach(): void;
  attach(): void;
}

// Résultat de recherche du carnet (modale Recherche) : page + extrait + ancre de bloc.
export interface NbSearchHit {
  pageId: string;
  title: string;
  icon: string | null;
  snippet: string;
  blockId: string;
}

// Métadonnées d'un lien (bloc signet). Snapshot persisté dans les props du bloc → pas de re-fetch.
export interface LinkMeta {
  url: string;
  title: string;
  description: string;
  image: string;
  siteName: string;
  favicon: string;
}

// ---- Collections (bibliothèque de plans gardés) --------------------------
// Icône de dossier : emoji natif, pictogramme lucide (nom), OU petite image uploadée (chemin disque).
export type CollectionIcon =
  | { kind: "emoji"; ch: string }
  | { kind: "lucide"; name: string }
  | { kind: "image"; path: string };

// Plan rangé : référence LÉGÈRE (chemin + in/out secondes ET frames). Vignette/proxy régénérés à la
// demande par le cache déterministe du derush — rien de dupliqué sur disque.
export interface CollectionShot {
  id?: string;           // généré côté core au rangement ; toujours présent en lecture
  path: string;
  name: string;
  in: number;            // secondes (lecture proxy / vignette)
  out: number;
  inFrame?: number;      // frames source inclusives (re-montage frame-accurate)
  outFrame?: number;
  srcFrames?: number;    // total de frames source (remap d'espace-frames au build)
  fps?: number;
  addedAt?: number;
  // Organisation (édition dans la vue détail) : étiquettes libres, label couleur, note 0-5, annotation.
  tags?: string[];
  label?: string | null; // nom d'une couleur de la palette (voir collectionShared.LABELS) ou null
  rating?: number;       // 0-5 (étoiles)
  note?: string;
}
// Champs éditables d'un plan rangé (undefined = inchangé ; null = effacé). Couvre les méta
// d'organisation ET le plan lui-même (rognage bornes/frames, renommage, repointage source).
export interface CollectionShotPatch {
  tags?: string[];
  label?: string | null;
  rating?: number | null;
  note?: string | null;
  in?: number;
  out?: number;
  inFrame?: number | null;
  outFrame?: number | null;
  srcFrames?: number | null;
  fps?: number | null;
  name?: string;
  path?: string;
}
// Aperçu d'un plan (mosaïque de la vue Galerie) — juste de quoi tirer une vignette.
export interface CollectionPreviewShot {
  path: string;
  in: number;
  inFrame?: number;
  fps?: number;
}
// Méta d'une collection (sans les shots) → grille de dossiers.
export interface CollectionMeta {
  id: string;
  name: string;
  color: string | null;
  icon: CollectionIcon | null;
  count: number;
  updatedAt: number;
  preview?: CollectionPreviewShot[];  // jusqu'à 4 plans (mosaïque Galerie)
  tags?: string[];                    // tags des plans DEDANS (chips sur la carte)
  labels?: string[];                  // ids de labels couleur présents (pastilles de résumé)
  collTags?: string[];                // tags de la COLLECTION (groupes → filtrer/trier transversalement)
  description?: string;               // mini description
  folderId?: string | null;          // dossier de rangement (null = racine)
  archive?: CollectionArchive | null; // réglages d'archivage (dossier de stockage, profil, auto)
  archived?: boolean;                 // déjà archivée sur disque au moins une fois
  autoSync?: boolean;                 // ré-archivage auto à chaque ajout
}
// Réglages d'archivage (export indépendant de la source → garder pour toujours).
export interface CollectionArchive {
  dir?: string;         // dossier de stockage
  // Format d'enregistrement (choix complet des codecs, comme l'export) : remux (copie) ou ré-encodage.
  workflow?: "video_remux" | "video_encode";
  codec?: string;       // codec de ré-encodage (ExportCodec)
  encoderMode?: string; // moteur d'encodage (ExportEncoderMode : gpu/nvenc/amf/qsv/cpu)
  speed?: string;       // compromis vitesse/compression (ExportSpeed)
  container?: string;   // conteneur (mp4/mkv/mov)
  audioMode?: string;   // codec audio (ExportAudioMode)
  audioSelect?: AudioSelect; // sélection de piste par langue (multi-pistes) ; absent = "auto"
  profileId?: string;   // legacy (ancien : id d'un profil d'export) — ignoré
  autoSync?: boolean;   // ré-exporter à chaque ajout
  upscale?: CollectionArchiveUpscale; // agrandir les plans au passage (impose le ré-encodage)
  lastAt?: number;      // dernier archivage réussi
  // Fichiers écrits, ALIGNÉS sur `shots` (null = plan en échec) → sait quoi déplacer, et où, quand on
  // change de dossier de stockage. Écrit par le core, jamais par le renderer.
  files?: (string | null)[];
  // Vérité par PLAN (identité stable, pas l'index) : fichier produit + empreinte de son contenu.
  // C'est elle qui permet de ne rien refaire quand rien n'a changé. Écrite par le core.
  entries?: Record<string, { file: string; key: string | null; at?: number }>;
}
// Upscale à l'archivage = EXACTEMENT les réglages de modèle de NetsuLab (`UpSettings`), pour que les
// deux écrans se comportent pareil ; seul `when` est propre à l'archivage (tout de suite, ou quand la
// machine ne fait plus d'encodage). Import de TYPE seulement : rien de `upscaleShared` n'atterrit
// dans le bundle du bridge.
export interface CollectionArchiveUpscale extends Partial<import("@/components/upscale/upscaleShared").UpSettings> {
  enabled?: boolean;
  when?: "now" | "idle";
}
// Une entrée de la file d'archivage différé.
export interface ArchiveQueueEntry {
  id: string;
  collId: string;
  name: string;
  mode: "now" | "idle";
  status: "pending" | "running" | "done" | "error";
  at: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  result?: { skipped: number; copied: number; rendered: number; failed: number };
}
export interface ArchiveQueueState {
  entries: ArchiveQueueEntry[];
  running: boolean;
}
// Collection COMPLÈTE (load) : méta d'organisation + shots. `tags` = tags de la collection.
export interface Collection {
  id: string;
  name: string;
  color: string | null;
  icon: CollectionIcon | null;
  description?: string;
  tags?: string[];
  folderId?: string | null;
  archive?: CollectionArchive | null;
  shots: CollectionShot[];
  updatedAt: number;
}
// Dossier de rangement des collections (hiérarchie façon Media Pool).
export interface CollectionFolder {
  id: string;
  name: string;
  parentId: string | null;
}
// Patch de méta d'une collection (save) — tous optionnels, undefined = inchangé.
export interface CollectionSave {
  id?: string;
  name: string;
  color?: string | null;
  icon?: CollectionIcon | null;
  description?: string;
  tags?: string[];
  folderId?: string | null;
  archive?: CollectionArchive | null;
}
export interface CollectionsApi {
  list(): Promise<CollectionMeta[]>;
  load(id: string): Promise<Collection | null>;
  // Crée (id absent) ou met à jour la méta (name/color/icon/description/tags/folderId/archive).
  save(c: CollectionSave): Promise<{ ok: boolean; id?: string; updatedAt?: number; error?: string }>;
  delete(id: string): Promise<{ ok: boolean; error?: string }>;
  addShots(id: string, shots: CollectionShot[]): Promise<{ ok: boolean; id?: string; added?: number; count?: number; updatedAt?: number; error?: string }>;
  removeShot(id: string, shotId: string): Promise<{ ok: boolean; count?: number; updatedAt?: number; error?: string }>;
  // Édite un plan rangé : méta (tags/label/note/étoiles) ET le plan (bornes/frames/nom/source).
  updateShot(id: string, shotId: string, patch: CollectionShotPatch): Promise<{ ok: boolean; updatedAt?: number; error?: string }>;
  saveIcon(bytes: ArrayBuffer, ext: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  // Dossiers de rangement (hiérarchie).
  listFolders(): Promise<CollectionFolder[]>;
  saveFolder(f: { id?: string; name: string; parentId?: string | null }): Promise<{ ok: boolean; id?: string; error?: string }>;
  deleteFolder(id: string): Promise<{ ok: boolean; error?: string }>;
  move(id: string, folderId: string | null): Promise<{ ok: boolean; updatedAt?: number; error?: string }>;
  // Registre global des tags (autocomplétion + recherche transversale).
  allTags(): Promise<string[]>;
  // Archivage : export de tous les plans vers un dossier via un profil (indépendant de la source).
  // `skipped`/`copied`/`rendered` disent ce que l'archivage a VRAIMENT fait : un dossier déjà à jour
  // ne réencode rien, et un plan déjà produit ailleurs est recopié plutôt que régénéré.
  archive(id: string, opts: { dir?: string; profile: ExportProfile; autoSync?: boolean; upscale?: CollectionArchiveUpscale }): Promise<{ ok: boolean; files?: string[]; skipped?: number; copied?: number; rendered?: number; pruned?: number; failed?: number; error?: string }>;
  // Changement de dossier de stockage : déplace l'archive existante vers `dir` (le dossier n'est pas
  // figé) et ré-exporte les plans dont le fichier manque → la nouvelle cible est toujours complète.
  relocateArchive(id: string, opts: { dir: string; profile: ExportProfile; autoSync?: boolean; upscale?: CollectionArchiveUpscale }): Promise<{ ok: boolean; files?: string[]; moved?: number; exported?: number; failed?: number; error?: string }>;
  // File des archivages différés : même opération, lancée quand la machine ne fait plus d'encodage.
  queueState(): Promise<ArchiveQueueState>;
  queueEnqueue(id: string, req: { name?: string; mode?: "now" | "idle"; opts?: { dir?: string; profile: ExportProfile; autoSync?: boolean; upscale?: CollectionArchiveUpscale } }): Promise<{ ok: boolean; id?: string; error?: string }>;
  queueCancel(entryId: string): Promise<{ ok: boolean; error?: string }>;
  onQueue(cb: (s: ArchiveQueueState) => void): () => void;
  // Médias hors-ligne (sources manquantes) + resynchronisation (relier par fichier ou dossier de renvoi).
  offline(id: string): Promise<{ ok: boolean; missing?: OfflineMedia[]; offline?: number; total?: number; error?: string }>;
  relinkPath(id: string, oldPath: string, newPath: string): Promise<{ ok: boolean; relinked?: number; error?: string }>;
  relinkDir(id: string, dir: string): Promise<{ ok: boolean; relinked?: number; error?: string }>;
}

// ---- Bibliothèque de rushs importés -----------------------------------------------------------
// Rushs ENTIERS déposés dans l'app sans passer par le Media Pool d'un logiciel de montage : c'est
// l'ENTRÉE du derush. À ne pas confondre avec les Collections (plans découpés in/out = la SORTIE).
// Modèle NU volontairement : pas de tags/notes/étoiles ici — ça, c'est le rôle des Collections.
export interface LibraryItem {
  id: string;
  name: string;
  path: string;
  folderId: string | null;
  // Métas au format Resolve (timecode « 00:00:30:00 », « 1920x1080 », « 23.976 ») pour que les cartes
  // importées se lisent comme celles du Media Pool. null = sonde en échec (le rush existe quand même).
  duration: string | null;
  fps: string | null;
  resolution: string | null;
  format: string | null;
  addedAt: number;
}
// Dossier de rangement de la bibliothèque (parentId null = racine « Importés »).
export interface LibraryFolder {
  id: string;
  name: string;
  parentId: string | null;
}
// Matière d'une annulation : les enregistrements COMPLETS d'avant la suppression. Les rushs portent
// leur folderId d'origine → les restaurer verbatim rétablit existence ET rangement.
export interface LibraryUndo {
  items: LibraryItem[];
  folders: LibraryFolder[];
}
export interface LibraryApi {
  list(): Promise<LibraryItem[]>;
  // Ajoute des fichiers (sondés + dédoublonnés par chemin). `folderId` = dossier d'accueil (drop sur
  // une rangée) ; absent ou inconnu → racine « Importés ».
  addPaths(paths: string[], folderId?: string | null): Promise<{ ok: boolean; added?: number; error?: string }>;
  // Importe un dossier : scan récursif des rushs, l'arborescence disque devient des sous-dossiers
  // du dossier d'accueil (`folderId`) ou de la racine.
  addDir(dir: string, folderId?: string | null): Promise<{ ok: boolean; added?: number; folders?: number; error?: string }>;
  // Retire l'entrée UNIQUEMENT — ne touche jamais au fichier sur le disque. Vaut pour TOUTE la
  // famille remove/removeMany/deleteFolder : la bibliothèque n'est qu'un index de chemins.
  remove(id: string): Promise<{ ok: boolean; undo?: LibraryUndo; error?: string }>;
  // Retrait en lot (multi-sélection) : un seul aller-retour, une seule annulation.
  removeMany(ids: string[]): Promise<{ ok: boolean; undo?: LibraryUndo; error?: string }>;
  // Remet en place ce qu'une suppression a retiré, à l'identique (même id, même dossier).
  restore(undo: LibraryUndo): Promise<{ ok: boolean; error?: string }>;
  move(id: string, folderId: string | null): Promise<{ ok: boolean; updatedAt?: number; error?: string }>;
  listFolders(): Promise<LibraryFolder[]>;
  saveFolder(f: { id?: string; name: string; parentId?: string | null }): Promise<{ ok: boolean; id?: string; error?: string }>;
  // `withItems` : false = sous-dossiers et rushs remontent au parent ; true = le sous-arbre entier part.
  deleteFolder(id: string, withItems?: boolean): Promise<{ ok: boolean; undo?: LibraryUndo; error?: string }>;
  // Rushs dont le fichier a disparu. Canal SÉPARÉ de list() : un existsSync sur des centaines
  // d'entrées peut bloquer plusieurs secondes sur un disque réseau mort.
  // Pas d'OfflineMedia ici : son `count` (plans par source) n'a de sens que pour les Collections,
  // où une source sert plusieurs plans. Une entrée de bibliothèque = un fichier, point.
  offline(): Promise<{ ok: boolean; missing?: { path: string; name: string }[]; offline?: number; total?: number; error?: string }>;
  relinkPath(oldPath: string, newPath: string): Promise<{ ok: boolean; relinked?: number; error?: string }>;
  relinkDir(dir: string): Promise<{ ok: boolean; relinked?: number; error?: string }>;
}

// Une source de plan manquante sur disque (à relier). `count` = nb de plans qui l'utilisent.
export interface OfflineMedia { path: string; name: string; count: number }

// Plan d'une timeline Resolve EXISTANTE (onglet Timeline Live) : source + in/out frames.
export interface TimelineCut {
  id: string;
  path: string;
  name: string;
  track: number;
  // Nom BRUT de la piste tel que l'hôte le donne (« Video 2 » par défaut, sinon celui de l'utilisateur).
  // Porté par le PLAN et non par un index de pistes à part : il survit ainsi au cache projet hors ligne,
  // qui ne persiste que les plans. Optionnel = snapshot ou panneau antérieur à ce champ.
  trackName?: string;
  in: number;            // secondes (in/out source ; out = fin de plan, exclusif)
  out: number;
  inFrame: number;       // frames source inclusives
  outFrame: number;
  srcFrames: number;
  fps: number;
  tlStart: number;       // position sur la timeline (ordre)
}
export interface TimelineCutsResult {
  ok: boolean;
  timeline?: string;
  cuts: TimelineCut[];
  cached?: boolean; // servi depuis le snapshot projet (hôte fermé) → plans lus hors ligne
  error?: string;
}

// ---- Découpe de timeline : structure éditable (éditeur de coupes in-app) -------------------
// Un plan de montage = { startFrame, frames } en frames SOURCE du rush (source-contigus dans un CutClip).
// Fusionner deux plans adjacents = un seul { startFrame du 1er, frames cumulés }. Supprimer un plan =
// le retirer de la liste. Le build (buildCutTimeline) régénère le FCPXML depuis la liste éditée.
export interface CutShot {
  startFrame: number;
  frames: number;
}
export interface CutClip {
  src: string;                 // file:// URL (media-rep FCPXML)
  path: string;                // chemin disque (vignettes)
  name: string;
  fps: { num: number; den: number };
  fpsNum?: number;             // fps décimal (affichage)
  totalFrames: number;
  w: number;
  h: number;
  shots: CutShot[];
}
export interface CutAnalysis {
  ok: boolean;
  source?: string;             // nom de la timeline d'origine
  base?: string;               // nom par défaut proposé (« <source> — découpé »)
  clips: CutClip[];
  shots?: number;              // total de plans
  error?: string;
}

// ---- Chat IA (copilote agentique) ----------------------------------------
// Moteur hybride : provider 'anthropic'/'openai' = BYOK (clé en RAM côté core, au repos = Stronghold),
// 'cli' = agent CLI installé (claude/codex) piloté via MCP. Outils = modules NetsuRush + catalogue
// Resolve. La permission (mode configurable) peut demander une approbation avant une action.
export type ChatProvider = "anthropic" | "openai" | "openrouter" | "cli";
export type ChatPermMode = "read-only" | "ask" | "auto" | "safe";
export interface ChatMessage { role: "user" | "assistant"; content: string }
export interface ChatAgentInfo { id: string; name: string; available: boolean; version: string | null; models: string[] }
export interface ChatAgentsInfo {
  mode: ChatPermMode;
  byok: { anthropic: boolean; openai: boolean; openrouter: boolean };
  cli: ChatAgentInfo[];
}
// Événement normalisé poussé en SSE (chat:event). Champs présents selon `type`.
export interface ChatEvent {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "status" | "usage" | "error" | "done";
  delta?: string;
  id?: string;
  name?: string;
  input?: unknown;
  ok?: boolean;
  content?: unknown;
  label?: string;
  message?: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}
export interface ChatApprovalReq { runId: string; callId: number; name: string; input: unknown; risk: "read" | "write" | "destructive" }
export interface ChatConvMeta { id: string; title: string; updatedAt: number }
export interface ChatConv { id: string; title: string; messages: ChatMessage[] }
export interface ChatConfig { mode?: ChatPermMode; anthropicKey?: string; openaiKey?: string; openaiBaseUrl?: string; openrouterKey?: string }
export interface ChatSendOpts {
  runId: string;
  provider: ChatProvider;
  agent?: string;          // CLI : id de l'agent (claude/codex/…)
  model?: string;
  messages: ChatMessage[];
  system?: string;
}
export interface ChatApi {
  agents(): Promise<ChatAgentsInfo>;
  configure(cfg: ChatConfig): Promise<{ ok: boolean }>;
  send(opts: ChatSendOpts): Promise<{ ok: boolean }>;
  cancel(runId: string): Promise<{ ok: boolean }>;
  respondApproval(callId: number, approved: boolean): Promise<{ ok: boolean }>;
  tools(): Promise<{ name: string; description: string; risk: string }[]>;
  onEvent(cb: (e: { runId: string; ev: ChatEvent }) => void): () => void;
  onApproval(cb: (r: ChatApprovalReq) => void): () => void;
  history: {
    list(): Promise<ChatConvMeta[]>;
    load(id: string): Promise<ChatConv | null>;
    save(conv: { id?: string; title?: string; messages: ChatMessage[] }): Promise<{ ok: boolean; id?: string }>;
    delete(id: string): Promise<{ ok: boolean }>;
  };
}

// ---- Optimisation : diagnostic perf + arrêt de tâches + nettoyage cache --------------------
export interface OptimizeRenderJob {
  id: string;
  name: string;
  target?: string;
}
export interface OptimizeDiagnosis {
  connected: boolean;
  project?: string | null;
  timeline?: string | null;
  version?: string | null;
  page?: string | null;                     // page Resolve active (media/edit/color/…)
  settings: Record<string, string>;        // réglages perf (cache/proxy/optimized) en lecture seule
  render: { jobs: OptimizeRenderJob[]; inProgress: boolean };
  cacheRoots: string[];                     // racines de cache candidates (auto-détectées)
  // `path`/`size` à null = base PostgreSQL : elle n'a pas de dossier à peser.
  db?: { path: string | null; name?: string; type?: string; size: number | null } | null; // taille de la base de données disque (read-only)
  vram?: OptimizeVram | null;               // VRAM GPU (nvidia-smi), null si illisible
}
export interface OptimizeVram {
  usedMB: number;
  totalMB: number;
  util: number | null;
}
export interface OptimizeResources {
  gpu: OptimizeVram | null;
  ram: { free: number; total: number };       // octets
  cpu: number | null;                          // charge CPU système % (delta), null au 1er échantillon
  resolveRam: number | null;                   // octets (working set Resolve.exe), null si introuvable
  disk: { total: number; free: number; used: number } | null;
}
// Dérive de la session Resolve : ce que la RAM/VRAM de Resolve.exe a pris DEPUIS son ouverture. Le
// verdict dit quand un rechargement/redémarrage vaut le coup — c'est le seul correctif (rien ne purge
// le cache Fusion ni la pile d'undo en cours de route).
export type OptimizeVerdict = "ok" | "watch" | "high";
export interface OptimizeSample {
  at: number;
  ram: number;                                 // octets
  vram: number | null;                         // Mo
  vramTotal: number | null;                    // Mo
}
export interface OptimizeSessionHealth {
  running: boolean;                            // false = Resolve fermé, aucune session mesurée
  verdict: OptimizeVerdict;
  samples: OptimizeSample[];
  since?: number;                              // 1re mesure de la session (epoch ms)
  measured?: number;                           // durée mesurée (ms) — pas l'uptime réel de Resolve
  ram?: number;                                // octets, dernière mesure
  baselineRam?: number;                        // octets, 1re mesure
  driftRam?: number;                           // octets pris depuis la baseline
  vram?: number | null;                        // Mo
  vramTotal?: number | null;                   // Mo
  driftVram?: number | null;                   // Mo
}
// Préférences Resolve lues SUR DISQUE : l'API de scripting sait écrire les réglages projet
// (`SetSetting`) mais n'expose rien pour les préférences de l'app — or c'est là que vivent les
// réglages les plus coûteux (chargement de toutes les timelines, limites mémoire).
export interface OptimizePref {
  id: string;
  key: string;                                 // clé réelle dans le fichier
  file: "system" | "user";                     // .config.data | config.user.xml
  kind: "bool" | "percent" | "enum";
  value: boolean | number | string;
  recommended: boolean | number | string | null;
  options: string[] | null;
  min: number | null;
  max: number | null;
  advisory: boolean;                           // arbitrage machine → signalé, jamais tranché
  warn: boolean;                               // s'écarte d'une reco FERME
}
export interface OptimizePrefs {
  ok: boolean;
  dir?: string;
  error?: string;
  prefs: OptimizePref[];
}
export interface OptimizePrefBackup {
  name: string;
  path: string;
  at: number;
  files: string[];
}
export interface OptimizeApplyPrefs {
  ok: boolean;
  applied?: number;
  backup?: string;
  restarted?: boolean;
  project?: string | null;
  reopenError?: string;
  error?: string;
}
export interface OptimizeSnapshot {
  name: string;
  path: string;
  size: number;
  mtime: number;
}
/** Classement d'un processus. `host` = logiciel de montage (Resolve/Premiere/AE) et ses satellites. */
export type OptimizeProcKind = "system" | "host" | "own" | "noise" | "unknown";
export type OptimizeNoiseRisk = "low" | "medium";
export interface OptimizeProc {
  pid: number;
  name: string;
  ram: number;        // octets (working set)
  vramMB: number;     // VRAM utilisée par ce process (nvidia-smi compute-apps)
  cpu: number | null; // % de la machine entière, mesuré par delta (null si non mesuré)
  windowed: boolean;  // fenêtre principale visible → jamais arrêté automatiquement
  kind: OptimizeProcKind;
  family: string | null;             // id de famille de bruit (clé i18n) quand kind === "noise"
  risk: OptimizeNoiseRisk | null;
  critical: boolean;  // système / hôte de montage / nos process → kill interdit
}
/** État de la surveillance mémoire (SSE `optimize:watchdog`). */
export interface OptimizeWatchdogPrefs {
  enabled: boolean;
  ramLowPct: number;
  vramHighPct: number;
}
export interface OptimizeWatchdogState {
  prefs: OptimizeWatchdogPrefs | null;
  armed: boolean;                        // une tâche lourde est en cours → surveillance active
  source?: string | null;                // export | proxy | render
  pressure?: { under: boolean; ramPct: number | null; vramPct: number | null; reasons: string[] } | null;
  journal: { at: number; reasons: string[]; trimmed: number; freed: number; names: string[] }[];
  // Libérer n'a pas suffi : arrêts PROPOSÉS, jamais exécutés seuls.
  suggestion: { at: number; procs: { pid: number; name: string; ram: number; family: string | null; risk: OptimizeNoiseRisk | null }[] } | null;
}
export interface OptimizeDeadProc {
  pid: number;
  name: string;
  critical: boolean;  // process figé mais protégé → exclu du nettoyage
}
export interface OptimizeCacheEntry {
  path: string;
  name: string;
  kind: string;                             // render | proxy | gallery | other
  label: string;
  size: number;                             // octets
}
export interface OptimizeCacheScan {
  ok: boolean;
  root?: string;
  error?: string;
  entries: OptimizeCacheEntry[];
  disk: { total: number; free: number; used: number } | null;
}
export interface OptimizeCleanResult {
  ok: boolean;
  freed: number;                            // octets libérés
  removed: string[];
  skipped: string[];
  error?: string;
}

// NetsuBoost côté Premiere Pro / After Effects. Trois voies d'action, chacune avec sa condition :
// job panneau CEP (app OUVERTE), disque (app FERMÉE — purger pendant qu'Adobe écrit corrompt sa base),
// processus (sans condition). Formes miroir de core/adobeBoost.js.
export type BoostCacheKind = "mediaCache" | "mediaCacheDb" | "peak" | "diskCache" | "autoSave" | "previews";
export interface BoostCacheRoot {
  id: string;                               // clé i18n (mediaCacheFiles, peakFiles…)
  kind: BoostCacheKind;
  dir: string;
  shared: boolean;                          // cache commun PPro/AE/AME/Audition → purge à double gain
  regenerable: boolean;                     // false = données utilisateur (auto-saves), pas un cache
  size: number | null;                      // rempli par measure()
}
export interface BoostProc {
  pid: number;
  name: string;
  ram: number;                              // octets (working set)
  host: AdobeApp | null;                    // l'app hôte elle-même, si c'en est une
  critical: boolean;                        // hôte vivant → jamais tuable (le montage serait perdu)
}
// Statistiques lues DANS l'hôte par le panneau. La forme diffère Premiere/AE et suit leurs API : on ne
// sur-type pas ce qu'on ne contrôle pas, seuls les champs sûrs sont nommés.
export interface BoostLiveStats extends Record<string, unknown> {
  ok: boolean;
  appVersion?: string;
  items?: number;
  memoryInUse?: number | null;              // AE : app.memoryInUse (octets), la vraie valeur AE
  bitsPerChannel?: number | null;
  gpuAccelType?: string | null;
  gpuAvailable?: string[];
  sequences?: number;                       // Premiere
  enableProxies?: boolean | null;
  proxies?: { total?: number; withProxy?: number; canProxy?: number };
}
export interface BoostDiagnosis {
  ok: boolean;
  app: AdobeApp;
  installed: boolean;
  running: boolean;
  exe: string | null;                       // porte le millésime quand l'extension est muette
  panelConnected: boolean;
  panelInstalled: boolean;
  project: string | null;
  projectPath: string | null;
  cacheRoots: BoostCacheRoot[];
  cacheTotal: number;
  disk: { total: number; free: number; used: number } | null;
  procs: BoostProc[];
  procsRam: number;
  live: BoostLiveStats | null;              // null si le panneau est muet — le reste arrive quand même
  liveError: string | null;
  error?: string;
}
export interface BoostCacheScan {
  ok: boolean;
  error?: string;
  root?: string;
  size?: number;
  files?: number;
  buckets?: { days: number; size: number; files: number }[];   // tranches d'ancienneté
  disk?: { total: number; free: number; used: number } | null;
}
export interface BoostCleanTarget {
  dir: string;
  minAgeDays?: number;
}
export interface BoostCleanResult {
  ok: boolean;
  code?: "APP_RUNNING";                     // purge disque refusée : l'application tient ses fichiers
  error?: string;
  freed?: number;
  removed?: string[];
  skipped?: string[];
  failed?: string[];
  restarted?: boolean;
  reopenError?: string;
}
// Contrat de ligne VOLONTAIREMENT distinct d'OptimizePref : même rendu, mais deux hôtes qui
// n'évoluent pas ensemble (+ kind "path" pour les scratch disks, + volatile/writeOnly côté AE).
export interface BoostPref {
  id: string;
  key: string;                              // API hôte visée (app.project.gpuAccelType…)
  kind: "bool" | "percent" | "enum" | "path";
  value: boolean | number | string | null;
  recommended: boolean | number | string | null;
  options: string[] | null;
  min: number | null;
  max: number | null;
  advisory: boolean;                        // arbitrage machine → jamais d'alerte
  volatile: boolean;                        // retombe à la fin du script (MFR)
  writeOnly: boolean;                       // l'hôte n'expose aucun accesseur en lecture
  warn: boolean;                            // mauvais réglage certain (SOFTWARE alors qu'un GPU existe)
}
export interface BoostPrefs {
  ok: boolean;
  error?: string;
  prefs: BoostPref[];
}
export interface BoostProxyItem {
  path: string;
  name: string;
  hasProxy: boolean;
  canProxy: boolean;
}
export interface BoostProxyAudit {
  ok: boolean;
  error?: string;
  enableProxies?: boolean | null;
  items?: BoostProxyItem[];
}
export interface BoostPurgeResult {
  ok: boolean;
  error?: string;
  code?: "UNSUPPORTED";
  target?: string;
  purged?: number;
  downgraded?: boolean;                     // version sans ALL_MEMORY_CACHES → repli sur 3 cibles
  memoryBefore?: number | null;
  memoryAfter?: number | null;
  freed?: number | null;
}
export interface BoostAttachResult {
  ok: boolean;
  attached: number;
  failed: string[];                         // un lot raté n'arrête pas les suivants
  total: number;
  error?: string;
}
export interface BoostProgress {
  msg: string | null;
  pct: number;
}

// Console / journal (debug + bêta-test). Une entrée du flux SSE `console:log` (core + sidecars python).
export interface ConsoleLogEntry {
  id: number;
  t: number;                                  // epoch ms
  source: string;                             // frontend | core | python:<name> | system
  level: "log" | "warn" | "error";
  message: string;
  repeat?: number;                            // occurrences consécutives repliées en une entrée
}
// Instantané machine collecté par le core (specs auto d'un rapport de bug). Champs volontairement
// larges : le formulaire les AFFICHE, il ne les saisit pas.
export interface BugContext {
  ok: boolean;
  collectedAt: number;
  app: { version: string; home: string; lang: string | null };
  os: { label: string; platform: string; arch: string; release: string };
  cpu: { name: string; threads: number };
  memory: { totalMB: number; freeMB: number };
  gpu: {
    devices: { name: string; vendor: string; driverVersion: string | null; role: string }[];
    label: string | null;
    vram: { name: string; totalMB: number; freeMB: number } | null;
  };
  runtime: {
    node: string;
    python: string;
    backends: { ml: string; onnx: string; transcribe: string };
    ffmpeg: string | null;
  };
  encoding: { h264: string | null; h265: string | null; av1: string | null; hardware: string[] } | null;
  storage: { home: string; disk: { totalGB: number; freeGB: number } | null };
  setup: { completedAt: number | null; modules: string[]; models: string[]; pythonFound: boolean; ffmpegFound: boolean };
}
// Rapport de bug envoyé au webhook Discord (via le core). Screenshots en base64, logs déjà sérialisés.
// Les libellés (`*Label`) accompagnent les identifiants : le rapport reste lisible dans la langue du
// testeur sans que le core ait à dupliquer la taxinomie du renderer.
export interface BugReportRequest {
  category: string;
  categoryLabel?: string;
  /** Sujet nommé par le testeur quand la catégorie ne le dit pas (« Autre », « Question »). */
  categoryDetail?: string | null;
  severity: string;
  severityLabel?: string;
  frequency: string;
  frequencyLabel?: string;
  module?: string | null;
  moduleLabel?: string | null;
  issueText: string;
  stepsText?: string | null;
  expectedText?: string | null;
  videoReference?: string | null;
  /** Specs tapées à la main quand le service n'a pas pu les lire. */
  manualSpecs?: string | null;
  contact?: { discordId?: string | null; discordName?: string | null; text?: string | null } | null;
  locale?: string | null;
  activeHost?: string | null;
  hostConnected?: boolean;
  /** Pièces jointes : captures, vidéos, fichiers. */
  attachments: { name: string; mimeType: string; sizeBytes: number; dataBase64: string }[];
  consoleLogs: string;
  consoleLogCount: number;
  errorCount?: number;
  warnCount?: number;
  redactionApplied: boolean;
  /** Relais Convex (site + session) quand l'app n'a pas de webhook direct. Le core valide le site. */
  relay?: { site: string; cookie: string } | null;
}
export interface BugReportResponse { ok: boolean; message: string; reportId?: string }

export interface NrApi {
  gpuStatus(): Promise<GpuStatus>;
  // Optimisation : diagnostic (lecture seule), contrôle de la file de rendu (arrêt), nettoyage cache.
  optimizeDiagnose(): Promise<OptimizeDiagnosis>;
  optimizeRenderJobs(): Promise<{ connected: boolean; jobs: OptimizeRenderJob[]; inProgress: boolean; error?: string }>;
  optimizeStopRender(): Promise<{ ok: boolean; error?: string }>;
  optimizeClearRenderQueue(): Promise<{ ok: boolean; error?: string }>;
  // Retire de la file uniquement les jobs terminés (Complete/Failed/Cancelled).
  optimizeClearFinishedJobs(): Promise<{ ok: boolean; removed?: number; error?: string }>;
  optimizeDeleteRenderJob(id: string): Promise<{ ok: boolean; error?: string }>;
  // Flush RAM : save → close → reopen du projet courant (libère les timelines empilées en mémoire).
  optimizeReloadProject(): Promise<{ ok: boolean; project?: string; error?: string }>;
  // Bascule Resolve sur une page légère (relâche le pipeline Couleur/Fusion qui occupe le GPU).
  optimizeOpenPage(page: string): Promise<{ ok: boolean; page?: string | null; error?: string }>;
  // Libère une ressource : arrête la charge NetsuRush + nettoie les applis figées (+ trim RAM), puis relit la jauge.
  optimizeFreeGpu(): Promise<{ ok: boolean; proxiesKilled?: number; deadKilled?: number; vramFreedMB?: number; vram?: OptimizeVram | null; error?: string }>;
  optimizeFreeCpu(): Promise<{ ok: boolean; proxiesKilled?: number; deadKilled?: number; cpu?: number | null; error?: string }>;
  optimizeFreeRam(): Promise<{ ok: boolean; deadKilled?: number; ramFreed?: number; ram?: { free: number; total: number }; error?: string }>;
  // Gestionnaire de ressources système : top processus du PC (RAM + VRAM) et terminaison d'un PID.
  optimizeListProcesses(): Promise<{ ok: boolean; procs: OptimizeProc[]; error?: string }>;
  optimizeKillProcess(pid: number): Promise<{ ok: boolean; error?: string }>;
  // Processus figés (« Ne répond pas ») : liste + nettoyage auto des non-critiques (résidus).
  optimizeDeadProcesses(): Promise<{ ok: boolean; procs: OptimizeDeadProc[]; error?: string }>;
  optimizeCleanDead(): Promise<{ ok: boolean; killed?: number; names?: string[]; error?: string }>;
  // Bruit d'arrière-plan (updaters, superpositions, synchro) : ces tâches-là RÉPONDENT très bien,
  // donc `optimizeCleanDead` ne les voit jamais. Liste arrêtable + arrêt groupé.
  optimizeNoiseProcesses(): Promise<{ ok: boolean; procs: OptimizeProc[]; error?: string }>;
  optimizeKillNoise(pids: number[]): Promise<{ ok: boolean; killed: number; names: string[]; skipped: number }>;
  // Surveillance mémoire pendant les tâches lourdes (état poussé aussi en SSE `optimize:watchdog`).
  optimizeWatchdog(): Promise<OptimizeWatchdogState>;
  optimizeSetWatchdog(prefs: Partial<OptimizeWatchdogPrefs>): Promise<OptimizeWatchdogState>;
  optimizeDismissWatchdog(): Promise<OptimizeWatchdogState>;
  onOptimizeWatchdog(cb: (state: OptimizeWatchdogState) => void): () => void;
  // Moniteur live VRAM/RAM/disque (pollé) → alerte avant saturation = crash.
  optimizeResources(root?: string): Promise<OptimizeResources>;
  optimizeSessionHealth(): Promise<OptimizeSessionHealth>;
  optimizePrefs(): Promise<OptimizePrefs>;
  optimizeApplyPrefs(changes: Record<string, boolean | number | string>): Promise<OptimizeApplyPrefs>;
  optimizePrefsBackups(): Promise<{ ok: boolean; dir: string; backups: OptimizePrefBackup[] }>;
  optimizeRestorePrefs(name: string): Promise<{ ok: boolean; restored?: string[]; error?: string }>;
  // Point de restauration : export .drp du projet courant (crash = ré-import, zéro perte).
  optimizeSnapshot(): Promise<{ ok: boolean; path?: string; name?: string; size?: number; error?: string }>;
  optimizeListSnapshots(): Promise<{ ok: boolean; dir: string; snapshots: OptimizeSnapshot[] }>;
  optimizeScanCache(root: string): Promise<OptimizeCacheScan>;
  optimizeCleanCache(paths: string[]): Promise<OptimizeCleanResult>;
  // NetsuBoost Premiere/AE. Diagnostic et processus marchent sans le panneau CEP (données disque et
  // table des process) ; purges, réglages et proxies l'exigent — l'UI dégrade au lieu de bloquer.
  boostDiagnose(app: AdobeApp): Promise<BoostDiagnosis>;
  boostProcs(): Promise<{ ok: boolean; procs: BoostProc[]; total?: number; error?: string }>;
  boostScanCache(app: AdobeApp, dir: string): Promise<BoostCacheScan>;
  // Application ouverte → refus `APP_RUNNING`, sauf `restart:true` qui enchaîne fermer → purger → rouvrir.
  boostCleanCache(app: AdobeApp, targets: BoostCleanTarget[], opts?: { restart?: boolean }): Promise<BoostCleanResult>;
  boostPurge(app: AdobeApp, target: string): Promise<BoostPurgeResult>;
  boostHygiene(app: AdobeApp, op: string): Promise<{ ok: boolean; mode?: string; removed?: number; code?: string; error?: string }>;
  // Premiere : passe par le QE DOM, non documenté et variable d'un build à l'autre → `experimental`.
  boostDeletePreviews(app: AdobeApp): Promise<{ ok: boolean; experimental?: boolean; code?: string; error?: string }>;
  boostPrefs(app: AdobeApp): Promise<BoostPrefs>;
  boostApplyPrefs(app: AdobeApp, changes: Record<string, boolean | number | string>): Promise<{ ok: boolean; applied?: number; error?: string }>;
  boostProxyAudit(app: AdobeApp): Promise<BoostProxyAudit>;
  boostAttachProxies(app: AdobeApp, pairs: { path: string; proxy: string }[]): Promise<BoostAttachResult>;
  boostSetEnableProxies(app: AdobeApp, on: boolean): Promise<{ ok: boolean; error?: string }>;
  onBoostProgress(cb: (p: BoostProgress) => void): () => void;
  // Langue de l'UI : lecture/écriture durable dans nr.config.json (le renderer applique via localStorage).
  configGet(): Promise<{ lang: string | null }>;
  // Réglages du renderer PARTAGÉS entre origines (app Tauri, panneau CEP, fenêtres détachées) :
  // `localStorage` est par origine, donc les défauts de détection/export y divergeaient et le même
  // rush ressortait « pas découpé » d'un côté. Sac clé→valeur opaque pour le core.
  prefsGet(): Promise<{ ok: boolean; prefs: Record<string, unknown> }>;
  prefsSet(patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  onPrefsChanged(cb: (p: { patch: Record<string, unknown> }) => void): () => void;
  // Miroir DURABLE du localStorage (cf. core/uistate.js). Le profil WebView2 n'est pas un stockage
  // sûr : recréé ou nettoyé, il ramenait toute l'interface à ses valeurs par défaut. Sac
  // clé→valeur opaque ; `null` dans un patch supprime la clé.
  uiStateGet(): Promise<{ ok: boolean; state: Record<string, string> }>;
  uiStateSet(patch: Record<string, string | null>): Promise<{ ok: boolean; error?: string }>;
  onUiStateChanged(cb: (p: { patch: Record<string, string | null> }) => void): () => void;
  configSetLang(lang: string): Promise<{ ok: boolean; error?: string }>;
  // Rich Presence Discord. Le core tient la connexion, le throttle de 15 s et l'état persisté ; le
  // renderer se contente de lire l'état, pousser les réglages et signaler le contexte courant.
  discordState(): Promise<DiscordState>;
  discordSetPrefs(patch: Partial<DiscordPrefs>): Promise<DiscordState>;
  discordSetContext(ctx: { module?: string | null; project?: string | null }): Promise<DiscordState>;
  onDiscordChanged(cb: (s: DiscordState) => void): () => void;
  // Provisionnement sélectif (socle + packs des pages + modèles choisis) — app packagée.
  setupStatus(): Promise<SetupStatus>;
  setupRun(options: SetupRunOptions): Promise<SetupRunResult>;
  compatibilityStatus(opts?: { force?: boolean }): Promise<CompatibilityStatus>;
  onSetupProgress(cb: (p: SetupProgress) => void): () => void;
  // Console / journal (Paramètres › Console) : historique des logs core+python, vidage, flux temps réel.
  consoleLogs(): Promise<{ ok: boolean; logs: ConsoleLogEntry[] }>;
  consoleClear(): Promise<{ ok: boolean }>;
  onConsoleLog(cb: (e: ConsoleLogEntry) => void): () => void;
  // Rapport de bug → webhook Discord (configuré hors dépôt). `configured` = webhook présent côté core.
  bugReport(request: BugReportRequest): Promise<BugReportResponse>;
  bugStatus(): Promise<{ ok: boolean; configured: boolean; maxAttachments?: number; maxAttachmentMB?: number }>;
  // Specs de la machine, lues par le core (jamais saisies par le testeur).
  bugContext(): Promise<BugContext | { ok: false }>;
  status(): Promise<ResolveInfo>;
  listMediaPool(): Promise<MediaList>;
  importToMediaPool(paths: string[]): Promise<{ ok: boolean; count?: number; error?: string }>;
  // Import dans un bin dédié du Media Pool (créé s'il manque, fichiers déjà présents sautés) —
  // ex. « Audios » pour les enregistrements voix off du module Script.
  importToBin(paths: string[], bin: string): Promise<{ ok: boolean; count?: number; skipped?: number; error?: string }>;
  buildTimeline(opts: { name: string; input: string; srcFrames?: number; mode?: "append" | "new"; timelineName?: string; whole?: boolean; dest?: "timeline" | "bin"; binName?: string; videoOnly?: boolean; insertion?: "insert" | "overwrite" | "replace" | "fit" | "above" | "end" | "ripple_overwrite"; segments?: { in: number; out: number; inFrame?: number; outFrame?: number }[]; colors?: string[] }): Promise<{ ok: boolean; timeline?: string; count?: number; dir?: string; error?: string; mapped?: boolean; mode?: string; created?: boolean; fpsMismatch?: boolean; timelineFps?: number; clipFps?: number; whole?: boolean; renamed?: boolean; requestedName?: string; colored?: number }>;
  // Découpe en lot : liste des timelines du projet, et découpe de tous les rushs d'une timeline.
  listTimelines(): Promise<{ ok: boolean; current?: string | null; timelines: { name: string; current: boolean }[]; cached?: boolean; error?: string }>;
  // Timelines rangées par bin Media Pool (arbre de dossiers) — navigateur Timeline Live.
  timelineTree(): Promise<{ ok: boolean; current?: string | null; timelines: { name: string; bin: string; current: boolean }[]; cached?: boolean; error?: string }>;
  // Vignette de chaque timeline : son 1er plan source ({ name, path, in sec }) → généré en lazy via thumbnail().
  // Streamé : chaque résultat est aussi poussé via onTimelineThumb (remplissage progressif). refresh = ignore le cache.
  // project = nom du projet courant : un changement (≠ projet du cache core) force un rescan (cache obsolète).
  timelineThumbs(opts?: { refresh?: boolean; project?: string }): Promise<{ ok: boolean; thumbs: { name: string; path: string; in: number }[]; cached?: boolean; error?: string }>;
  onTimelineThumb(cb: (t: { name: string; path: string; in: number }) => void): () => void;
  // mode : 'new' (défaut, timeline découpée à côté) ou 'replace' → UNE SEULE timeline (supprime
  // l'originale + renomme la nouvelle à son nom, pas de doublon).
  cutTimeline(opts: { timelineName?: string; model?: DetectModel; threshold?: number; detectionOptions?: DetectOptions; name?: string; mode?: "new" | "replace" }): Promise<{ ok: boolean; timeline?: string; source?: string; clips?: number; shots?: number; mode?: string; replaced?: boolean; gap?: number | null; diag?: Record<string, unknown> | null; error?: string }>;
  onTimelineCutProgress(cb: (p: { file: string; done: number; total: number; pct: number | null; phase: string }) => void): () => void;
  // Éditeur de coupes in-app : analyse (détecte les plans, RIEN construit) → structure éditable →
  // build depuis la structure (plans fusionnés/supprimés). Voie FCPXML (through-edits).
  analyzeTimelineCut(opts: { timelineName?: string; model?: DetectModel; threshold?: number; detectionOptions?: DetectOptions }): Promise<CutAnalysis>;
  buildCutTimeline(opts: { name?: string; source?: string; clips: CutClip[]; mode?: "new" | "replace" }): Promise<{ ok: boolean; timeline?: string; source?: string; clips?: number; shots?: number; mode?: string; replaced?: boolean; error?: string }>;
  // Lit les plans déjà montés d'une timeline Resolve existante (Timeline Live). null = timeline ouverte.
  readTimelineCuts(opts?: { timelineName?: string }): Promise<TimelineCutsResult>;
  // Synchro Resolve→renderer : le core pousse les changements (poll lent + diff), refetch ciblé.
  onResolveChanged(cb: (c: ResolveChange) => void): () => void;
  // Poll immédiat côté core (déclenché au focus fenêtre).
  refreshNow(): void;
  probe(filePath: string): Promise<MediaInfo>;
  playInfo(filePath: string): Promise<PlayInfo>;
  streamUrl(filePath: string, t: number, mode: "copy" | "enc"): string;
  audioTracks(filePath: string): Promise<{ tracks: AudioTrack[]; error?: string }>;
  detectScenes(filePath: string, threshold?: number, model?: DetectModel, options?: DetectOptions): Promise<SceneResult>;
  cachedScenes(filePath: string, model?: DetectModel, threshold?: number, options?: DetectOptions): Promise<SceneResult>;
  // Nb de détections à lancer en parallèle selon la VRAM/RAM libres (1 = séquentiel).
  detectConcurrency(): Promise<number>;
  // Édits de découpe persistés (clé = chemin fichier source + modèle de détection, chaque modèle
  // ayant ses propres frontières de plans) : réappliqués à la réouverture/re-détection.
  getCutEdits(filePath: string, model: DetectModel, optionsKey?: string): Promise<CutEdits>;
  saveCutEdits(filePath: string, model: DetectModel, edits: CutEdits, optionsKey?: string): Promise<{ ok: boolean; error?: string }>;
  clearCutEdits(filePath: string, model: DetectModel, optionsKey?: string): Promise<{ ok: boolean; error?: string }>;
  // `path` = rush concerné (découpe en lot N en parallèle → route le pct vers le bon item) ; null en simple.
  onScenesProgress(cb: (p: { path: string | null; pct: number }) => void): () => void;
  proxy(opts: { input: string; start: number; end: number; priority?: "high" | "low"; height?: number; token?: number; codec?: "h264" | "hevc"; requireVideo?: boolean; requireAudio?: boolean; settings?: PreviewGenerationSettings["proxy"] }): Promise<{ ok: boolean; path?: string; error?: string; cancelled?: boolean }>;
  // Résout en UN appel les proxies DÉJÀ encodés d'un lot de plans (aucun ffmpeg, aucune file) :
  // `file` vaut null quand la plage n'est pas en cache. Une grille amorce ainsi son cache d'URL à
  // l'ouverture au lieu de laisser chaque carte réclamer le sien au défilement — cf. core/proxy.js.
  proxyResolve(
    items: { input: string; start: number; end: number }[],
    opts?: { height?: number; codec?: "h264" | "hevc"; settings?: PreviewGenerationSettings["proxy"] },
  ): Promise<{ input: string; start: number; end: number; file: string | null }[]>;
  proxyCancel(token: number): void;
  proxyCancelMany(tokens: number[]): void;
  proxyCancelAll(): void;
  // Renvoie le CHEMIN du jpeg en cache (à passer à mediaUrl() pour l'affichage), pas un data URI.
  // `priority` : "high" (défaut) pour une carte à l'écran, "low" pour une carte encore hors champ —
  // le core réserve ses derniers ouvriers aux demandes "high", donc une bande d'anticipation large
  // ne doit surtout pas y entrer en concurrence.
  thumbnail(filePath: string, time?: number, priority?: "high" | "low"): Promise<string | { error: string }>;
  compareRenderFrames(opts: RenderCompareOpts): Promise<RenderCompareResult>;
  thumbsBatch(filePath: string, items: { time: number; frame: number }[]): Promise<{ ok: boolean; made?: number; error?: string }>;
  // Résout en UN appel les chemins des vignettes DÉJÀ en cache (sans rien générer) → le renderer
  // amorce son cache d'un coup et n'émet plus 1 RPC par carte (scroll fluide même cache plein).
  thumbsResolve(items: { path: string; time: number }[]): Promise<{ path: string; time: number; file: string | null }[]>;
  exportClip(opts: { input: string; start: number; end: number; output: string }): Promise<ExportResult>;
  // Export piloté par profil (remux/encode, GPU/CPU choisi, per-clip ou fusion) — bouton « Télécharger ».
  exportClips(opts: ExportClipsOpts): Promise<ExportClipsResult>;
  // Codecs réellement encodables sur cette machine (sonde ffmpeg cachée côté core) → l'UI masque le
  // reste. `force` relance la sonde en ignorant le cache.
  exportCapabilities(opts?: { force?: boolean }): Promise<ExportCapabilitiesResult>;
  // Nom de fichier que produirait le gabarit du profil (éditeur de profil). Résolu par le MÊME code
  // que l'export réel côté core → l'aperçu ne peut pas diverger du fichier écrit.
  exportPreviewName(opts: { profile: ExportProfile; baseName?: string }): Promise<ExportNamePreview>;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;
  aeExport(opts: AeExportOpts): Promise<AeExportResult>;
  onAeProgress(cb: (p: AeProgress) => void): () => void;
  // Transfert de timeline d'un logiciel de montage vers un autre.
  transferSources(opts: { host: TransferHost }): Promise<TransferSourceList>;
  transferRead(opts: { host: TransferHost; to?: TransferHost; timelineName?: string }): Promise<TransferPreview>;
  transferRun(opts: TransferOpts): Promise<TransferResult>;
  onTransferProgress(cb: (p: TransferProgress) => void): () => void;
  // Pont Adobe : statut apps/panneau, snapshot projet lu par le panneau CEP, lancement, scan à distance.
  adobeStatus(): Promise<AdobeBridgeStatus>;
  adobeSnapshot(app: AdobeApp): Promise<AdobeSnapshot | null>;
  adobeLaunch(app: AdobeApp): Promise<{ ok: boolean; already?: boolean; error?: string }>;
  adobeScan(app: AdobeApp): Promise<{ ok: boolean }>;
  adobeBuildTimeline(opts: AdobeBuildOpts): Promise<AdobeBuildResult>;
  adobeImport(app: AdobeApp, paths: string[]): Promise<{ ok: boolean; count?: number; error?: string }>;
  adobeInstallPanel(): Promise<{ ok: boolean; dir?: string; debugSet?: string[]; restart?: AdobeApp[]; version?: string | null; error?: string }>;
  adobeSetPanelAutoUpdate(on: boolean): Promise<{ ok: boolean; autoUpdate?: boolean; error?: string }>;
  onAdobePanelUpdated(cb: (p: { version: string | null; restart: AdobeApp[] }) => void): () => void;
  adobeDiagnose(): Promise<AdobeDiagnostic>;
  onAdobeUpdate(cb: (p: { app: AdobeApp; at: number }) => void): () => void;
  // Module voix : transcription (sous-titres + montage par texte). input = vidéo source (Media Pool
  // ou locale) ; model = whisper-turbo (précis) | parakeet-v3 (rapide) ; lang = langue ASR.
  // verbatim = Whisper amorcé pour transcrire les hésitations (euh/hum) au lieu de les gommer.
  transcribe(opts: { input: string; model?: AsrModel; lang?: string; track?: number; verbatim?: boolean }): Promise<TranscriptResult>;
  // Détection de silences (Silero VAD). params = curseurs (seuil, durées mini, marge ms).
  detectSilences(opts: { input: string; params?: SilenceParams; track?: number }): Promise<SilenceResult>;
  // Détection ACOUSTIQUE des hésitations (librosa) dans les trous inter-mots + mots low-conf.
  detectFillers(opts: { input: string; words: VoiceWord[]; silences: VoiceSpan[]; params?: Record<string, number>; track?: number }): Promise<{ ok: boolean; fillers: FillerSpan[]; duration?: number; error?: string }>;
  // Sous-titres SRT/VTT depuis les mots ; segments = cut list conservée → recalage sur le montage final.
  exportSubtitles(opts: { words: VoiceWord[]; segments?: { in: number; out: number }[]; format?: SubtitleFormat; destPath?: string; maxChars?: number; maxDur?: number; dropFillers?: boolean; baseName?: string }): Promise<SubtitleResult>;
  // Export fichier monté (silences coupés) : MP4 réencodé ou FCPXML (timecode source préservé).
  exportCut(opts: { input: string; segments: { in: number; out: number }[]; format?: "mp4" | "fcpxml"; destPath?: string; fps?: number }): Promise<{ ok: boolean; path?: string; clips?: number; error?: string }>;
  // Enveloppe d'amplitude pour la waveform (peaks 0..1 + durée). startSec/endSec = fenêtre
  // optionnelle (zoom : pics haute résolution sur la plage visible ; start/end = plage servie).
  waveform(opts: { input: string; track?: number; buckets?: number; startSec?: number; endSec?: number }): Promise<{ ok: boolean; peaks?: number[]; duration?: number; start?: number; end?: number; error?: string }>;
  // Recherche par PAROLES dans les transcriptions en cache : hit au mot exact.
  searchTranscripts(opts: { query: string; limit?: number; perFile?: number }): Promise<{ ok: boolean; hits: TranscriptHit[]; files: number; error?: string }>;
  onVoiceProgress(cb: (p: VoiceProgress) => void): () => void;
  upscaleRun(opts: UpscaleOpts): Promise<UpscaleResult>;
  upscaleShaderRun(opts: UpscaleShaderOpts): Promise<UpscaleResult>;
  upscaleTestFrame(opts: UpscaleFrameOpts): Promise<UpscaleFrameResult>;
  onUpscaleProgress(cb: (p: UpscaleProgress) => void): () => void;
  processInterpolate(opts: InterpOpts): Promise<ProcessResult>;
  processDepth(opts: DepthOpts): Promise<ProcessResult>;
  processRemoveBg(opts: RemoveBgOpts): Promise<ProcessResult>;
  processTestFrame(opts: ProcessFrameOpts): Promise<ProcessFrameResult>;
  onProcessProgress(cb: (p: ProcessProgress) => void): () => void;
  // Gestionnaire de modèles app-wide : liste + statut, téléchargement à la demande, suppression, disque.
  modelsList(): Promise<ModelListResult>;
  /** `replace` = consentement explicite à désinstaller le modèle exclusif concurrent. */
  modelsDownload(id: string, replace?: boolean): Promise<ModelOpResult>;
  modelsImport(id: string, source: string): Promise<ModelOpResult>;
  modelsCancel(id: string): Promise<ModelOpResult>;
  modelsDelete(id: string): Promise<ModelOpResult>;
  modelsDiskUsage(): Promise<ModelDiskUsage>;
  modelsGpu(): Promise<GpuVram | null>;
  onModelsProgress(cb: (p: ModelProgress) => void): () => void;
  // Pipeline ordonné : une chaîne de transforms sur une source → une sortie.
  pipelineRun(opts: PipelineOpts): Promise<ProcessResult>;
  onPipelineProgress(cb: (p: PipelineProgress) => void): () => void;
  // Roto Studio : session SAM interactive multi-objets (points → masque immédiat → propagation →
  // matte / export alpha / suppression d'objet). `obj` = id d'objet (1..n, couleur côté UI).
  rotoOpen(opts: { video: string; in?: number; out?: number; model?: string }): Promise<RotoOpenResult>;
  rotoAddPoint(opts: { frame: number; x: number; y: number; label: 0 | 1; obj: number }): Promise<RotoMaskResult>;
  rotoClearPoints(opts: { frame?: number; obj?: number }): Promise<RotoMaskResult>;
  rotoUndoPoint(): Promise<RotoMaskResult>;
  rotoPreviewPoint(opts: { frame: number; x: number; y: number; label: 0 | 1; obj: number }): Promise<RotoMaskResult>;
  rotoMask(opts: { frame: number }): Promise<RotoMaskResult>;
  rotoSetPost(opts: RotoPost): Promise<{ ok: boolean; error?: string }>;
  rotoSetView(opts: RotoView): Promise<{ ok: boolean; error?: string }>;
  rotoSetObjects(opts: { names: Record<string, string> }): Promise<{ ok: boolean; error?: string }>;
  rotoRemovePoint(opts: { frame: number; obj: number; index: number }): Promise<RotoMaskResult>;
  rotoMovePoint(opts: { frame: number; obj: number; index: number; x: number; y: number }): Promise<RotoMaskResult>;
  rotoClearTracking(): Promise<{ ok: boolean; error?: string }>;
  rotoDedupe(opts?: { threshold?: number; restore?: boolean }): Promise<RotoDedupeResult>;
  rotoPropagate(opts?: RotoPropagateOpts): Promise<RotoResult>;
  rotoCancel(): Promise<{ ok: boolean; error?: string }>;
  rotoRefine(opts: RotoRefineOpts): Promise<RotoResult>;
  rotoSetRefined(opts: { on: boolean }): Promise<RotoResult>;
  rotoExport(opts: { format: string; mode?: string; out?: string; obj?: number; bg?: string }): Promise<RotoResult>;
  rotoObjectRemove(opts: RotoRemoveOpts): Promise<RotoResult>;
  onRotoProgress(cb: (p: RotoProgress) => void): () => void;
  // Dictée vocale (push-to-talk) : extrait micro (base64) → texte transcrit.
  dictateTranscribe(opts: { audioB64: string; mime?: string; model?: string; lang?: string; idleMs?: number }): Promise<{ ok: boolean; text?: string; error?: string }>;
  // Statut du moteur natif transcribe.cpp (binaire GGUF fourni par l'utilisateur).
  dictateCppStatus(): Promise<{ ok: boolean; bin: string; backend: string; error: string | null }>;
  indexClip(filePath: string, force?: boolean, frames?: SamplingFrames, model?: DetectModel, options?: DetectOptions): Promise<IndexResult>;
  // Nb d'indexations à lancer en parallèle selon la VRAM libre (1 = séquentiel). Pour le mode parallèle.
  indexConcurrency(): Promise<number>;
  warmSearchIndex(): Promise<{ ok: boolean; count?: number; backend?: string | null; error?: string | null }>;
  runSearch(opts: SearchOpts): Promise<SearchResult>;
  dedup(opts: { scenes?: SceneKey[]; filePath?: string; threshold?: number }): Promise<DedupResult>;
  cluster(opts: { scenes?: SceneKey[]; filePath?: string; k?: number }): Promise<ClusterResult>;
  search(text: string, topK?: number): Promise<SearchResult>;
  searchStatus(o?: { filePaths?: string[] }): Promise<SearchStatus>;
  // Variante SigLIP active + ce que chaque variante a déjà indexé (chaque variante a son propre
  // index : basculer n'écrase rien, mais la nouvelle repart de zéro).
  searchModelState(): Promise<SearchModelState>;
  searchSetModel(id: string): Promise<SearchModelState & { error?: string; needsDownload?: boolean }>;
  // Projets de montage déjà ouverts dans NetsuRush + leurs rushs (portée de recherche multi-projets).
  projects(): Promise<ProjectScopeList>;
  forgetProject(name: string): Promise<{ ok: boolean }>;
  // Union des rushs des projets nommés (portée effective envoyée aux commandes de recherche).
  projectPaths(names: string[]): Promise<{ paths: string[]; error?: string | null }>;
  // Recensement des projets existants : Resolve ouvre chaque projet à tour de rôle pour relever ses
  // rushs, puis rouvre celui de départ. Action explicite (Paramètres › Stockage › Projets).
  scanProjects(): Promise<{ ok: boolean; scanned?: number; total?: number; failed?: string[]; error?: string }>;
  onProjectScan(cb: (p: ProjectScanProgress) => void): () => void;
  searchIndexed(): Promise<IndexedResult>;
  // Arrêt immédiat de l'indexation en cours (tue les daemons ; les jobs en vol rendent « annulée »).
  cancelIndexJobs(): Promise<{ ok: boolean }>;
  searchShots(filePath: string): Promise<ShotsResult>;
  faceIndex(filePath: string, force?: boolean, model?: string, options?: DetectOptions): Promise<IndexResult>;
  faceSearch(opts: { path?: string; filePath?: string; sceneIndex?: number; refs?: SearchRef[]; topK?: number; minScore?: number; filePaths?: string[] }): Promise<SearchResult>;
  // Visages détectés dans une image (picker de référence : cliquer LE visage à chercher).
  faceDetect(imagePath: string): Promise<FaceDetectResult>;
  faceStatus(o?: { filePaths?: string[] }): Promise<FaceStatus>;
  // Moteurs de visage disponibles (poids/dépendances présents) → proposer le téléchargement si absent.
  faceEngines(): Promise<{ anime: boolean; real: boolean; ready: boolean; error?: string | null }>;
  // État d'indexation des visages par clip (pour le sélecteur d'indexation des visages).
  faceIndexed(): Promise<{ indexed: Record<string, { faces: number; mtime: number }>; error?: string | null }>;
  // Galerie des visages détectés (regroupés par identité) → cliquer pour chercher directement.
  faceGallery(o?: { topK?: number; minSize?: number; filePaths?: string[] }): Promise<{ faces: GalleryFace[]; error?: string | null }>;
  // Bibliothèque de personnages nommés (roster + auto-étiquetage de l'index).
  charList(o?: { filePaths?: string[] }): Promise<{ characters: Character[]; error?: string | null }>;
  charCreate(o: { name: string; notes?: string; tags?: string[]; color?: string }): Promise<{ id: number | null; error?: string | null }>;
  charUpdate(o: { id: number; name?: string; notes?: string; tags?: string[]; color?: string }): Promise<{ ok: boolean; error?: string | null }>;
  charDelete(id: number): Promise<{ ok: boolean; error?: string | null }>;
  charAddSample(o: CharRef & { charId: number }): Promise<{ ok: boolean; added: number; error?: string | null }>;
  charRemoveSample(id: number): Promise<{ ok: boolean; error?: string | null }>;
  charSamples(charId: number): Promise<{ samples: CharSample[]; error?: string | null }>;
  charIdentify(o: { refs: CharRef[]; minScore?: number }): Promise<{ matches: (CharMatch | null)[]; error?: string | null }>;
  charSearch(o: { charId: number; topK?: number; minScore?: number; filePaths?: string[] }): Promise<SearchResult>;
  charShots(o: { charId: number; topK?: number; filePaths?: string[] }): Promise<SearchResult>;
  charLabelIndex(o?: { minScore?: number }): Promise<{ ok: boolean; labeled?: number; faces?: number; error?: string | null }>;
  charMerge(o: { sourceId: number; targetId: number }): Promise<{ ok: boolean; target_id?: number; error?: string | null }>;
  charDuplicates(o?: { minScore?: number }): Promise<{ pairs: DuplicatePair[]; error?: string | null }>;
  onSearchProgress(cb: (p: { pct: number | null; phase: string; kind?: "clip" | "face" | "label" }) => void): () => void;
  startDrag(file: string): void;
  chooseDir(): Promise<string | null>;
  chooseFiles(): Promise<string[] | null>;
  chooseMediaFiles(): Promise<string[] | null>;
  chooseImages(): Promise<string[] | null>;
  chooseAnyFile(): Promise<string | null>;
  // Chemins disque d'objets File lâchés depuis l'Explorateur (Chromium masque `File.path`). Index
  // aligné sur `files` ; chaîne vide quand le chemin est irrésoluble (navigateur, WebView2 ancien).
  pathsForFiles(files: File[]): Promise<string[]>;
  saveFile(defaultName?: string): Promise<string | null>;
  mediaUrl(filePath: string): string;
  // URL d'un fichier local pour les GRILLES d'aperçus (vignettes + proxys de lecture).
  //
  // `mediaUrl` sort du serveur HTTP du core, qui porte AUSSI /rpc et le flux SSE. Chromium n'ouvre
  // que 6 connexions HTTP/1.1 par origine : une prise par /events, quelques-unes par les RPC en vol,
  // et il reste ~4 créneaux pour des dizaines de <video>. C'est ce qui laisse la moitié d'une grille
  // figée sur sa vignette même quand TOUS les proxys sont déjà encodés — le fichier existe, il
  // attend juste un créneau de connexion.
  //
  // Sous Tauri on passe donc par le protocole ASSET (`convertFileSrc`) : la requête est interceptée
  // dans le processus par la coquille Rust, sans socket ni pool de connexions. Hors Tauri (panneau
  // CEP, navigateur) il n'existe pas → repli sur `mediaUrl`.
  assetUrl(filePath: string): string;
  // Flux d'une vidéo YouTube relayé par le core (yt-dlp résout, le core relaie) : source d'un
  // `<video>` ordinaire, donc AUCUN habillage YouTube — cf. core/ytstream.js.
  ytStreamUrl(videoId: string): string;
  openExternal(url: string): Promise<boolean>;
  openPath(path: string): Promise<boolean>;
  revealPath(path: string): Promise<boolean>;
  // Épingle la fenêtre principale au-dessus des autres (always-on-top), pour la garder visible
  // dans un coin de l'écran tout en travaillant dans Resolve. No-op hors Tauri.
  setAlwaysOnTop(on: boolean): void;
  // Redimensionne la fenêtre principale (taille logique). Sert à passer en petit format « coin »
  // quand on épingle, et à réagrandir au dépinglage (le responsif est inconfortable en très étroit).
  setWindowSize(w: number, h: number): void;
  reference?: RefApi;
  wallpaper?: WallpaperApi;
  script?: ScriptApi;
  notebook?: NotebookApi;
  collections?: CollectionsApi;
  library?: LibraryApi;
  chat?: ChatApi;
  outbox?: OutboxApi;
  power?: PowerApi;
  snapshot?: SnapshotApi;
  cache?: CacheApi;
}

// ---- Registre projet → rushs (portée de recherche) ---------------------------------------------
// L'index de recherche ne connaît que des chemins de fichiers : ce registre, alimenté à chaque
// lecture du Media Pool, dit quels rushs appartiennent à quel projet.
export interface ProjectScopeEntry {
  name: string;
  at: number;        // dernière lecture du Media Pool de ce projet (ms epoch)
  count: number;     // nb de rushs connus
  current: boolean;  // projet actuellement ouvert dans le logiciel de montage
}
export interface ProjectScanProgress {
  done: number;
  total: number;
  project: string | null;
  finished?: boolean;
}
export interface ProjectScopeList {
  projects: ProjectScopeEntry[];
  current: string | null;
  error?: string | null;
}

// ---- Snapshot projet (cache offline servi quand l'hôte de montage est fermé) --------------------
export interface SnapshotProgress { msg: string | null; pct: number | null; done?: boolean }
export interface SnapshotApi {
  state(): Promise<SnapshotState | null>;
  clear(): Promise<{ ok: boolean }>;
  // Lecture INSTANTANÉE d'une tranche du cache (zéro appel Resolve) : affichage stale-while-revalidate
  // — on peint le snapshot tout de suite, la lecture live remplace ensuite. Mêmes formes que les
  // replis offline des canaux resolve:* (cached:true). null = tranche absente du cache.
  peek(kind: "mediaPool"): Promise<MediaList | null>;
  peek(kind: "cuts", timelineName: string): Promise<TimelineCutsResult | null>;
  peek(kind: "timelines" | "tree" | "thumbs"): Promise<any | null>;
  // Construit/rafraîchit le cache offline EN LIGNE (arrière-plan). Incrémental sauf `force`.
  build(opts?: { force?: boolean; project?: string; refreshTimeline?: string }): Promise<{ ok: boolean; clips?: number; timelines?: number; fresh?: number; error?: string }>;
  onChanged(cb: (s: SnapshotState | null) => void): () => void;
  onProgress(cb: (p: SnapshotProgress) => void): () => void;
}

// --- Cache médias (Paramètres › Stockage) ------------------------------------------------------
/** Types de cache gérables. Miroir de CACHE_KINDS (core/config.js) — source unique côté core.
 *  L'ordre est celui d'AFFICHAGE, groupé par famille : les deux caches de vignettes se suivent,
 *  qu'ils vivent en fichiers ou en base — c'est le même contenu, le lieu de stockage n'intéresse
 *  personne. Le core rend ses types dans l'ordre de ses racines, donc l'UI retrie sur cette liste. */
export const CACHE_KIND_LIST = ["thumb", "indexThumbs", "proxy", "voice", "upscaleTest", "roto", "scenes", "transcripts", "embeddings", "faces"] as const;
export type CacheKind = (typeof CACHE_KIND_LIST)[number];

export interface CacheKindStat {
  kind: CacheKind;
  /** Session = supprimé à la fermeture ; reusable = aperçu borné ; durable = analyse coûteuse. */
  lifecycle: "session" | "reusable" | "durable";
  /** Dossier du cache, ou chemin de netsurush.db pour les types stockés en base. */
  dir: string;
  /** Poids connu de l'index (ou de la base). */
  bytes: number;
  files: number;
  /** Poids réel du dossier ; null pour les types en base. Un écart avec `bytes` = ce que
   *  « Réindexer » n'a pas encore rattrapé (caches antérieurs à l'index). */
  onDisk: number | null;
}

export interface CacheOverview {
  ok: boolean;
  kinds: CacheKindStat[];
  /** Poids connu de l'index. */
  total: number;
  /** Poids réel des dossiers de cache, indexés ou non. Supérieur à `total` tant que « Réindexer »
   *  n'a pas rattrapé les caches antérieurs à l'index. */
  totalOnDisk: number;
  /** Dossier de cache choisi (vignettes + proxies), null = emplacements par défaut. */
  root: string | null;
  defaults: { thumb: string; proxy: string };
  disk: { total: number; free: number; used: number } | null;
  db: { path: string; bytes: number; available: boolean };
  faiss: { bytes: number; files: number };
  models: { totalBytes: number; byTask: Record<string, number> };
  indexBackend: string;
}

export interface CacheRush {
  source: string;
  name: string;
  bytes: number;
  byKind: Partial<Record<CacheKind, number>>;
}
export interface CacheFolder {
  folder: string;
  bytes: number;
  rushes: CacheRush[];
}
export interface CacheTree {
  ok: boolean;
  folders: CacheFolder[];
  /** Entrées dont le rush source est inconnu (cache écrit avant l'index, ou clé non rejouable).
   *  Purgeables en bloc. */
  unattributed: { bytes: number; files: number; byKind: Partial<Record<CacheKind, number>> };
}

/** Une politique par type : quota (Go, appliqué en LRU) et âge (jours sans usage), activables
 *  séparément. `auto` est faux par défaut — rien n'est supprimé sans opt-in. */
export interface CacheKindPolicy {
  auto: boolean;
  maxGb: number | null;
  maxDays: number | null;
}
export type SessionCleanupTrigger = "operation" | "page" | "app";
export interface CacheSettings {
  policyVersion: number;
  dir: string | null;
  session: {
    roto: SessionCleanupTrigger;
    upscaleTest: SessionCleanupTrigger;
    voice: Exclude<SessionCleanupTrigger, "operation">;
  };
  /** Avertit sans supprimer. */
  warn: { enabled: boolean; gb: number };
  disk: { enabled: boolean; freeGb: number };
  kinds: Record<CacheKind, CacheKindPolicy>;
}

export interface CacheWarn {
  alerts: { kind: "cache" | "disk"; bytes?: number; gb?: number; freeGb?: number }[];
  total: number;
  at: number;
}
export interface CacheProgress {
  phase: "scan" | "index" | "move";
  done: number;
  total: number;
  pct: number;
}
export interface CacheClearResult {
  ok: boolean;
  freed?: number;
  files?: number;
  rows?: number;
  skipped?: number;
  error?: string;
}

export interface CacheApi {
  overview(): Promise<CacheOverview>;
  tree(): Promise<CacheTree>;
  /** Purge. `sources` = ces rushs seulement ; `kinds` seul = ce type en entier ; `unattributed` = le
   *  reliquat non attribué. Chaque chemin est revalidé côté core avant suppression. */
  clear(opts: { kinds?: CacheKind[]; sources?: string[]; unattributed?: boolean }): Promise<CacheClearResult>;
  /** Purge les médias d'aperçu d'anciennes plages de timeline, sans toucher aux autres rushs. */
  purgePreviewRanges(ranges: { path: string; start: number; end: number }[]): Promise<CacheClearResult>;
  /** Rushs indexés dont le fichier a disparu. Rapport seul (un disque débranché ne purge rien). */
  missing(): Promise<{ ok: boolean; sources: { source: string; bytes: number }[] }>;
  /** Compacte netsurush.db après une grosse purge. Échoue si un sidecar tient la base. */
  vacuum(): Promise<{ ok: boolean; freed?: number; error?: string }>;
  settings(): Promise<CacheSettings>;
  setSettings(patch: Partial<CacheSettings>): Promise<{ ok: boolean; error?: string; settings?: CacheSettings }>;
  check(): Promise<CacheWarn>;
  /** Signale une fin d'opération ou une sortie de page. Le core applique uniquement les types dont
   * la politique correspond au déclencheur. */
  sessionEvent(opts: { trigger: Exclude<SessionCleanupTrigger, "app">; kinds: CacheKind[] }): Promise<CacheClearResult>;
  /** Déplace le cache vignettes+proxies. `migrate: "move"` transporte l'existant, `"leave"` le laisse
   *  sur place (l'ancien dossier reste listé et purgeable). */
  setDir(opts: { dir: string | null; migrate?: "move" | "leave" }): Promise<{ ok: boolean; dirs?: { thumb: string; proxy: string }; moved?: number; total?: number; error?: string }>;
  /** Rattrape les caches déjà sur disque : l'index ne connaît que ce qui a été écrit depuis lui. */
  reindex(): Promise<{ ok: boolean; added: number; attributed: number }>;
  onProgress(cb: (p: CacheProgress) => void): () => void;
  onWarn(cb: (w: CacheWarn) => void): () => void;
  onChanged(cb: (c: { freed: number; files: number; rows?: number }) => void): () => void;
}

// ---- Fermer / rouvrir le logiciel de montage (libérer RAM/GPU pendant une tâche lourde) --------
export type PowerHost = "resolve" | "ppro" | "aeft";
export interface PowerClosed { host: PowerHost; project: string | null; projectPath?: string | null; page?: string | null; folder?: string[]; database?: Record<string, unknown> | null; at: number; }
export interface PowerState { closed: PowerClosed | null; busy: boolean; }
export interface PowerProgress { msg: string; pct: number | null; }
export interface PowerApi {
  state(): Promise<PowerState>;
  // Efface un état « fermé » périmé si le logiciel est en réalité détecté ouvert (réouverture externe).
  reconcile(): Promise<PowerState>;
  close(host: PowerHost): Promise<{ ok: boolean; project?: string | null; already?: boolean; error?: string }>;
  reopen(): Promise<{ ok: boolean; host?: PowerHost; project?: string | null; error?: string }>;
  // Fermer + rouvrir d'un geste, sur le même projet et la même page.
  restart(host: PowerHost): Promise<{ ok: boolean; host?: PowerHost; project?: string | null; error?: string }>;
  onChanged(cb: (s: PowerState) => void): () => void;
  onProgress(cb: (p: PowerProgress) => void): () => void;
}

// ---- « Cache projet » : file d'attente des envois différés (hôte fermé) ----------------------
export type OutboxHost = "resolve" | "ppro" | "aeft";
export interface OutboxEntry {
  id: string;
  ts: number;
  host: OutboxHost;
  kind: string;               // "buildTimeline"
  label: string;              // libellé humain (« Rush X — 12 plans »)
  opts: Record<string, unknown>; // opts rejoués (buildTimeline / adobeBuildTimeline)
  status: "pending" | "done" | "error";
  result?: string | null;     // nom de la timeline créée
  error?: string;
  appliedAt?: number;
}
export interface OutboxSettings {
  enabled: boolean;
  delaySec: number;
  target: "new" | "single";   // 'new' = 1 timeline/entrée ; 'single' = timeline collectrice unique
  targetName: string;
  keepDone: number;
}
export interface OutboxState { entries: OutboxEntry[]; settings: OutboxSettings; }
export interface OutboxApi {
  list(): Promise<OutboxState>;
  enqueue(entry: { host: OutboxHost; kind?: string; label: string; opts: Record<string, unknown> }): Promise<{ ok: boolean; id?: string; pending?: number }>;
  remove(id: string): Promise<{ ok: boolean }>;
  clear(which?: "all" | "done" | "pending"): Promise<{ ok: boolean }>;
  settings(): Promise<OutboxSettings>;
  setSettings(patch: Partial<OutboxSettings>): Promise<{ ok: boolean; settings: OutboxSettings }>;
  flush(host?: OutboxHost): Promise<{ ok: boolean; applied?: number; failed?: number; error?: string }>;
  onChanged(cb: (s: OutboxState) => void): () => void;
}

declare global {
  interface Window {
    nr?: NrApi;
  }
}

// Réglages Discord du mock : hors app, la vérité du core (NR_HOME/discord-rpc.json) n'existe pas, donc
// on retombe sur localStorage — juste assez pour que la carte des Paramètres réponde aux clics.
const MOCK_DISCORD_KEY = "nr-discord-prefs:v1";
function readMockStorage(key: string, legacyKey: string): string | null {
  if (typeof localStorage === "undefined") return null;
  const current = localStorage.getItem(key);
  if (current !== null) return current;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) localStorage.setItem(key, legacy);
  return legacy;
}
const MOCK_DISCORD_PREFS: DiscordPrefs = {
  enabled: false,
  showModule: true,
  showProject: false,
  showElapsed: true,
  detailsTpl: "",
  stateTpl: "",
};
function mockDiscordState(): DiscordState {
  let prefs = MOCK_DISCORD_PREFS;
  try {
    const raw = readMockStorage(MOCK_DISCORD_KEY, "nr-discord-prefs");
    if (raw) prefs = { ...MOCK_DISCORD_PREFS, ...JSON.parse(raw) };
  } catch {
    /* réglages illisibles : les défauts font l'affaire */
  }
  // Le vrai `preview` est calculé par le core (buildActivity) ; hors app on en donne un échantillon
  // figé, juste pour que la carte d'aperçu ait quelque chose à mettre en forme.
  const preview = {
    details: prefs.detailsTpl.trim() || "NetsuCut",
    state: prefs.stateTpl.trim() || undefined,
    timestamps: prefs.showElapsed ? { start: Math.floor(Date.now() / 1000) } : undefined,
  };
  // Le core résout le vrai nom/icône auprès de Discord ; hors app on ne fait pas l'appel réseau.
  return { enabled: prefs.enabled, connected: false, user: null, appId: false, prefs, error: null, preview, app: null };
}

const mock: NrApi = {
  gpuStatus: async () => ({ error: i18n.t("common:mock.resolveUnavailable") }),
  // Console / bug-report : inertes hors application (l'UI rend, aucun flux backend).
  consoleLogs: async () => ({ ok: true, logs: [] }),
  consoleClear: async () => ({ ok: true }),
  onConsoleLog: () => () => {},
  bugReport: async () => ({ ok: false, message: i18n.t("common:mock.outsideApp") }),
  bugStatus: async () => ({ ok: true, configured: false, maxAttachments: 8, maxAttachmentMB: 10 }),
  bugContext: async () => ({ ok: false as const }),
  // Optimisation : no-op hors app (l'UI rend mais ne pilote rien).
  optimizeDiagnose: async () => ({
    connected: false, project: null, timeline: null, version: null,
    settings: {}, render: { jobs: [], inProgress: false }, cacheRoots: [],
  }),
  optimizeRenderJobs: async () => ({ connected: false, jobs: [], inProgress: false }),
  optimizeStopRender: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  optimizeClearRenderQueue: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  optimizeClearFinishedJobs: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  optimizeDeleteRenderJob: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  optimizeReloadProject: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  optimizeOpenPage: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  optimizeFreeGpu: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  optimizeFreeCpu: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  optimizeFreeRam: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  optimizeListProcesses: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable"), procs: [] }),
  optimizeKillProcess: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  optimizeDeadProcesses: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable"), procs: [] }),
  optimizeCleanDead: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  optimizeNoiseProcesses: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable"), procs: [] }),
  optimizeKillNoise: async () => ({ ok: false, killed: 0, names: [], skipped: 0 }),
  optimizeWatchdog: async () => ({ prefs: null, armed: false, journal: [], suggestion: null }),
  optimizeSetWatchdog: async () => ({ prefs: null, armed: false, journal: [], suggestion: null }),
  optimizeDismissWatchdog: async () => ({ prefs: null, armed: false, journal: [], suggestion: null }),
  onOptimizeWatchdog: () => () => {},
  optimizeResources: async () => ({ gpu: null, ram: { free: 0, total: 0 }, cpu: null, resolveRam: null, disk: null }),
  optimizeSessionHealth: async () => ({ running: false, verdict: "ok" as const, samples: [] }),
  optimizePrefs: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable"), prefs: [] }),
  optimizeApplyPrefs: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  optimizePrefsBackups: async () => ({ ok: true, dir: "", backups: [] }),
  optimizeRestorePrefs: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  optimizeSnapshot: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  optimizeListSnapshots: async () => ({ ok: true, dir: "", snapshots: [] }),
  optimizeScanCache: async () => ({ ok: false, error: "mock", entries: [], disk: null }),
  optimizeCleanCache: async () => ({ ok: false, freed: 0, removed: [], skipped: [], error: "mock" }),
  // Hors application (vite dans un navigateur) : le diagnostic rend une forme VIDE mais complète pour
  // que l'onglet s'affiche entièrement ; les actions refusent comme les autres canaux Adobe.
  boostDiagnose: async (app) => ({
    ok: true,
    app,
    installed: false,
    running: false,
    exe: null,
    panelConnected: false,
    panelInstalled: false,
    project: null,
    projectPath: null,
    cacheRoots: [],
    cacheTotal: 0,
    disk: null,
    procs: [],
    procsRam: 0,
    live: null,
    liveError: null,
  }),
  boostProcs: async () => ({ ok: false, procs: [], total: 0, error: "appUnavailable" }),
  boostScanCache: async () => ({ ok: false, error: "appUnavailable" }),
  boostCleanCache: async () => ({ ok: false, error: "appUnavailable" }),
  boostPurge: async () => ({ ok: false, error: "appUnavailable" }),
  boostHygiene: async () => ({ ok: false, error: "appUnavailable" }),
  boostDeletePreviews: async () => ({ ok: false, error: "appUnavailable" }),
  boostPrefs: async () => ({ ok: false, prefs: [], error: "appUnavailable" }),
  boostApplyPrefs: async () => ({ ok: false, error: "appUnavailable" }),
  boostProxyAudit: async () => ({ ok: false, error: "appUnavailable" }),
  boostAttachProxies: async () => ({ ok: false, attached: 0, failed: [], total: 0, error: "appUnavailable" }),
  boostSetEnableProxies: async () => ({ ok: false, error: "appUnavailable" }),
  onBoostProgress: () => () => {},
  // Langue : hors app, la persistance durable vit dans localStorage (le renderer y écrit déjà).
  configGet: async () => ({ lang: typeof localStorage !== "undefined" ? localStorage.getItem("nr-lang") : null }),
  prefsGet: async () => ({ ok: true, prefs: {} }),
  prefsSet: async () => ({ ok: true }),
  onPrefsChanged: () => () => {},
  // Hors app (navigateur nu) : pas de disque, le localStorage local reste la seule persistance.
  uiStateGet: async () => ({ ok: true, state: {} }),
  uiStateSet: async () => ({ ok: true }),
  onUiStateChanged: () => () => {},
  configSetLang: async (lang) => {
    if (typeof localStorage !== "undefined") localStorage.setItem("nr-lang", lang);
    return { ok: true };
  },
  // Discord : hors app, pas de pipe IPC → jamais connecté. Les réglages restent modifiables (et
  // persistés localement) pour que la carte des Paramètres se pilote quand même dans un navigateur.
  discordState: async () => mockDiscordState(),
  discordSetPrefs: async (patch) => {
    const next = { ...mockDiscordState().prefs, ...patch };
    if (typeof localStorage !== "undefined") localStorage.setItem(MOCK_DISCORD_KEY, JSON.stringify(next));
    return mockDiscordState();
  },
  discordSetContext: async () => mockDiscordState(),
  onDiscordChanged: () => () => {},
  // Mock navigateur : tout est « prêt » → l'UI ne montre jamais l'écran d'installation hors app.
  setupStatus: async () => ({ ready: true, venv: true, ffmpeg: true, weights: true, home: "", items: [] }),
  setupRun: async () => ({ ok: true }),
  compatibilityStatus: async () => ({
    ok: true,
    hardware: { gpus: [], cpus: [], vendors: [], primaryVendor: "cpu", initialMlBackend: "cpu", initialOnnxBackend: "cpu", windowsBuild: 0, label: "CPU" },
    configured: { torch: "cpu", onnx: "cpu", transcribe: "cpu" },
    runtime: { torch: null, onnx: null, errors: [] },
    encoding: { h264: "h264_nvenc", h265: "hevc_nvenc", av1: null, webp: true, hardwareEncoders: ["h264_nvenc", "hevc_nvenc"], codecEncoders: { h264_main: "h264_nvenc", h264_high: "h264_nvenc", h265_main: "hevc_nvenc", h265_main10: "hevc_nvenc" }, codecEncoderOptions: { h264_main: ["h264_nvenc"], h265_main: ["hevc_nvenc"] }, upscaleProfileEncoderOptions: { h264_baseline: ["h264_nvenc"], h264_main: ["h264_nvenc"], h264_high: ["h264_nvenc"], h265_main: ["hevc_nvenc"], h265_main10: ["hevc_nvenc"], h265_rext444_8: ["hevc_nvenc"], h265_rext444_10: ["hevc_nvenc"] }, codecs: [], error: null },
  }),
  onSetupProgress: () => () => {},
  status: async () => ({ connected: false, error: i18n.t("common:mock.resolveUnavailable") }),
  listMediaPool: async () => ({ connected: false, clips: [], error: i18n.t("common:mock.resolveUnavailable") }),
  importToMediaPool: async () => ({ ok: false, error: "mock" }),
  importToBin: async () => ({ ok: false, error: "mock" }),
  buildTimeline: async () => ({ ok: false, error: "mock" }),
  listTimelines: async () => ({ ok: false, timelines: [], error: i18n.t("common:mock.resolveUnavailable") }),
  timelineTree: async () => ({ ok: false, timelines: [], error: i18n.t("common:mock.resolveUnavailable") }),
  timelineThumbs: async () => ({ ok: false, thumbs: [], error: i18n.t("common:mock.resolveUnavailable") }),
  onTimelineThumb: () => () => {},
  cutTimeline: async () => ({ ok: false, error: "mock" }),
  onTimelineCutProgress: () => () => {},
  analyzeTimelineCut: async () => ({ ok: false, clips: [], error: i18n.t("common:mock.resolveUnavailable") }),
  buildCutTimeline: async () => ({ ok: false, error: "mock" }),
  readTimelineCuts: async () => ({ ok: false, cuts: [], error: i18n.t("common:mock.resolveUnavailable") }),
  onResolveChanged: () => () => {},
  refreshNow: () => {},
  probe: async () => ({ duration: 0, width: 0, height: 0 }),
  playInfo: async () => ({ duration: 0, codec: "", pix: "", fps: 0, native: false }),
  streamUrl: (p, t, mode) => "nrstream://play?p=" + encodeURIComponent(p) + "&t=" + (t || 0) + "&mode=" + mode,
  audioTracks: async () => ({ tracks: [] }),
  detectScenes: async () => ({ scenes: [], duration: 0 }),
  cachedScenes: async () => ({ scenes: [], cached: false }),
  detectConcurrency: async () => 1,
  getCutEdits: async () => ({ merges: [], removed: [] }),
  saveCutEdits: async () => ({ ok: false }),
  clearCutEdits: async () => ({ ok: false }),
  onScenesProgress: () => () => {},
  proxy: async () => ({ ok: false, error: "mock" }),
  proxyResolve: async (items) => items.map((i) => ({ ...i, file: null })),
  proxyCancel: () => {},
  proxyCancelMany: () => {},
  proxyCancelAll: () => {},
  thumbnail: async () => ({ error: "mock" }),
  compareRenderFrames: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  thumbsBatch: async () => ({ ok: true, made: 0 }),
  thumbsResolve: async (items) => items.map((i) => ({ path: i.path, time: i.time, file: null })),
  exportClip: async () => ({ ok: false, error: "mock" }),
  exportClips: async () => ({ ok: false, error: "mock" }),
  // Hors app : aucune sonde possible → ok:false, donc le renderer ne masque AUCUN codec (l'UI se rend
  // entière dans un navigateur au lieu d'un menu de codecs vide).
  exportCapabilities: async () => ({ ok: false, codecs: [], cpuCodecs: [], hasGpuEncoder: false, hwEncoders: [], codecEncoderOptions: {}, error: "mock" }),
  // Hors app, le résolveur de noms n'est pas joignable. On rend VIDE plutôt qu'un nom fabriqué ici :
  // l'éditeur masque alors l'aperçu, au lieu d'afficher un nom qui ne serait celui d'aucun fichier.
  exportPreviewName: async () => ({ name: "", merged: "", tokens: [] }),
  onExportProgress: () => () => {},
  aeExport: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  onAeProgress: () => () => {},
  transferSources: async () => ({ ok: false, timelines: [], error: i18n.t("common:mock.resolveUnavailable") }),
  transferRead: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  transferRun: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  onTransferProgress: () => () => {},
  adobeStatus: async () => ({
    ok: false,
    ppro: { installed: false, exe: null, running: false, panelConnected: false, lastSnapshotAt: null },
    aeft: { installed: false, exe: null, running: false, panelConnected: false, lastSnapshotAt: null },
    panelInstalled: false,
  }),
  adobeSnapshot: async () => null,
  adobeLaunch: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  adobeScan: async () => ({ ok: false }),
  adobeBuildTimeline: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  adobeImport: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  adobeInstallPanel: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  adobeSetPanelAutoUpdate: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  onAdobePanelUpdated: () => () => {},
  adobeDiagnose: async () => ({ ok: false, panelDir: null, manifestExists: false, files: [], manifestHead: null, playerDebug: {}, cepLogs: [] }),
  onAdobeUpdate: () => () => {},
  transcribe: async () => ({ ok: false, words: [], error: i18n.t("common:mock.appUnavailable") }),
  detectSilences: async () => ({ ok: false, speech: [], silence: [], error: i18n.t("common:mock.appUnavailable") }),
  detectFillers: async () => ({ ok: false, fillers: [], error: i18n.t("common:mock.appUnavailable") }),
  exportSubtitles: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  exportCut: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  waveform: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  searchTranscripts: async () => ({ ok: false, hits: [], files: 0, error: i18n.t("common:mock.appUnavailable") }),
  onVoiceProgress: () => () => {},
  upscaleRun: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  upscaleShaderRun: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  upscaleTestFrame: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  onUpscaleProgress: () => () => {},
  processInterpolate: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  processDepth: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  processRemoveBg: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  processTestFrame: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  onProcessProgress: () => () => {},
  modelsList: async () => ({ ok: true, models: [] }),
  modelsDownload: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  modelsImport: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  modelsCancel: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  modelsDelete: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  modelsDiskUsage: async () => ({ ok: true, totalBytes: 0 }),
  modelsGpu: async () => null,
  onModelsProgress: () => () => {},
  pipelineRun: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  onPipelineProgress: () => () => {},
  rotoOpen: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoAddPoint: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoClearPoints: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoUndoPoint: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoPreviewPoint: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoMask: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoSetPost: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoSetView: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoSetObjects: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoRemovePoint: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoMovePoint: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoClearTracking: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoDedupe: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoPropagate: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoCancel: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoRefine: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoSetRefined: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoExport: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  rotoObjectRemove: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  onRotoProgress: () => () => {},
  dictateTranscribe: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
  dictateCppStatus: async () => ({ ok: false, bin: "", backend: "cpu", error: i18n.t("common:mock.appUnavailable") }),
  indexClip: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  indexConcurrency: async () => 1,
  warmSearchIndex: async () => ({ ok: true, count: 0 }),
  runSearch: async () => ({ hits: [] }),
  dedup: async () => ({ groups: [] }),
  cluster: async () => ({ clusters: [] }),
  search: async () => ({ hits: [] }),
  searchStatus: async () => ({ clips: 0, frames: 0 }),
  searchModelState: async () => ({ ok: false, active: "siglip2-so400m", models: [] }),
  searchSetModel: async () => ({ ok: false, active: "siglip2-so400m", models: [], error: i18n.t("common:mock.outsideApp") }),
  cancelIndexJobs: async () => ({ ok: false }),
  projects: async () => ({ projects: [], current: null }),
  forgetProject: async () => ({ ok: false }),
  projectPaths: async () => ({ paths: [] }),
  scanProjects: async () => ({ ok: false, error: i18n.t("common:mock.outsideApp") }),
  onProjectScan: () => () => {},
  searchIndexed: async () => ({ indexed: {} }),
  searchShots: async () => ({ shots: [] }),
  faceIndex: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
  faceSearch: async () => ({ hits: [] }),
  faceDetect: async () => ({ faces: [] }),
  faceStatus: async () => ({ faces: 0, clips: 0 }),
  faceEngines: async () => ({ anime: false, real: false, ready: false }),
  faceIndexed: async () => ({ indexed: {} }),
  faceGallery: async () => ({ faces: [] }),
  charList: async () => ({ characters: [] }),
  charCreate: async () => ({ id: null, error: i18n.t("common:mock.resolveUnavailable") }),
  charUpdate: async () => ({ ok: false }),
  charDelete: async () => ({ ok: false }),
  charAddSample: async () => ({ ok: false, added: 0 }),
  charRemoveSample: async () => ({ ok: false }),
  charIdentify: async () => ({ matches: [] }),
  charSearch: async () => ({ hits: [] }),
  charShots: async () => ({ hits: [] }),
  charSamples: async () => ({ samples: [] }),
  charLabelIndex: async () => ({ ok: false }),
  charMerge: async () => ({ ok: false }),
  charDuplicates: async () => ({ pairs: [] }),
  onSearchProgress: () => () => {},
  startDrag: () => {},
  chooseDir: async () => null,
  chooseFiles: async () => null,
  chooseMediaFiles: async () => null,
  chooseImages: async () => null,
  chooseAnyFile: async () => null,
  pathsForFiles: async (files) => files.map(() => ""),
  saveFile: async () => null,
  mediaUrl: (p) => "nrmedia://media?p=" + encodeURIComponent(p),
  assetUrl: (p) => "nrmedia://media?p=" + encodeURIComponent(p),
  ytStreamUrl: (id) => "nrmedia://ytstream?id=" + encodeURIComponent(id),
  openExternal: async (url) => { try { window.open(url, "_blank", "noopener"); } catch { /* noop */ } return true; },
  openPath: async () => false,
  revealPath: async () => false,
  setAlwaysOnTop: () => {},
  setWindowSize: () => {},
  // Le fond d'écran exige ffmpeg : sans backend, la bibliothèque est vide et l'import échoue
  // explicitement — l'UI reste navigable, elle ne prétend pas avoir importé quoi que ce soit.
  wallpaper: {
    import: async () => ({ ok: false, error: "mock" }),
    list: async () => ({ ok: true, entries: [] }),
    variant: async () => ({ ok: false, error: "mock" }),
    remove: async () => ({ ok: true, removed: false }),
  },
  // Mock navigateur : persistance en mémoire (localStorage) pour tester l'UI hors Resolve.
  reference: (() => {
    const KEY = "nr-ref-scenes:v1";
    const read = (): Record<string, RefSceneOut> => {
      try { return JSON.parse(readMockStorage(KEY, "nr-ref-scenes") || "{}"); } catch { return {}; }
    };
    const write = (o: Record<string, RefSceneOut>) => localStorage.setItem(KEY, JSON.stringify(o));
    return {
      listScenes: async () =>
        Object.values(read()).map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt }))
          .sort((a, b) => b.updatedAt - a.updatedAt),
      storagePath: async () => "",
      loadScene: async (id: string) => read()[id] ?? null,
      saveScene: async (scene: RefSceneIn) => {
        const o = read();
        const id = scene.id || Math.random().toString(36).slice(2, 10);
        const updatedAt = Date.now();
        o[id] = { id, name: scene.name, items: scene.items, view: scene.view ?? null, updatedAt };
        write(o);
        return { ok: true, id, updatedAt };
      },
      deleteScene: async (id: string) => { const o = read(); delete o[id]; write(o); return { ok: true }; },
      saveAsset: async () => ({ ok: false, error: "mock" }),
      fetchAsset: async () => ({ ok: false, error: "mock" }),
      resolveMedia: async (_url, _options) => ({ ok: false, error: "mock" }),
      upscaleItem: async () => ({ ok: false, error: "mock" }),
      dropAsset: async () => ({ ok: true, removed: false }),
      sweepAssets: async () => ({ ok: true, removed: 0, bytes: 0, kept: 0 }),
      scanFolder: async (dir: string) => ({ ok: false, root: dir, name: "", files: [], truncated: false, count: 0 }),
      writeFile: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
      sampleFrame: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
      extractMedia: async () => ({ ok: false, error: "mock" }),
      extractFrames: async () => ({ ok: false, error: "mock" }),
      exportBoard: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
      importBoard: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
      onShareProgress: () => () => {},
      relocateFrom: async () => ({ ok: false, found: [], scanned: 0, error: i18n.t("common:mock.appUnavailable") }),
      // Forme COMPLÈTE mais vide : le dialogue d'export rend ses quatre niveaux à 0 o au lieu de
      // tomber sur des `undefined` dans le navigateur.
      weigh: async () => ({ ok: true, level: "preview" as const, total: 0, perLevel: { link: 0, preview: 0, margin: 0, full: 0 }, items: [] }),
      chooseNetsu: async () => null,
      saveNetsuPath: async () => null,
      // Un projet est un FICHIER : dans le navigateur il n'y en a pas. On répond « indisponible »
      // plutôt que de simuler un enregistrement qui ne laisserait rien sur le disque.
      openProject: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
      previewProject: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
      saveProject: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
      saveProjectAs: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
      closeProject: async () => ({ ok: true, closed: false }),
      recentProjects: async () => [],
      forgetProject: async () => [],
      deleteProject: async () => ({ ok: false, recents: [], error: i18n.t("common:mock.appUnavailable") }),
      setDirty: () => {},
      detach: () => {},
      attach: () => {},
      setAlwaysOnTop: () => {},
      push: () => {},
      onPush: () => () => {},
    } satisfies RefApi;
  })(),
  // Mock navigateur : persistance des documents script en localStorage (teste l'UI hors Resolve).
  script: (() => {
    // Stats des cartes d'accueil. Le core les calcule en SQL ; ici les documents entiers sont déjà
    // en mémoire, on compte à la volée (mêmes types non narrés, même estimation de lecture).
    const NON_NARRATED = new Set(["heading", "storyboard", "divider", "callout"]);
    const mockScriptStats = (d: ScriptDoc): ScriptDocStats => {
      const blocks = Array.isArray(d.blocks) ? d.blocks : [];
      let words = 0, seconds = 0, media = 0, sections = 0;
      for (const b of blocks) {
        const list = Array.isArray(b.media) ? b.media : [];
        media += list.length;
        if (b.type === "heading") sections += 1;
        if (NON_NARRATED.has(b.type)) continue;
        const text = (b.text || "").replace(/<[^>]+>/g, " ").trim();
        const w = text ? text.split(/\s+/).filter(Boolean).length : 0;
        words += w;
        const cuts = list.flatMap((m) =>
          m.kind === "video" && m.outFrame != null && m.fps ? [(m.outFrame - m.inFrame + 1) / m.fps] : [],
        );
        seconds += cuts.length ? Math.max(...cuts) : (w / 200) * 60;
      }
      return { blocks: blocks.length, words, seconds: Math.round(seconds), media, sections };
    };
    const KEY = "nr-script-docs:v1";
    const KEY_V = "nr-script-versions:v1";
    const read = (): Record<string, ScriptDoc> => {
      try { return JSON.parse(readMockStorage(KEY, "nr-script-docs") || "{}"); } catch { return {}; }
    };
    const write = (o: Record<string, ScriptDoc>) => localStorage.setItem(KEY, JSON.stringify(o));
    return {
      recordings: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable"), files: [] }),
      mediaPool: async () => ({ connected: false, clips: [], error: i18n.t("common:mock.resolveUnavailable") }),
      importMedia: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
      listDocs: async (resolveProject?: string | null) =>
        Object.values(read())
          .filter((d) => !resolveProject || d.resolveProject === resolveProject)
          .map((d) => ({
            id: d.id,
            title: d.title,
            resolveProject: d.resolveProject ?? null,
            updatedAt: d.updatedAt ?? 0,
            stats: mockScriptStats(d),
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt),
      loadDoc: async (id: string) => read()[id] ?? null,
      saveDoc: async (doc: ScriptDoc) => {
        const o = read();
        const id = doc.id || Math.random().toString(36).slice(2, 10);
        const updatedAt = Date.now();
        o[id] = { ...doc, id, updatedAt };
        write(o);
        return { ok: true, id, updatedAt };
      },
      deleteDoc: async (id: string) => { const o = read(); delete o[id]; write(o); return { ok: true }; },
      listVersions: (() => {
        const readV = (): Record<string, { id: string; docId: string; label: string; createdAt: number; doc: ScriptDoc | null }> => {
          try { return JSON.parse(readMockStorage(KEY_V, "nr-script-versions") || "{}"); } catch { return {}; }
        };
        return async (docId: string) =>
          Object.values(readV())
            .filter((v) => v.docId === docId)
            .map(({ id, docId: d, label, createdAt }) => ({ id, docId: d, label, createdAt }))
            .sort((a, b) => b.createdAt - a.createdAt);
      })(),
      saveVersion: async (docId: string, label: string, doc: ScriptDoc) => {
        let o: Record<string, unknown> = {};
        try { o = JSON.parse(readMockStorage(KEY_V, "nr-script-versions") || "{}"); } catch { /* vide */ }
        const id = Math.random().toString(36).slice(2, 10);
        const createdAt = Date.now();
        o[id] = { id, docId, label, createdAt, doc };
        localStorage.setItem(KEY_V, JSON.stringify(o));
        return { ok: true, id, createdAt };
      },
      getVersion: async (id: string) => {
        try {
          const o = JSON.parse(readMockStorage(KEY_V, "nr-script-versions") || "{}");
          return o[id] ?? null;
        } catch { return null; }
      },
      deleteVersion: async (id: string) => {
        try {
          const o = JSON.parse(readMockStorage(KEY_V, "nr-script-versions") || "{}");
          delete o[id];
          localStorage.setItem(KEY_V, JSON.stringify(o));
        } catch { /* vide */ }
        return { ok: true };
      },
      buildTimeline: async () => ({ ok: false, error: i18n.t("common:mock.resolveUnavailable") }),
    } satisfies ScriptApi;
  })(),
  // Mock navigateur : Carnet en localStorage (carnets / pages / databases) — teste l'UI hors application.
  notebook: (() => {
    const K_NB = "nr-notebooks", K_PG = "nr-notebook-pages", K_DB = "nr-notebook-databases";
    type NbRow = NotebookMeta;
    type PgRow = NotebookPage;
    type DbRow = Database & { pageId: string };
    const rd = <T,>(k: string): Record<string, T> => { try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch { return {}; } };
    const wr = (k: string, o: unknown) => localStorage.setItem(k, JSON.stringify(o));
    const rid = () => Math.random().toString(36).slice(2, 10);
    const normalizeNotebook = (notebook: NbRow): NbRow => ({ ...notebook, kind: notebook.kind || "notes", language: notebook.language || "fr" });
    return {
      list: async () => Object.values(rd<NbRow>(K_NB)).map(normalizeNotebook).sort((a, b) => b.updatedAt - a.updatedAt),
      saveNotebook: async (nb) => {
        const o = rd<NbRow>(K_NB);
        const id = nb.id || rid();
        const updatedAt = Date.now();
        o[id] = {
          id,
          title: nb.title || i18n.t("notebook:panel.newNotebook"),
          icon: nb.icon ?? null,
          scriptId: nb.scriptId ?? null,
          kind: nb.kind ?? o[id]?.kind ?? "notes",
          language: nb.language ?? o[id]?.language ?? "fr",
          updatedAt,
        };
        wr(K_NB, o);
        return { ok: true, id, updatedAt };
      },
      deleteNotebook: async (id: string) => {
        const o = rd<NbRow>(K_NB); delete o[id]; wr(K_NB, o);
        const pg = rd<PgRow>(K_PG); for (const p of Object.values(pg)) if (p.notebookId === id) delete pg[p.id]; wr(K_PG, pg);
        return { ok: true };
      },
      forScript: async (scriptId: string, title?: string) => {
        const o = rd<NbRow>(K_NB);
        const found = Object.values(o).filter((n) => n.scriptId === scriptId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (found) return { ok: true, notebook: found, created: false };
        const id = rid();
        const updatedAt = Date.now();
        o[id] = { id, title: title || i18n.t("notebook:panel.scriptNotebook"), icon: null, scriptId, kind: "script", language: "fr", updatedAt };
        wr(K_NB, o);
        return { ok: true, notebook: o[id], created: true };
      },
      load: async (id: string) => {
        const nb = rd<NbRow>(K_NB)[id];
        if (!nb) return null;
        const pages = Object.values(rd<PgRow>(K_PG))
          .filter((p) => p.notebookId === id)
          .map(({ blocks, ...meta }) => meta as PageMeta)
          .sort((a, b) => a.orderIdx - b.orderIdx);
        return { notebook: normalizeNotebook(nb), pages };
      },
      loadPage: async (id: string) => {
        const page = rd<PgRow>(K_PG)[id];
        if (!page) return null;
        const databases: Record<string, Database> = {};
        for (const d of Object.values(rd<DbRow>(K_DB))) if (d.pageId === id) { const { pageId, ...rest } = d; databases[d.id] = rest; }
        return { page, databases };
      },
      savePage: async (page) => {
        const o = rd<PgRow>(K_PG);
        const id = page.id || rid();
        const updatedAt = Date.now();
        o[id] = {
          id, notebookId: page.notebookId, parentId: page.parentId ?? null,
          title: page.title || i18n.t("notebook:panel.untitled"), icon: page.icon ?? null, cover: page.cover ?? null,
          orderIdx: typeof page.orderIdx === "number" ? page.orderIdx : Date.now(),
          blocks: (page.blocks || []) as Record<string, unknown>[], updatedAt,
        };
        wr(K_PG, o);
        return { ok: true, id, updatedAt };
      },
      deletePage: async (id: string) => {
        const o = rd<PgRow>(K_PG);
        const removed: string[] = [];
        const childrenOf = (pid: string) => Object.values(o).filter((p) => (p.parentId ?? null) === pid).map((p) => p.id);
        const walk = (pid: string) => { removed.push(pid); for (const c of childrenOf(pid)) walk(c); };
        walk(id);
        for (const pid of removed) delete o[pid];
        wr(K_PG, o);
        const db = rd<DbRow>(K_DB); for (const d of Object.values(db)) if (removed.includes(d.pageId)) delete db[d.id]; wr(K_DB, db);
        return { ok: true, removed };
      },
      duplicatePage: async (id: string) => {
        const o = rd<PgRow>(K_PG);
        const src = o[id];
        if (!src) return { ok: false, error: i18n.t("common:mock.pageNotFound") };
        const nid = rid();
        o[nid] = { ...src, id: nid, title: `${src.title} (copie)`, orderIdx: src.orderIdx + 1, updatedAt: Date.now() };
        wr(K_PG, o);
        return { ok: true, id: nid };
      },
      // Mock : pas de corbeille (delete = définitif) — l'UI rend juste une corbeille vide.
      trashList: async () => [],
      restorePage: async () => ({ ok: true, restored: [] }),
      purgePage: async (id: string) => {
        const o = rd<PgRow>(K_PG); delete o[id]; wr(K_PG, o); return { ok: true, removed: [id] };
      },
      emptyTrash: async () => ({ ok: true, removed: 0 }),
      // Recherche mock : titres seulement (suffisant pour rendre l'UI hors app).
      search: async (notebookId: string, query: string) => {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        return Object.values(rd<PgRow>(K_PG))
          .filter((p) => p.notebookId === notebookId && (p.title || "").toLowerCase().includes(q))
          .slice(0, 20)
          .map((p) => ({ pageId: p.id, title: p.title, icon: p.icon, snippet: "", blockId: "" }));
      },
      saveDatabase: async (db) => {
        const o = rd<DbRow>(K_DB);
        const id = db.id || rid();
        const updatedAt = Date.now();
        o[id] = { ...db, id };
        wr(K_DB, o);
        return { ok: true, id, updatedAt };
      },
      deleteDatabase: async (id: string) => { const o = rd<DbRow>(K_DB); delete o[id]; wr(K_DB, o); return { ok: true }; },
      backlinks: async (notebookId: string, pageId: string) => {
        const out: PageMeta[] = [];
        for (const p of Object.values(rd<PgRow>(K_PG))) {
          if (p.notebookId !== notebookId || p.id === pageId) continue;
          if (JSON.stringify(p.blocks || []).includes(`"pageId":"${pageId}"`)) {
            const { blocks, ...meta } = p; out.push(meta as PageMeta);
          }
        }
        return out;
      },
      // Mock navigateur : objectURL en mémoire (survit à la session, pas au reload — suffisant hors app).
      saveAsset: async (bytes: ArrayBuffer, ext: string) => {
        try { const url = URL.createObjectURL(new Blob([bytes], { type: `application/${ext}` })); return { ok: true, path: url, url }; }
        catch (e) { return { ok: false, error: String(e) }; }
      },
      readAsset: async () => ({ ok: false, error: "mock" }),
      // Mock : téléchargement navigateur (pas de fs) — filePath ne sert que pour le nom de fichier.
      writeExport: async (filePath: string, text: string) => {
        try {
          const name = filePath.split(/[\\/]/).pop() || "export.md";
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
          a.download = name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          return { ok: true, path: name };
        } catch (e) { return { ok: false, error: String(e) }; }
      },
      linkMeta: async (url: string) => {
        let host = url; try { host = new URL(url).hostname; } catch { /* noop */ }
        return { ok: true, meta: { url, title: host, description: "", image: "", siteName: host, favicon: "" } };
      },
      // Mock : pas de fs → le partage .netsu n'existe que dans l'app (le menu masque l'option).
      exportFile: async () => ({ ok: false, error: "mock" }),
      // Un carnet-document est un FICHIER : il n'y en a pas dans le navigateur.
      openProject: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
      saveProjectAs: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
      closeProject: async () => ({ ok: true, closed: false }),
      projectOf: async () => null,
      importFile: async () => ({ ok: false, error: "mock" }),
      push: () => {},
      onPush: () => () => {},
      detach: () => {}, // fenêtre détachée = Tauri only
      attach: () => {},
    } satisfies NotebookApi;
  })(),
  // Mock navigateur : collections en localStorage (teste l'UI hors application).
  collections: (() => {
    const KEY = "nr-collections:v1";
    const read = (): Record<string, Collection> => {
      try { return JSON.parse(readMockStorage(KEY, "nr-collections") || "{}"); } catch { return {}; }
    };
    const write = (o: Record<string, Collection>) => localStorage.setItem(KEY, JSON.stringify(o));
    const FKEY = "nr-collection-folders:v1";
    const readFolders = (): CollectionFolder[] => { try { return JSON.parse(readMockStorage(FKEY, "nr-collection-folders") || "[]"); } catch { return []; } };
    const writeFolders = (a: CollectionFolder[]) => localStorage.setItem(FKEY, JSON.stringify(a));
    const shotKey = (s: CollectionShot) => `${s.path}|${s.inFrame ?? s.in}`;
    const metaOf = (c: Collection): CollectionMeta => {
      const tagSet = new Set<string>();
      for (const s of c.shots) for (const t of s.tags ?? []) tagSet.add(t);
      return {
        id: c.id, name: c.name, color: c.color, icon: c.icon, count: c.shots.length, updatedAt: c.updatedAt,
        preview: [...c.shots].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)).slice(0, 4).map((s) => ({ path: s.path, in: s.in, inFrame: s.inFrame, fps: s.fps })),
        tags: [...tagSet].sort(), labels: [...new Set(c.shots.map((sh) => sh.label).filter(Boolean) as string[])],
        collTags: c.tags ?? [], description: c.description ?? "", folderId: c.folderId ?? null,
        archive: c.archive ?? null, archived: !!c.archive?.lastAt, autoSync: !!c.archive?.autoSync,
      };
    };
    return {
      list: async () => Object.values(read()).map(metaOf).sort((a, b) => b.updatedAt - a.updatedAt),
      load: async (id: string) => read()[id] ?? null,
      save: async (c) => {
        const o = read();
        const id = c.id || Math.random().toString(36).slice(2, 10);
        const prev = c.id ? o[id] : null;
        const updatedAt = Date.now();
        o[id] = {
          id, name: c.name,
          color: c.color !== undefined ? c.color : (prev?.color ?? null),
          icon: c.icon !== undefined ? c.icon : (prev?.icon ?? null),
          description: c.description !== undefined ? c.description : (prev?.description ?? ""),
          tags: c.tags !== undefined ? c.tags : (prev?.tags ?? []),
          folderId: c.folderId !== undefined ? c.folderId : (prev?.folderId ?? null),
          archive: c.archive !== undefined ? c.archive : (prev?.archive ?? null),
          shots: prev?.shots ?? [], updatedAt,
        };
        write(o);
        return { ok: true, id, updatedAt };
      },
      delete: async (id: string) => { const o = read(); delete o[id]; write(o); return { ok: true }; },
      addShots: async (id: string, shots: CollectionShot[]) => {
        const o = read();
        const c = o[id];
        if (!c) return { ok: false, error: i18n.t("common:mock.collectionNotFound") };
        const seen = new Set(c.shots.map(shotKey));
        let added = 0;
        for (const s of shots) {
          const k = shotKey(s);
          if (seen.has(k)) continue;
          seen.add(k);
          c.shots.push({ ...s, id: s.id || Math.random().toString(36).slice(2, 10), addedAt: Date.now() });
          added++;
        }
        c.updatedAt = Date.now();
        write(o);
        return { ok: true, id, added, count: c.shots.length, updatedAt: c.updatedAt };
      },
      removeShot: async (id: string, shotId: string) => {
        const o = read();
        const c = o[id];
        if (!c) return { ok: false, error: i18n.t("common:mock.collectionNotFound") };
        c.shots = c.shots.filter((s) => s.id !== shotId);
        c.updatedAt = Date.now();
        write(o);
        return { ok: true, count: c.shots.length, updatedAt: c.updatedAt };
      },
      updateShot: async (id: string, shotId: string, patch: CollectionShotPatch) => {
        const o = read();
        const c = o[id];
        if (!c) return { ok: false, error: i18n.t("common:mock.collectionNotFound") };
        c.shots = c.shots.map((s) => {
          if (s.id !== shotId) return s;
          const n = { ...s };
          if (patch.tags !== undefined) n.tags = patch.tags;
          if (patch.label !== undefined) n.label = patch.label;
          if (patch.rating !== undefined) n.rating = patch.rating ?? undefined;
          if (patch.note !== undefined) n.note = patch.note ?? undefined;
          if (patch.in !== undefined) n.in = patch.in;
          if (patch.out !== undefined) n.out = patch.out;
          if (patch.inFrame !== undefined) n.inFrame = patch.inFrame ?? undefined;
          if (patch.outFrame !== undefined) n.outFrame = patch.outFrame ?? undefined;
          if (patch.srcFrames !== undefined) n.srcFrames = patch.srcFrames ?? undefined;
          if (patch.fps !== undefined) n.fps = patch.fps ?? undefined;
          if (patch.name !== undefined) n.name = patch.name;
          if (patch.path !== undefined) n.path = patch.path;
          return n;
        });
        c.updatedAt = Date.now();
        write(o);
        return { ok: true, updatedAt: c.updatedAt };
      },
      saveIcon: async () => ({ ok: false, error: "mock" }),
      listFolders: async () => readFolders(),
      saveFolder: async (f) => {
        const all = readFolders();
        const id = f.id || Math.random().toString(36).slice(2, 10);
        const existing = all.find((x) => x.id === id);
        const parentId = f.parentId !== undefined ? (f.parentId ?? null) : (existing?.parentId ?? null);
        const rec: CollectionFolder = { id, name: f.name || existing?.name || i18n.t("common:mock.folder"), parentId };
        const i = all.findIndex((x) => x.id === id);
        if (i >= 0) all[i] = rec; else all.push(rec);
        writeFolders(all);
        return { ok: true, id };
      },
      deleteFolder: async (id: string) => {
        const all = readFolders();
        const parent = all.find((x) => x.id === id)?.parentId ?? null;
        writeFolders(all.filter((x) => x.id !== id).map((x) => (x.parentId === id ? { ...x, parentId: parent } : x)));
        const o = read();
        for (const c of Object.values(o)) if (c.folderId === id) c.folderId = parent;
        write(o);
        return { ok: true };
      },
      move: async (id: string, folderId: string | null) => {
        const o = read(); const c = o[id];
        if (!c) return { ok: false, error: i18n.t("common:mock.collectionNotFound") };
        c.folderId = folderId; c.updatedAt = Date.now(); write(o);
        return { ok: true, updatedAt: c.updatedAt };
      },
      allTags: async () => {
        const set = new Set<string>();
        for (const c of Object.values(read())) { for (const t of c.tags ?? []) set.add(t); for (const s of c.shots) for (const t of s.tags ?? []) set.add(t); }
        return [...set].sort();
      },
      archive: async () => ({ ok: false, error: i18n.t("common:mock.archiveUnavailable") }),
      relocateArchive: async () => ({ ok: false, error: i18n.t("common:mock.archiveUnavailable") }),
      queueState: async () => ({ entries: [], running: false }),
      queueEnqueue: async () => ({ ok: false, error: i18n.t("common:mock.archiveUnavailable") }),
      queueCancel: async () => ({ ok: false, error: i18n.t("common:mock.archiveUnavailable") }),
      onQueue: () => () => {},
      offline: async () => ({ ok: true, missing: [], offline: 0, total: 0 }),
      relinkPath: async () => ({ ok: true, relinked: 0 }),
      relinkDir: async () => ({ ok: true, relinked: 0 }),
    } satisfies CollectionsApi;
  })(),
  // Mock navigateur : bibliothèque de rushs en localStorage. Pas de sonde ni de scan de dossier hors
  // app (aucun accès disque depuis un navigateur) → les métas restent nulles et addDir ne fait rien ;
  // l'UI rend et se manipule quand même.
  library: (() => {
    const KEY = "nr-library:v1";
    const LEGACY_KEY = "nr-library";
    const read = (): LibraryItem[] => {
      try { const a = JSON.parse(readMockStorage(KEY, LEGACY_KEY) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; }
    };
    const write = (a: LibraryItem[]) => localStorage.setItem(KEY, JSON.stringify(a));
    const FKEY = "nr-library-folders:v1";
    const LEGACY_FKEY = "nr-library-folders";
    const readFolders = (): LibraryFolder[] => {
      try { const a = JSON.parse(readMockStorage(FKEY, LEGACY_FKEY) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; }
    };
    const writeFolders = (a: LibraryFolder[]) => localStorage.setItem(FKEY, JSON.stringify(a));
    const uid = () => Math.random().toString(36).slice(2, 10);
    // Retrait en lot : `remove` en est un cas à un élément (une seule implémentation à maintenir).
    const dropMany = (ids: string[]) => {
      const wanted = new Set(ids);
      const items = read().filter((i) => wanted.has(i.id));
      write(read().filter((i) => !wanted.has(i.id)));
      return { ok: true as const, undo: { items, folders: [] as LibraryFolder[] } };
    };
    return {
      list: async () => read().sort((a, b) => b.addedAt - a.addedAt),
      addPaths: async (paths: string[], folderId?: string | null) => {
        const all = read();
        const dest = folderId && readFolders().some((f) => f.id === folderId) ? folderId : null;
        const known = new Set(all.map((i) => i.path.toLowerCase()));
        let added = 0;
        for (const p of paths) {
          if (!p || known.has(p.toLowerCase())) continue;
          known.add(p.toLowerCase());
          all.push({
            id: uid(), name: basename(p), path: p, folderId: dest,
            duration: null, fps: null, resolution: null, format: null, addedAt: Date.now(),
          });
          added++;
        }
        write(all);
        return { ok: true, added };
      },
      addDir: async () => ({ ok: false, error: i18n.t("common:mock.folderImportUnavailable") }),
      remove: async (id: string) => dropMany([id]),
      removeMany: async (ids: string[]) => dropMany(ids),
      restore: async (undo: LibraryUndo) => {
        const all = readFolders();
        for (const f of undo.folders) {
          const i = all.findIndex((x) => x.id === f.id);
          if (i >= 0) all[i] = f; else all.push(f);
        }
        writeFolders(all);
        const items = read();
        for (const it of undo.items) {
          const i = items.findIndex((x) => x.id === it.id);
          if (i >= 0) items[i] = it; else items.push(it);
        }
        write(items);
        return { ok: true };
      },
      move: async (id: string, folderId: string | null) => {
        write(read().map((i) => (i.id === id ? { ...i, folderId } : i)));
        return { ok: true, updatedAt: Date.now() };
      },
      listFolders: async () => readFolders(),
      // Mêmes refus que le core (nom vide / « / » / homonyme entre frères) : l'arbre s'adresse par
      // chemin de noms, un mock plus permissif ferait diverger le navigateur de l'app.
      saveFolder: async (f) => {
        const all = readFolders();
        const id = f.id || uid();
        const existing = all.find((x) => x.id === id);
        const parentId = f.parentId !== undefined ? (f.parentId ?? null) : (existing?.parentId ?? null);
        const name = f.name.trim();
        if (!name) return { ok: false, error: i18n.t("common:mock.emptyFolderName") };
        if (/[\\/]/.test(name)) return { ok: false, error: i18n.t("common:mock.invalidFolderName") };
        if (all.some((x) => x.id !== id && (x.parentId ?? null) === parentId && x.name.toLowerCase() === name.toLowerCase())) {
          return { ok: false, error: `Un dossier « ${name} » existe déjà ici` };
        }
        const rec: LibraryFolder = { id, name, parentId };
        const i = all.findIndex((x) => x.id === id);
        if (i >= 0) all[i] = rec; else all.push(rec);
        writeFolders(all);
        return { ok: true, id };
      },
      // Même sémantique que le core (withItems = le sous-arbre entier part, sinon remontée au parent) :
      // un mock divergent ferait mentir le navigateur sur ce que fait vraiment l'app.
      deleteFolder: async (id: string, withItems?: boolean) => {
        const all = readFolders();
        const target = all.find((x) => x.id === id);
        const parent = target?.parentId ?? null;
        if (withItems) {
          const doomed: LibraryFolder[] = [];
          const seen = new Set<string>();
          const walk = (fid: string) => {
            if (seen.has(fid)) return;
            seen.add(fid);
            const f = all.find((x) => x.id === fid);
            if (f) doomed.push(f);
            for (const c of all.filter((x) => (x.parentId ?? null) === fid)) walk(c.id);
          };
          walk(id);
          const ids = new Set(doomed.map((f) => f.id));
          const hit = read().filter((i) => i.folderId && ids.has(i.folderId));
          writeFolders(all.filter((x) => !ids.has(x.id)));
          write(read().filter((i) => !(i.folderId && ids.has(i.folderId))));
          return { ok: true, undo: { items: hit, folders: doomed } };
        }
        const moved = read().filter((i) => i.folderId === id);
        const reparented = all.filter((x) => x.parentId === id);
        writeFolders(all.filter((x) => x.id !== id).map((x) => (x.parentId === id ? { ...x, parentId: parent } : x)));
        write(read().map((i) => (i.folderId === id ? { ...i, folderId: parent } : i)));
        return { ok: true, undo: { items: moved, folders: target ? [target, ...reparented] : reparented } };
      },
      // Hors app on ne peut pas savoir si un fichier existe → jamais rien hors ligne (pas de faux positif).
      offline: async () => ({ ok: true, missing: [], offline: 0, total: read().length }),
      relinkPath: async () => ({ ok: true, relinked: 0 }),
      relinkDir: async () => ({ ok: true, relinked: 0 }),
    } satisfies LibraryApi;
  })(),
  // Mock navigateur : file « cache projet » en localStorage (l'UI rend ; pas de flush hors app).
  outbox: (() => {
    const KEY = "nr-outbox:v1";
    const LEGACY_KEY = "nr-outbox";
    const DEFAULTS: OutboxSettings = { enabled: true, delaySec: 6, target: "new", targetName: "NetsuRush — cache", keepDone: 20 };
    const read = (): OutboxState => {
      try { const s = JSON.parse(readMockStorage(KEY, LEGACY_KEY) || "{}"); return { entries: s.entries || [], settings: { ...DEFAULTS, ...(s.settings || {}) } }; }
      catch { return { entries: [], settings: { ...DEFAULTS } }; }
    };
    const write = (s: OutboxState) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* noop */ } };
    return {
      list: async () => read(),
      enqueue: async (entry) => {
        const s = read();
        const e: OutboxEntry = { id: Math.random().toString(36).slice(2, 10), ts: Date.now(), host: entry.host, kind: entry.kind || "buildTimeline", label: entry.label, opts: entry.opts, status: "pending" };
        s.entries.push(e); write(s);
        return { ok: true, id: e.id, pending: s.entries.filter((x) => x.status === "pending").length };
      },
      remove: async (id) => { const s = read(); s.entries = s.entries.filter((e) => e.id !== id); write(s); return { ok: true }; },
      clear: async (which) => { const s = read(); s.entries = which === "done" ? s.entries.filter((e) => e.status === "pending") : which === "pending" ? s.entries.filter((e) => e.status !== "pending") : []; write(s); return { ok: true }; },
      settings: async () => read().settings,
      setSettings: async (patch) => { const s = read(); s.settings = { ...s.settings, ...patch }; write(s); return { ok: true, settings: s.settings }; },
      flush: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
      onChanged: () => () => {},
    } satisfies OutboxApi;
  })(),
  // Mock navigateur : rien à fermer/rouvrir hors app.
  power: {
    state: async () => ({ closed: null, busy: false }),
    reconcile: async () => ({ closed: null, busy: false }),
    close: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
    reopen: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
    restart: async () => ({ ok: false, error: i18n.t("common:mock.appUnavailable") }),
    onChanged: () => () => {},
    onProgress: () => () => {},
  } satisfies PowerApi,
  snapshot: {
    state: async () => null,
    clear: async () => ({ ok: true }),
    peek: async () => null,
    build: async () => ({ ok: false, error: i18n.t("common:mock.outsideApp") }),
    onChanged: () => () => {},
    onProgress: () => () => {},
  } satisfies SnapshotApi,
  // Mock navigateur : aucun cache disque à mesurer hors app. Vue vide → la page Stockage rend son
  // état « rien en cache » au lieu de planter.
  cache: {
    overview: async () => ({
      ok: true, kinds: [], total: 0, totalOnDisk: 0, root: null, defaults: { thumb: "", proxy: "" }, disk: null,
      db: { path: "", bytes: 0, available: false }, faiss: { bytes: 0, files: 0 },
      models: { totalBytes: 0, byTask: {} }, indexBackend: "mock",
    }),
    tree: async () => ({ ok: true, folders: [], unattributed: { bytes: 0, files: 0, byKind: {} } }),
    clear: async () => ({ ok: false, error: i18n.t("common:mock.outsideApp") }),
    purgePreviewRanges: async () => ({ ok: true, freed: 0, files: 0, rows: 0, skipped: 0 }),
    missing: async () => ({ ok: true, sources: [] }),
    vacuum: async () => ({ ok: false, error: i18n.t("common:mock.outsideApp") }),
    settings: async () => ({
      policyVersion: 3,
      dir: null,
      session: { roto: "operation", upscaleTest: "operation", voice: "page" },
      warn: { enabled: true, gb: 50 },
      disk: { enabled: true, freeGb: 20 },
      kinds: CACHE_KIND_LIST.reduce(
        (a, k) => ((a[k] = ["voice", "upscaleTest", "roto"].includes(k)
          ? { auto: true, maxGb: null, maxDays: null }
          : k === "thumb" ? { auto: true, maxGb: 4, maxDays: 30 }
            : k === "proxy" ? { auto: true, maxGb: 8, maxDays: 7 }
              : { auto: false, maxGb: null, maxDays: null }), a),
        {} as Record<CacheKind, CacheKindPolicy>,
      ),
    }),
    setSettings: async () => ({ ok: false, error: i18n.t("common:mock.outsideApp") }),
    check: async () => ({ alerts: [], total: 0, at: Date.now() }),
    sessionEvent: async () => ({ ok: true, freed: 0, files: 0 }),
    setDir: async () => ({ ok: false, error: i18n.t("common:mock.outsideApp") }),
    reindex: async () => ({ ok: false, added: 0, attributed: 0 }),
    onProgress: () => () => {},
    onWarn: () => () => {},
    onChanged: () => () => {},
  } satisfies CacheApi,
  // Mock navigateur : Chat IA inerte (l'UI rend, aucun moteur). Les vrais appels passent par le core.
  chat: {
    agents: async () => ({ mode: "ask", byok: { anthropic: false, openai: false, openrouter: false }, cli: [] }),
    configure: async () => ({ ok: false }),
    send: async () => ({ ok: false }),
    cancel: async () => ({ ok: true }),
    respondApproval: async () => ({ ok: true }),
    tools: async () => [],
    onEvent: () => () => {},
    onApproval: () => () => {},
    history: {
      list: async () => [],
      load: async () => null,
      save: async () => ({ ok: false }),
      delete: async () => ({ ok: true }),
    },
  } satisfies ChatApi,
};

// coreClient (Tauri) et mock (navigateur) exposent tous deux `reference` → sélection directe.
export const nr: NrApi =
  typeof window !== "undefined" && window.nr
    ? window.nr
    : coreAvailable
      ? makeCoreClient()
      : mock;

// Token monotone par demande de proxy : identifie un job pour pouvoir l'annuler (carte hors écran).
let _proxyTok = 1;
export const nextProxyToken = (): number => _proxyTok++;
