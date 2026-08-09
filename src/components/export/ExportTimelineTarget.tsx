// Timeline visée par l'import, adossée au PROFIL d'export : même valeur dans le panneau de droite et
// dans les Réglages d'export. Réutilise le popover de destination du derush.
import { useApp } from "@/store";
import { TimelineTargetSelect } from "@/components/rushes/TimelineTargetSelect";
import { useTimelineList } from "@/components/rushes/useTimelineList";
import { type ExportProfile, coerceTimelineTarget, isTimelineImport } from "@/features/export/profiles";

export function ExportTimelineTarget({ profile, className }: { profile: ExportProfile; className?: string }) {
  const update = useApp((s) => s.updateExportProfile);
  const enabled = isTimelineImport(profile.workflow);
  // Le canal listTimelines choisit lui-même la meilleure source : Resolve en ligne, sinon snapshot.
  // `s.connected` appartient au Media Pool du derush et peut être faux alors que l'API Resolve répond.
  const { timelines, current } = useTimelineList(enabled);
  if (!enabled) return null;

  return (
    <TimelineTargetSelect
      className={className}
      target={{
        timelines,
        current,
        value: coerceTimelineTarget(profile.timelineTarget),
        setValue: (v) => update(profile.id, { timelineTarget: coerceTimelineTarget(v) }),
      }}
    />
  );
}
