// Timeline visée par l'import, adossée au PROFIL d'export : même valeur dans le panneau de droite et
// dans les Réglages d'export. Réutilise le popover de destination du derush.
import { useApp } from "@/store";
import { TimelineTargetSelect } from "@/components/rushes/TimelineTargetSelect";
import { useTimelineList } from "@/components/rushes/useTimelineList";
import { type ExportProfile, coerceTimelineTarget } from "@/features/export/profiles";

export function ExportTimelineTarget({ profile, className, disabled }: { profile: ExportProfile; className?: string; disabled?: boolean }) {
  const update = useApp((s) => s.updateExportProfile);
  // Le canal listTimelines choisit lui-même la meilleure source : Resolve en ligne, sinon snapshot.
  // `s.connected` appartient au Media Pool du derush et peut être faux alors que l'API Resolve répond.
  // La liste est chargée dès que le sélecteur est utilisable : un menu qu'on peut ouvrir mais qui
  // ne propose aucune timeline se lit comme un projet vide.
  const { timelines, current } = useTimelineList(!disabled);

  return (
    <TimelineTargetSelect
      className={className}
      disabled={disabled}
      target={{
        timelines,
        current,
        value: coerceTimelineTarget(profile.timelineTarget),
        setValue: (v) => update(profile.id, { timelineTarget: coerceTimelineTarget(v) }),
      }}
    />
  );
}
