// Modèle des profils d'export. Un profil décrit COMMENT sortir des plans :
//  - timeline_import : aucun fichier, on importe la découpe dans la timeline Resolve (comme avant) ;
//  - video_remux     : fichier(s), copie de flux sans réencodage (lossless) ;
//  - video_encode    : fichier(s) ré-encodés (codec/audio/conteneur).
// Le profil ACTIF est appliqué d'un clic par le bouton « Télécharger ». Profils édités dans les
// Paramètres. Les moteurs matériels proposés sont ceux réellement sondés côté core.
import i18n from "@/i18n";

export type ExportWorkflow = "timeline_import" | "video_remux" | "video_encode";

export type ExportCodecFamily = "h264" | "h265" | "av1" | "vp9" | "prores" | "dnxhr" | "cineform" | "ffv1";

export type ExportCodec =
  | "h264_baseline"
  | "h264_main"
  | "h264_high"
  | "h264_high10"
  | "h264_high422"
  | "h264_high444"
  | "h265_main"
  | "h265_main10"
  | "h265_main12"
  | "h265_main422_10"
  | "h265_main444"
  | "h265_main444_10"
  | "av1_main"
  | "av1_main10"
  | "vp9"
  | "vp9_10"
  | "ffv1"
  | "prores_422_lt"
  | "prores_422"
  | "prores_422_hq"
  | "prores_4444"
  | "prores_4444_xq"
  | "dnxhr_lb"
  | "dnxhr_sq"
  | "dnxhr_hq"
  | "dnxhr_hqx"
  | "dnxhr_444"
  | "cineform"
  | "cineform_hq";

// Codecs audio RÉELLEMENT employés en post aujourd'hui, chacun à plusieurs débits. Volontairement
// court : AC-3/E-AC-3 (livraison broadcast Dolby), Vorbis (remplacé par Opus), MP2 (legacy broadcast)
// et PCM 32 bits flottant (mastering audio) n'ont pas leur place dans un outil de derush — ils
// allongeaient le menu sans que personne ne les choisisse.
export type ExportAudioMode =
  | "copy"
  | "aac_128"
  | "aac"
  | "aac_256"
  | "aac_320"
  | "opus_128"
  | "opus"
  | "opus_192"
  | "mp3_192"
  | "mp3"
  | "flac"
  | "alac"
  | "pcm16"
  | "pcm24"
  | "none";

// Famille d'un codec audio : sert UNIQUEMENT à grouper le sélecteur (plusieurs débits par codec →
// une liste plate se relit mal). « copy » n'appartient à aucune famille — c'est l'absence de ré-encodage.
export type ExportAudioFamily = "lossy" | "lossless";

export type ExportContainer = "mp4" | "mkv" | "mov" | "webm";

export type ExportEncoderMode = "gpu" | "nvenc" | "amf" | "qsv" | "cpu";
export type ExportSpeed = "fast" | "balanced" | "quality" | "max";

// Sélection de piste audio (fichiers multi-pistes : VO / VF / VOSTFR…). UN seul menu déroulant :
//  - "auto"     : « Aucun » — ne force rien (garde toutes les pistes) ;
//  - "language" : garder la piste de la langue choisie (tag/titre normalisés côté core ; secours IA
//                 silencieux si une piste n'est pas étiquetée) ;
//  - "track"    : garder une piste précise par numéro (a:N).
type AudioSelectMode = "auto" | "language" | "track";

export interface AudioSelect {
  mode: AudioSelectMode;
  language?: string;   // code de langue cible (mode "language"), ex. "ja"
  track?: number;      // index de piste a:N (mode "track")
}

// Langues proposées (codes alignés sur core/audioLang.js — les variantes d'étiquetage y sont gérées).
export const AUDIO_LANGUAGES: { code: string; label: string }[] = [
  { code: "ja", get label() { return i18n.t("export:lang.ja"); } },
  { code: "en", get label() { return i18n.t("export:lang.en"); } },
  { code: "fr", get label() { return i18n.t("export:lang.fr"); } },
  { code: "es", get label() { return i18n.t("export:lang.es"); } },
  { code: "de", get label() { return i18n.t("export:lang.de"); } },
  { code: "it", get label() { return i18n.t("export:lang.it"); } },
  { code: "pt", get label() { return i18n.t("export:lang.pt"); } },
  { code: "ru", get label() { return i18n.t("export:lang.ru"); } },
  { code: "zh", get label() { return i18n.t("export:lang.zh"); } },
  { code: "ko", get label() { return i18n.t("export:lang.ko"); } },
  { code: "ar", get label() { return i18n.t("export:lang.ar"); } },
  { code: "hi", get label() { return i18n.t("export:lang.hi"); } },
];

