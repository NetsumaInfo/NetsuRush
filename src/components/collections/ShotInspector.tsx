import { NetsuIcon } from "@/components/ui/netsu-icon";
import { useTranslation } from "react-i18next";
import { type CollectionShot, type CollectionShotPatch } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LABELS } from "./collectionShared";
import { StarRating } from "./StarRating";
import { TagInput } from "./TagInput";

// Inspecteur d'un plan sélectionné (barre du bas) : note étoiles + label couleur + tags + annotation.
// Édition ciblée → cartes de la grille non surchargées (respecte /impeccable). Commit via updateShot.
export function ShotInspector({ shot, suggestions, onPatch, onClose }: {
  shot: CollectionShot;
  suggestions: string[];                         // tags déjà présents dans la collection
  onPatch: (patch: CollectionShotPatch) => void; // applique + persiste (le parent recharge)
  onClose: () => void;
}) {
  const { t: tr } = useTranslation("collections");
  const tags = shot.tags ?? [];

  return (
    <div className="shrink-0 border-t border-border bg-card/60 px-4 py-2">
      {/* Row 1: name, rating, label, close — one line of h-7 controls, aligned with the bar borders. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <Input value={shot.name} onChange={(e) => onPatch({ name: e.target.value })} placeholder={tr("inspector.namePlaceholder")} className="h-7 min-w-0 max-w-[240px] flex-1 text-xs font-medium" aria-label={tr("inspector.renameShot")} />

        {/* Note */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{tr("inspector.rating")}</span>
          <StarRating value={shot.rating ?? 0} onChange={(n) => onPatch({ rating: n || null })} iconClassName="size-4" />
        </div>

        {/* Label couleur */}
        <div className="flex items-center gap-1">
          <span className="mr-0.5 text-[11px] text-muted-foreground">{tr("inspector.label")}</span>
          {LABELS.map((l) => (
            <Tooltip key={l.id}>
              <TooltipTrigger render={
                <Button variant="ghost" size="icon-xs" aria-label={tr(l.nameKey)} aria-pressed={shot.label === l.id}
                  onClick={() => onPatch({ label: shot.label === l.id ? null : l.id })}
                  className="size-5 rounded-full p-0">
                  <span className={cn("size-3 rounded-full border transition-transform group-hover/button:scale-125",
                    shot.label === l.id ? "border-foreground ring-1 ring-foreground" : "border-transparent")}
                    style={{ background: l.color }} />
                </Button>
              } />
              <TooltipContent>{tr(l.nameKey)}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" onClick={onClose} aria-label={tr("inspector.close")} className="text-muted-foreground hover:text-foreground" />}>
            <NetsuIcon name="close" className="size-4" />
          </TooltipTrigger>
          <TooltipContent>{tr("inspector.close")}</TooltipContent>
        </Tooltip>
      </div>

      {/* Row 2: tags + annotation */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <div className="flex min-w-[200px] flex-1 items-center gap-1.5">
          <NetsuIcon name="tag" className="size-3.5 shrink-0 text-muted-foreground" />
          <TagInput value={tags} onChange={(next) => onPatch({ tags: next })} suggestions={suggestions} />
        </div>
        <Input value={shot.note ?? ""} onChange={(e) => onPatch({ note: e.target.value || null })}
          placeholder={tr("inspector.notePlaceholder")} className="h-7 min-w-[200px] flex-1 text-xs" />
      </div>
    </div>
  );
}
