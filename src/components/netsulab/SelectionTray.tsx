import { useEffect, useRef, useState } from "react";
import { X, Layers, Eraser, Eye, Pencil, RotateCcw, AlertTriangle, Image as ImageIcon } from "lucide-react";
import { useApp } from "@/store";
import { nlSrcKey } from "@/store/netsulab";
import { nr } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { LazyThumb } from "@/components/rushes/LazyThumb";
import { isStillSource } from "@/components/upscale/imageOutput";
import { useSharedProcSources } from "@/components/upscale/useProcSources";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

// Garde-fou : le clic qui FERME un menu contextuel (Base UI) ne doit pas déclencher l'aperçu d'une
// autre ligne (setActive → lecteur). On ignore les clics survenus juste après une fermeture de menu.
let lastCtxCloseAt = 0;
const noteCtx = (open: boolean) => { if (!open) lastCtxCloseAt = performance.now(); };
const guarded = (fn: () => void) => { if (performance.now() - lastCtxCloseAt < 250) return; fn(); };

// Bac de sélection : chaque source cochée (fichier ou plan, quel que soit le dossier) atterrit ici.
// Vignette + nom → on reconnaît ce qui est sélectionné ; l'entrée aperçue au centre est marquée (œil).
// Clic sur une ligne → aperçue au centre ; croix → retirée ; double-clic sur le nom → renommage de la
// SORTIE de ce média (le seul endroit où l'on renomme un média, le motif partagé fait le reste).
export function SelectionTray() {
  const { t } = useTranslation("upscale");
  const sources = useApp((s) => s.nlSources);
  const activeIdx = useApp((s) => s.nlActiveIdx);
  const setActive = useApp((s) => s.nlSetActiveIdx);
  const remove = useApp((s) => s.nlRemoveSource);
  const clear = useApp((s) => s.nlClearSources);
  const { nameReport, setSourceName } = useSharedProcSources();
  const [editing, setEditing] = useState<string | null>(null);

  if (sources.length === 0) return null;

  // Indices dont le nom de sortie entre en collision avec celui d'une autre source.
  const clashing = new Set(nameReport.collisions.flatMap((c) => c.indexes));

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
          const still = isStillSource(s);
          const outName = nameReport.names[i] ?? "";
          const clash = clashing.has(i);
          return (
            // Clic droit : aperçu/renommage/retrait de la source sans passer par la croix.
            <ContextMenu key={s.uid ?? key} onOpenChange={noteCtx}>
              <ContextMenuTrigger
                render={<div
                  onClick={() => guarded(() => setActive(i))}
                  onDoubleClick={() => setEditing(key)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setActive(i); }}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "group flex cursor-pointer items-center gap-2 rounded-md border px-1.5 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card/40 text-muted-foreground hover:bg-card",
                    clash && "border-destructive/60",
                  )}
                />}
              >
                {/* Une image fixe n'a pas de vignette à extraire : elle EST sa vignette. */}
                {still ? (
                  <img src={nr.mediaUrl(s.path)} alt="" loading="lazy"
                    className="aspect-video w-12 shrink-0 rounded object-cover" />
                ) : (
                  <LazyThumb path={s.path} at={s.in ?? 0} className="aspect-video w-12 shrink-0 rounded" />
                )}
                <div className="min-w-0 flex-1">
                  {editing === key ? (
                    <RenameField
                      value={s.outName ?? outName}
                      onCancel={() => setEditing(null)}
                      onSubmit={(next) => { setSourceName(s, next); setEditing(null); }}
                      label={t("tray.renameLabel", { name: s.name })}
                    />
                  ) : (
                    <>
                      <div className="flex items-center gap-1">
                        {still && (
                          <Tooltip>
                            <TooltipTrigger render={<ImageIcon className="h-3 w-3 shrink-0 text-primary" />} />
                            <TooltipContent>{t("tray.stillSource")}</TooltipContent>
                          </Tooltip>
                        )}
                        <Tooltip>
                          <TooltipTrigger render={<span className="min-w-0 flex-1 truncate">{s.name}</span>} />
                          <TooltipContent>{s.name}</TooltipContent>
                        </Tooltip>
                      </div>
                      {/* Nom de SORTIE résolu : ce que le run va écrire, et en rouge quand une autre
                          source retombe sur le même nom. */}
                      <Tooltip>
                        <TooltipTrigger render={<span className={cn(
                          "flex min-w-0 items-center gap-1 truncate font-mono text-[10px]",
                          clash ? "text-destructive" : "text-muted-foreground/80",
                        )} />}>
                          {clash && <AlertTriangle className="h-2.5 w-2.5 shrink-0" />}
                          {s.outName && <Pencil className="h-2.5 w-2.5 shrink-0" />}
                          {outName}
                        </TooltipTrigger>
                        <TooltipContent>{clash ? t("tray.nameClash") : t("tray.outputName", { name: outName })}</TooltipContent>
                      </Tooltip>
                    </>
                  )}
                </div>
                {active && editing !== key && (
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
                <ContextMenuItem onClick={() => setEditing(key)}><Pencil /> {t("tray.rename")}</ContextMenuItem>
                {s.outName && (
                  <ContextMenuItem onClick={() => setSourceName(s, null)}><RotateCcw /> {t("tray.renameReset")}</ContextMenuItem>
                )}
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

// Champ de renommage en place : Entrée valide, Échap annule, vide = revenir au motif partagé.
function RenameField({ value, onSubmit, onCancel, label }: {
  value: string;
  onSubmit: (next: string | null) => void;
  onCancel: () => void;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => { ref.current?.select(); }, []);
  return (
    <Input
      ref={ref}
      value={draft}
      autoFocus
      spellCheck={false}
      aria-label={label}
      className="h-6 px-1.5 text-[11px]"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onSubmit(draft.trim() || null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onSubmit(draft.trim() || null);
        else if (e.key === "Escape") onCancel();
      }}
    />
  );
}
