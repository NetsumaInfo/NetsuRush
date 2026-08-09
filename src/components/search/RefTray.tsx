import { useTranslation } from "react-i18next";
import { ImagePlus, X, Sparkles, Images, Trash2 } from "lucide-react";
import type { SearchRef } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";

type Props = {
  refs: SearchRef[];
  searching: boolean;
  onSearch: () => void;
  removeRef: (idx: number) => void;
  clearRefs: () => void;
};

// Bac de références (image→image / moodboard multi-exemple). La recherche par visage a son
// propre picker (FaceRefPicker, bouton « Visage » de la barre) — plus de bouton ici.
export function RefTray({ refs, searching, onSearch, removeRef, clearRefs }: Props) {
  const { t } = useTranslation("search");
  if (refs.length === 0) return null;
  return (
    <Card className="block border-border/70 p-2.5">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <Images className="h-4 w-4 text-primary" />
        <span className="font-medium">{t("refTray.title", { count: refs.length })}</span>
        <span className="text-muted-foreground">{refs.length === 1 ? t("refTray.singleMode") : t("refTray.multiMode")}</span>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger render={<Button size="icon-sm" aria-label={t("refTray.findSimilarAria")} disabled={searching} onClick={onSearch} />}>
            {searching ? <Spinner /> : <Sparkles className="h-3.5 w-3.5" />}
          </TooltipTrigger>
          <TooltipContent>{t("refTray.findSimilarTooltip")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("refTray.clearAria")} onClick={clearRefs} />}>
            <X className="h-3.5 w-3.5" />
          </TooltipTrigger>
          <TooltipContent>{t("refTray.clearTooltip")}</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex flex-wrap gap-2">
        {refs.map((r, i) => (
          <ContextMenu key={r.path ? `p:${r.path}` : `s:${r.file_path}#${r.scene_index}`}>
            <ContextMenuTrigger render={<div className="group relative h-14 w-20 shrink-0 overflow-hidden rounded-lg border border-border bg-muted transition-colors hover:border-primary/60" />}>
              {r.thumb
                ? <img src={r.thumb} alt="" className="h-full w-full object-cover" />
                : <div className="flex h-full items-center justify-center text-muted-foreground"><ImagePlus className="h-4 w-4" /></div>}
              {/* Retirer : pastille pleine et opaque (l'ancienne, 16 px translucide sur la vignette,
                  était illisible sur une image claire) + voile au survol pour détacher l'icône. */}
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/50 to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
              <Tooltip>
                <TooltipTrigger render={<button type="button" onClick={() => removeRef(i)} aria-label={t("refTray.remove")} className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-background text-foreground shadow-sm ring-1 ring-border opacity-0 transition-opacity hover:bg-destructive hover:text-white group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-primary" />}>
                  <X className="size-3" />
                </TooltipTrigger>
                <TooltipContent>{t("refTray.remove")}</TooltipContent>
              </Tooltip>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-48">
              <ContextMenuItem onClick={onSearch} disabled={searching}><Sparkles /> {t("refTray.findSimilarMenu")}</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={() => removeRef(i)}><X /> {t("refTray.remove")}</ContextMenuItem>
              <ContextMenuItem variant="destructive" onClick={clearRefs}><Trash2 /> {t("refTray.clearTooltip")}</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>
    </Card>
  );
}
