// Visionneuse plein écran (lightbox) — grande image sur fond sombre, BANDE DE VIGNETTES en bas
// (clic = sauter à l'image), zoom molette + déplacement à la souris, double-clic = zoom rapide,
// diaporama auto (lecture/pause, 3 s), légende, flèches clavier, Échap. Portail sur <body>.
// Zéro boucle d'anim JS (transform direct + un setInterval de diaporama).
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import i18n from "@/i18n";

const SLIDESHOW_MS = 3000;

export function Lightbox({ urls, index, onClose, onIndex, captions }: {
  urls: string[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
  captions?: string[];
}) {
  const many = urls.length > 1;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [playing, setPlaying] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const go = (d: number) => onIndex((index + d + urls.length) % urls.length);

  // Changement d'image → zoom/pan remis à zéro.
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [index]);

  // Diaporama : avance toutes les 3 s tant que lecture active.
  useEffect(() => {
    if (!playing || !many) return;
    const t = setInterval(() => onIndex((index + 1) % urls.length), SLIDESHOW_MS);
    return () => clearInterval(t);
  }, [playing, many, index, urls.length, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && many) go(-1);
      else if (e.key === "ArrowRight" && many) go(1);
      else if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  });

  const clampZoom = (z: number) => Math.min(6, Math.max(1, z));
  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    const z = clampZoom(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
    if (z === 1) setPan({ x: 0, y: 0 });
    setZoom(z);
    setPlaying(false);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (zoom === 1) return;
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPan({ x: drag.current.px + e.clientX - drag.current.x, y: drag.current.py + e.clientY - drag.current.y });
  };
  const onPointerUp = () => { drag.current = null; };
  const toggleQuickZoom = () => {
    if (zoom === 1) setZoom(2);
    else { setZoom(1); setPan({ x: 0, y: 0 }); }
  };

  const caption = captions?.[index]?.trim();

  return createPortal(
    <div className="fixed inset-0 z-[200] flex flex-col bg-black/95" onClick={onClose}>
      {/* Barre du haut : compteur + zoom + diaporama + fermer */}
      <div className="flex items-center justify-between px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <span className="text-sm text-white/70 tabular-nums">{index + 1} / {urls.length}</span>
        <div className="flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" type="button" onClick={() => { setZoom(clampZoom(zoom / 1.4)); if (zoom / 1.4 <= 1) setPan({ x: 0, y: 0 }); }} className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"><NetsuIcon name="zoom-out" className="size-4" /></Button>} />
            <TooltipContent>{i18n.t("notebook:lightbox.zoomOut")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" type="button" onClick={() => setZoom(clampZoom(zoom * 1.4))} className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"><NetsuIcon name="zoom-in" className="size-4" /></Button>} />
            <TooltipContent>{i18n.t("notebook:lightbox.zoomIn")}</TooltipContent>
          </Tooltip>
          {many && (
            <Tooltip>
              <TooltipTrigger render={
                <Button variant="ghost" type="button" onClick={() => setPlaying((p) => !p)} className={cn("h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0", `flex size-9 items-center justify-center rounded-full text-white hover:bg-white/20 ${playing ? "bg-primary" : "bg-white/10"}`)}>
                  <NetsuIcon name="play-pause" on={playing} className="size-4" />
                </Button>
              } />
              <TooltipContent>{playing ? i18n.t("notebook:lightbox.pause") : i18n.t("notebook:lightbox.slideshow")}</TooltipContent>
            </Tooltip>
          )}
          <Button variant="ghost" type="button" onClick={onClose} className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20" aria-label={i18n.t("notebook:window.close")}><NetsuIcon name="close" className="size-4" /></Button>
        </div>
      </div>

      {/* Image (zoom/pan) + flèches */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {many && (
          <>
            <Button variant="ghost" type="button" onClick={(e) => { e.stopPropagation(); setPlaying(false); go(-1); }} className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0 absolute left-4 z-10 flex size-12 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20" aria-label={i18n.t("notebook:lightbox.previous")}><NetsuIcon name="prev" className="size-6" /></Button>
            <Button variant="ghost" type="button" onClick={(e) => { e.stopPropagation(); setPlaying(false); go(1); }} className="h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0 absolute right-4 z-10 flex size-12 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20" aria-label={i18n.t("notebook:lightbox.next")}><NetsuIcon name="next" className="size-6" /></Button>
          </>
        )}
        <img
          src={urls[index]}
          alt=""
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={toggleQuickZoom}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, cursor: zoom > 1 ? "grab" : "zoom-in", touchAction: "none" }}
          className="max-h-full max-w-full object-contain select-none"
          draggable={false}
        />
      </div>

      {/* Légende + bande de vignettes */}
      <div className="flex flex-col items-center gap-2 px-4 pt-2 pb-3" onClick={(e) => e.stopPropagation()}>
        {caption && <p className="max-w-2xl truncate text-center text-sm text-white/80">{caption}</p>}
        {many && (
          <div className="flex max-w-full items-center gap-1.5 overflow-x-auto pb-1">
            {urls.map((u, k) => (
              <Button variant="ghost"
                key={u + k}
                type="button"
                aria-label={`${caption || i18n.t("notebook:fileKind.image")} ${k + 1}`}
                onClick={() => { setPlaying(false); onIndex(k); }}
                className={cn("h-auto gap-0 rounded-none px-0 py-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent justify-start shrink select-auto active:not-aria-[haspopup]:translate-y-0", `h-14 w-20 shrink-0 overflow-hidden rounded-md transition-opacity ${k === index ? "ring-2 ring-primary" : "opacity-50 hover:opacity-90"}`)}
              >
                <img src={u} alt="" className="h-full w-full object-cover" draggable={false} />
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