// Nombre de pistes proposées par numéro dans le menu (profil générique → aucun fichier à sonder).
export const AUDIO_TRACK_SLOTS = 4;

// Timeline visée par l'import (workflow timeline_import) : « open » = celle ouverte dans l'hôte,
// « new » = toujours une nouvelle, « tl:<nom> » = une existante par son nom. MÊME encodage que
// useTimelineTarget → le popover de destination se réutilise tel quel, sans conversion.
export type TimelineTargetValue = string;
const DEFAULT_TIMELINE_TARGET: TimelineTargetValue = "open";

export function coerceTimelineTarget(v: string | undefined | null): TimelineTargetValue {
  if (v === "open" || v === "new") return v;
  if (typeof v === "string" && v.startsWith("tl:") && v.slice(3).trim()) return v;
  return DEFAULT_TIMELINE_TARGET;
}

export function timelineTargetName(v: TimelineTargetValue): string | null {
  return v.startsWith("tl:") ? v.slice(3) : null;
}

export function audioLanguageLabel(code: string | undefined | null): string {
  return AUDIO_LANGUAGES.find((l) => l.code === code)?.label ?? i18n.t("export:lang.ja");
}

// Encodage/décodage de la valeur du menu unique : "auto" | "lang:<code>" | "track:<index>".
export function audioSelectValue(sel: AudioSelect): string {
  if (sel.mode === "language") return `lang:${sel.language ?? "ja"}`;
  if (sel.mode === "track") return `track:${sel.track ?? 0}`;
  return "auto";
}

export function parseAudioSelectValue(v: string): AudioSelect {
  if (v.startsWith("lang:")) return { mode: "language", language: v.slice(5) || "ja" };
  if (v.startsWith("track:")) return { mode: "track", track: Math.max(0, Number(v.slice(6)) || 0) };
  return { mode: "auto" };
}

export function audioSelectLabel(sel: AudioSelect): string {
  if (sel.mode === "language") return audioLanguageLabel(sel.language);
  if (sel.mode === "track") return i18n.t("export:audio.trackN", { n: (sel.track ?? 0) + 1 });
  return i18n.t("export:audio.allTracks");
}

// Icône du profil (affichée sur le bouton + la liste) : soit un glyphe lucide nommé,
// soit une image importée par l'utilisateur (data-URL réduite). Optionnel → repli sur
// une icône par défaut selon le flux.
export type ExportIcon =
  | { type: "lucide"; name: string }
  | { type: "emoji"; ch: string }
  | { type: "image"; src: string };

export interface ExportProfile {
  id: string;
  name: string;
  workflow: ExportWorkflow;
  codec: ExportCodec;
  audioMode: ExportAudioMode;
  container: ExportContainer;
  mergeEnabled: boolean;
  // Gabarit du nom des fichiers produits (jetons `{base}`, `{source}`, `{index}`… résolus côté core
  // par export/naming.js). Absent = gabarit par défaut, c'est-à-dire le nommage historique.
  naming?: string;
  // Noir intercalé ENTRE les plans d'un montage fusionné, en millisecondes (0 = aucun). N'a de sens
  // qu'avec `mergeEnabled` : sans fusion, chaque plan est déjà un fichier séparé.
  mergeGap?: number;
  // Moteur d'encodage et compromis vitesse/compression. Optionnels pour relire les anciens profils.
  encoderMode?: ExportEncoderMode;
  speed?: ExportSpeed;
  // Sélection de piste audio par langue (fichiers multi-pistes). Absent = "auto" (rétro-compat).
  audioSelect?: AudioSelect;
  icon?: ExportIcon;
  // Destination de l'import timeline (workflow timeline_import) : null/absent = timeline à la racine ;
  // une chaîne = nom du DOSSIER Media Pool où ranger la timeline créée. Ignoré hors timeline_import.
  binTarget?: string | null;
  // Timeline visée par l'import (workflow timeline_import) : "open" | "new" | "tl:<nom>".
  timelineTarget?: TimelineTargetValue;
}

// ---------------------------------------------------------------------------
// Options + libellés (FR)
// ---------------------------------------------------------------------------

export const EXPORT_WORKFLOW_OPTIONS: { value: ExportWorkflow; label: string }[] = [
  { value: "timeline_import", get label() { return i18n.t("export:workflow.timeline"); } },
  { value: "video_remux", get label() { return i18n.t("export:workflow.remux"); } },
  { value: "video_encode", get label() { return i18n.t("export:workflow.encode"); } },
];

