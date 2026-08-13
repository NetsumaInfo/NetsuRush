// Lecteur de séquence d'images : quand un item `sequence` est seul sélectionné, une
// barre de contrôle flotte SOUS l'item (vitesse, frame précédente, play/pause, frame suivante, toggle
// pellicule) et une pellicule de vignettes numérotées s'affiche en bas du board (frame active cernée,
// clic = saut). Avance auto pilotée par le contenu (BoardItem) ; ici on ne pilote que seqPlay/frame.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SkipBack, SkipForward, Play, Pause, GalleryHorizontal, ImageOff,
  FlipHorizontal, FlipVertical, BringToFront, SendToBack, Trash2, Copy,
  Repeat, Repeat2, ArrowRightToLine, Undo2,
} from "lucide-react";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@/lib/utils";
import { nr } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useBoard } from "./useReferenceBoard";
import { displaySrc, youtubeId } from "./referenceShared";
import { revertSequence } from "./boardMediaActions";
import { IconAction, IconToggle } from "./inspectorControls";
import { iconForLink } from "./brandIcons";

// Vitesses de lecture (cycle via le bouton ×N) — du ralenti au double.
const SPEEDS = [0.25, 0.5, 1, 1.25, 1.5, 2];

// Type de boucle (bouton-cycle, partage le champ `playMode` avec la vidéo).
type SeqLoop = "loop" | "pingpong" | "off";
const LOOP_META: Record<SeqLoop, { icon: typeof Repeat; labelKey: string }> = {
  loop: { icon: Repeat, labelKey: "sequence.loop" },
  pingpong: { icon: Repeat2, labelKey: "sequence.pingpong" },
  off: { icon: ArrowRightToLine, labelKey: "sequence.once" },
};
const LOOP_NEXT: Record<SeqLoop, SeqLoop> = { loop: "pingpong", pingpong: "off", off: "loop" };

