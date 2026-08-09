// Barre du haut MINIMALE (focus écriture) : toggle Footages · stats · Aperçu du montage ·
// « Vers la timeline » (export natif, routé par hôte via useScriptExport) · menu ⋯ (carnet,
// historique des versions, modes de vue, raccourcis) · toggle panneau droit. Le titre du doc vit
// en tête de feuille (NotebookEditor) ; les modes de vue et actions rares vivent dans le menu ⋯.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelLeft, PanelRight, MoreHorizontal, FileText, LayoutGrid, VolumeX, Play, Clapperboard, Loader2, AlertTriangle, Bookmark, NotebookPen, History, Keyboard, Settings2, Columns2, ExternalLink } from "lucide-react";
import { useApp } from "@/store";
import { nr } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { hostShort } from "@/lib/host";
import { docStats, fmtDuration, type ScriptView } from "./scriptShared";
import { useScript } from "./useScript";
import { useScriptExport } from "./useScriptExport";
import { ScriptSettings } from "./ScriptSettings";
import { VersionHistory } from "./VersionHistory";

interface Props {
  view: ScriptView;
  onSetView: (v: ScriptView) => void;
  save: () => Promise<void> | void;
}

const VIEWS: { id: ScriptView; icon: typeof LayoutGrid }[] = [
  { id: "all", icon: LayoutGrid },
  { id: "no-audio", icon: VolumeX },
  { id: "text-only", icon: FileText },
];

const SHORTCUTS = ["insert", "headings", "headingText", "favoriteTag", "footages", "outline"] as const;
const SHORTCUT_KEYS = ["/", "#  ##  ###", "Ctrl Alt H", "Ctrl 1-9", "Ctrl [", "Ctrl ]"];

