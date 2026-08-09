import { X, Layers, Eraser, Eye } from "lucide-react";
import { useApp } from "@/store";
import { nlSrcKey } from "@/store/netsulab";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { LazyThumb } from "@/components/rushes/LazyThumb";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

// Garde-fou : le clic qui FERME un menu contextuel (Base UI) ne doit pas déclencher l'aperçu d'une
// autre ligne (setActive → lecteur). On ignore les clics survenus juste après une fermeture de menu.
let lastCtxCloseAt = 0;
const noteCtx = (open: boolean) => { if (!open) lastCtxCloseAt = performance.now(); };
const guarded = (fn: () => void) => { if (performance.now() - lastCtxCloseAt < 250) return; fn(); };

// Bac de sélection : chaque source cochée (fichier ou plan, quel que soit le dossier) atterrit ici.
// Vignette + nom → on reconnaît ce qui est sélectionné ; l'entrée aperçue au centre est marquée (œil).
// Clic sur une ligne → aperçue au centre ; croix → retirée.
export function SelectionTray() {
  const { t } = useTranslation("upscale");
  const sources = useApp((s) => s.nlSources);
  const activeIdx = useApp((s) => s.nlActiveIdx);
  const setActive = useApp((s) => s.nlSetActiveIdx);
  const remove = useApp((s) => s.nlRemoveSource);
  const clear = useApp((s) => s.nlClearSources);

  if (sources.length === 0) return null;

  return (
    <div className="flex min-h-0 flex-col border-t border-border">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Layers className="h-3.5 w-3.5 text-primary" />
          {t("tray.title")}
          <span className="tabular-nums text-muted-foreground">({sources.length})</span>
        </div>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={clear} aria-label={t("tray.clearAll")}>
            <Eraser className="h-3.5 w-3.5" />
          </Button>} />
          <TooltipContent>{t("tray.clearAll")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="max-h-56 min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {sources.map((s, i) => {
          const key = nlSrcKey(s);
          const active = i === Math.min(activeIdx, sources.length - 1);
          return (
            // Clic droit : aperçu/retrait de la source sans passer par la croix.
            <ContextMenu key={s.uid ?? key} onOpenChange={noteCtx}>
              <ContextMenuTrigger
                render={<div
                  onClick={() => guarded(() => setActive(i))}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setActive(i); }}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "group flex cursor-pointer items-center gap-2 rounded-md border px-1.5 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card/40 text-muted-foreground hover:bg-card",
                  )}
                />}
              >
                <LazyThumb path={s.path} at={s.in ?? 0} className="aspect-video w-12 shrink-0 rounded" />
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 truncate">{s.name}</span>} />
                  <TooltipContent>{s.name}</TooltipContent>
                </Tooltip>
                {active && (
                  <Tooltip>
                    <TooltipTrigger render={<Eye className="h-3.5 w-3.5 shrink-0 text-primary" />} />
                    <TooltipContent>{t("tray.previewCenter")}</TooltipContent>
                  </Tooltip>
                )}
                <button type="button"
                  onClick={(e) => { e.stopPropagation(); remove(key); }}
                  className="shrink-0 rounded p-0.5 opacity-50 hover:bg-destructive/20 hover:text-destructive hover:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t("tray.removeNamed", { name: s.name })}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => setActive(i)} disabled={active}><Eye /> {t("tray.previewCenterMenu")}</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onClick={() => remove(key)}><X /> {t("tray.remove")}</ContextMenuItem>
                <ContextMenuItem variant="destructive" onClick={clear}><Eraser /> {t("tray.clearAll")}</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
    </div>
  );
}
