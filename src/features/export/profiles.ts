// Modèle des profils d'export. Un profil décrit COMMENT sortir des plans :
//  - timeline_import : aucun fichier, on importe la découpe dans la timeline Resolve (comme avant) ;
//  - video_remux     : fichier(s), copie de flux sans réencodage (lossless) ;
//  - video_encode    : fichier(s) ré-encodés (codec/audio/conteneur).
// Le profil ACTIF est appliqué d'un clic par le bouton « Télécharger ». Profils édités dans les
// Paramètres. Les moteurs matériels proposés sont ceux réellement sondés côté core.
import i18n from "@/i18n";

export type ExportWorkflow = "timeline_import" | "video_remux" | "video_encode";

export type ExportCodecFamily = "h264" | "h265" | "prores" | "dnxhr";

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
  | "prores_422_lt"
  | "prores_422"
  | "prores_422_hq"
  | "prores_4444"
  | "prores_4444_xq"
  | "dnxhr_lb"
  | "dnxhr_sq"
  | "dnxhr_hq"
  | "dnxhr_hqx"
  | "dnxhr_444";

// Codecs audio RÉELLEMENT employés en post aujourd'hui, chacun à plusieurs débits. Le critère est la
// COMPATIBILITÉ : AAC (universel), AC-3 (livraison broadcast Dolby, lu par tous les NLE et tous les
// lecteurs), MP3 (compatibilité héritée), et le sans-perte du montage — le PCM 16/24 bits, c'est-à-dire
// le codec que porte un WAV. Écartés : Opus (ni Resolve ni les Adobe ne l'importent), ALAC (lu par le
// seul monde Apple), FLAC (compresse sans perte mais reste un format de diffusion audio, refusé en MOV
// et ignoré des monteurs), Vorbis, MP2 et PCM 32 bits flottant (mastering audio).
export type ExportAudioMode =
  | "copy"
  | "aac_128"
  | "aac"
  | "aac_256"
  | "aac_320"
  | "ac3"
  | "ac3_640"
  | "mp3_192"
  | "mp3"
  | "pcm16"
  | "pcm24"
  | "none";

// Famille d'un codec audio : sert UNIQUEMENT à grouper le sélecteur (plusieurs débits par codec →
// une liste plate se relit mal). « copy » n'appartient à aucune famille — c'est l'absence de ré-encodage.
export type ExportAudioFamily = "lossy" | "lossless";

export type ExportContainer = "mp4" | "mkv" | "mov";

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
// « new » / « new:<nom> » = toujours une nouvelle (nommée ou auto), « tl:<nom> » = une existante par
// son nom. MÊME encodage que useTimelineTarget → le popover de destination se réutilise tel quel.
export type TimelineTargetValue = string;
const DEFAULT_TIMELINE_TARGET: TimelineTargetValue = "open";

export function coerceTimelineTarget(v: string | undefined | null): TimelineTargetValue {
  if (v === "open" || v === "new") return v;
  if (typeof v === "string" && v.startsWith("tl:") && v.slice(3).trim()) return v;
  // « new:<nom> » = nouvelle timeline nommée à la main. Saisie gardée BRUTE (trim au point d'usage,
  // comme binTarget) : trimmer ici mangerait les espaces pendant la frappe.
  if (typeof v === "string" && v.startsWith("new:")) return v.slice(4) ? v : "new";
  return DEFAULT_TIMELINE_TARGET;
}

export function timelineTargetName(v: TimelineTargetValue): string | null {
  return v.startsWith("tl:") ? v.slice(3) : null;
}

/** Cible « nouvelle timeline » (nommée ou non). */
export function isNewTimelineTarget(v: TimelineTargetValue): boolean {
  return v === "new" || v.startsWith("new:");
}