export function ScriptTopBar({ view, onSetView, save }: Props) {
  const { t } = useTranslation("script");
  const doc = useScript((s) => s.doc);
  const footagesOpen = useScript((s) => s.footagesOpen);
  const rightOpen = useScript((s) => s.rightOpen);
  const splitOpen = useScript((s) => s.splitOpen);
  const activeHost = useApp((s) => s.activeHost);
  const openScriptNotebook = useApp((s) => s.nbForScript);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"new" | "append">("new");
  const [exportMarkers, setExportMarkers] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { clips, markers, partial, sectionCount, build, resetBuild, run } = useScriptExport(save);

  if (!doc) return null;
  const stats = docStats(doc);
  const adobe = activeHost !== "resolve";

  return (
    <header className="top-bar">
      <div className="top-bar-left">
        <Tooltip>
          <TooltipTrigger render={<button type="button" className={`toggle-btn ${footagesOpen ? "active" : ""}`} onClick={() => useScript.getState().toggleFootages()} />}><PanelLeft /></TooltipTrigger>
          <TooltipContent>{t("topbar.footages")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="top-bar-center">
        <span className="doc-stats-line">
          {t("topbar.stats", { paragraphs: stats.paragraphs, words: stats.words, duration: fmtDuration(stats.seconds) })}
        </span>
      </div>

      <div className="top-bar-right">
        <Tooltip>
          <TooltipTrigger render={<button type="button" className={`toggle-btn ${splitOpen ? "active" : ""}`} onClick={() => useScript.getState().toggleSplit()} />}><Columns2 /></TooltipTrigger>
          <TooltipContent>{t("topbar.notebookSplit")}</TooltipContent>
        </Tooltip>

        <Button size="sm" disabled={!clips.length} onClick={() => { resetBuild(); setOpen(true); }}>
          <Play /> {t("topbar.toTimeline")}{partial && <span className="section-badge">{sectionCount}</span>}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger render={<button type="button" className="toggle-btn" aria-label={t("topbar.moreActions")} />}><MoreHorizontal /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onClick={() => void openScriptNotebook(doc.id, t("topbar.notebookName", { title: doc.title || "script" }))}>
              <NotebookPen /> {t("topbar.scriptNotebook")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => nr.notebook?.detach()}>
              <ExternalLink /> {t("topbar.notebookWindow")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShowHistory(true)}>
              <History /> {t("versions.title")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShowSettings(true)}>
              <Settings2 /> {t("topbar.scriptSettings")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShowShortcuts(true)}>
              <Keyboard /> {t("topbar.keyboardShortcuts")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("topbar.display")}</DropdownMenuLabel>
              {VIEWS.map((v) => (
                <DropdownMenuItem key={v.id} onClick={() => onSetView(v.id)}>
                  <v.icon /> {t(`topbar.views.${v.id}`)}{view === v.id && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip>
          <TooltipTrigger render={<button type="button" className={`toggle-btn ${rightOpen ? "active" : ""}`} onClick={() => useScript.getState().toggleRight()} />}><PanelRight /></TooltipTrigger>
          <TooltipContent>{t("topbar.rightPanel")}</TooltipContent>
        </Tooltip>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle className="flex items-center gap-2"><Clapperboard className="size-4" /> {t("topbar.buildTimeline")}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {t("topbar.buildSummary", { count: clips.length, host: adobe ? t("topbar.adobeSequence", { host: hostShort(activeHost) }) : t("topbar.resolveNative") })}
            {partial ? ` ${t("topbar.partialScope")}` : ""}
          </p>
          <ToggleGroup className="w-full" value={[mode]} onValueChange={(v) => v[0] && setMode(v[0] as "new" | "append")}>
            <ToggleGroupItem className="flex-1" value="new">{t("topbar.newTimeline")}</ToggleGroupItem>
            <ToggleGroupItem className="flex-1" value="append">{t("topbar.currentTimeline")}</ToggleGroupItem>
          </ToggleGroup>
          {markers.length > 0 && !adobe && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" className="nr-check outline-none focus-visible:ring-1 focus-visible:ring-ring" checked={exportMarkers} onChange={(e) => setExportMarkers(e.target.checked)} />
              <Bookmark className="size-3.5" /> {t("topbar.commentsMarkers", { count: markers.length })}
            </label>
          )}
          {markers.length > 0 && adobe && (
            <p className="text-xs text-muted-foreground">{t("topbar.markersResolveOnly")}</p>
          )}
          {build.kind === "busy" && build.progress && (
            <p className="text-xs text-muted-foreground">{build.progress}</p>
          )}
          {build.kind !== "idle" && build.kind !== "busy" && (
            <div className={`flex items-start gap-1.5 text-xs ${build.kind === "error" || ("warn" in build && build.warn) ? "text-destructive" : "text-[var(--color-ok)]"}`}>
              {(build.kind === "error" || ("warn" in build && build.warn)) && <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
              <span>{build.text}</span>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>{t("common.close")}</Button>
            <Button disabled={!clips.length || build.kind === "busy"} onClick={() => void run(mode, exportMarkers)}>
              {build.kind === "busy" ? <Loader2 className="size-4 animate-spin" /> : <Clapperboard className="size-4" />} {t("topbar.build")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {showHistory && <VersionHistory onClose={() => setShowHistory(false)} save={save} />}

      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle className="flex items-center gap-2"><Settings2 className="size-4" /> {t("topbar.scriptSettings")}</DialogTitle>
          <ScriptSettings mode="doc" />
        </DialogContent>
      </Dialog>

      <Dialog open={showShortcuts} onOpenChange={setShowShortcuts}>
        <DialogContent className="sm:max-w-xs">
          <DialogTitle className="flex items-center gap-2"><Keyboard className="size-4" /> {t("topbar.shortcuts")}</DialogTitle>
          <div className="shortcut-list">
            {SHORTCUTS.map((id, index) => (
              <div key={id} className="shortcut-row"><span className="kbd">{SHORTCUT_KEYS[index]}</span> {t(`topbar.shortcutItems.${id}`)}</div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </header>
  );
}