export const EXPORT_CODEC_OPTIONS: { value: ExportCodec; label: string }[] = [
  { value: "h264_baseline", label: "H.264 — Baseline" },
  { value: "h264_main", label: "H.264 — Main" },
  { value: "h264_high", label: "H.264 — High" },
  { value: "h264_high10", get label() { return `H.264 — High ${i18n.t("export:codec.bitDepth", { count: 10 })}`; } },
  { value: "h264_high422", label: "H.264 — High 4:2:2" },
  { value: "h264_high444", label: "H.264 — High 4:4:4" },
  { value: "h265_main", label: "H.265 — Main" },
  { value: "h265_main10", get label() { return `H.265 — Main ${i18n.t("export:codec.bitDepth", { count: 10 })}`; } },
  { value: "h265_main12", get label() { return `H.265 — Main ${i18n.t("export:codec.bitDepth", { count: 12 })}`; } },
  { value: "h265_main422_10", get label() { return `H.265 — Main 4:2:2 ${i18n.t("export:codec.bitDepth", { count: 10 })}`; } },
  { value: "h265_main444", get label() { return `H.265 — Main 4:4:4 ${i18n.t("export:codec.bitDepth", { count: 8 })}`; } },
  { value: "h265_main444_10", get label() { return `H.265 — Main 4:4:4 ${i18n.t("export:codec.bitDepth", { count: 10 })}`; } },
  { value: "av1_main", label: "AV1 — Main" },
  { value: "av1_main10", get label() { return `AV1 — Main ${i18n.t("export:codec.bitDepth", { count: 10 })}`; } },
  { value: "vp9", get label() { return `VP9 — ${i18n.t("export:codec.profile", { count: 0 })}`; } },
  { value: "vp9_10", get label() { return `VP9 — ${i18n.t("export:codec.profile", { count: 2 })} (${i18n.t("export:codec.bitDepth", { count: 10 })})`; } },
  { value: "ffv1", get label() { return `FFV1 — ${i18n.t("export:codec.losslessArchive")}`; } },
  { value: "prores_422_lt", label: "ProRes 422 LT" },
  { value: "prores_422", label: "ProRes 422" },
  { value: "prores_422_hq", label: "ProRes 422 HQ" },
  { value: "prores_4444", label: "ProRes 4444" },
  { value: "prores_4444_xq", label: "ProRes 4444 XQ" },
  { value: "dnxhr_lb", label: "DNxHR LB" },
  { value: "dnxhr_sq", label: "DNxHR SQ" },
  { value: "dnxhr_hq", label: "DNxHR HQ" },
  { value: "dnxhr_hqx", get label() { return `DNxHR HQX ${i18n.t("export:codec.bitDepth", { count: 10 })}`; } },
  { value: "dnxhr_444", get label() { return `DNxHR 444 ${i18n.t("export:codec.bitDepth", { count: 10 })}`; } },
  { value: "cineform", label: "GoPro CineForm" },
  { value: "cineform_hq", label: "GoPro CineForm HQ" },
];

// Codecs audio PROPOSÉS (ligne « Codec audio »). « none » n'y est pas : couper le son s'exprime une
// seule fois, dans le menu de piste (cf. features/export/audioSelect.ts) — deux entrées « Aucun »
// voisines qui ne voulaient pas dire la même chose étaient la source de confusion.
export const EXPORT_AUDIO_OPTIONS: { value: ExportAudioMode; label: string }[] = [
  { value: "copy", get label() { return i18n.t("export:audioMode.copy"); } },
  { value: "aac_128", get label() { return i18n.t("export:audioMode.aac_128"); } },
  { value: "aac", get label() { return i18n.t("export:audioMode.aac"); } },
  { value: "aac_256", get label() { return i18n.t("export:audioMode.aac_256"); } },
  { value: "aac_320", get label() { return i18n.t("export:audioMode.aac_320"); } },
  { value: "opus_128", get label() { return i18n.t("export:audioMode.opus_128"); } },
  { value: "opus", get label() { return i18n.t("export:audioMode.opus"); } },
  { value: "opus_192", get label() { return i18n.t("export:audioMode.opus_192"); } },
  { value: "mp3_192", get label() { return i18n.t("export:audioMode.mp3_192"); } },
  { value: "mp3", get label() { return i18n.t("export:audioMode.mp3"); } },
  { value: "flac", get label() { return i18n.t("export:audioMode.flac"); } },
  { value: "alac", get label() { return i18n.t("export:audioMode.alac"); } },
  { value: "pcm16", get label() { return i18n.t("export:audioMode.pcm16"); } },
  { value: "pcm24", get label() { return i18n.t("export:audioMode.pcm24"); } },
];

