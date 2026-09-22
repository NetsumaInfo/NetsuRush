import { useTranslation } from "react-i18next";
import { Sparkles, Wrench, Gauge, Bug } from "lucide-react";
import { CHANGE_KINDS, releaseLines, releaseText, type ChangeKind, type Release } from "@/data/releases";
import { cn } from "@/lib/utils";

// Le contenu d'une version, classé par nature. Partagé par la fenêtre qui s'ouvre après une mise à
// jour et par l'historique des paramètres : une seule règle de classement, un seul jeu d'icônes.
//
// Vingt lignes à la file se valent toutes visuellement, si bien que la seule vraie nouveauté se perd
// au milieu des petites réparations. Groupées, on voit d'un coup d'œil ce que la version apporte
// avant de décider d'en lire le détail. Les versions antérieures à ce classement n'ont qu'une liste :
// elles s'affichent telle qu'elle a été écrite, plutôt que de recevoir des étiquettes inventées
// après coup.

const SECTIONS: Record<ChangeKind, { icon: typeof Sparkles; tone: string }> = {
  feature: { icon: Sparkles, tone: "text-primary" },
  improvement: { icon: Wrench, tone: "text-foreground" },
  performance: { icon: Gauge, tone: "text-[var(--color-ok)]" },
  fix: { icon: Bug, tone: "text-muted-foreground" },
};

export function ReleaseNotes({ release, compact = false }: { release: Release; compact?: boolean }) {
  const { t, i18n } = useTranslation("settings");
  const language = i18n.language;
  const grouped = CHANGE_KINDS
    .map((kind) => ({
      kind,
      ...SECTIONS[kind],
      entries: (release.changes ?? []).filter((change) => change.kind === kind),
    }))
    .filter((section) => section.entries.length > 0);

  if (!grouped.length) {
    // Version antérieure au classement : sa liste, telle quelle.
    return (
      <ul className={cn(
        "list-disc space-y-1 pl-5 text-muted-foreground",
        compact ? "text-xs" : "space-y-2 text-sm",
      )}>
        {releaseLines(release, language).map((line) => <li key={line}>{line}</li>)}
      </ul>
    );
  }

  return (
    <div className={cn("flex flex-col", compact ? "gap-3" : "gap-5")}>
      {grouped.map(({ kind, icon: Icon, tone, entries }) => (
        <section key={kind}>
          {/* Le compte est dans le titre : il dit d'emblée si la section vaut d'être lue. */}
          <h3 className={cn("flex items-center gap-2 font-medium", compact ? "text-xs" : "text-sm")}>
            <Icon className={cn("shrink-0", compact ? "size-3.5" : "size-4", tone)} />
            {t(`updates.kind.${kind}`)}
            <span className="text-xs font-normal text-muted-foreground">{entries.length}</span>
          </h3>
          <ul className={cn(
            "mt-1.5 list-disc text-muted-foreground",
            compact ? "space-y-1 pl-6 text-xs" : "mt-2 space-y-2 pl-7 text-sm",
          )}>
            {entries.map((change) => <li key={change.en}>{releaseText(change, language)}</li>)}
          </ul>
        </section>
      ))}
    </div>
  );
}
