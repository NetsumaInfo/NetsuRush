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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link2, Trash2, Unlink2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBoard } from "./useReferenceBoard";
import { screenToBoard, uid, type BoardItem, type DrawShape } from "./referenceShared";
import { shapeBBox, hitShape, shifted, handlesFor, editShape, penPath, connectorPath } from "./drawGeometry";
import { FLAT_PRESSURE, pressureWidth, tiltLean, usesEraser } from "./tabletInput";
import { attachShape, detachShape, indexItems, reanchorShape, resolveShapes } from "./drawAnchor";
import { frameAtPoint } from "./boardFrames";
import { useLive } from "./boardLive";
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
  const { t } = useTranslation("reference");
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
  // La gomme peut venir de l'outil choisi OU du bout inversé du stylet : le geste en cours doit
  // s'en souvenir, le retourner en plein tracé ne relance pas de pointerdown.
  const erasing = useRef(false);
  // Une tablette SANS capteur renvoie exactement 0,5 tant que la pointe touche (valeur imposée par
  // la spec). Tant qu'aucun échantillon n'en dévie, le tracé ne garde aucune pression : il redevient
  // un trait d'épaisseur constante, exactement ce que la souris pose.
  const sawPressure = useRef(false);
  // Contact qui tient le tracé en cours : un DEUXIÈME doigt veut zoomer, pas dessiner.
  const strokeId = useRef<number | null>(null);

  // Formes LIÉES à un média : leurs coordonnées stockées sont exprimées dans le repère de l'item,
  // et reconverties ici depuis sa géométrie courante. Pendant un geste, la géométrie vit dans le
  // canal vivant (l'item n'a pas encore été commité) → une flèche suit l'image en direct.
  const stored = drawItem?.shapes ?? EMPTY_SHAPES;
  const boardItems = useBoard((s) => s.items);
  const live = useLive();
  const anchoredItems = useMemo<BoardItem[]>(() => {
    const geoms = live.geom;
    if (!Object.keys(geoms).length) return boardItems;
    return boardItems.map((it) => (geoms[it.id] ? { ...it, ...geoms[it.id] } : it));
  }, [boardItems, live.geom]);
  const shapes = useMemo(() => resolveShapes(stored, anchoredItems), [stored, anchoredItems]);

  // Culling des tracés, même logique que les items : seuls ceux qui croisent le viewport élargi
  // (une marge d'un viewport de chaque côté) sont rendus. Sans lui, un board très annoté rendait
  // TOUTES les formes, et la couche promue prenait pour bornes la bbox de l'ensemble — un raster
  // énorme à fort zoom. La vue ne commite qu'une fois par geste : ce filtre est payé au commit,
  // jamais par frame. La sélection et la gomme, elles, continuent de voir la liste complète.
  const drawnShapes = useMemo(() => {
    if (shapes.length < 40) return shapes;
    const el = ref.current;
    const w = (el?.clientWidth || window.innerWidth) / view.scale;
    const h = (el?.clientHeight || window.innerHeight) / view.scale;
    const x = -view.tx / view.scale, y = -view.ty / view.scale;
    const x0 = x - w, y0 = y - h, x1 = x + w * 2, y1 = y + h * 2;
    return shapes.filter((s) => {
      const [a, b, c, d] = shapeBBox(s);
      return a < x1 && c > x0 && b < y1 && d > y0;
    });
  }, [shapes, view]);

  // Écriture des formes : ce qui est lié est RÉ-ANCRÉ avant d'être stocké (sinon un tracé déplacé à
  // la main reviendrait à sa position d'origine au rendu suivant).
  const writeShapes = useCallback((next: DrawShape[], record = true, tag?: string) => {
    const byId = indexItems(useBoard.getState().items);
    useBoard.getState().drawSetShapes(next.map((s) => reanchorShape(s, byId)), record, tag);
  }, []);
  // Mode sélection actif : hors dessin, ou outil « sélection » du mode dessin.
  const selectMode = !drawMode || pen.tool === "select";

  const worldFromXY = useCallback((cx: number, cy: number) => {
    const r = ref.current?.getBoundingClientRect();
    return screenToBoard(useBoard.getState().view, cx - (r?.left ?? 0), cy - (r?.top ?? 0));
  }, []);
  const worldPoint = (e: React.PointerEvent) => worldFromXY(e.clientX, e.clientY);
  const wWorld = () => pen.width / useBoard.getState().view.scale;
  // Formes RÉSOLUES (coordonnées monde) : c'est sur elles que portent hit-test et mutations ;
  // `writeShapes` se charge de les ré-ancrer avant stockage.
  const getShapes = () => {
    const st = useBoard.getState();
    return resolveShapes(st.items.find((i) => i.kind === "draw")?.shapes ?? [], st.items);
  };

  // --- Déplacement / édition d'une forme (partagé wrapper mode dessin ET cibles hors dessin) ----
  // Stable (refs + getState uniquement) → permet de mémoïser les cibles transparentes.
  const applyMove = useCallback((cx: number, cy: number) => {
    const { x, y } = worldFromXY(cx, cy);
    if (edit.current) {
      const ed = edit.current;
      const straight = 6 / useBoard.getState().view.scale;
      const next = getShapes().map((s) => (s.id === ed.id ? editShape(s, ed.k, x, y, straight) : s));
      writeShapes(next, !ed.recorded);
      ed.recorded = true;
      return true;
    }
    if (drag.current) {
      const d = drag.current;
      const dx = x - d.lx, dy = y - d.ly;
      d.lx = x; d.ly = y;
      const next = getShapes().map((s) => (s.id === d.id ? shifted(s, dx, dy) : s));
      writeShapes(next, !d.recorded);
      d.recorded = true;
      return true;
    }
    return false;
  }, [worldFromXY]);
  // Tracé délié traîné hors de tout cadre : le lien coupé n'a plus d'objet — même règle que les
  // items, sinon il arriverait secrètement délié dans le prochain cadre où on le pose.
  const endGesture = () => {
    const id = drag.current?.id;
    drag.current = null;
    edit.current = null;
    if (!id) return;
    const shape = getShapes().find((s) => s.id === id);
    if (!shape?.detached) return;
    const [a, b, c, d] = shapeBBox(shape);
    if (frameAtPoint((a + c) / 2, (b + d) / 2, useBoard.getState().items)) return;
    writeShapes(getShapes().map((s) => (s.id === id ? { ...s, detached: undefined } : s)), false);
  };

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

  // Un deuxième contact pendant un tracé = un pincement qui commence, pas un deuxième trait : la
  // planche prend la main et le trait en cours est jeté. Écoute sur la FENÊTRE et en capture — le
  // board arrête la propagation du deuxième doigt pour l'empêcher de déclencher un geste d'item,
  // donc l'événement n'atteindrait jamais ce calque.
  useEffect(() => {
    const onSecond = (e: PointerEvent) => {
      if (!drawing.current || strokeId.current === null || e.pointerId === strokeId.current) return;
      if (e.pointerType === "mouse" || !useBoard.getState().prefs.touchGestures) return;
      drawing.current = false;
      erasing.current = false;
      strokeId.current = null;
      setDraft(null);
    };
    window.addEventListener("pointerdown", onSecond, { capture: true });
    return () => window.removeEventListener("pointerdown", onSecond, { capture: true });
  }, []);

  // Cet échantillon apporte-t-il une variation d'épaisseur RÉELLE ? La spec impose 0,5 à un matériel
  // sans capteur : une valeur qui ne bouge jamais ne mérite pas d'être stockée par point.
  const varies = (e: { pressure: number; tiltX: number; tiltY: number }) => {
    const p = useBoard.getState().prefs;
    if (p.penPressure && Math.abs(e.pressure - FLAT_PRESSURE) > 0.01) return true;
    return p.penTilt && (e.tiltX !== 0 || e.tiltY !== 0);
  };

  // Part d'épaisseur d'un échantillon : la pression du stylet, éventuellement élargie par
  // l'inclinaison (un stylet couché pose une marque plus large, comme le flanc d'un crayon). Vaut 1
  // pour une souris, un doigt, ou quand le réglage est coupé — donc trait d'épaisseur constante.
  const widthFactor = (e: { pointerType: string; pressure: number; tiltX: number; tiltY: number }) => {
    if (e.pointerType !== "pen") return 1;
    const p = useBoard.getState().prefs;
    let f = p.penPressure ? pressureWidth(e.pressure, p.penMinWidth) : 1;
    if (p.penTilt) f *= 1 + tiltLean(e.tiltX, e.tiltY) * 0.6;
    return f;
  };

  // --- Wrapper plein écran : actif uniquement en mode dessin (tracé / gomme / outil sélection) ----
  const onDown = (e: React.PointerEvent) => {
    // La pointe gomme du stylet arrive avec son propre bouton (5), pas le bouton 0 d'une pointe
    // d'écriture : sans ce test elle ne déclencherait rien du tout.
    const tipErases = useBoard.getState().prefs.penEraserTip && usesEraser(e);
    if (!drawMode || (e.button !== 0 && !tipErases)) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
    const { x, y } = worldPoint(e);
    const tool = tipErases ? "eraser" : pen.tool;
    erasing.current = tool === "eraser";
    sawPressure.current = false;
    strokeId.current = e.pointerId;

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
      writeShapes(getShapes().filter((s) => !hitShape(s, x, y, thr)));
      return;
    }
    // formes tracées. Opacité : réglage libre du pen ; le surligneur force ~0,45 si laissé opaque.
    drawing.current = true;
    const op = tool === "marker" ? (pen.op < 1 ? pen.op : 0.45) : pen.op < 1 ? pen.op : undefined;
    const base = { id: uid(), c: pen.color, w: wWorld(), dash: pen.dash, op };
    const f = widthFactor(e);
    if (tool === "pen") setDraft({ ...base, t: "pen", p: [x, y], pw: [f] });
    else if (tool === "marker") setDraft({ ...base, t: "pen", w: wWorld() * 2.4, p: [x, y], pw: [f] }); // trait large
    else if (tool === "arrow") setDraft({ ...base, t: "arrow", p: [x, y, x, y], h1: pen.head1, h2: pen.head2, route: pen.route });
    else if (tool === "line") setDraft({ ...base, t: "line", p: [x, y, x, y], route: pen.route }); // ligne = sans pointe
    else setDraft({ ...base, t: tool, p: [x, y, x, y] });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drawMode) return;
    if (applyMove(e.clientX, e.clientY)) return;
    if (!drawing.current) return;
    const { x, y } = worldPoint(e);
    if (erasing.current) {
      const thr = (pen.width + 12) / view.scale;
      writeShapes(getShapes().filter((s) => !hitShape(s, x, y, thr)));
      return;
    }
    const shift = e.shiftKey;
    // Échantillons FUSIONNÉS : un stylet émet à 200–1000 Hz, le navigateur n'en livre qu'un par
    // frame et empile le reste dans l'événement. Les relire, c'est la différence entre une courbe
    // et une ligne brisée — c'est là que se joue la fidélité d'un tracé rapide.
    const samples: PointerEvent[] = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const pts = samples.length ? samples : [e.nativeEvent];
    // Hors de la mise à jour d'état, qui doit rester pure : elle peut être rejouée.
    if (!sawPressure.current && pts.some((ev) => ev.pointerType === "pen" && varies(ev))) sawPressure.current = true;
    setDraft((c) => {
      if (!c) return c;
      if (c.t === "pen") {
        // Amincissement : ignorer les échantillons < ~1,5px écran du précédent (bruit du pointeur) →
        // tracés plus légers et lissage penPath plus stable.
        const minD = 1.5 / useBoard.getState().view.scale;
        let p = c.p, pw = c.pw;
        for (const ev of pts) {
          const w = worldFromXY(ev.clientX, ev.clientY);
          const n = p.length;
          if (n >= 2 && Math.hypot(w.x - p[n - 2], w.y - p[n - 1]) < minD) continue;
          if (p === c.p) { p = [...c.p]; pw = c.pw ? [...c.pw] : undefined; }
          p.push(w.x, w.y);
          pw?.push(widthFactor(ev));
        }
        return p === c.p ? c : { ...c, p, pw };
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
    erasing.current = false;
    strokeId.current = null;
    endGesture();
    if (draft) {
      const ok = draft.t === "pen" ? draft.p.length >= 4 : Math.hypot(draft.p[2] - draft.p[0], draft.p[3] - draft.p[1]) > 3 / view.scale;
      // Rien n'a varié sur toute la course (souris, doigt, ou tablette sans capteur figée à 0,5) :
      // le tracé repart en épaisseur constante plutôt que de traîner un tableau de 1 par point.
      const kept = draft.pw && !sawPressure.current ? { ...draft, pw: undefined } : draft;
      // Accrochage automatique : une flèche tracée d'une image vers une autre est tenue par ses deux
      // bouts ; un trait posé sur une image lui appartient. Débrayable dans les Paramètres.
      if (ok) {
        const st = useBoard.getState();
        const shaped = st.prefs.autoAnchorDraw ? attachShape(kept, st.items) : kept;
        writeShapes([...getShapes(), shaped]);
      }
      setDraft(null);
    }
  };

  if (!drawItem && !drawMode) return null;

  const selShape = drawSel && selectMode ? shapes.find((s) => s.id === drawSel) : null;
  // Largeur de la zone cliquable des cibles transparentes, quantifiée à l'octave : une valeur exacte
  // en 1/scale changerait à chaque commit de zoom et casserait le memo de HitTargets — toutes les
  // cibles re-réconciliées pour un cheveu de différence. Entre deux octaves elle vaut 7 à 14 px
  // écran, largement dans la tolérance d'un clic.
  const hitW = 14 / 2 ** Math.ceil(Math.log2(Math.max(view.scale, 1e-6)));

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
        <StaticShapes shapes={drawnShapes} draft={draft} />

        {!drawMode && <HitTargets shapes={drawnShapes} hitW={hitW} onDown={onTargetDown} onMove={onTargetMove} onUp={onTargetUp} />}

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

      {/* Pastilles posées sur le tracé sélectionné — mêmes gestes que sur un item : lien au cadre
          (bleu = le cadre l'emmène) et suppression. Rendues HORS de la couche transformée, donc à
          taille d'écran constante : un tracé fin très dézoomé garde des boutons cliquables. */}
      {selShape && !drawMode && (() => {
        const [a, b, c, d] = shapeBBox(selShape);
        const left = view.tx + a * view.scale;
        const top = view.ty + b * view.scale;
        const width = (c - a) * view.scale;
        const frame = frameAtPoint((a + c) / 2, (b + d) / 2, boardItems);
        const setDetached = (on: boolean) =>
          writeShapes(getShapes().map((s) => (s.id === selShape.id ? { ...s, detached: on || undefined } : s)));
        return (
          <div
            className="pointer-events-auto absolute z-30 flex items-center gap-1"
            style={{ left, top: top - 34, width: Math.max(width, 64) }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {frame && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t(selShape.detached ? "actions.linkFrame" : "actions.unlinkFrame")}
                      aria-pressed={!selShape.detached}
                      onClick={() => setDetached(!selShape.detached)}
                      className={cn(
                        "flex size-6 items-center justify-center rounded-full shadow ring-1 [&_svg]:size-3.5",
                        selShape.detached
                          ? "bg-muted text-muted-foreground ring-foreground/15 hover:bg-muted/80"
                          : "bg-primary text-primary-foreground ring-black/10 hover:bg-primary/90",
                      )}
                    />
                  }
                >
                  {selShape.detached ? <Unlink2 /> : <Link2 />}
                </TooltipTrigger>
                <TooltipContent>{t(selShape.detached ? "actions.linkFrame" : "actions.unlinkFrame")}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={t("common:action.delete")}
                    onClick={() => { writeShapes(getShapes().filter((s) => s.id !== selShape.id)); selectDrawShape(null); }}
                    className="flex size-6 items-center justify-center rounded-full bg-destructive/90 text-white shadow ring-1 ring-black/10 hover:bg-destructive [&_svg]:size-3.5"
                  />
                }
              >
                <Trash2 />
              </TooltipTrigger>
              <TooltipContent>{t("common:action.delete")}</TooltipContent>
            </Tooltip>
          </div>
        );
      })()}

      {selShape && (
        <ShapeInspector
          shape={selShape}
          scale={view.scale}
          onPatch={(patch) => writeShapes(getShapes().map((s) => (s.id === selShape.id ? { ...s, ...patch } : s)))}
          onDuplicate={() => {
            const off = 16 / useBoard.getState().view.scale;
            const copy = { ...shifted(selShape, off, off), id: uid() };
            writeShapes([...getShapes(), copy]);
            selectDrawShape(copy.id);
          }}
          onDelete={() => { writeShapes(getShapes().filter((s) => s.id !== selShape.id)); selectDrawShape(null); }}
          // Délier fige le tracé en coordonnées monde ; relier retente l'accrochage automatique.
          onUnlink={() => {
            const byId = indexItems(useBoard.getState().items);
            writeShapes(getShapes().map((s) => (s.id === selShape.id ? detachShape(s, byId) : s)));
          }}
          onRelink={() => {
            const its = useBoard.getState().items;
            writeShapes(getShapes().map((s) => (s.id === selShape.id ? attachShape(s, its) : s)));
          }}
        />
      )}
    </div>
  );
}
