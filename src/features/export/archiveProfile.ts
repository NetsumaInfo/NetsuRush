// Profil d'export fabriqué à partir des réglages d'archivage d'une collection.
//
// Le core ne connaît pas les profils d'export : il reçoit un profil complet. Les réglages
// d'archivage d'une collection (format, codec, conteneur, audio, traitement) EN sont un, écrit
// autrement — on le reconstitue ici, à un seul endroit, parce que trois appelants en ont besoin :
// l'archivage, la mise en file, et le PARTAGE (partager une collection, c'est l'archiver).
import type { CollectionArchive } from "@/lib/bridge";
import {
  coerceExportCodec, coerceExportContainer, coerceExportAudioMode, coerceAudioSelect,
  coerceExportEncoderMode, coerceExportSpeed, type ExportProfile,
} from "./profiles";
import i18n from "@/i18n";

export const archiveProcessing = (a: CollectionArchive | null | undefined) => !!a?.process?.enabled;

export function archiveProfile(a: CollectionArchive | null | undefined): ExportProfile {
  return {
    id: "__archive__", name: i18n.t("collections:archive.profileName"),
    workflow: a?.workflow === "video_encode" || archiveProcessing(a) ? "video_encode" : "video_remux",
    codec: coerceExportCodec(a?.codec), audioMode: coerceExportAudioMode(a?.audioMode),
    container: coerceExportContainer(a?.container), mergeEnabled: false,
    encoderMode: coerceExportEncoderMode(a?.encoderMode), speed: coerceExportSpeed(a?.speed),
    audioSelect: coerceAudioSelect(a?.audioSelect),
  };
}
