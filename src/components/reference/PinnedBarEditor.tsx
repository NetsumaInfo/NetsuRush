// Éditeur d'une barre d'outils : une réserve d'icônes, et une maquette de la barre où on les dépose.
// Ce qu'on voit est ce qu'on aura — même sens, mêmes deux extrémités, même ordre.
//
// Glisser-déposer HTML5 nu (aucune dépendance pour deux zones). Le clic reste une voie complète :
// un réglage inatteignable au clavier ou au stylet est un réglage perdu.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { PINNED_BUTTONS, isVerticalSide, type PinnedButtonId, type PinnedSide } from "./toolbarButtons";

type Zone = "start" | "end";

const meta = (id: PinnedButtonId) => PINNED_BUTTONS.find((b) => b.id === id);

export function PinnedBarEditor({
  side,
  start,
  end,
  onChange,
}: {
  side: PinnedSide;
  start: PinnedButtonId[];
  end: PinnedButtonId[];
  onChange: (next: { start: PinnedButtonId[]; end: PinnedButtonId[] }) => void;
}) {
  const { t } = useTranslation("reference");
  const [dragging, setDragging] = useState<PinnedButtonId | null>(null);
  const [over, setOver] = useState<Zone | null>(null);
  const vertical = isVerticalSide(side);
  const placed = new Set([...start, ...end]);
  const bank = PINNED_BUTTONS.filter((b) => !placed.has(b.id));

  // Pose `id` dans `zone` à `index` (fin si omis) en le retirant d'ailleurs. Source unique des
  // mouvements : dépôt et clic passent par ici.
  const move = (id: PinnedButtonId, zone: Zone, index?: number) => {
    const next = {
      start: start.filter((x) => x !== id),
      end: end.filter((x) => x !== id),
    };
    const list = next[zone];
    list.splice(index ?? list.length, 0, id);
    onChange(next);
  };

  const remove = (id: PinnedButtonId) =>
    onChange({ start: start.filter((x) => x !== id), end: end.filter((x) => x !== id) });

  const drop = (zone: Zone, index?: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const id = (dragging ?? e.dataTransfer.getData("text/plain")) as PinnedButtonId;
    setDragging(null);
    setOver(null);
    if (meta(id)) move(id, zone, index);
  };

  const Chip = ({ id, index, zone }: { id: PinnedButtonId; index: number; zone: Zone }) => {
    const m = meta(id);
    if (!m) return null;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              draggable
              onDragStart={(e) => { setDragging(id); e.dataTransfer.setData("text/plain", id); e.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => { setDragging(null); setOver(null); }}
              // Dépôt SUR une icône : la nouvelle prend sa place.
              onDragOver={(e) => e.preventDefault()}
              onDrop={drop(zone, index)}
              onClick={() => remove(id)}
              aria-label={t("settings.pinnedRemove", { label: t(m.labelKey) })}
              className={cn(
                "inline-flex size-7 shrink-0 cursor-grab items-center justify-center rounded border border-transparent bg-primary text-primary-foreground active:cursor-grabbing",
                dragging === id && "opacity-40",
              )}
            />
          }
        >
          <m.icon className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>{t(m.labelKey)}</TooltipContent>
      </Tooltip>
    );
  };

  const Dropzone = ({ zone, ids }: { zone: Zone; ids: PinnedButtonId[] }) => (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(zone); }}
      onDragLeave={() => setOver((z) => (z === zone ? null : z))}
      onDrop={drop(zone)}
      className={cn(
        // `basis-0` : les deux moitiés font la même largeur quel que soit leur contenu, donc la
        // coupure reste au milieu — sinon la zone la plus remplie pousse l'autre.
        "flex min-h-8 min-w-8 flex-1 basis-0 items-center gap-1 rounded-md border border-dashed p-1 transition-colors",
        vertical ? "flex-col justify-start" : "justify-start",
        over === zone ? "border-primary bg-primary/10" : "border-border/60",
      )}
    >
      {/* La zone de fin colle son contenu au bout, comme dans la vraie barre. */}
      <span className={cn(zone === "end" && (vertical ? "mt-auto" : "ml-auto"), "flex gap-1", vertical && "flex-col")}>
        {ids.map((id, i) => <Chip key={id} id={id} index={i} zone={zone} />)}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      {/* Maquette : deux extrémités, dans le sens du bord. */}
      <div
        className={cn(
          "flex items-stretch gap-2 rounded-xl border border-border bg-card/80 p-1.5",
          vertical ? "h-40 w-max flex-col" : "w-full",
        )}
      >
        <Dropzone zone="start" ids={start} />
        {/* Milieu de la barre : un trait, pas un mot — il marque la coupure sans se lire. */}
        <span
          aria-hidden
          className={cn("shrink-0 self-stretch border-border/60", vertical ? "border-t" : "border-l")}
        />
        <Dropzone zone="end" ids={end} />
      </div>

      {/* Réserve : ce qui n'est pas posé. Clic = ajouter, glisser = choisir la place. */}
      <span className="text-xs text-muted-foreground">{t("settings.pinnedAvailable")}</span>
      <div
        className="flex flex-wrap gap-1.5"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const id = (dragging ?? e.dataTransfer.getData("text/plain")) as PinnedButtonId; setDragging(null); if (meta(id)) remove(id); }}
      >
        {bank.length === 0 && <span className="text-[11px] text-muted-foreground">{t("settings.pinnedAllPlaced")}</span>}
        {bank.map((b) => (
          <button
            key={b.id}
            type="button"
            draggable
            onDragStart={(e) => { setDragging(b.id); e.dataTransfer.setData("text/plain", b.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragEnd={() => { setDragging(null); setOver(null); }}
            onClick={() => move(b.id, "start")}
            className={cn(
              "inline-flex cursor-grab items-center gap-1.5 rounded border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing",
              dragging === b.id && "opacity-40",
            )}
          >
            <b.icon className="size-3.5" /> {t(b.labelKey)}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        <X className="mr-1 inline size-3" />
        {t("settings.pinnedBarHint")}
      </p>
    </div>
  );
}
