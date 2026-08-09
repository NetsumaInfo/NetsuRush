import { Plus, X, MousePointerClick, CirclePlus, CircleMinus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { colorOf } from "./rotoShared";
import type { RotoSession } from "./useRotoSession";
import { useTranslation } from "react-i18next";

// Objets de la session : pastille couleur + nom éditable + actif au clic.
// Les points posés vont sur l'objet ACTIF ; retirer un objet efface ses points.
export function ObjectsPanel({ s }: { s: RotoSession }) {
  const { t } = useTranslation("roto");
  const { objects, activeObj, setActiveObj, addObject, removeObject, renameObject } = s;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={addObject} disabled={!!s.busy} aria-label={t("objects.add")}>
            <Plus className="h-3.5 w-3.5" />
          </Button>} />
          <TooltipContent>{t("objects.addTip")}</TooltipContent>
        </Tooltip>
      </div>

      {/* Polarité du clic gauche. Inclure = ajoute l'objet ; Exclure = retire une zone (aide SAM à
          affiner quand il déborde). Le clic droit reste toujours « exclure ». */}
      <ToggleGroup className="w-full" value={[s.pointLabel === 0 ? "exclude" : "include"]}
        onValueChange={(v) => v[0] && s.setPointLabel(v[0] === "exclude" ? 0 : 1)}>
        <Tooltip>
          <TooltipTrigger render={<ToggleGroupItem value="include" className="flex-1 gap-1 text-[11px]">
            <CirclePlus className="h-3 w-3 text-[var(--color-ok)]" /> {t("objects.include")}
          </ToggleGroupItem>} />
          <TooltipContent>{t("objects.includeTip")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<ToggleGroupItem value="exclude" className="flex-1 gap-1 text-[11px]">
            <CircleMinus className="h-3 w-3 text-destructive" /> {t("objects.exclude")}
          </ToggleGroupItem>} />
          <TooltipContent>{t("objects.excludeTip")}</TooltipContent>
        </Tooltip>
      </ToggleGroup>
      {objects.map((o) => (
        // Clic droit : activer/ajouter/supprimer l'objet (le renommage reste le champ inline).
        <ContextMenu key={o.id}>
          <ContextMenuTrigger
            render={<div
              onClick={() => setActiveObj(o.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setActiveObj(o.id); }}
              role="button"
              tabIndex={0}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                o.id === activeObj ? "border-primary bg-primary/10" : "border-border hover:bg-accent/60",
              )}
            />}
          >
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: colorOf(o.id) }} />
            <Input
              value={o.name}
              onChange={(e) => renameObject(o.id, e.target.value)}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 h-6 border-0 bg-transparent px-0 py-0"
              aria-label={t("objects.nameAria")}
            />
            {objects.length > 1 && (
              <button type="button"
                onClick={(e) => { e.stopPropagation(); removeObject(o.id); }}
                className="shrink-0 rounded p-0.5 opacity-50 hover:bg-destructive/20 hover:text-destructive hover:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("objects.removeAria", { name: o.name })}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => setActiveObj(o.id)} disabled={o.id === activeObj}><MousePointerClick /> {t("objects.setActive")}</ContextMenuItem>
            <ContextMenuItem onClick={addObject} disabled={!!s.busy}><Plus /> {t("objects.add")}</ContextMenuItem>
            {objects.length > 1 && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onClick={() => removeObject(o.id)}><X /> {t("objects.remove")}</ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </div>
  );
}
