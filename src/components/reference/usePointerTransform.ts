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
import { rotatedBBox } from "./boardArrange";
import { snapMove, snapValue, snapCandidates, type SnapGuide, type SnapRect } from "./boardSnap";
import { clearLive, setLiveGeom, setLiveGuides } from "./boardLive";

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
  // Aimant : voisins et seuil FIGÉS au début du geste (une seule lecture du store, pas une par frame).
  snap: { others: SnapRect[]; cands: { x: number[]; y: number[] }; threshold: number; stick: number } | null;
  live: boolean; // publier la géométrie vivante (des tracés sont liés à cet item)
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
  opts?: {
    keepAspect?: boolean;
    captureRef?: React.RefObject<HTMLElement | null>;
    // Id de l'item manipulé : active l'aimant (les autres items deviennent des cibles d'accrochage)
    // et la publication de géométrie vivante quand des tracés lui sont liés.
    id?: string;
    // Items EMMENÉS par celui-ci (contenu d'un cadre) : ils ne peuvent pas être cibles d'aimant.
    // Fonction acceptée pour ne calculer la liste qu'au début du geste, pas à chaque rendu.
    groupIds?: string[] | (() => string[]);
  },
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
      const st = useBoard.getState();
      const scale = st.view.scale;

      // Cibles de l'aimant : tous les autres items, sauf ceux qui partent avec (multi-sélection),
      // le calque de dessin, et les cadres de pose. Lues UNE fois : la scène ne bouge pas pendant
      // le geste, et relire N items par frame coûterait plus cher que le geste lui-même.
      let snap: Drag["snap"] = null;
      if (opts?.id && st.prefs.snap && mode.type !== "rotate") {
        // Ce qui part AVEC l'item ne peut pas servir de cible : la multi-sélection déplacée en bloc,
        // et le contenu d'un cadre (un cadre emmène ce qu'il contient).
        const group = st.selectedIds.length > 1 && st.selectedIds.includes(opts.id) ? st.selectedIds : [opts.id];
        const carried = typeof opts.groupIds === "function" ? opts.groupIds() : opts.groupIds ?? [];
        const skip = new Set([...group, ...carried]);
        const others = st.items
          .filter((it) => !skip.has(it.id) && it.kind !== "draw" && it.w > 0 && it.h > 0)
          .map((it) => {
            const b = rotatedBBox(it);
            return { x: b.x, y: b.y, w: b.w, h: b.h };
          });
        if (others.length) {
          snap = {
            others,
            cands: snapCandidates(others),
            threshold: (st.prefs.snapThreshold ?? 8) / scale,
            stick: st.prefs.snapStick ?? 0,
          };
        }
      }

      // Publication vivante seulement si un tracé est réellement lié à cet item (sinon, zéro coût).
      const anchored = opts?.id
        ? (st.items.find((it) => it.kind === "draw")?.shapes ?? []).some(
            (s) => s.own === opts.id || s.a1?.id === opts.id || s.a2?.id === opts.id,
          )
        : false;

      drag.current = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        origin: { ...g },
        cx: g.x + g.w / 2,
        cy: g.y + g.h / 2,
        scx: r.left + r.width / 2,
        scy: r.top + r.height / 2,
        scale,
        snap,
        live: anchored,
      };
      useBoard.getState().beginNavigation();
    },
    [opts?.captureRef, opts?.id, opts?.groupIds],
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
        let g: Geom = { ...o, x: o.x + dxs, y: o.y + dys };
        // Aimant : accrochage bords / centres / coins, et collage bord à bord. Alt = geste libre.
        if (d.snap && !e.altKey) {
          const b = rotatedBBox(g);
          const res = snapMove(b, d.snap.others, d.snap.threshold, d.snap.stick);
          if (res.dx || res.dy) g = { ...g, x: g.x + res.dx, y: g.y + res.dy };
          setLiveGuides(res.guides);
        } else if (d.snap) {
          setLiveGuides([]);
        }
        schedule(g);
        if (d.live && opts?.id) setLiveGeom({ [opts.id]: g });
        return;
      }

      if (d.mode.type === "rotate") {
        // Angle autour du centre ÉCRAN (px) : delta exact même board pané/zoomé.
        const a0 = Math.atan2(d.startY - d.scy, d.startX - d.scx);
        const a1 = Math.atan2(e.clientY - d.scy, e.clientX - d.scx);
        let deg = o.rotation + (a1 - a0) / RAD;
        if (e.shiftKey || e.ctrlKey) deg = Math.round(deg / 15) * 15; // snap 15°
        const g = { ...o, rotation: deg };
        schedule(g);
        if (d.live && opts?.id) setLiveGeom({ [opts.id]: g });
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
      let g: Geom = { rotation: o.rotation, w: nw, h: nh, x: ncx - nw / 2, y: ncy - nh / 2 };

      // Aimant au redimensionnement : seuls les bords TIRÉS s'accrochent, et seulement sur un item
      // non tourné (sur un item pivoté, « le bord droit » n'a plus d'axe propre — on laisse libre).
      if (d.snap && !e.altKey && !o.rotation) {
        const guides: SnapGuide[] = [];
        const { cands } = d.snap;
        if (dir.dx > 0) {
          const s = snapValue(g.x + g.w, cands.x, d.snap.threshold);
          if (s.at != null) { g = { ...g, w: Math.max(MIN_SIZE, s.value - g.x) }; guides.push({ axis: "x", at: s.at, from: g.y, to: g.y + g.h }); }
        } else if (dir.dx < 0) {
          const s = snapValue(g.x, cands.x, d.snap.threshold);
          if (s.at != null) { const right = g.x + g.w; g = { ...g, x: s.value, w: Math.max(MIN_SIZE, right - s.value) }; guides.push({ axis: "x", at: s.at, from: g.y, to: g.y + g.h }); }
        }
        if (dir.dy > 0) {
          const s = snapValue(g.y + g.h, cands.y, d.snap.threshold);
          if (s.at != null) { g = { ...g, h: Math.max(MIN_SIZE, s.value - g.y) }; guides.push({ axis: "y", at: s.at, from: g.x, to: g.x + g.w }); }
        } else if (dir.dy < 0) {
          const s = snapValue(g.y, cands.y, d.snap.threshold);
          if (s.at != null) { const bottom = g.y + g.h; g = { ...g, y: s.value, h: Math.max(MIN_SIZE, bottom - s.value) }; guides.push({ axis: "y", at: s.at, from: g.x, to: g.x + g.w }); }
        }
        setLiveGuides(guides);
      }

      schedule(g);
      if (d.live && opts?.id) setLiveGeom({ [opts.id]: g });
    },
    [schedule, opts?.keepAspect, opts?.id],
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
      // Le store fait de nouveau foi : guides éteints, géométrie vivante rendue.
      clearLive();
      useBoard.getState().endNavigation();
    },
    [onCommit, override, opts?.captureRef],
  );

  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      if (drag.current) {
        drag.current = null;
        clearLive();
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