/** Nom saisi pour la nouvelle timeline, brut (null si aucun). */
export function timelineNewName(v: TimelineTargetValue): string | null {
  return v.startsWith("new:") ? v.slice(4) : null;
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

// Processing passes a profile can run WHILE re-encoding. Cutout is absent on purpose: its alpha
// needs a codec a profile may not carry, and a silently flattened matte is worse than no option.
export const EXPORT_PROCESS_KINDS = ["upscale", "interpolate", "depth"] as const;
export type ExportProcessKind = (typeof EXPORT_PROCESS_KINDS)[number];

// Two passes at most: the shots are decoded and re-encoded once per pass, so a third would cost a
// generation of quality for an effect nobody asked for.
export const EXPORT_PROCESS_MAX_STEPS = 2;

// The settings of a pass are EXACTLY those of the Traitements panel, kept in one bucket per op: two
// ops both have a `model` that means a different thing, and switching type must not throw away what
// the other one was tuned to. `kinds` names the ops that run, in order — the same op twice would pay
// the GPU twice for what one pass already did. Type-only imports: nothing of that panel lands here.
export interface ExportProcess {
  enabled?: boolean;
  kinds?: ExportProcessKind[];
  upscale?: Partial<import("@/components/upscale/upscaleShared").UpSettings>;
  interpolate?: Partial<import("@/components/upscale/processShared").InterpSettings>;
  depth?: Partial<import("@/components/upscale/processShared").DepthSettings>;
}

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
  // Rangement des FICHIERS produits (workflows video_remux / video_encode) : null/absent = écrits
  // directement dans le dossier choisi à l'export ; une chaîne = nom du sous-dossier créé dedans.
  // Pendant du binTarget, côté disque. Ignoré par l'import timeline.
  folderTarget?: string | null;
  // Timeline visée par l'import (workflow timeline_import) : "open" | "new" | "new:<nom>" | "tl:<nom>".
  timelineTarget?: TimelineTargetValue;
  // Processing pass run on every shot during the export. Only read on `video_encode`: replacing the
  // pixels is out of reach of a stream copy or of a timeline import. Absent = off.
  process?: ExportProcess;
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
  { value: "ac3", get label() { return i18n.t("export:audioMode.ac3"); } },
  { value: "ac3_640", get label() { return i18n.t("export:audioMode.ac3_640"); } },
  { value: "mp3_192", get label() { return i18n.t("export:audioMode.mp3_192"); } },
  { value: "mp3", get label() { return i18n.t("export:audioMode.mp3"); } },
  { value: "pcm16", get label() { return i18n.t("export:audioMode.pcm16"); } },
  { value: "pcm24", get label() { return i18n.t("export:audioMode.pcm24"); } },
];

export const EXPORT_CODEC_PROFILE_LABELS: Record<ExportCodec, string> = {
  h264_baseline: "Baseline",
  h264_main: "Main",
  h264_high: "High",
  get h264_high10() { return `High ${i18n.t("export:codec.bitDepth", { count: 10 })}`; },
  h264_high422: "High 4:2:2",
  h264_high444: "High 4:4:4",
  h265_main: "Main",
  get h265_main10() { return `Main ${i18n.t("export:codec.bitDepth", { count: 10 })}`; },
  get h265_main12() { return `Main ${i18n.t("export:codec.bitDepth", { count: 12 })}`; },
  get h265_main422_10() { return `Main 4:2:2 ${i18n.t("export:codec.bitDepth", { count: 10 })}`; },
  get h265_main444() { return `Main 4:4:4 ${i18n.t("export:codec.bitDepth", { count: 8 })}`; },
  get h265_main444_10() { return `Main 4:4:4 ${i18n.t("export:codec.bitDepth", { count: 10 })}`; },
  prores_422_lt: "422 LT",
  prores_422: "422",
  prores_422_hq: "422 HQ",
  prores_4444: "4444",
  prores_4444_xq: "4444 XQ",
  dnxhr_lb: "LB",
  dnxhr_sq: "SQ",
  dnxhr_hq: "HQ",
  get dnxhr_hqx() { return `HQX ${i18n.t("export:codec.bitDepth", { count: 10 })}`; },
  get dnxhr_444() { return `444 ${i18n.t("export:codec.bitDepth", { count: 10 })}`; },
};

export function getExportCodecProfileLabel(codec: ExportCodec): string {
  return EXPORT_CODEC_PROFILE_LABELS[codec] ?? getExportCodecLabel(codec);
}

/** Codecs d'une famille, dans l'ordre du catalogue. */
export function codecsForFamily(family: ExportCodecFamily): ExportCodec[] {
  return CODEC_FAMILY_TO_CODECS[family];
}

export function getCodecFamilyLabel(family: ExportCodecFamily): string {
  return CODEC_FAMILY_LABELS[family];
}

