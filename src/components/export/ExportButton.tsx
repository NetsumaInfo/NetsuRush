// Bouton d'export partagé (Derush + Recherche). Partie gauche = applique le PROFIL ACTIF d'un
// clic (import timeline OU export fichier selon le flux), libellé = NOM du profil + icône. Partie
// droite = engrenage → petite fenêtre flottante (ExportQuickDialog) pour paramétrer, sans changer
// de page ni recharger.
import { useApp } from "@/store";
import { useExport } from "./useExport";
import { type ExportClipInput } from "@/lib/bridge";
import {
  getActiveExportProfile, getExportProfileSummary, isTimelineImport, getExportProfileIssues,
} from "@/features/export/profiles";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
  ContextMenuCheckboxItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuGroup,
} from "@/components/ui/context-menu";
import { Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { ExportProfileIcon } from "./exportIcons";
import { ExportQuickDialog } from "./ExportQuickDialog";
import { TimelineInsertionButton } from "@/components/rushes/TimelineInsertionSelect";

interface ExportButtonProps {
  clips: () => ExportClipInput[];
  baseName: string;
  onTimelineImport?: () => void;
  verb?: string;
  disabled?: boolean;
  className?: string;
  // Force la fusion quel que soit le profil. Un montage voix sort UN fichier : ses centaines de
  // segments de parole n'ont aucun sens en fichiers séparés.
  merge?: boolean;
  // Barre d'outils : duo compact h-8 (icône du profil + engrenage), le nom du profil passe dans
  // l'infobulle. Sinon : bouton pleine largeur h-9 avec le nom, pour les panneaux latéraux.
  compact?: boolean;
}

export function ExportButton({ clips, baseName, onTimelineImport, verb, disabled, className, merge, compact = false }: ExportButtonProps) {
  const { t } = useTranslation("export");
  const profiles = useApp((s) => s.exportProfiles);
  const activeId = useApp((s) => s.activeExportProfileId);
  const setActiveProfile = useApp((s) => s.setActiveExportProfile);
  const openExportSettings = useApp((s) => s.openExportSettings);
  const { download, busy } = useExport();

  const active = getActiveExportProfile(profiles, activeId);
  const toTimeline = isTimelineImport(active.workflow);
  // Profil incomplet (ex. « Dossier » sans nom) → export IMPOSSIBLE : bouton éteint + infobulle qui
  // dit quoi corriger, plutôt qu'un clic qui échoue côté hôte.
  const issue = getExportProfileIssues(active)[0];

  const run = () => {
    if (issue) return;
    if (toTimeline) onTimelineImport?.();
    else void download({ clips: clips(), baseName, merge });
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className={cn("inline-flex min-w-0 items-stretch", className)} />}>
        <Tooltip>
          <TooltipTrigger
            render={compact
              // Même gabarit que les autres actions d'une barre d'outils (h-8, contour, texte
              // atténué — cf. Découpage et Timeline Live) : en `ghost` 24 px il flottait, plus
              // petit et sans cadre, au milieu d'une rangée de boutons contournés.
              ? <Button variant="outline" size="icon-sm" aria-label={active.name} onClick={run} disabled={disabled || !!busy || !!issue} className="rounded-r-none text-muted-foreground" />
              : <Button variant="outline" className="min-w-0 flex-1 justify-start rounded-r-none" onClick={run} disabled={disabled || !!busy || !!issue} />}
          >
            <ExportProfileIcon profile={active} className={compact ? "size-3.5 shrink-0" : "size-4 shrink-0"} />
            {!compact && <span className="truncate">{busy || `${active.name}${verb ? ` ${verb}` : ""}`}</span>}
          </TooltipTrigger>
          <TooltipContent>{issue ? issue.message : `${active.name} — ${getExportProfileSummary(active)}`}</TooltipContent>
        </Tooltip>

        {/* Segment central : mode d'insertion. Toujours présent en barre d'outils — il ne gouverne
            pas que le profil d'export, mais TOUT montage timeline de la vue (bouton clap compris,
            cf. useTimelineTarget qui lit `timelineInsertions[host]`). */}
        {compact && <TimelineInsertionButton className="rounded-none border-l-0" />}

        <ExportQuickDialog compact={compact} />
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        <ContextMenuGroup>
          <ContextMenuLabel>{t("settings.menuLabel")}</ContextMenuLabel>
          {profiles.map((p) => (
            <ContextMenuCheckboxItem key={p.id} checked={p.id === activeId} onClick={() => setActiveProfile(p.id)}>
              <ExportProfileIcon profile={p} className="size-4 shrink-0" /> {p.name}
            </ContextMenuCheckboxItem>
          ))}
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => openExportSettings()}><Settings2 /> {t("settings.title")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