const AUDIO_FAMILY_TO_MODES: Record<ExportAudioFamily, ExportAudioMode[]> = {
  lossy: ["aac_128", "aac", "aac_256", "aac_320", "opus_128", "opus", "opus_192", "mp3_192", "mp3"],
  lossless: ["flac", "alac", "pcm16", "pcm24"],
};

const AUDIO_FAMILY_LABELS: Record<ExportAudioFamily, string> = {
  get lossy() { return i18n.t("export:audioGroup.lossy"); },
  get lossless() { return i18n.t("export:audioGroup.lossless"); },
};

// Valeurs VALIDES d'audioMode : les codecs proposés + « none ». C'est le format de fil lu par le core
// (encodeArgs.audioMapArgs / timeline.videoOnly), donc « none » doit survivre à la normalisation même
// s'il ne figure plus dans le menu.
const EXPORT_AUDIO_MODES: ExportAudioMode[] = [...EXPORT_AUDIO_OPTIONS.map((o) => o.value), "none"];

export const EXPORT_CONTAINER_OPTIONS: { value: ExportContainer; label: string }[] = [
  { value: "mp4", label: "MP4" },
  { value: "mkv", label: "MKV" },
  { value: "mov", label: "MOV" },
  { value: "webm", label: "WebM" },
];

export const EXPORT_SPEED_OPTIONS: { value: ExportSpeed; label: string; hint: string }[] = [
  { value: "fast", get label() { return i18n.t("export:speed.fast.label"); }, get hint() { return i18n.t("export:speed.fast.hint"); } },
  { value: "balanced", get label() { return i18n.t("export:speed.balanced.label"); }, get hint() { return i18n.t("export:speed.balanced.hint"); } },
  { value: "quality", get label() { return i18n.t("export:speed.quality.label"); }, get hint() { return i18n.t("export:speed.quality.hint"); } },
  { value: "max", get label() { return i18n.t("export:speed.max.label"); }, get hint() { return i18n.t("export:speed.max.hint"); } },
];

const CODEC_FAMILY_LABELS: Record<ExportCodecFamily, string> = {
  h264: "H.264 / AVC",
  h265: "H.265 / HEVC",
  av1: "AV1",
  vp9: "VP9",
  prores: "ProRes",
  dnxhr: "DNxHR / DNxHD (Avid)",
  cineform: "GoPro CineForm",
  get ffv1() { return `FFV1 (${i18n.t("export:codec.archive")})`; },
};

const CODEC_FAMILY_TO_CODECS: Record<ExportCodecFamily, ExportCodec[]> = {
  h264: ["h264_baseline", "h264_main", "h264_high", "h264_high10", "h264_high422", "h264_high444"],
  h265: ["h265_main", "h265_main10", "h265_main12", "h265_main422_10", "h265_main444", "h265_main444_10"],
  av1: ["av1_main", "av1_main10"],
  vp9: ["vp9", "vp9_10"],
  prores: ["prores_422_lt", "prores_422", "prores_422_hq", "prores_4444", "prores_4444_xq"],
  dnxhr: ["dnxhr_lb", "dnxhr_sq", "dnxhr_hq", "dnxhr_hqx", "dnxhr_444"],
  cineform: ["cineform", "cineform_hq"],
  ffv1: ["ffv1"],
};

// Codecs groupés par famille (rendu du Select en sections).
export const EXPORT_CODEC_GROUPS: { family: ExportCodecFamily; label: string; options: { value: ExportCodec; label: string }[] }[] =
  (Object.keys(CODEC_FAMILY_TO_CODECS) as ExportCodecFamily[]).map((family) => ({
    family,
    get label() { return CODEC_FAMILY_LABELS[family]; },
    options: EXPORT_CODEC_OPTIONS.filter((o) => CODEC_FAMILY_TO_CODECS[family].includes(o.value)),
  }));

// ---------------------------------------------------------------------------
// Profils par défaut — l'ACTIF est « Vers la timeline » → comportement actuel (import découpe).
// ---------------------------------------------------------------------------

export const DEFAULT_EXPORT_PROFILE_ID = "import-timeline";

