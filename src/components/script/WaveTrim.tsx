// Waveform de sélection in/out, zoomable façon éditeur audio.
//
// Deux couches de canvas superposées, et c'est la clé des performances : le FOND (graduations +
// barres) ne dépend ni de la sélection ni de la tête de lecture, il n'est donc repeint qu'au zoom ou
// au redimensionnement ; le DESSUS (voile, teinte de sélection, tête de lecture) est le seul repeint
// à 60 fps pendant la lecture ou pendant un glissé de borne. Auparavant tout vivait sur un canvas
// unique dont le rendu balayait les pics à chaque frame.
//
// Les poignées sont de VRAIS éléments DOM (pas des traits peints) : zone de préhension large,
// curseur `ew-resize`, survol visible, et une bande centrale `grab` qui déplace la sélection ENTIÈRE
// sans changer sa durée. Molette = zoom centré curseur, Maj+molette = défiler. Zoomé, une mini-carte
// (fichier entier + fenêtre visible) apparaît dessous.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  drawMinimap, drawWaveBase, drawWaveOverlay, snapTime,
  type WavePalette, type WaveWindow,
} from "./wave/waveDraw";

export type { WaveWindow } from "./wave/waveDraw";

export interface WaveTrimHandle {
  fitAll(): void;
  fitSelection(): void;
}

interface Props {
  peaks: number[]; // enveloppe pleine durée (repli + mini-carte)
  duration: number;
  inSec: number;
  outSec: number;
  time: number;
  playing?: boolean;
  onIn: (t: number) => void;
  onOut: (t: number) => void;
  onRange: (inSec: number, outSec: number) => void; // tracé d'une plage / déplacement du bloc
  onSeek: (t: number) => void;
  // Pics haute résolution sur une fenêtre (zoom). null = indisponible (mock) → repli pleine durée.
  loadWindow?: (start: number, end: number, buckets: number) => Promise<WaveWindow | null>;
  // Points d'aimantation (mots du transcript…). La tête de lecture et les bornes du fichier s'y
  // ajoutent toujours. Alt enfoncé = aimantation désactivée.
  snapPoints?: number[];
  onZoom?: (zoomed: boolean) => void;
  className?: string;
}

type DragMode = "in" | "out" | "range" | "move" | "seek" | null;

const MIN_SPAN = 0.5;   // zoom max : une demi-seconde plein cadre
const HI_BUCKETS = 1600;
const RULER_H = 16;     // bande de graduations, en haut du canvas
const DRAG_SLOP = 4;    // px : en deçà, un glissé reste un clic (ne détruit pas la sélection)
const SNAP_PX = 7;
const MIN_SELECTION = 0.02;

