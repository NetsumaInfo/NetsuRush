import { useState } from "react";
import { X, Tag } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type CollectionShot, type CollectionShotPatch } from "@/lib/bridge";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LABELS } from "./collectionShared";
import { StarRating } from "./StarRating";

// Inspecteur d'un plan sélectionné (barre du bas) : note étoiles + label couleur + tags + annotation.
// Édition ciblée → cartes de la grille non surchargées (respecte /impeccable). Commit via updateShot.
export function ShotInspector({ shot, suggestions, onPatch, onClose }: {
  shot: CollectionShot;
  suggestions: string[];                         // tags déjà présents dans la collection
  onPatch: (patch: CollectionShotPatch) => void; // applique + persiste (le parent recharge)
  onClose: () => void;
}) {
  const { t: tr } = useTranslation("collections");
  const [tagInput, setTagInput] = useState("");
  const tags = shot.tags ?? [];

  const addTag = (raw: string) => {
    const t = raw.trim();
    if (!t || tags.includes(t)) { setTagInput(""); return; }
    onPatch({ tags: [...tags, t] });
    setTagInput("");
  };
  const removeTag = (t: string) => onPatch({ tags: tags.filter((x) => x !== t) });

  const filteredSug = suggestions.filter((t) => !tags.includes(t) && t.toLowerCase().includes(tagInput.trim().toLowerCase())).slice(0, 6);

  return (
    <div className="shrink-0 border-t border-border bg-card/60 px-4 py-2">
      {/* Une seule ligne de contrôles, tous en h-7 : la légende « plan sélectionné » sous le nom
          rendait cette colonne haute de deux lignes, si bien que rien n'était aligné avec les
          bordures de la barre. La barre elle-même dit déjà qu'un plan est sélectionné. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <Input value={shot.name} onChange={(e) => onPatch({ name: e.target.value })} placeholder={tr("inspector.namePlaceholder")} className="h-7 min-w-0 max-w-[240px] flex-1 text-xs font-medium" aria-label={tr("inspector.renameShot")} />

        {/* Note */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{tr("inspector.rating")}</span>
          <StarRating value={shot.rating ?? 0} onChange={(n) => onPatch({ rating: n || null })} size={16} />
        </div>

        {/* Label couleur */}
        <div className="flex items-center gap-1">
          <span className="mr-0.5 text-[11px] text-muted-foreground">{tr("inspector.label")}</span>
          {LABELS.map((l) => (
            <Tooltip key={l.id}>
              <TooltipTrigger render={
                <button type="button" aria-label={tr(l.nameKey)}
                  onClick={() => onPatch({ label: shot.label === l.id ? null : l.id })}
                  className={cn("size-4 rounded-full border transition-transform hover:scale-110 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    shot.label === l.id ? "border-foreground ring-1 ring-foreground" : "border-transparent")}
                  style={{ background: l.color }} />
              } />
              <TooltipContent>{tr(l.nameKey)}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        {/* Tags */}
        <div className="flex min-w-[200px] flex-1 items-center gap-1.5">
          <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="flex flex-wrap items-center gap-1">
            {tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[11px]">
                {t}
                <button type="button" aria-label={tr("tags.remove", { tag: t })} onClick={() => removeTag(t)} className="text-muted-foreground hover:text-destructive"><X className="h-2.5 w-2.5" /></button>
              </span>
            ))}
            <div className="relative">
              <Input value={tagInput} onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") { e.preventDefault(); addTag(tagInput); } }}
                placeholder={tr("tags.addTag")} className="h-6 w-24 px-1.5 text-[11px]" />
              {tagInput && filteredSug.length > 0 && (
                <div className="absolute bottom-7 left-0 z-10 w-40 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md">
                  {filteredSug.map((t) => (
                    <button key={t} type="button" onClick={() => addTag(t)} className="block w-full px-2 py-1 text-left text-[11px] hover:bg-accent">{t}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <button type="button" onClick={onClose} aria-label={tr("inspector.close")} className="grid size-7 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><X className="size-4" /></button>
      </div>

      {/* Annotation (ligne dédiée, discrète) */}
      <Input value={shot.note ?? ""} onChange={(e) => onPatch({ note: e.target.value || null })}
        placeholder={tr("inspector.notePlaceholder")} className="mt-1.5 h-7 text-xs" />
    </div>
  );
}
