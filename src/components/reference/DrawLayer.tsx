// Calque de dessin MAISON (SVG, zéro dépendance). Outils : sélection, stylo, ligne, flèche,
// rectangle, ellipse, losange, texte, gomme. Formes en coordonnées MONDE, rendues dans un <svg>
// transformé comme la couche board → alignement parfait au pan/zoom (tout scale, façon encre).
// Persisté dans l'item singleton `draw` (`shapes`), via le store (undo/redo inclus).
//
// Sélection façon image : HORS mode dessin, une couche de cibles transparentes rend chaque tracé
// cliquable (clic = sélection + poignées + inspecteur, glissé = déplacement) sans entrer en dessin.
//
// PERF — les tracés et leurs cibles vivent dans des sous-composants MÉMOÏSÉS (clés sur `shapes` seul,
// PAS sur `view`). Pendant le pan, seul le `transform` du <svg> change (déplacement composite GPU,
// comme la couche d'items) : on ne re-réconcilie PAS toutes les formes à chaque frame → plus de lag.

import { memo, useCallback, useRef, useState } from "react";
import { useBoard } from "./useReferenceBoard";
import { screenToBoard, uid, type DrawShape } from "./referenceShared";
import { shapeBBox, hitShape, shifted, handlesFor, editShape, penPath, connectorPath } from "./drawGeometry";
import { ShapeView } from "./ShapeView";
import { ShapeInspector } from "./ShapeInspector";

// Référence stable pour « pas de tracés » : évite un `[]` neuf à chaque render
// (sinon les props de StaticShapes/HitTargets changent au pan et cassent leur memo).
const EMPTY_SHAPES: DrawShape[] = [];

// Tous les tracés + le brouillon en cours. Mémoïsé : ne dépend QUE de `shapes`/`draft`, jamais de
// `view` → invisible au pan (skip la réconciliation des N formes à chaque frame).
const StaticShapes = memo(function StaticShapes({ shapes, draft }: { shapes: DrawShape[]; draft: DrawShape | null }) {
  return (
    <>
      {shapes.map((s) => <ShapeView key={s.id} s={s} />)}
      {draft && <ShapeView s={draft} />}
    </>
  );
});

// Cibles transparentes (hors mode dessin) : rendent chaque tracé cliquable/déplaçable. Contour épais
// transparent → on attrape le tracé ; intérieur des formes fermées cliquable seulement si rempli (sinon
// il passerait au travers des items placés dedans, comme un cadre). Mémoïsé (clés sur shapes + hitW +
// handlers stables) → ignoré pendant le pan.
const HitTargets = memo(function HitTargets({ shapes, hitW, onDown, onMove, onUp }: {
  shapes: DrawShape[];
  hitW: number;
  onDown: (id: string, e: React.PointerEvent) => void;
  onMove: (e: React.PointerEvent) => void;
  onUp: (e: React.PointerEvent) => void;
}) {
  return (
    <>
      {shapes.map((s) => {
        const handlers = {
          onPointerDown: (e: React.PointerEvent) => onDown(s.id, e),
          onPointerMove: onMove,
          onPointerUp: onUp,
          style: { cursor: "move" as const },
        };
        const k = `h-${s.id}`;
        const sw = Math.max(s.w, hitW);
        const filled = !!s.fill && s.fill !== "none";
        if (s.t === "pen") {
          return <path key={k} {...handlers} d={penPath(s.p)} stroke="transparent" strokeWidth={sw} fill="none" strokeLinecap="round" strokeLinejoin="round" pointerEvents="stroke" />;
        }
        if (s.t === "line" || s.t === "arrow") {
          return <path key={k} {...handlers} d={connectorPath(s).d} stroke="transparent" strokeWidth={sw} fill="none" strokeLinejoin="round" pointerEvents="stroke" />;
        }
        if (s.t === "rect") {
          const x = Math.min(s.p[0], s.p[2]), y = Math.min(s.p[1], s.p[3]);
          return <rect key={k} {...handlers} x={x} y={y} width={Math.abs(s.p[2] - s.p[0])} height={Math.abs(s.p[3] - s.p[1])} fill={filled ? "transparent" : "none"} stroke="transparent" strokeWidth={sw} pointerEvents={filled ? "all" : "stroke"} />;
        }
        if (s.t === "ellipse") {
          const cx = (s.p[0] + s.p[2]) / 2, cy = (s.p[1] + s.p[3]) / 2;
          return <ellipse key={k} {...handlers} cx={cx} cy={cy} rx={Math.abs(s.p[2] - s.p[0]) / 2} ry={Math.abs(s.p[3] - s.p[1]) / 2} fill={filled ? "transparent" : "none"} stroke="transparent" strokeWidth={sw} pointerEvents={filled ? "all" : "stroke"} />;
        }
        if (s.t === "diamond") {
          const x0 = Math.min(s.p[0], s.p[2]), y0 = Math.min(s.p[1], s.p[3]);
          const x1 = Math.max(s.p[0], s.p[2]), y1 = Math.max(s.p[1], s.p[3]);
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
          return <polygon key={k} {...handlers} points={`${cx},${y0} ${x1},${cy} ${cx},${y1} ${x0},${cy}`} fill={filled ? "transparent" : "none"} stroke="transparent" strokeWidth={sw} pointerEvents={filled ? "all" : "stroke"} />;
        }
        // texte : boîte pleine cliquable.
        const [a, b, c, d] = shapeBBox(s);
        return <rect key={k} {...handlers} x={a} y={b} width={Math.max(1, c - a)} height={Math.max(1, d - b)} fill="transparent" pointerEvents="all" />;
      })}
    </>
  );
});

