import type { ExportEncodingValue } from "@/features/export/encodingFields";
import {
  coerceExportEncoderMode,
  coerceExportSpeed,
  usesEncoding,
  type ExportAudioMode,
  type ExportCodec,
  type ExportContainer,
  type ExportEncoderMode,
  type ExportProfile,
  type ExportSpeed,
} from "@/features/export/profiles";

// Contrat d'encodage partagé par Upscale / Interpolation / Profondeur. Les valeurs sont exactement
// celles des profils d'export généraux : une seule taxonomie renderer → core → ffmpeg.
export interface ProcessExportSettings {
  exportCodec: ExportCodec;
  encoderMode: ExportEncoderMode;
  exportSpeed: ExportSpeed;
  exportAudioMode: ExportAudioMode;
  exportContainer: ExportContainer;
  // -1 = toutes les pistes ; >= 0 = piste précise. Le son coupé vit dans exportAudioMode="none".
  audioTrack: number;
}

export const DEFAULT_PROCESS_EXPORT: ProcessExportSettings = {
  exportCodec: "h265_main10",
  encoderMode: "gpu",
  exportSpeed: "balanced",
  exportAudioMode: "copy",
  exportContainer: "mp4",
  audioTrack: -1,
};

// Le hub nomme ses champs d'encodage `export*` (ils cohabitent avec les réglages de traitement) ;
// la logique partagée des sélecteurs parle le vocabulaire des profils. Deux traductions pures.
export function processEncodingValue(settings: ProcessExportSettings): ExportEncodingValue {
  return {
    codec: settings.exportCodec,
    container: settings.exportContainer,
    audioMode: settings.exportAudioMode,
    encoderMode: settings.encoderMode,
    speed: settings.exportSpeed,
  };
}

export function processEncodingPatch(patch: Partial<ExportEncodingValue>): Partial<ProcessExportSettings> {
  const next: Partial<ProcessExportSettings> = {};
  if (patch.codec) next.exportCodec = patch.codec;
  if (patch.container) next.exportContainer = patch.container;
  if (patch.audioMode) next.exportAudioMode = patch.audioMode;
  if (patch.encoderMode) next.encoderMode = patch.encoderMode;
  if (patch.speed) next.exportSpeed = patch.speed;
  return next;
}

// NetsuLab encode TOUJOURS un nouveau fichier : seuls les profils de ré-encodage s'y appliquent
// (un profil « timeline » ou « copie des flux » n'a pas de codec de sortie à donner).
export function isProcessExportProfile(profile: ExportProfile): boolean {
  return usesEncoding(profile.workflow);
}

// Profil général → réglages d'encodage du hub. La sélection de piste par LANGUE n'a pas d'équivalent
// ici (elle se résout par fichier côté core, au moment de l'export de plans) → on retombe sur « toutes
// les pistes », le mode par défaut du hub.
export function processExportFromProfile(profile: ExportProfile): ProcessExportSettings {
  return {
    exportCodec: profile.codec,
    encoderMode: coerceExportEncoderMode(profile.encoderMode),
    exportSpeed: coerceExportSpeed(profile.speed),
    exportAudioMode: profile.audioMode,
    exportContainer: profile.container,
    audioTrack: profile.audioSelect?.mode === "track" ? profile.audioSelect.track ?? 0 : -1,
  };
}

// Id du profil dont les réglages d'encodage correspondent EXACTEMENT à l'état courant, sinon null
// (= « Personnalisé »). La piste audio est exclue de la comparaison : elle dépend du média chargé,
// pas du profil.
export function matchProcessExportProfile(profiles: ExportProfile[], settings: ProcessExportSettings): string | null {
  const match = profiles.filter(isProcessExportProfile).find((profile) => {
    const mapped = processExportFromProfile(profile);
    return mapped.exportCodec === settings.exportCodec
      && mapped.encoderMode === settings.encoderMode
      && mapped.exportSpeed === settings.exportSpeed
      && mapped.exportAudioMode === settings.exportAudioMode
      && mapped.exportContainer === settings.exportContainer;
  });
  return match?.id ?? null;
}

export function processExportPayload(settings: ProcessExportSettings) {
  return {
    exportCodec: settings.exportCodec,
    encoderMode: settings.encoderMode,
    speed: settings.exportSpeed,
    audioMode: settings.exportAudioMode,
    container: settings.exportContainer,
    audioTrack: settings.audioTrack,
  };
}