export const WaveTrim = forwardRef<WaveTrimHandle, Props>(function WaveTrim(
  { peaks, duration, inSec, outSec, time, playing, onIn, onOut, onRange, onSeek, loadWindow, snapPoints, onZoom, className },
  handle,
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ mode: DragMode; anchor: number; anchorX: number; span: number; moved: boolean }>(
    { mode: null, anchor: 0, anchorX: 0, span: 0, moved: false },
  );
  const [view, setView] = useState({ a: 0, b: 0 });
  const [hi, setHi] = useState<WaveWindow | null>(null);
  const [sizeTick, setSizeTick] = useState(0);
  const [hover, setHover] = useState<"in" | "out" | "move" | null>(null);
  const hiSeq = useRef(0);

  const span = view.b - view.a;
  const zoomed = duration > 0 && span > 0 && span < duration * 0.995;

  // Vue initiale = fichier entier (la durée arrive async) ; clamp si la durée change.
  useEffect(() => {
    if (duration <= 0) return;
    setView((v) => (v.b <= 0 || v.b > duration + 0.01 ? { a: 0, b: duration } : v));
  }, [duration]);

  useEffect(() => { onZoom?.(zoomed); }, [zoomed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pics haute résolution : redemandés (debounce) quand la fenêtre visible change. Marge de 25 % de
  // chaque côté pour survivre aux petits pans sans repasser par le repli basse résolution.
  useEffect(() => {
    if (!loadWindow || !zoomed) { setHi(null); return; }
    const seq = ++hiSeq.current;
    const pad = span * 0.25;
    const a = Math.max(0, view.a - pad);
    const b = Math.min(duration, view.b + pad);
    const id = setTimeout(() => {
      void loadWindow(a, b, HI_BUCKETS).then((w) => {
        if (w && seq === hiSeq.current) setHi(w);
      }).catch(() => {});
    }, 160);
    return () => clearTimeout(id);
  }, [view.a, view.b, zoomed, duration]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => setSizeTick((t) => t + 1));
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // La tête de lecture suit le zoom : sortie de la fenêtre pendant la lecture → page suivante.
  useEffect(() => {
    if (!playing || !zoomed) return;
    if (time > view.b || time < view.a) {
      const a = Math.max(0, Math.min(duration - span, time - span * 0.1));
      setView({ a, b: a + span });
    }
  }, [time, playing, zoomed, view.a, view.b, span, duration]);

  // Molette : zoom centré sur le curseur ; Maj (ou delta horizontal) = pan. Listener natif
  // non-passif obligatoire (React pose wheel en passif → preventDefault ignoré, la page défilerait).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || duration <= 0) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      setView((v) => {
        const s = v.b - v.a;
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          const d = ((e.deltaX || e.deltaY) / rect.width) * s;
          const a = Math.max(0, Math.min(duration - s, v.a + d));
          return { a, b: a + s };
        }
        const cursorT = v.a + ((e.clientX - rect.left) / rect.width) * s;
        const ns = Math.max(Math.min(MIN_SPAN, duration), Math.min(duration, s * (e.deltaY < 0 ? 0.75 : 1.35)));
        const a = Math.max(0, Math.min(duration - ns, cursorT - ((cursorT - v.a) / s) * ns));
        return { a, b: a + ns };
      });
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [duration]);

  useImperativeHandle(handle, () => ({
    fitAll() { if (duration > 0) setView({ a: 0, b: duration }); },
    fitSelection() {
      if (duration <= 0) return;
      const s = Math.max(Math.min(MIN_SPAN, duration), Math.min(duration, (outSec - inSec) * 1.25));
      const a = Math.max(0, Math.min(duration - s, (inSec + outSec) / 2 - s / 2));
      setView({ a, b: a + s });
    },
  }), [duration, inSec, outSec]);

  // Palette lue sur le WRAPPER : le canvas est portalé dans un Dialog, les tokens résolvent au
  // top-level et non sous .nr-script.
  const palette = useCallback((): WavePalette => {
    const style = getComputedStyle(wrapRef.current ?? document.body);
    const primary = (style.getPropertyValue("--primary") || "#8b7cf6").trim();
    const fg = (style.getPropertyValue("--foreground") || "#eee").trim();
    return {
      bar: `color-mix(in srgb, ${fg} 55%, transparent)`,
      barSel: primary,
      sel: `color-mix(in srgb, ${primary} 26%, transparent)`,
      dim: "rgba(0,0,0,.42)",
      tick: `color-mix(in srgb, ${fg} 45%, transparent)`,
      head: "#fff",
    };
  }, []);

  const setupCanvas = (cv: HTMLCanvasElement | null, w: number, h: number) => {
    if (!cv) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  };

  // ── Fond : graduations + barres (indépendant de la sélection et de la lecture) ──
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || duration <= 0 || span <= 0) return;
    const w = wrap.clientWidth || 600;
    const h = wrap.clientHeight || 96;
    const ctx = setupCanvas(baseRef.current, w, h);
    if (!ctx) return;
    const useHi = hi && hi.peaks.length > 0 && hi.start <= view.a + 1e-6 && hi.end >= view.b - 1e-6;
    drawWaveBase({
      ctx, width: w, height: h,
      viewStart: view.a, viewEnd: view.b,
      src: useHi ? hi.peaks : peaks,
      srcStart: useHi ? hi.start : 0,
      srcEnd: useHi ? hi.end : duration,
      palette: palette(), rulerHeight: RULER_H,
    });
  }, [peaks, hi, duration, view.a, view.b, span, sizeTick, palette]);

  // ── Dessus : voile + sélection + tête de lecture ──
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || duration <= 0 || span <= 0) return;
    const w = wrap.clientWidth || 600;
    const h = wrap.clientHeight || 96;
    const ctx = setupCanvas(overRef.current, w, h);
    if (!ctx) return;
    drawWaveOverlay({
      ctx, width: w, height: h,
      viewStart: view.a, viewEnd: view.b,
      inSec, outSec, time, palette: palette(), rulerHeight: RULER_H,
    });
  }, [duration, view.a, view.b, span, inSec, outSec, time, sizeTick, palette]);

  // ── Mini-carte (fichier entier) ──
  useEffect(() => {
    const cv = mapRef.current;
    if (!cv || !zoomed || duration <= 0) return;
    const w = cv.clientWidth || 600;
    const h = cv.clientHeight || 22;
    const ctx = setupCanvas(cv, w, h);
    if (!ctx) return;
    drawMinimap({
      ctx, width: w, height: h, peaks, duration,
      inSec, outSec, viewStart: view.a, viewEnd: view.b, palette: palette(),
    });
  }, [peaks, duration, view.a, view.b, inSec, outSec, zoomed, sizeTick, palette]);

  // ── Géométrie ──
  const toX = (t: number) => ((t - view.a) / span) * (wrapRef.current?.clientWidth || 1);
  const inX = toX(inSec);
  const outX = toX(outSec);

  const snapTargets = useMemo(
    () => [0, duration, ...(snapPoints ?? [])],
    [duration, snapPoints],
  );

  const tAt = (clientX: number, withSnap: boolean): number => {
    const r = wrapRef.current!.getBoundingClientRect();
    const raw = Math.max(0, Math.min(duration, view.a + ((clientX - r.left) / r.width) * span));
    if (!withSnap) return raw;
    const tolerance = (SNAP_PX / r.width) * span;
    return snapTime(raw, [...snapTargets, time], tolerance);
  };

  const begin = (e: React.PointerEvent, mode: DragMode) => {
    if (duration <= 0 || span <= 0) return;
    drag.current = { mode, anchor: tAt(e.clientX, !e.altKey), anchorX: e.clientX, span: outSec - inSec, moved: false };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* best-effort */ }
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.mode) return;
    if (!d.moved && Math.abs(e.clientX - d.anchorX) < DRAG_SLOP) return; // clic, pas encore un glissé
    d.moved = true;
    const t = tAt(e.clientX, !e.altKey);
    if (d.mode === "in") onIn(Math.min(t, outSec - MIN_SELECTION));
    else if (d.mode === "out") onOut(Math.max(t, inSec + MIN_SELECTION));
    else if (d.mode === "move") {
      // Déplacer la sélection sans changer sa durée (bloquée aux bornes du fichier).
      const start = Math.max(0, Math.min(duration - d.span, t - d.span / 2));
      onRange(start, start + d.span);
    } else {
      d.mode = "range";
      onRange(Math.min(d.anchor, t), Math.max(d.anchor, t));
    }
  };

  const onUp = () => {
    const d = drag.current;
    if (!d.moved && (d.mode === "seek" || d.mode === "move")) onSeek(d.anchor); // clic simple = seek
    drag.current = { mode: null, anchor: 0, anchorX: 0, span: 0, moved: false };
  };

  // Mini-carte : glisser = centrer la fenêtre visible sur le curseur.
  const ovDrag = useRef(false);
  const ovCenter = (clientX: number) => {
    const cv = mapRef.current;
    if (!cv || duration <= 0) return;
    const r = cv.getBoundingClientRect();
    const t = ((clientX - r.left) / r.width) * duration;
    const a = Math.max(0, Math.min(duration - span, t - span / 2));
    setView({ a, b: a + span });
  };

  const handleStyle = (x: number) => ({ left: `${x}px`, top: `${RULER_H}px` });

  return (
    <div className={cn("flex min-h-0 flex-col gap-1", className)}>
      <div
        ref={wrapRef}
        className="wave-trim min-h-0 flex-1"
        onPointerDown={(e) => begin(e, "seek")}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <canvas ref={baseRef} className="wave-trim-canvas" />
        <canvas ref={overRef} className="wave-trim-canvas" />

        {/* Bande centrale : déplace la sélection entière (clic sans glissé = seek). */}
        <div
          className={cn("wave-region", hover === "move" && "is-hot")}
          style={{ left: `${inX}px`, width: `${Math.max(0, outX - inX)}px`, top: `${RULER_H}px` }}
          onPointerDown={(e) => { e.stopPropagation(); begin(e, "move"); }}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerEnter={() => setHover("move")}
          onPointerLeave={() => setHover(null)}
        />

        {(["in", "out"] as const).map((side) => (
          <div
            key={side}
            role="slider"
            tabIndex={-1}
            aria-label={side}
            aria-valuenow={side === "in" ? inSec : outSec}
            aria-valuemin={0}
            aria-valuemax={duration}
            className={cn("wave-handle", `is-${side}`, hover === side && "is-hot")}
            style={handleStyle(side === "in" ? inX : outX)}
            onPointerDown={(e) => { e.stopPropagation(); begin(e, side); }}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onPointerEnter={() => setHover(side)}
            onPointerLeave={() => setHover(null)}
          >
            <span className="wave-handle-grip" />
          </div>
        ))}
      </div>

      {zoomed && (
        <canvas
          ref={mapRef}
          className="wave-overview"
          onPointerDown={(e) => {
            ovDrag.current = true;
            ovCenter(e.clientX);
            try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* best-effort */ }
          }}
          onPointerMove={(e) => { if (ovDrag.current) ovCenter(e.clientX); }}
          onPointerUp={() => { ovDrag.current = false; }}
          onPointerCancel={() => { ovDrag.current = false; }}
        />
      )}
    </div>
  );
});
