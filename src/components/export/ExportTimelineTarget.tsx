// Timeline visée par l'import, adossée au PROFIL d'export : même valeur dans le panneau de droite et
// dans les Réglages d'export. Réutilise le popover de destination du derush.
import { useApp } from "@/store";
import { TimelineTargetSelect } from "@/components/rushes/TimelineTargetSelect";
import { useTimelineList } from "@/components/rushes/useTimelineList";
import { type ExportProfile, coerceTimelineTarget, isTimelineImport } from "@/features/export/profiles";

export function ExportTimelineTarget({ profile, className, disabled }: { profile: ExportProfile; className?: string; disabled?: boolean }) {
  const update = useApp((s) => s.updateExportProfile);
  const enabled = isTimelineImport(profile.workflow);
  // Le canal listTimelines choisit lui-même la meilleure source : Resolve en ligne, sinon snapshot.
  // `s.connected` appartient au Media Pool du derush et peut être faux alors que l'API Resolve répond.
  // Hors import timeline, le sélecteur reste POSÉ mais inerte (l'éditeur ne doit pas sauter) : rien
  // n'est alors demandé à Resolve, la liste vide suffit à afficher le libellé de la valeur gardée.
  const { timelines, current } = useTimelineList(enabled);

  return (
    <TimelineTargetSelect
      className={className}
      disabled={disabled ?? !enabled}
      target={{
        timelines,
        current,
        value: coerceTimelineTarget(profile.timelineTarget),
        setValue: (v) => update(profile.id, { timelineTarget: coerceTimelineTarget(v) }),
      }}
    />
  );
}