export const DEFAULT_EXPORT_PROFILES: ExportProfile[] = [
  {
    id: DEFAULT_EXPORT_PROFILE_ID,
    name: i18n.t("export:profileName.toTimeline"),
    workflow: "timeline_import",
    codec: "h264_high",
    audioMode: "copy",
    container: "mp4",
    mergeEnabled: false,
    encoderMode: "gpu",
    speed: "balanced",
    icon: { type: "lucide", name: "Clapperboard" },
  },
  {
    id: "remux-mp4",
    name: i18n.t("export:profileName.fileNoReencode"),
    workflow: "video_remux",
    codec: "h264_high",
    audioMode: "copy",
    container: "mp4",
    mergeEnabled: false,
    encoderMode: "gpu",
    speed: "balanced",
    icon: { type: "lucide", name: "Copy" },
  },
  {
    id: "mp4-h264",
    name: i18n.t("export:profileName.mp4H264"),
    workflow: "video_encode",
    codec: "h264_high",
    audioMode: "aac",
    container: "mp4",
    mergeEnabled: false,
    encoderMode: "gpu",
    speed: "balanced",
    icon: { type: "lucide", name: "Film" },
  },
  {
    id: "mp4-h265-10",
    name: i18n.t("export:profileName.mp4H265_10"),
    workflow: "video_encode",
    codec: "h265_main10",
    audioMode: "aac",
    container: "mp4",
    mergeEnabled: false,
    encoderMode: "gpu",
    speed: "balanced",
    icon: { type: "lucide", name: "Video" },
  },
  {
    id: "prores-422-hq",
    name: i18n.t("export:profileName.prores422hq"),
    workflow: "video_encode",
    codec: "prores_422_hq",
    audioMode: "pcm16",
    container: "mov",
    mergeEnabled: false,
    encoderMode: "cpu",
    speed: "balanced",
    icon: { type: "lucide", name: "Star" },
  },
  {
    id: "dnxhr-hq",
    name: i18n.t("export:profileName.dnxhrHq"),
    workflow: "video_encode",
    codec: "dnxhr_hq",
    audioMode: "pcm16",
    container: "mov",
    mergeEnabled: false,
    encoderMode: "cpu",
    speed: "balanced",
    icon: { type: "lucide", name: "Film" },
  },
  // Conservation : H.265 10 bits en MKV, piste audio RECOPIÉE (aucune perte ajoutée au son).
  {
    id: "mkv-h265-10",
    name: i18n.t("export:profileName.mkvH265_10"),
    workflow: "video_encode",
    codec: "h265_main10",
    audioMode: "copy",
    container: "mkv",
    mergeEnabled: false,
    encoderMode: "gpu",
    speed: "quality",
    icon: { type: "lucide", name: "Save" },
  },
  {
    id: "webm-av1",
    name: i18n.t("export:profileName.webmAv1"),
    workflow: "video_encode",
    codec: "av1_main",
    audioMode: "opus",
    container: "webm",
    mergeEnabled: false,
    encoderMode: "gpu",
    speed: "balanced",
    icon: { type: "lucide", name: "Share2" },
  },
  // Seul profil à couche alpha : ProRes 4444 la transporte, ni H.264/265 ni DNxHR HQX.
  {
    id: "prores-4444",
    name: i18n.t("export:profileName.prores4444"),
    workflow: "video_encode",
    codec: "prores_4444",
    audioMode: "pcm24",
    container: "mov",
    mergeEnabled: false,
    encoderMode: "cpu",
    speed: "balanced",
    icon: { type: "lucide", name: "Sparkles" },
  },
  {
    id: "dnxhr-hqx",
    name: i18n.t("export:profileName.dnxhrHqx"),
    workflow: "video_encode",
    codec: "dnxhr_hqx",
    audioMode: "pcm24",
    container: "mov",
    mergeEnabled: false,
    encoderMode: "cpu",
    speed: "balanced",
    icon: { type: "lucide", name: "FileVideo" },
  },
  {
    id: "ffv1-archive",
    name: i18n.t("export:profileName.ffv1Archive"),
    workflow: "video_encode",
    codec: "ffv1",
    audioMode: "flac",
    container: "mkv",
    mergeEnabled: false,
    encoderMode: "cpu",
    speed: "balanced",
    icon: { type: "lucide", name: "Package" },
  },
];

const DEFAULT_EXPORT_PROFILE = DEFAULT_EXPORT_PROFILES[0];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function usesEncoding(workflow: ExportWorkflow): boolean {
  return workflow === "video_encode";
}

export function usesFile(workflow: ExportWorkflow): boolean {
  return workflow === "video_remux" || workflow === "video_encode";
}

