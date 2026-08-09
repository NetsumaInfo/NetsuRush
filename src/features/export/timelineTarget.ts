// Options de montage portées par le profil d'export ACTIF quand il vise la timeline : timeline
// visée, dossier de rangement, vidéo seule. Fonction PURE — SEULE traduction profil → opts de build,
// pour que tous les chemins (créer / envoyer la sélection / ajouter un plan) se comportent pareil.
import { type ExportProfile, coerceTimelineTarget, timelineTargetName, isTimelineImport } from "./profiles";
import type { TimelineInsertionMode } from "@/features/timeline/insertion";

export interface TimelineBuildOpts {
  mode: "new" | "append";
  timelineName?: string;
  dest?: "timeline" | "bin";
  binName?: string;
  videoOnly?: boolean;
  insertion?: TimelineInsertionMode;
}

export function timelineBuildOptsFromProfile(profile: ExportProfile): TimelineBuildOpts {
  if (!isTimelineImport(profile.workflow)) return { mode: "append" };
  const target = coerceTimelineTarget(profile.timelineTarget);
  const name = timelineTargetName(target);
  const o: TimelineBuildOpts = { mode: target === "new" ? "new" : "append" };
  if (name) o.timelineName = name;
  // Trim au POINT D'USAGE (le profil garde la saisie brute) → jamais de dossier nommé « » côté hôte.
  const bin = profile.binTarget?.trim();
  if (bin) { o.dest = "bin"; o.binName = bin; }
  if (profile.audioMode === "none") o.videoOnly = true;
  return o;
}