function CtrlBtn({ icon: Icon, label, onClick, active }: {
  icon: typeof Play; label: string; onClick: () => void; active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant={active ? "default" : "ghost"} size="icon-sm" onClick={onClick} aria-label={label} aria-pressed={active} />}
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function SequencePlayer() {
  const { t } = useTranslation("reference");
  const selectedId = useBoard((s) => s.selectedId);
  const count = useBoard((s) => s.selectedIds.length);
  const editingId = useBoard((s) => s.editingId);
  const item = useBoard((s) => s.items.find((i) => i.id === s.selectedId) ?? null);
  const view = useBoard((s) => s.view);
  const patchItem = useBoard((s) => s.patchItem);
  const commitSeqFrame = useBoard((s) => s.commitSeqFrame);
  const removeItem = useBoard((s) => s.removeItem);
  const duplicateItem = useBoard((s) => s.duplicateItem);
  const bringToFront = useBoard((s) => s.bringToFront);
  const sendToBack = useBoard((s) => s.sendToBack);
  const [showStrip, setShowStrip] = useState(true);
  const stripRef = useRef<HTMLDivElement>(null);

  const frames = item?.frames ?? [];
  const total = frames.length;
  // Frame VIVANTE d'abord : pendant la lecture elle vit hors du document (cf. `seqFrames`) pour ne
  // pas recréer `items` à chaque image. Le sélecteur ne rend qu'un nombre — la pellicule suit sans
  // que le board entier soit réveillé.
  const liveFrame = useBoard((s) => (item ? s.seqFrames[item.id] : undefined));
  const cur = item ? Math.min(Math.max(liveFrame ?? item.frame ?? 0, 0), Math.max(0, total - 1)) : 0;

  // Centre la vignette active dans la pellicule au fil de la lecture.
  useEffect(() => {
    if (!showStrip) return;
    stripRef.current?.querySelector<HTMLElement>(`[data-frame="${cur}"]`)
      ?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [cur, showStrip]);

  if (!selectedId || count !== 1 || !item || item.kind !== "sequence") return null;
  if (editingId === item.id) return null;

  const speed = item.speed ?? 1;
  const playing = item.seqPlay ?? true; // défaut = lecture
  // Saut manuel : écrit la position DANS le document et oublie la frame vivante, qui la masquerait.
  const goto = (n: number) => {
    commitSeqFrame(item.id, (n + total) % total);
    patchItem(item.id, { seqPlay: false }, false);
  };
  const cycleSpeed = () => patchItem(item.id, { speed: SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1 }, false);
  // Type de boucle (playMode) + portée de boucle [seqIn, seqOut] (index de frames ; défaut = toutes).
  const loopMode = (item.playMode ?? "loop") as SeqLoop;
  const loopMeta = LOOP_META[loopMode];
  const cycleLoop = () => patchItem(item.id, { playMode: LOOP_NEXT[loopMode] });
  const loopIn = Math.min(Math.max(item.seqIn ?? 0, 0), Math.max(0, total - 1));
  const loopOut = Math.min(Math.max(item.seqOut ?? total - 1, loopIn), Math.max(0, total - 1));
  // Stocke `undefined` aux extrêmes (= plage pleine) → persistance propre.
  const setRange = (a: number, b: number) =>
    patchItem(item.id, { seqIn: a <= 0 ? undefined : a, seqOut: b >= total - 1 ? undefined : b });
  // Lien d'origine (la séquence garde le sourceUrl de la vidéo dont elle est issue) → ouvrir le site.
  const linkUrl = item.sourceUrl || null;
  const LinkIcon = linkUrl ? iconForLink(linkUrl) : null;
  // Média d'origine mémorisé → bouton « revenir » (lecteur YouTube si la source était YouTube).
  const revertLabel = item.prevMedia
    ? (item.prevMedia.sourceUrl && youtubeId(item.prevMedia.sourceUrl) ? t("sequence.backToYouTube") : t("sequence.backToVideo"))
    : "";

  // Position de la barre : sous l'item, en coordonnées écran (suit pan/zoom/déplacement).
  const left = view.tx + (item.x + item.w / 2) * view.scale;
  const top = view.ty + (item.y + item.h) * view.scale + 12;

  return (
    <>
      <div className="absolute z-30 -translate-x-1/2" style={{ left, top }}>
        <div className="flex items-center gap-1 rounded-xl border border-border bg-card/95 px-2 py-1.5 shadow-xl backdrop-blur">
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="sm" className="w-12 tabular-nums" onClick={cycleSpeed} aria-label={t("sequence.playbackSpeed")} />}
            >
              ×{speed}
            </TooltipTrigger>
            <TooltipContent>{t("sequence.playbackSpeed")}</TooltipContent>
          </Tooltip>
          <CtrlBtn icon={SkipBack} label={t("sequence.prevFrame")} onClick={() => goto(cur - 1)} />
          <CtrlBtn
            icon={playing ? Pause : Play}
            label={playing ? t("sequence.pause") : t("sequence.play")}
            active={playing}
            onClick={() => patchItem(item.id, { seqPlay: !playing }, false)}
          />
          <CtrlBtn icon={SkipForward} label={t("sequence.nextFrame")} onClick={() => goto(cur + 1)} />
          <CtrlBtn icon={loopMeta.icon} label={t(loopMeta.labelKey)} active={loopMode !== "off"} onClick={cycleLoop} />
          <CtrlBtn
            icon={GalleryHorizontal}
            label={showStrip ? t("sequence.hideStrip") : t("sequence.showStrip")}
            active={showStrip}
            onClick={() => setShowStrip((v) => !v)}
          />

          {/* Actions génériques de l'item (la séquence n'a pas d'Inspector dédié) */}
          <Separator orientation="vertical" className="mx-0.5 h-6" />
          <IconToggle on={item.flipH} label={t("actions.flipH")} onClick={() => patchItem(item.id, { flipH: !item.flipH })}>
            <FlipHorizontal />
          </IconToggle>
          <IconToggle on={item.flipV} label={t("actions.flipV")} onClick={() => patchItem(item.id, { flipV: !item.flipV })}>
            <FlipVertical />
          </IconToggle>
          {linkUrl && LinkIcon && (
            <IconAction label={t("actions.openLink")} onClick={() => void nr.openExternal(linkUrl)}>
              <LinkIcon />
            </IconAction>
          )}
          {item.prevMedia && (
            <IconAction label={revertLabel} onClick={() => revertSequence(item.id)}><Undo2 /></IconAction>
          )}
          <IconAction label={t("actions.duplicate")} onClick={() => duplicateItem(item.id)}><Copy /></IconAction>
          <IconAction label={t("actions.bringToFront")} onClick={() => bringToFront(item.id)}><BringToFront /></IconAction>
          <IconAction label={t("actions.sendToBack")} onClick={() => sendToBack(item.id)}><SendToBack /></IconAction>
          <IconAction label={t("common:action.delete")} onClick={() => removeItem(item.id)}>
            <Trash2 className="text-destructive" />
          </IconAction>
        </div>
      </div>

      {showStrip && total > 0 && (
        <div className="absolute bottom-3 left-1/2 z-30 max-w-[94vw] -translate-x-1/2">
          <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-card/95 p-2 shadow-xl backdrop-blur">
            {/* Portée de boucle : double-curseur sur les index de frames (zone bouclée = piste pleine) */}
            {total >= 2 && (
              <div className="flex items-center gap-2 px-1">
                <span className="text-[10px] tabular-nums text-muted-foreground">{loopIn + 1}</span>
                <SliderPrimitive.Root
                  value={[loopIn, loopOut]} min={0} max={total - 1} step={1} thumbAlignment="edge"
                  onValueChange={(v) => { const a = Array.isArray(v) ? v : [0, total - 1]; setRange(a[0], a[1]); }}
                  className="flex-1"
                  aria-label={t("sequence.loopRange")}
                >
                  <SliderPrimitive.Control className="relative flex w-full touch-none items-center py-1.5 select-none">
                    <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-foreground/20 select-none">
                      <SliderPrimitive.Indicator className="h-full bg-primary select-none" />
                    </SliderPrimitive.Track>
                    {[loopIn, loopOut].map((_, i) => (
                      <SliderPrimitive.Thumb key={i} className="block size-3 shrink-0 rounded-full border-2 border-primary bg-white shadow ring-primary/40 transition-[box-shadow] select-none hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden" />
                    ))}
                  </SliderPrimitive.Control>
                </SliderPrimitive.Root>
                <span className="text-[10px] tabular-nums text-muted-foreground">{loopOut + 1}</span>
              </div>
            )}
            <div ref={stripRef} className="flex items-end gap-1.5 overflow-x-auto">
            {frames.map((f, i) => (
              <button
                key={i}
                type="button"
                data-frame={i}
                onClick={() => goto(i)}
                className={cn(
                  "group relative h-16 w-24 shrink-0 overflow-hidden rounded-md ring-1 transition",
                  i === cur ? "ring-2 ring-primary" : "ring-border hover:ring-foreground/40",
                  (i < loopIn || i > loopOut) && "opacity-35", // hors portée de boucle → estompé
                )}
                style={{ contentVisibility: "auto" } as React.CSSProperties}
                aria-label={t("sequence.frameN", { n: i + 1 })}
                aria-current={i === cur}
              >
                {f ? (
                  <img
                    src={displaySrc("image", f)}
                    alt=""
                    draggable={false}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-muted/40 text-muted-foreground">
                    <ImageOff className="size-5" strokeWidth={1.5} />
                  </span>
                )}
                <span
                  className={cn(
                    "absolute bottom-0 right-0 rounded-tl bg-black/70 px-1 text-[10px] font-medium tabular-nums",
                    i === cur ? "text-primary" : "text-white/90",
                  )}
                >
                  {i + 1}
                </span>
              </button>
            ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