export function isTimelineImport(workflow: ExportWorkflow): boolean {
  return workflow === "timeline_import";
}

export function getExportCodecLabel(codec: ExportCodec): string {
  return EXPORT_CODEC_OPTIONS.find((o) => o.value === codec)?.label ?? i18n.t("export:codecUnknown");
}

export function getCodecFamily(codec: ExportCodec): ExportCodecFamily {
  if (codec.startsWith("h264_")) return "h264";
  if (codec.startsWith("h265_")) return "h265";
  if (codec.startsWith("av1_")) return "av1";
  if (codec.startsWith("vp9")) return "vp9";
  if (codec.startsWith("dnxhr_")) return "dnxhr";
  if (codec.startsWith("cineform")) return "cineform";
  if (codec === "ffv1") return "ffv1";
  return "prores";
}

export function coerceExportCodec(codec: string | undefined | null): ExportCodec {
  if (codec && EXPORT_CODEC_OPTIONS.some((o) => o.value === codec)) return codec as ExportCodec;
  return "h264_high";
}

export function coerceExportAudioMode(audioMode: string | undefined | null): ExportAudioMode {
  if (audioMode && EXPORT_AUDIO_MODES.includes(audioMode as ExportAudioMode)) return audioMode as ExportAudioMode;
  return "copy";
}

export function coerceAudioSelect(sel: AudioSelect | undefined | null): AudioSelect {
  if (sel?.mode === "language") {
    const language = typeof sel.language === "string" && sel.language ? sel.language : "ja";
    return { mode: "language", language };
  }
  if (sel?.mode === "track") {
    const track = Math.max(0, Math.round(Number(sel.track) || 0));
    return { mode: "track", track };
  }
  return { mode: "auto" };
}

// Noir de séparation : millisecondes entières. Le plafond n'est pas une limite technique — au-delà
// de dix secondes le « séparateur » devient un plan à lui seul, ce que la fusion ne promet pas.
export const MERGE_GAP_MAX_MS = 10000;
export const MERGE_GAP_STEP_MS = 100;
export const MERGE_GAP_DEFAULT_MS = 1000;

function coerceMergeGap(ms: number | undefined | null): number {
  const v = Math.round(ms == null ? MERGE_GAP_DEFAULT_MS : Number(ms) || 0);
  return Math.min(MERGE_GAP_MAX_MS, Math.max(0, v));
}

export function coerceExportContainer(container: string | undefined | null): ExportContainer {
  if (container && EXPORT_CONTAINER_OPTIONS.some((o) => o.value === container)) return container as ExportContainer;
  return "mp4";
}

function coerceExportWorkflow(workflow: string | undefined | null): ExportWorkflow {
  if (workflow === "timeline_import" || workflow === "video_remux" || workflow === "video_encode") return workflow;
  return "video_remux";
}

export function coerceExportEncoderMode(mode: string | undefined | null): ExportEncoderMode {
  return mode === "nvenc" || mode === "amf" || mode === "qsv" || mode === "cpu" ? mode : "gpu";
}

export function coerceExportSpeed(speed: string | undefined | null): ExportSpeed {
  return speed === "fast" || speed === "quality" || speed === "max" ? speed : "balanced";
}

export function supportsExportSpeed(codec: ExportCodec): boolean {
  const family = getCodecFamily(codec);
  return family === "h264" || family === "h265" || family === "av1" || family === "vp9";
}

export function isExportCodecContainerCompatible(codec: ExportCodec, container: ExportContainer): boolean {
  const fam = getCodecFamily(codec);
  // WebM n'accepte QUE VP8/VP9/AV1 (ffmpeg refuse le mux sinon) → jamais pour les autres familles.
  if (container === "webm") return fam === "vp9" || fam === "av1";
  // Intermédiaires montage (ProRes / DNxHR / CineForm) → conteneurs MOV/MKV (pas MP4).
  if (fam === "prores" || fam === "dnxhr" || fam === "cineform") return container === "mov" || container === "mkv";
  // AV1 → MP4/MKV seulement (MOV ne mux pas l'AV1 de façon fiable).
  if (fam === "av1") return container === "mp4" || container === "mkv";
  // VP9 → WebM/MKV (famille Matroska). MP4 accepte VP9 mais la lecture est très inégale.
  if (fam === "vp9") return container === "mkv";
  // FFV1 : mappage normalisé en Matroska (référence archivage) et MOV. Pas de mappage MP4 standard.
  if (fam === "ffv1") return container === "mkv" || container === "mov";
  return true; // h264/h265 → mp4/mov/mkv
}