export function DrawLayer() {
  const drawMode = useBoard((s) => s.drawMode);
  const drawBack = useBoard((s) => s.drawBack);
  const view = useBoard((s) => s.view);
  const pen = useBoard((s) => s.pen);
  const drawItem = useBoard((s) => s.items.find((i) => i.kind === "draw") ?? null);
  const drawSel = useBoard((s) => s.drawSel);
  const selectDrawShape = useBoard((s) => s.selectDrawShape);

  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<DrawShape | null>(null);
  const drag = useRef<{ id: string; lx: number; ly: number; recorded: boolean } | null>(null);
  const edit = useRef<{ id: string; k: string; recorded: boolean } | null>(null);
  const drawing = useRef(false);

  const shapes = drawItem?.shapes ?? EMPTY_SHAPES;
  // Mode sélection actif : hors dessin, ou outil « sélection » du mode dessin.
  const selectMode = !drawMode || pen.tool === "select";

  const worldFromXY = useCallback((cx: number, cy: number) => {
    const r = ref.current?.getBoundingClientRect();
    return screenToBoard(useBoard.getState().view, cx - (r?.left ?? 0), cy - (r?.top ?? 0));
  }, []);
  const worldPoint = (e: React.PointerEvent) => worldFromXY(e.clientX, e.clientY);
  const wWorld = () => pen.width / useBoard.getState().view.scale;
  const getShapes = () => useBoard.getState().items.find((i) => i.kind === "draw")?.shapes ?? [];

  // --- Déplacement / édition d'une forme (partagé wrapper mode dessin ET cibles hors dessin) ----
  // Stable (refs + getState uniquement) → permet de mémoïser les cibles transparentes.
  const applyMove = useCallback((cx: number, cy: number) => {
    const { x, y } = worldFromXY(cx, cy);
    if (edit.current) {
      const ed = edit.current;
      const straight = 6 / useBoard.getState().view.scale;
      const next = getShapes().map((s) => (s.id === ed.id ? editShape(s, ed.k, x, y, straight) : s));
      useBoard.getState().drawSetShapes(next, !ed.recorded);
      ed.recorded = true;
      return true;
    }
    if (drag.current) {
      const d = drag.current;
      const dx = x - d.lx, dy = y - d.ly;
      d.lx = x; d.ly = y;
      const next = getShapes().map((s) => (s.id === d.id ? shifted(s, dx, dy) : s));
      useBoard.getState().drawSetShapes(next, !d.recorded);
      d.recorded = true;
      return true;
    }
    return false;
  }, [worldFromXY]);
  const endGesture = () => { drag.current = null; edit.current = null; };

  // Cibles transparentes (hors mode dessin) : pointer capture sur la cible → déplacement.
  const onTargetDown = useCallback((id: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectDrawShape(id);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
    const { x, y } = worldFromXY(e.clientX, e.clientY);
    drag.current = { id, lx: x, ly: y, recorded: false };
  }, [selectDrawShape, worldFromXY]);
  const onHandleDown = (id: string, k: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
    edit.current = { id, k, recorded: false };
  };
  const onTargetMove = useCallback((e: React.PointerEvent) => { if (applyMove(e.clientX, e.clientY)) e.stopPropagation(); }, [applyMove]);
  const onTargetUp = useCallback((e: React.PointerEvent) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    endGesture();
  }, []);

  // --- Wrapper plein écran : actif uniquement en mode dessin (tracé / gomme / outil sélection) ----
  const onDown = (e: React.PointerEvent) => {
    if (!drawMode || e.button !== 0) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
    const { x, y } = worldPoint(e);
    const tool = pen.tool;

    if (tool === "select") {
      if (drawSel) {
        const sel = shapes.find((s) => s.id === drawSel);
        const hThr = 11 / view.scale;
        const h = sel && handlesFor(sel).find((p) => Math.hypot(p.x - x, p.y - y) < hThr);
        if (sel && h) { edit.current = { id: sel.id, k: h.k, recorded: false }; return; }
      }
      const thr = 10 / view.scale;
      const hit = [...shapes].reverse().find((s) => hitShape(s, x, y, thr, true));
      selectDrawShape(hit?.id ?? null);
      if (hit) drag.current = { id: hit.id, lx: x, ly: y, recorded: false };
      return;
    }
    if (tool === "eraser") {
      drawing.current = true;
      const thr = (pen.width + 12) / view.scale;
      useBoard.getState().drawSetShapes(getShapes().filter((s) => !hitShape(s, x, y, thr)));
      return;
    }
    // formes tracées. Opacité : réglage libre du pen ; le surligneur force ~0,45 si laissé opaque.
    drawing.current = true;
    const op = tool === "marker" ? (pen.op < 1 ? pen.op : 0.45) : pen.op < 1 ? pen.op : undefined;
    const base = { id: uid(), c: pen.color, w: wWorld(), dash: pen.dash, op };
    if (tool === "pen") setDraft({ ...base, t: "pen", p: [x, y] });
    else if (tool === "marker") setDraft({ ...base, t: "pen", w: wWorld() * 2.4, p: [x, y] }); // trait large
    else if (tool === "arrow") setDraft({ ...base, t: "arrow", p: [x, y, x, y], h1: pen.head1, h2: pen.head2, route: pen.route });
    else if (tool === "line") setDraft({ ...base, t: "line", p: [x, y, x, y], route: pen.route }); // ligne = sans pointe
    else setDraft({ ...base, t: tool, p: [x, y, x, y] });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drawMode) return;
    if (applyMove(e.clientX, e.clientY)) return;
    if (!drawing.current) return;
    const { x, y } = worldPoint(e);
    if (pen.tool === "eraser") {
      const thr = (pen.width + 12) / view.scale;
      useBoard.getState().drawSetShapes(getShapes().filter((s) => !hitShape(s, x, y, thr)));
      return;
    }
    const shift = e.shiftKey;
    setDraft((c) => {
      if (!c) return c;
      if (c.t === "pen") {
        // Amincissement : ignorer les échantillons < ~1,5px écran du précédent (bruit du pointeur) →
        // tracés plus légers et lissage penPath plus stable.
        const minD = 1.5 / useBoard.getState().view.scale;
        const n = c.p.length;
        if (n >= 2 && Math.hypot(x - c.p[n - 2], y - c.p[n - 1]) < minD) return c;
        return { ...c, p: [...c.p, x, y] };
      }
      let ex = x, ey = y;
      if (shift && (c.t === "line" || c.t === "arrow")) {
        // Maj : angle contraint aux multiples de 15°.
        const dx = x - c.p[0], dy = y - c.p[1];
        const len = Math.hypot(dx, dy);
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
        ex = c.p[0] + Math.cos(ang) * len; ey = c.p[1] + Math.sin(ang) * len;
      } else if (shift && (c.t === "rect" || c.t === "ellipse" || c.t === "diamond")) {
        // Maj : carré / cercle (côté = plus grande dimension, signe conservé).
        const dx = x - c.p[0], dy = y - c.p[1];
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        ex = c.p[0] + Math.sign(dx || 1) * side; ey = c.p[1] + Math.sign(dy || 1) * side;
      }
      return { ...c, p: [c.p[0], c.p[1], ex, ey] };
    });
  };

  const onUp = (e: React.PointerEvent) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    drawing.current = false;
    endGesture();
    if (draft) {
      const ok = draft.t === "pen" ? draft.p.length >= 4 : Math.hypot(draft.p[2] - draft.p[0], draft.p[3] - draft.p[1]) > 3 / view.scale;
      if (ok) useBoard.getState().drawSetShapes([...getShapes(), draft]);
      setDraft(null);
    }
  };

  if (!drawItem && !drawMode) return null;

  const selShape = drawSel && selectMode ? shapes.find((s) => s.id === drawSel) : null;
  const hitW = 14 / view.scale; // largeur de la zone cliquable des cibles transparentes

  // z : en mode dessin TOUJOURS au-dessus (z 20, items = z 10) pour tracer par-dessus tout ; sinon
  // respecte `drawBack` (arrière-plan = sous les items). → « premier plan » d'un item passe devant.
  const zIndex = drawMode ? 20 : drawBack ? 0 : 20;

  return (
    <div
      ref={ref}
      className="absolute inset-0"
      style={{
        zIndex,
        pointerEvents: drawMode ? "auto" : "none",
        cursor: pen.tool === "eraser" ? "cell" : pen.tool === "select" ? "default" : "crosshair",
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
    >
      {/* La TRANSFORM vit sur un <div> (et non le <svg>) : un div + will-change:transform est promu
          en couche composite FIABLE (comme la couche d'items) → le pan ne fait que déplacer la texture
          GPU. Un <svg> transformé n'est pas toujours promu dans Chromium → il re-rasterise au pan
          (= le lag ressenti). Le <svg> reste statique, rasterisé une fois, déplacé par le div parent. */}
      <div
        data-board-pan
        className="absolute inset-0 origin-top-left will-change-transform"
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
      >
        <svg
          className="absolute left-0 top-0 h-full w-full overflow-visible"
          style={{ pointerEvents: "none", overflow: "visible" }}
        >
        <StaticShapes shapes={shapes} draft={draft} />

        {!drawMode && <HitTargets shapes={shapes} hitW={hitW} onDown={onTargetDown} onMove={onTargetMove} onUp={onTargetUp} />}

        {selShape && (() => {
          const [a, b, c, d] = shapeBBox(selShape);
          const pad = 6 / view.scale;
          const r = 5 / view.scale;
          return (
            <g>
              <rect
                x={a - pad} y={b - pad} width={c - a + pad * 2} height={d - b + pad * 2}
                fill="none" stroke="var(--color-primary)" strokeDasharray={`${6 / view.scale} ${4 / view.scale}`}
                strokeWidth={1.5 / view.scale} style={{ pointerEvents: "none" }}
              />
              {handlesFor(selShape).map((h) => (
                <circle
                  key={h.k} cx={h.x} cy={h.y} r={h.bend ? r * 0.85 : r}
                  fill={h.bend ? "var(--color-primary)" : "var(--color-bg)"}
                  stroke="var(--color-primary)" strokeWidth={1.5 / view.scale}
                  style={{ pointerEvents: drawMode ? "none" : "auto", cursor: "pointer" }}
                  onPointerDown={drawMode ? undefined : (e) => onHandleDown(selShape.id, h.k, e)}
                  onPointerMove={drawMode ? undefined : onTargetMove}
                  onPointerUp={drawMode ? undefined : onTargetUp}
                />
              ))}
            </g>
          );
        })()}
        </svg>
      </div>

      {selShape && (
        <ShapeInspector
          shape={selShape}
          scale={view.scale}
          onPatch={(patch) => useBoard.getState().drawSetShapes(getShapes().map((s) => (s.id === selShape.id ? { ...s, ...patch } : s)))}
          onDuplicate={() => {
            const off = 16 / useBoard.getState().view.scale;
            const copy = { ...shifted(selShape, off, off), id: uid() };
            useBoard.getState().drawSetShapes([...getShapes(), copy]);
            selectDrawShape(copy.id);
          }}
          onDelete={() => { useBoard.getState().drawSetShapes(getShapes().filter((s) => s.id !== selShape.id)); selectDrawShape(null); }}
        />
      )}
    </div>
  );
}
