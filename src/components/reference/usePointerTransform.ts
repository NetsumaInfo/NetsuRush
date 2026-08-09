// Moteur de gestes d'un item du board : déplacer / redimensionner (8 poignées) / pivoter.
// Remplace interact.js par des pointer events natifs. Pendant le geste, la géométrie vit dans
// un état LOCAL (override) coalescé en rAF → seul l'item manipulé re-render, jamais tout le board.
// Au relâchement (pointerup) on commit dans le store. Tient compte du zoom du board (delta /scale)
// et de la rotation de l'item (le redimensionnement se fait dans le repère local de l'item).
// Le zoom est LU AU DÉBUT du geste (on ne zoome pas en pleine manipulation) plutôt que reçu en prop :
// une prop réactive re-rendait TOUS les items du board à chaque cran de molette.

import { useCallback, useEffect, useRef, useState } from "react";
import { type Geom, MIN_SIZE } from "./referenceShared";
import { useBoard } from "./useReferenceBoard";

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type Mode = { type: "move" } | { type: "rotate" } | { type: "resize"; handle: ResizeHandle };

interface Drag {
  mode: Mode;
  startX: number;
  startY: number;
  origin: Geom;
  cx: number; // centre item (board coords) — réancrage du redimensionnement
  cy: number;
  scx: number; // centre item à l'ÉCRAN (px) — pivot de rotation (invariant pan/zoom)
  scy: number;
  scale: number; // zoom du board FIGÉ au début du geste (cf. commentaire d'en-tête)
}

const RAD = Math.PI / 180;

// Unité horizontale/verticale poussée par chaque poignée (sur les axes locaux de l'item).
const HANDLE_DIR: Record<ResizeHandle, { dx: number; dy: number }> = {
  nw: { dx: -1, dy: -1 }, n: { dx: 0, dy: -1 }, ne: { dx: 1, dy: -1 },
  e: { dx: 1, dy: 0 }, se: { dx: 1, dy: 1 }, s: { dx: 0, dy: 1 },
  sw: { dx: -1, dy: 1 }, w: { dx: -1, dy: 0 },
};

export function usePointerTransform(
  geom: Geom,
  onCommit: (g: Geom) => void,
  opts?: { keepAspect?: boolean; captureRef?: React.RefObject<HTMLElement | null> },
) {
  const [override, setOverride] = useState<Geom | null>(null);
  const drag = useRef<Drag | null>(null);
  const raf = useRef<number | null>(null);
  const pending = useRef<Geom | null>(null);
  const latest = useRef<Geom>(geom);
  // `geom` est construit inline par BoardItem : synchronisation à chaque commit, sans dépendance
  // d'objet toujours neuve qui relancerait artificiellement un effet à chaque rendu.
  useEffect(() => { latest.current = override ?? geom; });

  const flush = useCallback(() => {
    raf.current = null;
    if (pending.current) setOverride(pending.current);
  }, []);

  const schedule = useCallback(
    (g: Geom) => {
      pending.current = g;
      if (raf.current == null) raf.current = requestAnimationFrame(flush);
    },
    [flush],
  );

  const start = useCallback(
    (mode: Mode, e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const cap = opts?.captureRef?.current ?? (e.currentTarget as Element);
      try { cap.setPointerCapture?.(e.pointerId); } catch { /* capture best-effort */ }
      // Centre ÉCRAN de l'item (rect du wrapper) : pivot de rotation correct quel que soit
      // le pan/zoom du board (l'angle est invariant par translation/échelle uniforme).
      const r = cap.getBoundingClientRect();
      const g = latest.current;
      drag.current = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        origin: { ...g },
        cx: g.x + g.w / 2,
        cy: g.y + g.h / 2,
        scx: r.left + r.width / 2,
        scy: r.top + r.height / 2,
        scale: useBoard.getState().view.scale,
      };
      useBoard.getState().beginNavigation();
    },
    [opts?.captureRef],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      // Delta écran → delta board (compense le zoom).
      const dxs = (e.clientX - d.startX) / d.scale;
      const dys = (e.clientY - d.startY) / d.scale;
      const o = d.origin;

      if (d.mode.type === "move") {
        schedule({ ...o, x: o.x + dxs, y: o.y + dys });
        return;
      }

      if (d.mode.type === "rotate") {
        // Angle autour du centre ÉCRAN (px) : delta exact même board pané/zoomé.
        const a0 = Math.atan2(d.startY - d.scy, d.startX - d.scx);
        const a1 = Math.atan2(e.clientY - d.scy, e.clientX - d.scx);
        let deg = o.rotation + (a1 - a0) / RAD;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15; // snap 15°
        schedule({ ...o, rotation: deg });
        return;
      }

      // resize : projeter le delta sur les axes LOCAUX de l'item (annule la rotation).
      const dir = HANDLE_DIR[d.mode.handle];
      const cos = Math.cos(o.rotation * RAD);
      const sin = Math.sin(o.rotation * RAD);
      const localX = dxs * cos + dys * sin;
      const localY = -dxs * sin + dys * cos;

      let nw = o.w + dir.dx * localX;
      let nh = o.h + dir.dy * localY;
      const aspect = opts?.keepAspect && o.h !== 0 ? o.w / o.h : null;
      if (aspect) {
        // Proportionnel : axe dominant pilote, sauf poignées de bord (n/s/e/w) → l'axe actif.
        if (dir.dx !== 0 && dir.dy !== 0) {
          if (Math.abs(localX) > Math.abs(localY)) nh = nw / aspect;
          else nw = nh * aspect;
        } else if (dir.dx !== 0) nh = nw / aspect;
        else nw = nh * aspect;
      }
      nw = Math.max(MIN_SIZE, nw);
      nh = Math.max(MIN_SIZE, nh);

      // Garder le coin/bord OPPOSÉ fixe : recentre selon la croissance, en repère monde.
      const grewW = nw - o.w;
      const grewH = nh - o.h;
      const offLocalX = (dir.dx * grewW) / 2;
      const offLocalY = (dir.dy * grewH) / 2;
      const offX = offLocalX * cos - offLocalY * sin;
      const offY = offLocalX * sin + offLocalY * cos;
      const ncx = d.cx + offX;
      const ncy = d.cy + offY;
      schedule({ rotation: o.rotation, w: nw, h: nh, x: ncx - nw / 2, y: ncy - nh / 2 });
    },
    [schedule, opts?.keepAspect],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return;
      const cap = opts?.captureRef?.current ?? (e.currentTarget as Element);
      try { cap.releasePointerCapture?.(e.pointerId); } catch { /* noop */ }
      drag.current = null;
      if (raf.current != null) {
        cancelAnimationFrame(raf.current);
        raf.current = null;
      }
      const g = pending.current ?? override;
      pending.current = null;
      if (g) {
        onCommit(g);
        setOverride(null);
      }
      useBoard.getState().endNavigation();
    },
    [onCommit, override, opts?.captureRef],
  );

  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      if (drag.current) {
        drag.current = null;
        useBoard.getState().endNavigation();
      }
    },
    [],
  );

  return {
    geom: override ?? geom,
    dragging: drag.current != null,
    startMove: (e: React.PointerEvent) => start({ type: "move" }, e),
    startRotate: (e: React.PointerEvent) => start({ type: "rotate" }, e),
    startResize: (handle: ResizeHandle, e: React.PointerEvent) => start({ type: "resize", handle }, e),
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  };
}
