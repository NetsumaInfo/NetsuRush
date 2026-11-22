import { NetsuIcon } from "@/components/ui/netsu-icon";
import { useTranslation } from "react-i18next";
import { type CollectionShot, type CollectionShotPatch } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { LABELS, labelColor } from "./collectionShared";
import { StarRating } from "./StarRating";
import { TagInput } from "./TagInput";

// Selected shot editor, docked under the grid (never under the player, which keeps its full height).
// One quiet card: the name and the note are borderless fields that only show a frame on hover or
// focus, the colour label is a single dot opening its palette, and the tags sit on the second line.
const FIELD = "h-7 min-w-0 rounded-md border border-transparent bg-transparent px-1.5 text-xs outline-none transition-colors "
  + "placeholder:text-muted-foreground/70 hover:border-border focus:border-ring focus:bg-background";

export function ShotInspector({ shot, suggestions, onPatch, onClose }: {
  shot: CollectionShot;
  suggestions: string[];                         // tags already present in the collection
  onPatch: (patch: CollectionShotPatch) => void; // applies + persists (the parent reloads)
  onClose: () => void;
}) {
  const { t: tr } = useTranslation("collections");
  const tags = shot.tags ?? [];
  const color = labelColor(shot.label);
  const current = LABELS.find((l) => l.id === shot.label);

  return (
    <div className="mx-1 mb-2 shrink-0 rounded-xl border border-border bg-card/80 px-2 py-1.5 shadow-sm">
      <div className="flex items-center gap-1">
        <Popover>
          <Tooltip>
            <TooltipTrigger render={
              <PopoverTrigger render={
                <Button variant="ghost" size="icon-xs" aria-label={current ? tr(current.nameKey) : tr("inspector.label")} className="size-7 shrink-0 rounded-full" />
              } />
            }>
              <span className={cn("size-3 rounded-full border", color ? "border-transparent" : "border-dashed border-muted-foreground/60")}
                style={color ? { background: color } : undefined} />
            </TooltipTrigger>
            <TooltipContent>{current ? tr(current.nameKey) : tr("inspector.label")}</TooltipContent>
          </Tooltip>
          <PopoverContent side="top" align="start" className="w-auto p-1.5">
            <div className="grid grid-cols-5 gap-1">
              {LABELS.map((l) => (
                <Tooltip key={l.id}>
                  <TooltipTrigger render={
                    <Button variant="ghost" size="icon-xs" aria-label={tr(l.nameKey)} aria-pressed={shot.label === l.id}
                      onClick={() => onPatch({ label: shot.label === l.id ? null : l.id })} className="size-7 rounded-full p-0" />
                  }>
                    <span className={cn("size-3.5 rounded-full", shot.label === l.id && "ring-2 ring-foreground ring-offset-1 ring-offset-popover")}
                      style={{ background: l.color }} />
                  </TooltipTrigger>
                  <TooltipContent>{tr(l.nameKey)}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <input value={shot.name} onChange={(e) => onPatch({ name: e.target.value })} placeholder={tr("inspector.namePlaceholder")}
          aria-label={tr("inspector.renameShot")} autoComplete="off" spellCheck={false}
          className={cn(FIELD, "w-0 flex-1 font-medium")} />

        <StarRating value={shot.rating ?? 0} onChange={(n) => onPatch({ rating: n || null })} iconClassName="size-3.5" className="shrink-0" />

        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" onClick={onClose} aria-label={tr("inspector.close")} className="shrink-0 text-muted-foreground hover:text-foreground" />}>
            <NetsuIcon name="close" className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>{tr("inspector.close")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-1">
        <NetsuIcon name="tag" className="size-3 shrink-0 text-muted-foreground" />
        <TagInput value={tags} onChange={(next) => onPatch({ tags: next })} suggestions={suggestions} />
        <input value={shot.note ?? ""} onChange={(e) => onPatch({ note: e.target.value || null })}
          placeholder={tr("inspector.notePlaceholder")} aria-label={tr("inspector.notePlaceholder")} autoComplete="off"
          className={cn(FIELD, "min-w-[160px] flex-1 text-muted-foreground focus:text-foreground")} />
      </div>
    </div>
  );
}
