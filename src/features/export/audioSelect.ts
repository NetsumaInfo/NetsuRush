// Menu audio de l'export : définition UNIQUE, partagée par le panneau de droite et les Réglages
// d'export. Les deux vues lisent/écrivent le MÊME profil → elles sont synchronisées par construction.
//
// Espace de valeurs : "none" (pas d'audio) | "auto" (toutes les pistes) | "track:<i>" | "lang:<code>".
// « Pas d'audio » vit dans profile.audioMode (format de fil du core) ; le reste dans profile.audioSelect.
import type { AudioTrack } from "@/lib/bridge";
import i18n from "@/i18n";
import {
  type ExportProfile,
  type ExportWorkflow,
  AUDIO_LANGUAGES,
  AUDIO_TRACK_SLOTS,
  audioSelectValue,
  parseAudioSelectValue,
  coerceAudioSelect,
  usesEncoding,
  isTimelineImport,
} from "./profiles";

export type ExportAudioValue = string;

export interface ExportAudioItem {
  value: ExportAudioValue;
  label: string;
  group?: string;
}

export function exportAudioValue(profile: ExportProfile): ExportAudioValue {
  if (profile.audioMode === "none") return "none";
  // L'import timeline ne propose que tout-ou-rien : une règle de piste héritée d'un autre flux ne
  // figure pas dans le menu → on l'affiche pour ce qu'elle vaut ici, « toutes les pistes ».
  if (isTimelineImport(profile.workflow)) return "auto";
  return audioSelectValue(coerceAudioSelect(profile.audioSelect));
}

// Patch de profil pour une valeur de menu. Choisir une piste alors que le son est coupé n'a pas de
// sens : on rallume l'audio avec un codec valide pour le flux (« Copie » sauf en ré-encodage).
export function applyExportAudioValue(profile: ExportProfile, v: ExportAudioValue): Partial<ExportProfile> {
  if (v === "none") return { audioMode: "none" };
  const audioSelect = coerceAudioSelect(parseAudioSelectValue(v));
  const revive = profile.audioMode === "none" ? { audioMode: usesEncoding(profile.workflow) ? ("aac" as const) : ("copy" as const) } : {};
  return { audioSelect, ...revive };
}

// Options du menu. `tracks` = pistes réellement sondées de la source (vide si aucune source connue,
// ex. les Réglages d'export ouverts hors d'un clip → on retombe sur des numéros génériques).
export function exportAudioItems({ workflow, tracks }: { workflow: ExportWorkflow; tracks: AudioTrack[] }): ExportAudioItem[] {
  const items: ExportAudioItem[] = [
    { value: "auto", label: i18n.t("export:audio.allTracks") },
    { value: "none", label: i18n.t("export:audio.noAudio") },
  ];
  // Import timeline : Resolve n'expose que mediaType 1 (vidéo seule) sur AppendToTimeline — aucune
  // sélection de piste n'est possible, donc on n'en propose pas.
  if (isTimelineImport(workflow)) return items;

  const trackGroup = i18n.t("export:audio.trackGroup");
  if (tracks.length) {
    for (const t of tracks) items.push({ value: `track:${t.index}`, label: audioTrackLabel(t), group: trackGroup });
  } else {
    for (let i = 0; i < AUDIO_TRACK_SLOTS; i++) items.push({ value: `track:${i}`, label: i18n.t("export:audio.trackN", { n: i + 1 }), group: trackGroup });
  }
  const langGroup = i18n.t("export:audio.languageGroup");
  for (const l of AUDIO_LANGUAGES) items.push({ value: `lang:${l.code}`, label: l.label, group: langGroup });
  return items;
}

export function audioTrackLabel(t: AudioTrack): string {
  return i18n.t("export:audio.trackLabel", {
    n: t.index + 1,
    lang: t.lang ? ` · ${t.lang}` : "",
    channels: t.channels,
    codec: t.codec,
  });
}

// Piste à laquelle se résout une règle par langue sur cette source. `langCode` est normalisé côté
// core (audioLang) → pas de table de variantes dupliquée ici.
export function resolveLanguageTrack(tracks: AudioTrack[], code: string | undefined | null): AudioTrack | null {
  if (!code) return null;
  return tracks.find((t) => t.langCode === code) ?? null;
}