export const EXPORT_CODEC_FAMILIES = ["h264", "h265", "prores", "dnxhr"] as const;

const AUDIO_FAMILY_TO_MODES: Record<ExportAudioFamily, ExportAudioMode[]> = {
  lossy: ["aac_128", "aac", "aac_256", "aac_320", "ac3", "ac3_640", "mp3_192", "mp3"],
  lossless: ["pcm16", "pcm24"],
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
  prores: "ProRes",
  dnxhr: "DNxHR / DNxHD (Avid)",
};

const CODEC_FAMILY_TO_CODECS: Record<ExportCodecFamily, ExportCodec[]> = {
  h264: ["h264_baseline", "h264_main", "h264_high", "h264_high10", "h264_high422", "h264_high444"],
  h265: ["h265_main", "h265_main10", "h265_main12", "h265_main422_10", "h265_main444", "h265_main444_10"],
  prores: ["prores_422_lt", "prores_422", "prores_422_hq", "prores_4444", "prores_4444_xq"],
  dnxhr: ["dnxhr_lb", "dnxhr_sq", "dnxhr_hq", "dnxhr_hqx", "dnxhr_444"],
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
  if (codec.startsWith("dnxhr_")) return "dnxhr";
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
  return family === "h264" || family === "h265";
}

export function isExportCodecContainerCompatible(codec: ExportCodec, container: ExportContainer): boolean {
  const fam = getCodecFamily(codec);
  // Intermédiaires montage (ProRes / DNxHR) → conteneurs MOV/MKV (pas MP4).
  if (fam === "prores" || fam === "dnxhr") return container === "mov" || container === "mkv";
  return true; // h264/h265 → mp4/mov/mkv
}

