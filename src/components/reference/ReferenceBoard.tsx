// Canvas du board : couche pan/zoom (transform translate+scale) rendant les items, gestion de la
// molette (zoom centré curseur), du pan (glissé sur le vide), du drop fichiers et du paste.
// Expose un handle impératif (addFiles/addVideoUrl/addUrl/addPath/fit/reset) consommé par la Toolbar.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBoard } from "./useReferenceBoard";
import { useBoardIngest } from "./useBoardIngest";
import { useBoardCulling } from "./useBoardCulling";
import { BoardItem } from "./BoardItem";
import { DrawLayer } from "./DrawLayer";
import { DrawToolbar } from "./DrawToolbar";
import {
  type BoardView,
  type NrMediaDrag,
  NR_MEDIA_DND,
  ZOOM_MIN,
  ZOOM_MAX,
  screenToBoard,
  makeTextItem,
  makeFrameItem,
} from "./referenceShared";
import { shapeBBox } from "./drawGeometry";

const clampScale = (s: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));

export interface BoardHandle {
  addFiles: (files: FileList | File[]) => void;
  addVideoUrl: (url: string, opts?: { allowGenericEmbed?: boolean }) => boolean;
  addUrl: (url: string, opts?: { allowGenericEmbed?: boolean }) => Promise<boolean>;
  addPath: (path: string, title?: string) => void;
  addCut: (path: string, inSec: number, outSec: number, title?: string) => void;
  addCuts: (path: string, cuts: { in: number; out: number; title?: string }[]) => void;
  addSequence: (paths: string[]) => void;
  addPaste: (data: DataTransfer) => Promise<boolean>;
  pasteClipboard: () => void;
  addText: () => void;
  addFrame: () => void;
  fit: () => void;
  reset: () => void;
  zoomBy: (factor: number) => void;
}

