// Barre d'action du lot (accueil NetsuTalk) : analyser la sélection, puis la RENDRE avec le profil
// d'export actif (mêmes profils que le Derush et la Recherche — une seule notion de « rendu » dans
// l'app). Clic droit sur le bouton de rendu = changer de profil sans quitter la page.
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import { CircleStop, Settings2, Sparkles, Play } from "lucide-react";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
  ContextMenuCheckboxItem, ContextMenuGroup, ContextMenuLabel, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { ExportProfileIcon } from "@/components/export/exportIcons";
import { getActiveExportProfile, getExportProfileIssues, getExportProfileSummary } from "@/features/export/profiles";

interface VoiceBatchBarProps {
  selectedCount: number;
  onAnalyze: () => void;
  onRender: () => void;
}

export function VoiceBatchBar({ selectedCount, onAnalyze, onRender }: VoiceBatchBarProps) {
  const { t } = useTranslation(["voice", "export"]);
  const {
    voiceBatch, voiceBatchRunning, stopVoiceBatch, voiceRender, voiceRenderRunning, stopVoiceRender,
    profiles, activeId, setActiveProfile, openExportSettings,
  } = useApp(useShallow((s) => ({
    voiceBatch: s.voiceBatch, voiceBatchRunning: s.voiceBatchRunning, stopVoiceBatch: s.stopVoiceBatch,
    voiceRender: s.voiceRender, voiceRenderRunning: s.voiceRenderRunning, stopVoiceRender: s.stopVoiceRender,
    profiles: s.exportProfiles, activeId: s.activeExportProfileId,
    setActiveProfile: s.setActiveExportProfile, openExportSettings: s.openExportSettings,
  })));

  const profile = getActiveExportProfile(profiles, activeId);
  const issue = getExportProfileIssues(profile)[0];
  const busy = voiceBatchRunning || voiceRenderRunning;
  const analysing = Object.values(voiceBatch).filter((e) => e.status === "running").length;
  const rendering = Object.values(voiceRender).filter((e) => e.status === "running").length;
  const queued = Object.values(voiceRender).filter((e) => e.status === "queued").length
    + Object.values(voiceBatch).filter((e) => e.status === "queued").length;
  const none = selectedCount === 0;

  if (busy) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="destructive" size="sm" onClick={voiceRenderRunning ? stopVoiceRender : stopVoiceBatch}>
          <CircleStop className="size-4" /> {t("voice:home.stop")}
        </Button>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          {voiceRenderRunning
            ? t("voice:render.runningCount", { count: rendering })
            : t("voice:home.runningCount", { count: analysing })}
          {queued ? ` · ${t("voice:home.queuedSuffix", { count: queued })}` : ""}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={none} onClick={onAnalyze}>
        <Sparkles className="size-4" />
        {none ? t("voice:home.analyzeSelection") : t("voice:home.analyzeCount", { count: selectedCount })}
      </Button>

      <ContextMenu>
        <ContextMenuTrigger render={<div className="inline-flex min-w-0 items-stretch" />}>
          <Tooltip>
            <TooltipTrigger render={
              <Button size="sm" className="min-w-0 rounded-r-none" disabled={none || !!issue} onClick={onRender} />
            }>
              <ExportProfileIcon profile={profile} className="size-4 shrink-0" />
              <span className="truncate">
                {none ? t("voice:render.action") : t("voice:render.actionCount", { count: selectedCount })}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {issue ? issue.message : `${profile.name} — ${getExportProfileSummary(profile)}`}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={
              <Button size="sm" variant="secondary" className="rounded-l-none border-l border-primary-foreground/20 px-2"
                aria-label={t("export:settings.title")} onClick={() => openExportSettings()} />
            }>
              <Settings2 className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t("voice:render.profileHint")}</TooltipContent>
          </Tooltip>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-52">
          <ContextMenuGroup>
            <ContextMenuLabel>{t("export:settings.menuLabel")}</ContextMenuLabel>
            {profiles.map((p) => (
              <ContextMenuCheckboxItem key={p.id} checked={p.id === activeId} onClick={() => setActiveProfile(p.id)}>
                <ExportProfileIcon profile={p} className="size-4 shrink-0" /> {p.name}
              </ContextMenuCheckboxItem>
            ))}
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => openExportSettings()}><Settings2 /> {t("export:settings.title")}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Rappel de ce que fait le bouton : le profil décide fichier OU timeline, ce n'est pas deviné. */}
      <span className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex">
        <Play className="size-3" /> {getExportProfileSummary(profile)}
      </span>
    </div>
  );
}
