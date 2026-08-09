import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowRightToLine, ArrowLeftToLine, RotateCcw } from "lucide-react";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { colorOf } from "./rotoShared";
import { rotoFrameUrl } from "./RotoViewer";
import type { RotoSession } from "./useRotoSession";
import { useTranslation } from "react-i18next";

// Timeline du Roto Studio (scrubber custom, pattern ScenePlayer : divs pilotées, pas de Progress).
// FILMSTRIP de vignettes (les frames JPEG existent déjà — zéro coût ffmpeg), playhead, marqueurs
// des frames annotées (couleur objet), bornes IN/OUT (touches I/O + poignées glissables, la zone
// hors plage est grisée : suivi et export s'y limitent), survol = aperçu de la frame visée.
const STRIP = 12;   // vignettes du filmstrip

export function RotoTimeline({ s, goto }: { s: RotoSession; goto: (f: number) => void }) {
  const { t } = useTranslation("roto");
  const nb = s.dims?.frames || 0;
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ f: number; px: number } | null>(null);
  const [menuF, setMenuF] = useState(0);   // frame sous le curseur au clic droit (bornes IN/OUT)
  const dragging = useRef<null | "seek" | "in" | "out">(null);

  const strip = useMemo(() => {
    if (!s.framesDir || nb < 2) return [];
    return Array.from({ length: STRIP }, (_, i) => Math.round((i * (nb - 1)) / (STRIP - 1)));
  }, [s.framesDir, nb]);

  // Frames annotées → marqueurs {frame, objs} (une pastille par objet distinct).
  const markers = useMemo(() =>
    Object.entries(s.pointsByFrame).map(([f, pts]) => ({
      f: Number(f), objs: [...new Set(pts.map((p) => p.obj))],
    })), [s.pointsByFrame]);

  const frameAt = useCallback((clientX: number) => {
    const el = trackRef.current; if (!el || nb < 2) return 0;
    const r = el.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(t * (nb - 1));
  }, [nb]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || nb < 2) return;
    const f = frameAt(e.clientX);
    // Attrape une poignée in/out si le clic tombe à ±2 % d'elle, sinon seek.
    const near = (v: number | null) => v !== null && Math.abs(f - v) / (nb - 1) < 0.02;
    dragging.current = near(s.inF) ? "in" : near(s.outF) ? "out" : "seek";
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ }
    if (dragging.current === "seek") goto(f);
    else if (dragging.current === "in") s.setInF(f);
    else s.setOutF(f);
  }, [nb, frameAt, goto, s]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const f = frameAt(e.clientX);
    const el = trackRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setHover({ f, px: Math.min(r.width - 1, Math.max(0, e.clientX - r.left)) });
    }
    const d = dragging.current;
    if (d === "seek") goto(f);
    else if (d === "in") s.setInF(Math.min(f, (s.outF ?? nb - 1)));
    else if (d === "out") s.setOutF(Math.max(f, (s.inF ?? 0)));
  }, [frameAt, goto, s, nb]);

  const pct = (f: number) => (nb > 1 ? (f / (nb - 1)) * 100 : 0);
  const lo = s.inF ?? 0;
  const hi = s.outF ?? (nb ? nb - 1 : 0);

  if (!s.framesDir || nb < 2) return null;
  const hasRange = s.inF !== null || s.outF !== null;
  return (
    <div className="w-full min-w-0 max-w-full select-none">
      {/* Clic droit sur le scrubber : poser IN/OUT à la frame sous le curseur (le clic gauche seek). */}
      <ContextMenu>
      <ContextMenuTrigger render={<div
        ref={trackRef}
        className="relative h-16 w-full cursor-pointer overflow-hidden rounded-md border border-border bg-black sm:h-14"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => { dragging.current = null; }}
        onPointerLeave={() => { dragging.current = null; setHover(null); }}
        onContextMenu={(e) => setMenuF(frameAt(e.clientX))}
      />}>
        {/* Filmstrip (vignettes = frames extraites, décodage navigateur, lazy) */}
        <div className="pointer-events-none absolute inset-0 flex opacity-70">
          {strip.map((f) => (
            <img key={f} src={rotoFrameUrl(s.framesDir!, f)} alt="" loading="lazy"
              className="h-full min-w-0 flex-1 object-cover" draggable={false} />
          ))}
        </div>
        {/* Hors plage in/out grisé */}
        {lo > 0 && <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/70" style={{ width: `${pct(lo)}%` }} />}
        {hi < nb - 1 && <div className="pointer-events-none absolute inset-y-0 right-0 bg-black/70" style={{ width: `${100 - pct(hi)}%` }} />}
        {/* Marqueurs des frames annotées */}
        {markers.map((m) => (
          <div key={m.f} className="pointer-events-none absolute bottom-0 top-auto flex h-2.5 -translate-x-1/2 gap-px" style={{ left: `${pct(m.f)}%` }}>
            {m.objs.map((o) => (
              <span key={o} className="h-full w-1 rounded-sm" style={{ background: colorOf(o) }} />
            ))}
          </div>
        ))}
        {/* Poignées in/out (visibles si plage active) */}
        {(s.inF !== null || s.outF !== null) && (
          <>
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-primary" style={{ left: `${pct(lo)}%` }} />
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-primary" style={{ left: `${pct(hi)}%` }} />
          </>
        )}
        {/* Playhead */}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_3px_rgba(0,0,0,0.8)]" style={{ left: `${pct(s.frame)}%` }} />
        {/* Aperçu au survol */}
        {hover && !dragging.current && (
          <div className="pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2" style={{ left: hover.px }}>
            <img src={rotoFrameUrl(s.framesDir!, hover.f)} alt="" className="w-28 rounded border border-border" draggable={false} />
            <p className="text-center text-[10px] tabular-nums text-muted-foreground">{hover.f + 1}</p>
          </div>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => s.setInF(menuF)}><ArrowRightToLine /> {t("timeline.inHere", { n: menuF + 1 })}</ContextMenuItem>
        <ContextMenuItem onClick={() => s.setOutF(menuF)}><ArrowLeftToLine /> {t("timeline.outHere", { n: menuF + 1 })}</ContextMenuItem>
        {hasRange && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => { s.setInF(null); s.setOutF(null); }}><RotateCcw /> {t("timeline.resetRange")}</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