// Conteneurs qui muxent RÉELLEMENT chaque codec audio. Table explicite plutôt qu'une suite de règles :
// avec quinze codecs, une condition oubliée sortait un couple que ffmpeg refuse à l'exécution.
//  - WebM ne mux qu'Opus (« Only ... Vorbis or Opus audio ... are supported for WebM ») ; « copy » y
//    est exclu, la piste source est presque toujours AAC → l'échec serait la règle ;
//  - MP4 ne porte ni FLAC ni PCM de façon lisible par les monteurs → MOV/MKV pour ces modes ;
//  - MOV ne porte pas Opus.
const AUDIO_CONTAINERS: Record<Exclude<ExportAudioMode, "none">, ExportContainer[]> = {
  copy: ["mp4", "mkv", "mov"],
  aac_128: ["mp4", "mkv", "mov"],
  aac: ["mp4", "mkv", "mov"],
  aac_256: ["mp4", "mkv", "mov"],
  aac_320: ["mp4", "mkv", "mov"],
  opus_128: ["mp4", "mkv", "webm"],
  opus: ["mp4", "mkv", "webm"],
  opus_192: ["mp4", "mkv", "webm"],
  mp3_192: ["mp4", "mkv", "mov"],
  mp3: ["mp4", "mkv", "mov"],
  flac: ["mkv", "mov"],
  alac: ["mp4", "mkv", "mov"],
  pcm16: ["mkv", "mov"],
  pcm24: ["mkv", "mov"],
};

export function isExportAudioContainerCompatible(audioMode: ExportAudioMode, container: ExportContainer): boolean {
  if (audioMode === "none") return true;
  return (AUDIO_CONTAINERS[audioMode] ?? []).includes(container);
}

// Codecs audio COMPATIBLES d'un conteneur (filtre du sélecteur → jamais un couple invalide).
export function compatibleAudioForContainer(container: ExportContainer): { value: ExportAudioMode; label: string }[] {
  return EXPORT_AUDIO_OPTIONS.filter((o) => isExportAudioContainerCompatible(o.value, container));
}

// Mêmes options, groupées par famille pour le rendu en sections (« Copie » reste hors groupe, en tête).
export function compatibleAudioGroupsForContainer(container: ExportContainer): {
  family: ExportAudioFamily; label: string; options: { value: ExportAudioMode; label: string }[];
}[] {
  const offered = compatibleAudioForContainer(container);
  return (Object.keys(AUDIO_FAMILY_TO_MODES) as ExportAudioFamily[])
    .map((family) => ({
      family,
      get label() { return AUDIO_FAMILY_LABELS[family]; },
      options: offered.filter((o) => AUDIO_FAMILY_TO_MODES[family].includes(o.value)),
    }))
    .filter((group) => group.options.length > 0);
}

// Codec audio de repli quand le conteneur refuse celui du profil (ex. bascule vers WebM → Opus).
export function getRecommendedAudioForContainer(container: ExportContainer): ExportAudioMode {
  if (container === "webm") return "opus";
  return "aac";
}

// Conteneurs COMPATIBLES avec un codec (pour filtrer le sélecteur → on ne propose jamais un couple invalide).
export function compatibleContainersForExportCodec(codec: ExportCodec): { value: ExportContainer; label: string }[] {
  return EXPORT_CONTAINER_OPTIONS.filter((o) => isExportCodecContainerCompatible(codec, o.value));
}

export function getRecommendedContainerForCodec(codec: ExportCodec): ExportContainer {
  const fam = getCodecFamily(codec);
  if (fam === "prores" || fam === "dnxhr" || fam === "cineform") return "mov";
  if (fam === "ffv1") return "mkv";
  if (fam === "vp9") return "webm";
  if (fam === "av1") return "mp4";
  return "mp4";
}

// ---------------------------------------------------------------------------
// Validité d'un profil — SOURCE UNIQUE du rouge (éditeur) et du blocage (bouton d'export).
// ---------------------------------------------------------------------------

export type ExportProfileField = "binTarget";

export interface ExportProfileIssue {
  field: ExportProfileField;
  message: string;
}

// Un profil « Dossier » sans nom de dossier ne peut pas être exécuté : Resolve n'a pas de cible.
// Le champ vaut "" (mode dossier choisi, nom vide) — distinct de null (= timeline à la racine, valide).
export function getExportProfileIssues(profile: ExportProfile): ExportProfileIssue[] {
  const issues: ExportProfileIssue[] = [];
  if (isTimelineImport(profile.workflow) && profile.binTarget != null && !profile.binTarget.trim()) {
    issues.push({ field: "binTarget", message: i18n.t("export:issue.binTargetRequired") });
  }
  return issues;
}