export const ReferenceBoard = forwardRef<BoardHandle>(function ReferenceBoard(_props, ref) {
  const { t } = useTranslation("reference");
  const containerRef = useRef<HTMLDivElement>(null);
  const items = useBoard((s) => s.items);
  // Le tracé (kind `draw`) est rendu par DrawLayer ; mémoïsé pour ne pas re-filtrer à chaque frame de pan.
  const boardItems = useMemo(() => items.filter((it) => it.kind !== "draw"), [items]);
  const view = useBoard((s) => s.view);
  const background = useBoard((s) => s.background);
  const dotGap = useBoard((s) => s.prefs.dotGap);
  const fitOnOpen = useBoard((s) => s.prefs.fitOnOpen);
  const sceneId = useBoard((s) => s.sceneId);
  const placeFrame = useBoard((s) => s.placeFrame);
  const drawMode = useBoard((s) => s.drawMode);
  const selectedIds = useBoard((s) => s.selectedIds);
  const selectedId = useBoard((s) => s.selectedId);
  const editingId = useBoard((s) => s.editingId);
  const focusReq = useBoard((s) => s.focusReq);
  const setView = useBoard((s) => s.setView);
  const select = useBoard((s) => s.select);
  const selectMany = useBoard((s) => s.selectMany);
  const addItem = useBoard((s) => s.addItem);

  const [over, setOver] = useState(false);
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const gesture = useRef<"pan" | "marquee" | null>(null);
  const space = useRef(false);
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeDiv = useRef<HTMLDivElement>(null);
  const dotsRef = useRef<HTMLDivElement>(null);

  // PERF pan — pendant le geste, la vue vit ICI (ref) et s'applique en IMPÉRATIF coalescé en rAF
  // (transform des couches [data-board-pan] + translation modulo de la grille de points) ; le store
  // n'est commité qu'au pointerup. Sinon chaque pointermove (souris 125–1000 Hz) déclenchait un
  // setView → re-render React de tout le board + repaint plein écran du fond en points = saccades.
  const liveView = useRef<BoardView | null>(null);
  const rafId = useRef<number | null>(null);
  const zoomResumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Taille du viewport tenue à jour par ResizeObserver : le culling la lit à chaque frame de pan,
  // un getBoundingClientRect par frame forcerait un recalcul de layout.
  const size = useRef({ w: 0, h: 0 });

  const rect = () => containerRef.current?.getBoundingClientRect();

  // Ne monte que les items proches de l'écran (cf. useBoardCulling) : un board de plusieurs centaines
  // de médias ne garde ainsi qu'une poignée de <video>/iframes vivantes.
  const { visible, syncViewport } = useBoardCulling(boardItems, selectedIds, editingId);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const ro = new ResizeObserver(([e]) => {
      size.current = { w: e.contentRect.width, h: e.contentRect.height };
      syncViewport(useBoard.getState().view, size.current.w, size.current.h);
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [syncViewport]);

  const applyGesture = useCallback(() => {
    rafId.current = null;
    const c = containerRef.current;
    if (!c) return;
    const v = liveView.current;
    if (v) {
      const tf = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
      c.querySelectorAll<HTMLElement>("[data-board-pan]").forEach((el) => { el.style.transform = tf; });
      const dots = dotsRef.current;
      if (dots) {
        const g = useBoard.getState().prefs.dotGap || 24;
        dots.style.transform = `translate(${v.tx % g}px, ${v.ty % g}px)`;
      }
      syncViewport(v, size.current.w, size.current.h);
    }
    const m = marqueeRef.current;
    const md = marqueeDiv.current;
    if (m && md) {
      md.style.left = `${Math.min(m.x0, m.x1)}px`;
      md.style.top = `${Math.min(m.y0, m.y1)}px`;
      md.style.width = `${Math.abs(m.x1 - m.x0)}px`;
      md.style.height = `${Math.abs(m.y1 - m.y0)}px`;
    }
  }, [syncViewport]);
  const scheduleGesture = useCallback(() => {
    if (rafId.current == null) rafId.current = requestAnimationFrame(applyGesture);
  }, [applyGesture]);

  // Le culling suit la vue COMMITÉE (zoom, fit, focus, fin de pan).
  useLayoutEffect(() => { syncViewport(view, size.current.w, size.current.h); }, [view, syncViewport]);

  // Un re-render PENDANT un geste (montage d'items par le culling) remettrait la transform issue du
  // store, périmée tant que le pan n'est pas commité → on ré-applique la vue vivante avant le paint.
  useLayoutEffect(() => { if (liveView.current) applyGesture(); });

  // Cadre « zone de pose » : englobe tout le contenu (items ET tracés de dessin) en coords board →
  // suit le pan/zoom. Repère visible des limites du contenu quand on navigue vers les coins.
  const PLACE_PAD = 48; // marge board autour du contenu
  const contentBounds = useMemo(() => {
    // Recalcul O(items + tracés) : il se déclencherait à CHAQUE frame d'une séquence en lecture
    // (setSeqFrame réécrit `items`) → on ne le paie que si le cadre est réellement affiché.
    if (!placeFrame) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    for (const it of items) {
      if (it.kind === "draw") {
        // calque de dessin : englobe chaque tracé via sa bbox (coords monde).
        for (const s of it.shapes ?? []) {
          const [a, b, c, d] = shapeBBox(s);
          minX = Math.min(minX, a); minY = Math.min(minY, b);
          maxX = Math.max(maxX, c); maxY = Math.max(maxY, d);
          any = true;
        }
        continue;
      }
      minX = Math.min(minX, it.x); minY = Math.min(minY, it.y);
      maxX = Math.max(maxX, it.x + it.w); maxY = Math.max(maxY, it.y + it.h);
      any = true;
    }
    if (!any) return null;
    return { x: minX - PLACE_PAD, y: minY - PLACE_PAD, w: maxX - minX + PLACE_PAD * 2, h: maxY - minY + PLACE_PAD * 2 };
  }, [items, placeFrame]);

  // Espace maintenu → le glissé gauche sur le fond pane au lieu de sélectionner (façon mood-board).
  useEffect(() => {
    const kd = (e: KeyboardEvent) => { if (e.code === "Space") space.current = true; };
    const ku = (e: KeyboardEvent) => { if (e.code === "Space") space.current = false; };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => { window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); };
  }, []);

  const centerPoint = useCallback(() => {
    const r = rect();
    const cx = r ? r.width / 2 : 400;
    const cy = r ? r.height / 2 : 300;
    return screenToBoard(useBoard.getState().view, cx, cy);
  }, []);

  const ingest = useBoardIngest(centerPoint);

  // Un zoom est une rafale (molette/trackpad ou clics rapprochés). On ne fait qu'un gel au début,
  // puis on reprend après le dernier événement. Le compteur du store protège les chevauchements avec
  // un pan ou le déplacement d'un item.
  const holdMediaForZoom = useCallback(() => {
    if (zoomResumeTimer.current == null) useBoard.getState().beginNavigation();
    else clearTimeout(zoomResumeTimer.current);
    zoomResumeTimer.current = setTimeout(() => {
      zoomResumeTimer.current = null;
      useBoard.getState().endNavigation();
    }, 140);
  }, []);

  useEffect(() => () => {
    if (zoomResumeTimer.current != null) {
      clearTimeout(zoomResumeTimer.current);
      zoomResumeTimer.current = null;
      useBoard.getState().endNavigation();
    }
    if (gesture.current === "pan") useBoard.getState().endNavigation();
  }, []);

  const zoomAt = useCallback(
    (px: number, py: number, factor: number) => {
      holdMediaForZoom();
      const v = useBoard.getState().view;
      const ns = clampScale(v.scale * factor);
      const bx = (px - v.tx) / v.scale;
      const by = (py - v.ty) / v.scale;
      setView({ tx: px - bx * ns, ty: py - by * ns, scale: ns });
    },
    [holdMediaForZoom, setView],
  );

  // Molette coalescée : les trackpads tirent bien plus d'événements que de frames → on accumule le
  // delta et on applique UN zoom par frame (setView re-rend le board, inutile de le faire 3× par vsync).
  const wheelAcc = useRef<{ dy: number; x: number; y: number } | null>(null);
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const r = rect();
      if (!r) return;
      const a = wheelAcc.current;
      if (a) {
        a.dy += e.deltaY; a.x = e.clientX - r.left; a.y = e.clientY - r.top;
        return;
      }
      wheelAcc.current = { dy: e.deltaY, x: e.clientX - r.left, y: e.clientY - r.top };
      requestAnimationFrame(() => {
        const w = wheelAcc.current;
        wheelAcc.current = null;
        if (!w) return;
        // Sensibilité + sens configurables (Paramètres).
        const p = useBoard.getState().prefs;
        const k = 0.0015 * (p.zoomSpeed || 1) * (p.invertZoom ? -1 : 1);
        zoomAt(w.x, w.y, Math.exp(-w.dy * k));
      });
    },
    [zoomAt],
  );

  // Fond : glissé gauche = marquee de sélection ; clic milieu ou Espace+gauche = pan.
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.target !== e.currentTarget && e.button === 0) return; // clic sur un item → géré par l'item
      if (e.button !== 0 && e.button !== 1) return;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture best-effort */ }
      const v = useBoard.getState().view;
      if (e.button === 1 || space.current) {
        gesture.current = "pan";
        pan.current = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty };
        useBoard.getState().beginNavigation();
        // Curseur en impératif : aucun re-render React pendant le pan.
        if (containerRef.current) containerRef.current.style.cursor = "grabbing";
      } else {
        gesture.current = "marquee";
        select(null);
        const r = rect();
        const x = e.clientX - (r?.left ?? 0), y = e.clientY - (r?.top ?? 0);
        marqueeRef.current = { x0: x, y0: y, x1: x, y1: y };
        setMarquee(marqueeRef.current); // monte la div ; les moves la déplacent en impératif
      }
    },
    [select],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (gesture.current === "pan") {
        const p = pan.current;
        if (!p) return;
        const v = liveView.current ?? useBoard.getState().view;
        liveView.current = { ...v, tx: p.tx + (e.clientX - p.x), ty: p.ty + (e.clientY - p.y) };
        scheduleGesture();
      } else if (gesture.current === "marquee" && marqueeRef.current) {
        const r = rect();
        marqueeRef.current = { ...marqueeRef.current, x1: e.clientX - (r?.left ?? 0), y1: e.clientY - (r?.top ?? 0) };
        scheduleGesture();
      }
    },
    [scheduleGesture],
  );
  const finishPointerGesture = useCallback((e: React.PointerEvent) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    const wasPanning = gesture.current === "pan";
    if (rafId.current != null) { cancelAnimationFrame(rafId.current); rafId.current = null; }
    if (gesture.current === "pan" && liveView.current) {
      setView(liveView.current); // commit unique : les abonnés React se resynchronisent ici
    }
    if (gesture.current === "marquee" && marqueeRef.current) {
      const m = marqueeRef.current;
      const v = useBoard.getState().view;
      const a = screenToBoard(v, Math.min(m.x0, m.x1), Math.min(m.y0, m.y1));
      const b = screenToBoard(v, Math.max(m.x0, m.x1), Math.max(m.y0, m.y1));
      if (Math.abs(m.x1 - m.x0) > 4 || Math.abs(m.y1 - m.y0) > 4) {
        const ids = useBoard.getState().items
          .filter((it) => it.x < b.x && it.x + it.w > a.x && it.y < b.y && it.y + it.h > a.y)
          .map((it) => it.id);
        selectMany(ids);
      }
    }
    gesture.current = null;
    pan.current = null;
    liveView.current = null;
    marqueeRef.current = null;
    setMarquee(null);
    if (containerRef.current) containerRef.current.style.cursor = "";
    if (wasPanning) useBoard.getState().endNavigation();
  }, [selectMany, setView]);

  // Cadre tous les items dans le viewport (« fit »).
  const fit = useCallback(() => {
    const its = useBoard.getState().items;
    const r = rect();
    if (!its.length || !r) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of its) {
      minX = Math.min(minX, it.x); minY = Math.min(minY, it.y);
      maxX = Math.max(maxX, it.x + it.w); maxY = Math.max(maxY, it.y + it.h);
    }
    const pad = 60;
    const s = clampScale(Math.min((r.width - pad) / (maxX - minX), (r.height - pad) / (maxY - minY)));
    const tx = (r.width - (maxX - minX) * s) / 2 - minX * s;
    const ty = (r.height - (maxY - minY) * s) / 2 - minY * s;
    setView({ tx, ty, scale: s });
  }, [setView]);

  // Recadrer tous les items à l'ouverture d'une scène (Paramètres). Un tick après le montage des items.
  useEffect(() => {
    if (!fitOnOpen || !sceneId) return;
    const t = setTimeout(fit, 60);
    return () => clearTimeout(t);
  }, [sceneId, fitOnOpen, fit]);

  // Double-clic sur un média → centre l'item dans le viewport et zoome pour le cadrer.
  // La demande arrive via le store (focusReq) ; on la consomme puis on la remet à null.
  useEffect(() => {
    if (!focusReq) return;
    const it = useBoard.getState().items.find((i) => i.id === focusReq);
    const r = rect();
    useBoard.getState().requestFocus(null);
    if (!it || !r) return;
    const pad = 80;
    const s = clampScale(Math.min((r.width - pad) / it.w, (r.height - pad) / it.h));
    const tx = r.width / 2 - (it.x + it.w / 2) * s;
    const ty = r.height / 2 - (it.y + it.h / 2) * s;
    setView({ tx, ty, scale: s });
  }, [focusReq, setView]);

  useImperativeHandle(
    ref,
    () => ({
      addFiles: ingest.addFiles,
      addVideoUrl: ingest.addVideoUrl,
      addUrl: ingest.addUrl,
      addPath: ingest.addPath,
      addCut: ingest.addCut,
      addCuts: ingest.addCuts,
      addSequence: (paths: string[]) => void ingest.addSequence(paths),
      addPaste: ingest.addPaste,
      // Coller depuis le menu contextuel : pas de DataTransfer → on lit le presse-papier async.
      pasteClipboard: async () => {
        try {
          const clip = await navigator.clipboard.read();
          for (const it of clip) {
            const t = it.types.find((x) => x.startsWith("image/") || x.startsWith("video/"));
            if (t) {
              const ext = t.split("/")[1] || "png";
              ingest.addFiles([new File([await it.getType(t)], `collage.${ext}`, { type: t })]);
              return;
            }
          }
        } catch { /* pas de média accessible */ }
        try {
          const text = (await navigator.clipboard.readText()).trim();
          if (text) { void ingest.addUrl(text); return; }
        } catch { /* presse-papier inaccessible */ }
        useBoard.getState().setNotice({ kind: "error", text: t("board.clipboardEmpty") });
      },
      addText: () => {
        const c = centerPoint();
        const z = useBoard.getState().items.reduce((m, it) => Math.max(m, it.z), 0) + 1;
        const note = makeTextItem(c.x - 120, c.y - 70, z);
        // Applique les défauts de note configurés (Paramètres).
        const p = useBoard.getState().prefs;
        Object.assign(note, {
          fontFamily: p.defaultFont, fontSize: p.defaultFontSize,
          color: p.defaultTextColor, bg: p.defaultNoteBg,
        });
        addItem(note);
        useBoard.getState().setEditing(note.id);
      },
      // Cadre : centré sur le viewport, posé en fond (z bas, géré par makeFrameItem).
      addFrame: () => {
        const c = centerPoint();
        const p = useBoard.getState().prefs;
        addItem(makeFrameItem(c.x - 320, c.y - 210, { color: p.defaultFrameColor, fillMode: p.defaultFrameFill }));
      },
      fit,
      reset: () => setView({ tx: 0, ty: 0, scale: 1 } satisfies BoardView),
      zoomBy: (factor: number) => {
        const r = rect();
        if (r) zoomAt(r.width / 2, r.height / 2, factor);
      },
    }),
    [ingest.addFiles, ingest.addVideoUrl, ingest.addUrl, ingest.addPath, ingest.addCut, ingest.addCuts, ingest.addSequence, ingest.addPaste, addItem, centerPoint, fit, setView, zoomAt, t],
  );

  return (
    <div
      ref={containerRef}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPointerGesture}
      onPointerCancel={finishPointerGesture}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        // Drop interne (carte du MediaPicker) → posé EXACTEMENT au curseur, en coords board.
        const raw = e.dataTransfer.getData(NR_MEDIA_DND);
        if (raw) {
          try {
            const m = JSON.parse(raw) as NrMediaDrag;
            const r = rect();
            const at = screenToBoard(useBoard.getState().view, e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0));
            if (m.in != null && m.out != null) void ingest.addCut(m.file, m.in, m.out, m.title, at);
            else void ingest.addPath(m.file, m.title, at);
          } catch { /* payload illisible */ }
          return;
        }
        if (e.dataTransfer.files.length) ingest.addFiles(e.dataTransfer.files);
        else void ingest.addPaste(e.dataTransfer);
      }}
      className={cn(
        "relative h-full w-full cursor-default touch-none overflow-hidden outline-none",
        over && "ring-2 ring-inset ring-primary",
      )}
      style={{ backgroundColor: background.color }}
    >
      {/* Grille de points (repère spatial, masquée en fond monochrome) : div dédiée TRANSLATÉE en
          modulo du pas — déplacement composite GPU, zéro repaint pendant le pan (l'ancien
          backgroundPosition sur le conteneur re-rasterisait tout le viewport à chaque frame). */}
      {background.mode === "dots" && (
        <div
          ref={dotsRef}
          aria-hidden
          className="pointer-events-none absolute will-change-transform"
          style={{
            inset: -dotGap,
            backgroundImage: "radial-gradient(circle, var(--color-border) 1px, transparent 1px)",
            backgroundSize: `${dotGap}px ${dotGap}px`,
            transform: `translate(${view.tx % dotGap}px, ${view.ty % dotGap}px)`,
          }}
        />
      )}
      {/* couche transformée : tous les items en coordonnées board (z 10 → le dessin peut passer
          devant (z 20) ou derrière (z 0) selon `drawBack`). `data-board-pan` : ciblée par le pan
          impératif (applyGesture). */}
      <div
        data-board-pan
        className="absolute left-0 top-0 z-10 origin-top-left will-change-transform"
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
      >
        {/* Cadre de la zone de pose : aplat très léger + contour, derrière les items (zIndex 0).
            Épaisseur ÷ scale → reste ~1,5px à l'écran quel que soit le zoom. */}
        {placeFrame && contentBounds && (
          <div
            className="pointer-events-none absolute rounded-2xl"
            style={{
              left: contentBounds.x,
              top: contentBounds.y,
              width: contentBounds.w,
              height: contentBounds.h,
              zIndex: 0,
              border: `${1.5 / view.scale}px solid color-mix(in srgb, var(--color-fg) 14%, transparent)`,
              background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
            }}
          />
        )}
        {visible.map((it) => (
          <BoardItem
            key={it.id}
            item={it}
            selected={selected.has(it.id)}
            primary={it.id === selectedId && selectedIds.length === 1}
            editing={editingId === it.id}
          />
        ))}
      </div>

      {/* calque de dessin maison (SVG plein board, suit le pan/zoom) + barre du mode dessin */}
      <DrawLayer />
      {drawMode && <DrawToolbar />}

      {/* Marquee : montée/démontée par état, mais DÉPLACÉE en impératif (applyGesture) pendant le
          glissé → zéro re-render du board par pointermove. */}
      {marquee && (
        <div
          ref={marqueeDiv}
          className="pointer-events-none absolute z-40 rounded-sm border border-primary bg-primary/10"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}

      {!items.some((it) => it.kind !== "draw") && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
          <ImageOff className="size-8" />
          <p className="text-sm">{t("board.emptyTitle")}</p>
          <p className="text-xs">{t("board.emptyHint")}</p>
        </div>
      )}
    </div>
  );
});
