import { useMemo, useState } from "react";
import { X, Plus, Minus, ArrowRight } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { colorOf } from "./rotoShared";
import type { RotoSession } from "./useRotoSession";
import { useTranslation } from "react-i18next";

// Table des points : chaque point posé est listé (image, objet, type, position) —
// clic = aller à l'image ; croix = retirer CE point précis (le backend rejoue le reste).
// Bascule « image courante / toutes » pour ne pas noyer les longues sessions.
export function PointsTable({ s, goto, running }: {
  s: RotoSession; goto: (f: number) => void; running: boolean;
}) {
  const { t } = useTranslation("roto");
  const [all, setAll] = useState(false);

  const rows = useMemo(() => {
    const frames = all
      ? Object.keys(s.pointsByFrame).map(Number).sort((a, b) => a - b)
      : (s.pointsByFrame[s.frame]?.length ? [s.frame] : []);
    const out: { f: number; obj: number; label: 0 | 1; x: number; y: number; index: number }[] = [];
    for (const f of frames) {
      const perObj: Record<number, number> = {};
      for (const p of s.pointsByFrame[f] || []) {
        const index = perObj[p.obj] ?? 0;
        perObj[p.obj] = index + 1;
        out.push({ f, obj: p.obj, label: p.label, x: p.x, y: p.y, index });
      }
    }
    return out;
  }, [s.pointsByFrame, s.frame, all]);

  if (!s.pointCount) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Tooltip>
          <TooltipTrigger render={<Toggle size="sm" pressed={all} onPressedChange={setAll} className="h-6 px-2 text-[11px]">
            {t("points.allFrames")}
          </Toggle>} />
          <TooltipContent>{t("points.allFramesTip")}</TooltipContent>
        </Tooltip>
      </div>
      <div className="max-h-40 space-y-0.5 overflow-y-auto pr-1">
              {rows.map((r) => {
            const name = s.objects.find((o) => o.id === r.obj)?.name || t("object.name", { n: r.obj });
            const sel = s.selectedPoint?.f === r.f && s.selectedPoint.obj === r.obj && s.selectedPoint.index === r.index;
            const pick = () => { s.selectPoint({ f: r.f, obj: r.obj, index: r.index }); goto(r.f); };
            return (
              // Clic = sélectionner (lueur sur le viewer) + aller à l'image. Clic droit : aller/retirer.
              <ContextMenu key={`${r.f}-${r.obj}-${r.index}`}>
                <ContextMenuTrigger
                  render={<div
                    onClick={pick}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } }}
                    className={cn(
                      "group flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      sel ? "bg-primary/20 text-foreground ring-1 ring-primary/50"
                        : r.f === s.frame ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent/60",
                    )}
                  />}
                >
                  <span className="w-10 shrink-0 tabular-nums">{t("img")} {r.f}</span>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorOf(r.obj) }} />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  {r.label
                    ? <Plus className="h-3 w-3 shrink-0 text-[var(--color-ok)]" />
                    : <Minus className="h-3 w-3 shrink-0 text-destructive" />}
                  <span className="shrink-0 tabular-nums opacity-60">{Math.round(r.x * 100)},{Math.round(r.y * 100)}</span>
                  <button type="button"
                    onClick={(e) => { e.stopPropagation(); void s.removePoint(r.f, r.obj, r.index); }}
                    disabled={running}
                    className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/20 hover:text-destructive group-hover:opacity-70 disabled:opacity-0"
                    aria-label={t("points.removeAria")}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => goto(r.f)}><ArrowRight /> {t("points.goToFrame")}</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onClick={() => void s.removePoint(r.f, r.obj, r.index)} disabled={running}><X /> {t("points.removePoint")}</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
      </div>
    </div>
  );
}