// Conteneurs qui muxent RÉELLEMENT chaque codec audio. Table explicite plutôt qu'une suite de règles :
// une condition oubliée sortait un couple que ffmpeg refuse à l'exécution.
//  - MP4 ne porte pas le PCM de façon lisible par les monteurs (son tag `ipcm` date de 2020 et
//    aucun NLE ne le lit) → MOV/MKV pour ces modes, exactement là où vit le PCM d'un WAV.
const AUDIO_CONTAINERS: Record<Exclude<ExportAudioMode, "none">, ExportContainer[]> = {
  copy: ["mp4", "mkv", "mov"],
  aac_128: ["mp4", "mkv", "mov"],
  aac: ["mp4", "mkv", "mov"],
  aac_256: ["mp4", "mkv", "mov"],
  aac_320: ["mp4", "mkv", "mov"],
  ac3: ["mp4", "mkv", "mov"],
  ac3_640: ["mp4", "mkv", "mov"],
  mp3_192: ["mp4", "mkv", "mov"],
  mp3: ["mp4", "mkv", "mov"],
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

// Groupe une liste de codecs audio par famille pour le rendu en sections (« Copie » n'appartient à
// aucune famille et reste hors groupe, en tête).
export function groupAudioOptions(offered: { value: ExportAudioMode; label: string }[]): {
  family: ExportAudioFamily; label: string; options: { value: ExportAudioMode; label: string }[];
}[] {
  return (Object.keys(AUDIO_FAMILY_TO_MODES) as ExportAudioFamily[])
    .map((family) => ({
      family,
      get label() { return AUDIO_FAMILY_LABELS[family]; },
      options: offered.filter((o) => AUDIO_FAMILY_TO_MODES[family].includes(o.value)),
    }))
    .filter((group) => group.options.length > 0);
}

// Mêmes options, groupées par famille.
export function compatibleAudioGroupsForContainer(container: ExportContainer) {
  return groupAudioOptions(compatibleAudioForContainer(container));
}

// Codec audio de repli quand le conteneur refuse celui du profil (ex. MP4 après un profil PCM).
// L'AAC est le seul codec que les trois conteneurs portent tous.
export function getRecommendedAudioForContainer(_container: ExportContainer): ExportAudioMode {
  return "aac";
}

// Conteneurs COMPATIBLES avec un codec (pour filtrer le sélecteur → on ne propose jamais un couple invalide).
export function compatibleContainersForExportCodec(codec: ExportCodec): { value: ExportContainer; label: string }[] {
  return EXPORT_CONTAINER_OPTIONS.filter((o) => isExportCodecContainerCompatible(codec, o.value));
}

export function getRecommendedContainerForCodec(codec: ExportCodec): ExportContainer {
  const fam = getCodecFamily(codec);
  if (fam === "prores" || fam === "dnxhr") return "mov";
  return "mp4";
}

// ---------------------------------------------------------------------------
// Validité d'un profil — SOURCE UNIQUE du rouge (éditeur) et du blocage (bouton d'export).
// ---------------------------------------------------------------------------

export type ExportProfileField = "binTarget" | "folderTarget";

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
  if (usesFile(profile.workflow) && profile.folderTarget != null && !profile.folderTarget.trim()) {
    issues.push({ field: "folderTarget", message: i18n.t("export:issue.binTargetRequired") });
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
  // A processing pass multiplies the export time by ten: it belongs in the one line that says what
  // the profile does, not only inside its editor.
  const processLabel = processEnabled(profile) ? i18n.t("export:summary.processed", { label: exportProcessLabel(profile.process) }) : "";
  return `${codecLabel} · ${profile.container.toUpperCase()}${processLabel}${mergeLabel}`;
}

export function getActiveExportProfile(profiles: ExportProfile[], activeProfileId: string): ExportProfile {
  return profiles.find((p) => p.id === activeProfileId) ?? profiles[0] ?? DEFAULT_EXPORT_PROFILE;
}

// Ops the passes run, in order: known, never repeated, never more than the ceiling. Empty falls back
// on a single upscale, the op every screen offers.
export function exportProcessKinds(proc: ExportProcess | undefined | null): ExportProcessKind[] {
  const kinds = (proc?.kinds ?? []).filter((k, i, all) => EXPORT_PROCESS_KINDS.includes(k) && all.indexOf(k) === i);
  return kinds.length ? kinds.slice(0, EXPORT_PROCESS_MAX_STEPS) : ["upscale"];
}

// True when this profile really processes its shots: the option is only read on a re-encode.
export function processEnabled(profile: ExportProfile): boolean {
  return !!profile.process?.enabled && usesEncoding(profile.workflow);
}

// Name of one pass, with the number that changes what comes out: an upscale's resolution class or
// factor (restoration works at 1x, RTX VSR ignores the class — same rules as `core/upscaleArgs.js`),
// or an interpolation factor.
export function exportProcessStepLabel(proc: ExportProcess | undefined | null, kind: ExportProcessKind): string {
  const name = i18n.t(`upscale:ops.${kind}`);
  if (kind === "interpolate") return `${name} ${proc?.interpolate?.factor ?? 2}×`;
  if (kind !== "upscale") return name;
  const up = proc?.upscale;
  if (up?.mode === "restore") return `${name} 1×`;
  // `isRtxShader` lives in upscaleShared, which imports this module back: compare the id here.
  const rtx = up?.engine === "turbo" && up.shader === "rtx_vsr";
  if (up?.targetHeight && !rtx) return `${name} ${up.targetHeight}p`;
  return `${name} ${rtx ? 2 : up?.scale ?? 2}×`;
}

// The whole chain, in the order it runs.
export function exportProcessLabel(proc: ExportProcess | undefined | null): string {
  return exportProcessKinds(proc).map((k) => exportProcessStepLabel(proc, k)).join(" + ");
}

// Processing settings are kept AS THEY ARE — they are NetsuLab's own shape, and the core normalizes
// them when the job starts. Only `enabled` and `kinds` are coerced, so a profile whose option is
// switched off keeps every op it has tuned, ready for the next time.
function normalizeExportProcess(proc: ExportProcess | undefined | null): ExportProcess | undefined {
  if (!proc || typeof proc !== "object") return undefined;
  return { ...proc, enabled: !!proc.enabled, kinds: exportProcessKinds(proc) };
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
    folderTarget: typeof profile.folderTarget === "string" ? profile.folderTarget : null,
    timelineTarget: coerceTimelineTarget(profile.timelineTarget),
    process: normalizeExportProcess(profile.process),
  };
}

export function createExportProfile(index: number): ExportProfile {
  return normalizeExportProfile({
    ...DEFAULT_EXPORT_PROFILES[2],
    id: `export-profile-${index}`,
    name: i18n.t("export:profileName.generic", { index }),
  });
}