export function getExportProfileIssue(profile: ExportProfile, field: ExportProfileField): ExportProfileIssue | undefined {
  return getExportProfileIssues(profile).find((i) => i.field === field);
}

// Vrai si le profil peut partir en export (aucun réglage obligatoire manquant).
export function isExportProfileReady(profile: ExportProfile): boolean {
  return getExportProfileIssues(profile).length === 0;
}

export function getExportProfileSummary(profile: ExportProfile): string {
  if (isTimelineImport(profile.workflow)) return i18n.t("export:summary.timelineImport");
  const codecLabel = usesEncoding(profile.workflow) ? getExportCodecLabel(profile.codec) : i18n.t("export:summary.streamCopy");
  const mergeLabel = profile.mergeEnabled ? i18n.t("export:summary.merged") : "";
  return `${codecLabel} · ${profile.container.toUpperCase()}${mergeLabel}`;
}

export function getActiveExportProfile(profiles: ExportProfile[], activeProfileId: string): ExportProfile {
  return profiles.find((p) => p.id === activeProfileId) ?? profiles[0] ?? DEFAULT_EXPORT_PROFILE;
}

function normalizeExportIcon(icon: ExportIcon | undefined | null): ExportIcon | undefined {
  if (!icon || typeof icon !== "object") return undefined;
  if (icon.type === "image" && typeof icon.src === "string" && icon.src) return { type: "image", src: icon.src };
  if (icon.type === "emoji" && typeof icon.ch === "string" && icon.ch) return { type: "emoji", ch: icon.ch };
  if (icon.type === "lucide" && typeof icon.name === "string" && icon.name) return { type: "lucide", name: icon.name };
  return undefined;
}

// Aligne un profil chargé (conteneur compatible avec le codec, audio compatible avec le conteneur).
export function normalizeExportProfile(profile: ExportProfile): ExportProfile {
  const workflow = coerceExportWorkflow(profile.workflow);
  const codec = coerceExportCodec(profile.codec);
  let container = coerceExportContainer(profile.container);
  if (usesEncoding(workflow) && !isExportCodecContainerCompatible(codec, container)) {
    container = getRecommendedContainerForCodec(codec);
  }
  // Le son coupé (« none ») traverse tout ; sinon le conteneur a le dernier mot (WebM → Opus).
  let audioMode = coerceExportAudioMode(profile.audioMode);
  if (usesEncoding(workflow) && !isExportAudioContainerCompatible(audioMode, container)) {
    audioMode = getRecommendedAudioForContainer(container);
  }
  return {
    id: profile.id,
    name: typeof profile.name === "string" && profile.name.trim() ? profile.name : i18n.t("export:profileName.fallback"),
    workflow,
    codec,
    audioMode,
    container,
    mergeEnabled: profile.mergeEnabled ?? false,
    // Gardé TEL QUEL (comme binTarget) : la normalisation passe à chaque frappe, trimmer volerait
    // l'espace qu'on vient de taper entre deux jetons. Un gabarit vide = repli sur le défaut du core.
    naming: typeof profile.naming === "string" ? profile.naming : undefined,
    mergeGap: coerceMergeGap(profile.mergeGap),
    encoderMode: coerceExportEncoderMode(profile.encoderMode),
    speed: coerceExportSpeed(profile.speed),
    audioSelect: coerceAudioSelect(profile.audioSelect),
    icon: normalizeExportIcon(profile.icon),
    // Chaîne gardée TELLE QUELLE (jamais trim/collapse ici) : la normalisation passe à CHAQUE frappe.
    // Trimmer volerait les espaces en cours de saisie (« NetsuRush — Coupes » serait intapable) et
    // replier "" sur null ferait resauter le sélecteur sur « Timeline » dès qu'on vide le champ.
    // "" = mode dossier SANS nom → invalide (cf. getExportProfileIssues), null = timeline à la racine.
    binTarget: typeof profile.binTarget === "string" ? profile.binTarget : null,
    timelineTarget: coerceTimelineTarget(profile.timelineTarget),
  };
}

export function createExportProfile(index: number): ExportProfile {
  return normalizeExportProfile({
    ...DEFAULT_EXPORT_PROFILES[2],
    id: `export-profile-${index}`,
    name: i18n.t("export:profileName.generic", { index }),
  });
}
