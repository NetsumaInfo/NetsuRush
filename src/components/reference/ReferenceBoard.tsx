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
import { nr } from "@/lib/bridge";
import i18n from "@/i18n";
import { logError } from "@/lib/appLog";
import { useBoard } from "./useReferenceBoard";
import { useBoardIngest, pastedSourceUrl } from "./useBoardIngest";
import { watchMouseThroughExit } from "./boardMouseThrough";
import { clampMediaOpacity } from "./boardPrefs";
import { useBoardCulling } from "./useBoardCulling";
import { BoardItem } from "./BoardItem";
import { DrawLayer } from "./DrawLayer";
import { DrawToolbar } from "./DrawToolbar";
import {
  type BoardItem as Item,
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
import { isPalm, isTouchFirst, kindOf, usesBarrel, watchPen, type PointerKind } from "./tabletInput";
import { boundsOf, rotatedBBox } from "./boardArrange";
import { useLive } from "./boardLive";
import { itemToPngBlob } from "./boardRender";
import { primeBoardThumbs } from "./boardImageLod";
import { posterTime } from "./boardVideoLod";

const clampScale = (s: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));

// Guides de l'aimant : traits d'un pixel ÉCRAN (épaisseur indépendante du zoom) montrant l'axe sur
// lequel l'item vient de s'accrocher. Abonné au canal vivant : hors geste, ce composant ne rend rien
// et ne re-rend jamais — un board qui n'aimante pas ne paie rien.
function SnapGuides({ view }: { view: BoardView }) {
  const { guides } = useLive();
  if (!guides.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {guides.map((g, i) => {
        const a = view.tx + g.at * view.scale;
        const b = view.ty + g.at * view.scale;
        const from = g.axis === "x" ? view.ty + g.from * view.scale : view.tx + g.from * view.scale;
        const to = g.axis === "x" ? view.ty + g.to * view.scale : view.tx + g.to * view.scale;
        const pad = 24; // dépassement pour que le guide reste lisible quand les bords coïncident
        return (
          <div
            key={`${g.axis}-${i}`}
            className="absolute bg-primary/80"
            style={
              g.axis === "x"
                ? { left: a, top: from - pad, width: 1, height: to - from + pad * 2 }
                : { top: b, left: from - pad, height: 1, width: to - from + pad * 2 }
            }
          />
        );
      })}
    </div>
  );
}

export interface BoardHandle {
  addFiles: (files: FileList | File[], at?: { x: number; y: number }, extra?: Partial<Item>) => void;
  addVideoUrl: (url: string, opts?: { allowGenericEmbed?: boolean }) => boolean;
  addUrl: (url: string, opts?: { allowGenericEmbed?: boolean }) => Promise<boolean>;
  addPath: (path: string, title?: string) => void;
  addCut: (path: string, inSec: number, outSec: number, title?: string) => void;
  addCuts: (path: string, cuts: { in: number; out: number; title?: string }[]) => void;
  addSequence: (paths: string[]) => void;
  // Import GROUPÉ d'un dossier : un cadre par dossier, contenu rangé, une seule entrée d'annulation.
  addFolder: (dirPath: string) => void;
  addPaste: (data: DataTransfer) => Promise<boolean>;
  pasteClipboard: () => void;
  // Colle le presse-papiers INTERNE (items copiés dans le board) au centre du viewport.
  pasteItems: () => number;
  addText: () => void;
  addFrame: () => void;
  fit: () => void;
  fitSelection: () => void;
  // Copier / couper la sélection : presse-papiers interne (tous les items) + presse-papiers système
  // (PNG du premier média, ou texte d'une note) pour pouvoir coller dans un autre logiciel.
  copySelection: (cut?: boolean) => Promise<void>;
  reset: () => void;
  zoomBy: (factor: number) => void;
}

export interface ReferenceBoardProps {
  // Ouvre un projet `.netsu` lâché sur la board. Absent = persistance indisponible : le fichier est
  // alors refusé avec un message, jamais avalé en silence comme un média.
  onOpenProjectFile?: (filePath: string) => void;
}

export const ReferenceBoard = forwardRef<BoardHandle, ReferenceBoardProps>(function ReferenceBoard({ onOpenProjectFile }, ref) {
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
  const seeThroughShell = useBoard((s) => s.prefs.seeThroughShell);
  const seeThroughPlaceFrame = useBoard((s) => s.prefs.seeThroughPlaceFrame);
  const contentOpacity = useBoard((s) => s.prefs.contentOpacity);
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
  const gesture = useRef<"pan" | "marquee" | "pinch" | null>(null);
  const space = useRef(false);
  // Contacts en cours (doigts/stylet), CLÉS par pointerId. Deux contacts simultanés = pincement :
  // c'est le seul zoom d'une machine sans molette, et le seul pan d'une machine sans clavier.
  const contacts = useRef(new Map<number, { x: number; y: number }>());
  // Repère figé au 2e contact : écart et milieu des deux doigts, plus la vue de départ. Tout se
  // calcule PAR RAPPORT à lui — un pincement mesuré d'une frame à l'autre dérive.
  const pinch = useRef<{ d: number; cx: number; cy: number; view: BoardView } | null>(null);
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeDiv = useRef<HTMLDivElement>(null);
  const dotsRef = useRef<HTMLDivElement>(null);

  // PERF pan — pendant le geste, la vue vit ICI (ref) et s'applique en IMPÉRATIF coalescé en rAF
  // (transform des couches [data-board-pan] + translation modulo de la grille de points) ; le store
  // n'est commité qu'au pointerup. Sinon chaque pointermove (souris 125–1000 Hz) déclenchait un
  // setView → re-render React de tout le board + repaint plein écran du fond en points = saccades.
  const liveView = useRef<BoardView | null>(null);
  // Vue d'avant un zoom au double-clic : re-double-cliquer le même item y revient exactement.
  const zoomBack = useRef<{ id: string; view: BoardView } | null>(null);
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

  // Le culling suit la vue COMMITÉE (fit, focus, fin de pan/zoom).
  useLayoutEffect(() => { syncViewport(view, size.current.w, size.current.h); }, [view, syncViewport]);

  // Vue explicite (fit, reset, focus) : annule la rafale de zoom en attente — sinon son commit
  // différé (cf. holdMediaForZoom) écraserait la vue qu'on vient de poser.
  const commitView = useCallback((v: BoardView) => {
    liveView.current = null;
    setView(v);
  }, [setView]);

  // Amorce les vignettes du LOD en UN RPC à l'ouverture d'une scène : sans ça, chaque image monte en
  // source pleine (gros bitmap décodé pour rien) avant d'apprendre, un RPC par item, que sa vignette
  // existait déjà sur disque. Les vidéos y gagnent leur frame d'affiche (poster + mode timbre-poste).
  useEffect(() => {
    primeBoardThumbs(
      useBoard.getState().items.flatMap((it) => {
        if (it.kind === "image") return [{ ref: it.ref }];
        if (it.kind === "video") return [{ ref: it.ref, time: posterTime(it) }];
        return [];
      }),
    );
  }, [sceneId]);

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

  // Pont de résolution des chemins d'objets `File` : attaché au montage, jamais au premier dépôt.
  // Son attache (imports dynamiques + `invoke`) s'ajoutait sinon au temps d'attente entre le lâcher
  // du fichier et son apparition — la seule fraction de l'import que l'utilisateur regarde.
  useEffect(() => { nr.warmFilePaths(); }, []);

  // Guet du stylet : c'est ce qui permet au rejet de paume de savoir qu'un stylet travaille même
  // quand il survole la barre d'outils plutôt que la planche.
  useEffect(() => { watchPen(); }, []);

  // A translucent background makes the page and the shells step aside (see `nr-see-through`);
  // without that the opacity would dissolve into the application background instead of revealing
  // the desktop. The second class says whether the interface follows, or keeps an opaque surface.
  useEffect(() => {
    const root = document.documentElement;
    const on = background.opacity < 1;
    root.classList.toggle("nr-see-through", on);
    root.classList.toggle("nr-see-through-shell", on && seeThroughShell);
    return () => {
      root.classList.remove("nr-see-through");
      root.classList.remove("nr-see-through-shell");
    };
  }, [background.opacity, seeThroughShell]);

  // Mouse-transparent: regaining focus gives the mouse back, and so does unmounting.
  useEffect(() => watchMouseThroughExit(), []);

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
    return screenToBoard(liveView.current ?? useBoard.getState().view, cx, cy);
  }, []);

  const ingest = useBoardIngest(centerPoint);

  // Un zoom est une rafale (molette/trackpad ou clics rapprochés). On ne fait qu'un gel au début,
  // puis on reprend après le dernier événement. Le compteur du store protège les chevauchements avec
  // un pan ou le déplacement d'un item. C'est AUSSI le point de commit du zoom impératif : la vue
  // vivante ne rejoint le store qu'ici — l'UNIQUE re-render React de toute la rafale (le LOD des
  // images et les abonnés de `view` ne s'évaluent donc qu'une fois, sur la vue finale).
  const holdMediaForZoom = useCallback(() => {
    if (zoomResumeTimer.current == null) useBoard.getState().beginNavigation();
    else clearTimeout(zoomResumeTimer.current);
    zoomResumeTimer.current = setTimeout(() => {
      zoomResumeTimer.current = null;
      // Un pan ou un pincement en cours garde la main sur liveView : lui committera au pointerup.
      if (gesture.current !== "pan" && gesture.current !== "pinch" && liveView.current) {
        const v = liveView.current;
        liveView.current = null;
        setView(v);
      }
      useBoard.getState().endNavigation();
    }, 140);
  }, [setView]);

  useEffect(() => () => {
    if (zoomResumeTimer.current != null) {
      clearTimeout(zoomResumeTimer.current);
      zoomResumeTimer.current = null;
      // Démontage en pleine rafale : la vue vivante rejoint quand même le store, sinon le dernier
      // zoom serait perdu au retour sur le board.
      if (gesture.current !== "pan" && gesture.current !== "pinch" && liveView.current) setView(liveView.current);
      liveView.current = null;
      useBoard.getState().endNavigation();
    }
    if (gesture.current === "pan" || gesture.current === "pinch") useBoard.getState().endNavigation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PERF zoom — même chemin IMPÉRATIF que le pan : la vue vit dans liveView et s'applique en rAF
  // (transform des couches + culling), le store n'est commité qu'en fin de rafale (holdMediaForZoom).
  // Un setView par cran re-rendait tout le board à chaque frame de molette : ~mille sélecteurs
  // zustand évalués + réconciliation de tous les items visibles, en pleine re-rasterisation GPU.
  const zoomAt = useCallback(
    (px: number, py: number, factor: number) => {
      holdMediaForZoom();
      zoomBack.current = null; // vue navigée à la main → le retour du double-clic n'a plus de sens
      const v = liveView.current ?? useBoard.getState().view;
      const ns = clampScale(v.scale * factor);
      const bx = (px - v.tx) / v.scale;
      const by = (py - v.ty) / v.scale;
      liveView.current = { tx: px - bx * ns, ty: py - by * ns, scale: ns };
      scheduleGesture();
    },
    [holdMediaForZoom, scheduleGesture],
  );

  // Molette coalescée : les trackpads tirent bien plus d'événements que de frames → on accumule le
  // delta et on applique UN zoom par frame (setView re-rend le board, inutile de le faire 3× par vsync).
  const wheelAcc = useRef<{ dy: number; x: number; y: number; left: number; top: number } | null>(null);
  // Alt + wheel = OPACITY, never zoom. Over a medium: its own. Over the void: the whole board's.
  // It is the gesture of reference tools, and it costs no key.
  const wheelOpacity = useCallback((e: React.WheelEvent) => {
    const step = e.deltaY > 0 ? -0.05 : 0.05;
    const st = useBoard.getState();
    const hit = (e.target as HTMLElement | null)?.closest?.("[data-board-item]") as HTMLElement | null;
    const id = hit?.dataset.boardItem;
    const item = id ? st.items.find((it) => it.id === id) : undefined;
    if (item) {
      const next = clampMediaOpacity((item.opacity ?? 1) + step);
      st.patchItem(item.id, { opacity: next < 1 ? next : undefined }, false);
      st.setNotice({ kind: "ok", text: i18n.t("reference:notice.itemOpacity", { percent: Math.round(next * 100) }) });
      return;
    }
    const next = clampMediaOpacity(st.prefs.contentOpacity + step);
    st.setPrefs({ contentOpacity: next });
    st.setNotice({ kind: "ok", text: i18n.t("reference:notice.contentOpacity", { percent: Math.round(next * 100) }) });
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      // Alt held: the wheel sets opacity. Zoom keeps the bare wheel.
      if (e.altKey) { wheelOpacity(e); return; }
      // L'origine du conteneur est mesurée UNE fois par frame (à l'ouverture de l'accumulateur) :
      // un getBoundingClientRect par événement forçait un recalcul de layout à la cadence du
      // trackpad, entrelacé avec les écritures de transform du geste.
      const a = wheelAcc.current;
      if (a) {
        a.dy += e.deltaY; a.x = e.clientX - a.left; a.y = e.clientY - a.top;
        return;
      }
      const r = rect();
      if (!r) return;
      wheelAcc.current = { dy: e.deltaY, x: e.clientX - r.left, y: e.clientY - r.top, left: r.left, top: r.top };
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
    [zoomAt, wheelOpacity],
  );

  // Le glissé sur le fond navigue-t-il au lieu de sélectionner ? `auto` tranche sur la machine :
  // une tablette-PC (tactile, aucun pointeur qui survole) n'a ni molette ni barre d'espace, donc
  // pas d'autre geste pour se déplacer ; une tablette à écran posée à côté d'une souris garde le
  // lasso, qui reste ce qu'on attend d'un glissé sur le vide.
  const dragNavigates = useCallback((kind: PointerKind) => {
    if (kind === "mouse") return false;
    const mode = useBoard.getState().prefs.penDragPans;
    if (mode !== "auto") return mode === "on";
    return kind === "touch" || isTouchFirst();
  }, []);

  // Démarre le pan à partir de la vue VIVANTE : un zoom peut être en rafale (pas encore commité),
  // et repartir de la vue du store ferait sauter le board à l'état d'avant la rafale.
  const beginPan = useCallback((cx: number, cy: number) => {
    const v = liveView.current ?? useBoard.getState().view;
    gesture.current = "pan";
    pan.current = { x: cx, y: cy, tx: v.tx, ty: v.ty };
    useBoard.getState().beginNavigation();
    // Curseur en impératif : aucun re-render React pendant le pan.
    if (containerRef.current) containerRef.current.style.cursor = "grabbing";
  }, []);

  // Abandonne le geste à un doigt en cours au profit du pincement, SANS rien commiter : le lasso
  // n'a pas à sélectionner ce qu'il a balayé le temps que le deuxième doigt se pose.
  const dropMarquee = useCallback(() => {
    marqueeRef.current = null;
    setMarquee(null);
  }, []);

  // Suivi des contacts et rejet de paume en phase de CAPTURE, avant tout le monde. Un doigt posé
  // sur un média ne remonte jamais jusqu'ici — l'item arrête la propagation pour prendre son geste —
  // et c'est pourtant le cas le plus courant d'un DEUXIÈME doigt sur une planche bien remplie.
  const onPointerDownCapture = useCallback((e: React.PointerEvent) => {
    // Rejet de paume : la main posée sur une dalle qui ne sait pas la distinguer arrive comme un
    // contact tactile ordinaire. Tant que le stylet travaille, un doigt n'est pas une intention —
    // et l'arrêter ICI est ce qui empêche aussi un média de partir avec la paume.
    if (isPalm(e, useBoard.getState().prefs.palmRejection)) { e.stopPropagation(); return; }
    if (kindOf(e) === "mouse") return;
    contacts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Pincement : deux contacts, et la planche tient encore le geste. Un média déjà en cours de
    // déplacement le garde : le lui voler en pleine main serait pire que de ne rien faire.
    if (contacts.current.size !== 2 || !useBoard.getState().prefs.touchGestures) return;
    if (gesture.current !== null && gesture.current !== "marquee" && gesture.current !== "pan") return;
    // Geste sans nom côté planche, mais navigation déjà tenue : c'est un ITEM qui est en cours de
    // déplacement sous le premier doigt (usePointerTransform tient le sien). Il le garde.
    if (gesture.current === null && useBoard.getState().navigating) return;
    const [a, b] = [...contacts.current.values()];
    const r = rect();
    dropMarquee();
    if (gesture.current !== "pan") useBoard.getState().beginNavigation();
    gesture.current = "pinch";
    pan.current = null;
    pinch.current = {
      d: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      cx: (a.x + b.x) / 2 - (r?.left ?? 0),
      cy: (a.y + b.y) / 2 - (r?.top ?? 0),
      view: liveView.current ?? useBoard.getState().view,
    };
    e.stopPropagation(); // le deuxième doigt ne commence pas un geste d'item
  }, [dropMarquee]);

  const onPointerMoveCapture = useCallback((e: React.PointerEvent) => {
    if (contacts.current.has(e.pointerId)) contacts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }, []);

  // Fond : glissé gauche = marquee de sélection ; clic milieu ou Espace+gauche = pan.
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (gesture.current === "pinch") return;
      if (e.target !== e.currentTarget && e.button === 0) return; // clic sur un item → géré par l'item
      // Bouton latéral du stylet réglé sur « naviguer » : il arrive comme un clic droit (bouton 2).
      const barrelPans = usesBarrel(e) && useBoard.getState().prefs.penBarrel === "pan";
      if (!barrelPans && e.button !== 0 && e.button !== 1) return;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture best-effort */ }
      if (e.button === 1 || barrelPans || space.current || dragNavigates(kindOf(e))) {
        beginPan(e.clientX, e.clientY);
      } else {
        gesture.current = "marquee";
        select(null);
        const r = rect();
        const x = e.clientX - (r?.left ?? 0), y = e.clientY - (r?.top ?? 0);
        marqueeRef.current = { x0: x, y0: y, x1: x, y1: y };
        setMarquee(marqueeRef.current); // monte la div ; les moves la déplacent en impératif
      }
    },
    [select, beginPan, dragNavigates],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      // Pincement : l'écart des doigts donne l'échelle, leur milieu donne la translation. Un seul
      // calcul pour les deux — le point du board sous le milieu de départ reste sous le milieu
      // courant, ce qui EST le geste attendu (deux doigts déplacent autant qu'ils zooment).
      if (gesture.current === "pinch") {
        const p = pinch.current;
        if (!p || contacts.current.size < 2) return;
        const [a, b] = [...contacts.current.values()];
        const r = rect();
        const d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
        const cx = (a.x + b.x) / 2 - (r?.left ?? 0);
        const cy = (a.y + b.y) / 2 - (r?.top ?? 0);
        const ns = clampScale(p.view.scale * (d / p.d));
        const bx = (p.cx - p.view.tx) / p.view.scale;
        const by = (p.cy - p.view.ty) / p.view.scale;
        liveView.current = { tx: cx - bx * ns, ty: cy - by * ns, scale: ns };
        zoomBack.current = null; // vue navigée à la main → le retour du double-clic n'a plus de sens
        scheduleGesture();
        return;
      }
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
  // Fin d'un contact, en capture pour la même raison que son début. Un doigt levé termine le
  // pincement : le second qui reste ne redevient PAS un lasso, sinon relâcher un pouce
  // sélectionnerait la moitié de la planche.
  const onPointerUpCapture = useCallback((e: React.PointerEvent) => {
    if (!contacts.current.delete(e.pointerId) || gesture.current !== "pinch") return;
    if (rafId.current != null) { cancelAnimationFrame(rafId.current); rafId.current = null; }
    if (liveView.current) { setView(liveView.current); liveView.current = null; }
    gesture.current = null;
    pinch.current = null;
    useBoard.getState().endNavigation();
  }, [setView]);

  const finishPointerGesture = useCallback((e: React.PointerEvent) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (gesture.current === "pinch") return;
    const wasPanning = gesture.current === "pan";
    if (rafId.current != null) { cancelAnimationFrame(rafId.current); rafId.current = null; }
    if (gesture.current === "pan" && liveView.current) {
      zoomBack.current = null; // vue navigée à la main → plus de retour au double-clic
      setView(liveView.current); // commit unique : les abonnés React se resynchronisent ici
    }
    if (gesture.current === "marquee" && marqueeRef.current) {
      const m = marqueeRef.current;
      // Zoom en rafale pendant le lasso : la conversion écran→board doit lire la vue VIVANTE.
      const v = liveView.current ?? useBoard.getState().view;
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

  // Cadre un ensemble d'items dans le viewport. Sans liste → tout le board ; la mesure porte sur
  // l'emprise TOURNÉE, sinon une image pivotée déborderait du cadrage.
  const fitItems = useCallback((subset?: string[]) => {
    const all = useBoard.getState().items.filter((it) => it.kind !== "draw");
    const its = subset?.length ? all.filter((it) => subset.includes(it.id)) : all;
    const r = rect();
    if (!its.length || !r) return;
    const b = boundsOf(its);
    if (!(b.w > 0) || !(b.h > 0)) return;
    const pad = 60;
    const s = clampScale(Math.min((r.width - pad) / b.w, (r.height - pad) / b.h));
    commitView({
      tx: (r.width - b.w * s) / 2 - b.x * s,
      ty: (r.height - b.h * s) / 2 - b.y * s,
      scale: s,
    });
  }, [commitView]);
  const fit = useCallback(() => fitItems(), [fitItems]);
  // Cadrer la SÉLECTION (repli sur tout le board si rien n'est sélectionné).
  const fitSelection = useCallback(() => {
    const sel = useBoard.getState().selectedIds;
    fitItems(sel.length ? sel : undefined);
  }, [fitItems]);

  // Recadrer tous les items à l'ouverture d'une scène (Paramètres). Un tick après le montage des items.
  useEffect(() => {
    if (!fitOnOpen || !sceneId) return;
    const t = setTimeout(fit, 60);
    return () => clearTimeout(t);
  }, [sceneId, fitOnOpen, fit]);

  // Double-clic sur un média → centre l'item dans le viewport et zoome pour le cadrer.
  // RE-double-clic sur le MÊME item → retour exact à la vue d'avant (transform mémorisée). La
  // mémoire est invalidée dès qu'on pan/zoome à la main : le retour ne ramène jamais à une vue
  // périmée. La demande arrive via le store (focusReq) ; on la consomme puis on la remet à null.
  useEffect(() => {
    if (!focusReq) return;
    const it = useBoard.getState().items.find((i) => i.id === focusReq);
    const r = rect();
    useBoard.getState().requestFocus(null);
    if (!it || !r) return;
    const back = zoomBack.current;
    if (back && back.id === focusReq) {
      zoomBack.current = null;
      commitView(back.view);
      return;
    }
    const b = rotatedBBox(it);
    const pad = 80;
    const s = clampScale(Math.min((r.width - pad) / b.w, (r.height - pad) / b.h));
    zoomBack.current = { id: focusReq, view: useBoard.getState().view };
    commitView({
      tx: r.width / 2 - b.cx * s,
      ty: r.height / 2 - b.cy * s,
      scale: s,
    });
  }, [focusReq, commitView]);

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
      addFolder: (dirPath: string) => void ingest.addFolder(dirPath),
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
      pasteItems: () => {
        const c = centerPoint();
        return useBoard.getState().pasteClipboard(c.x, c.y);
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
      // Cadre. Sur une SÉLECTION, il l'encadre : le cadre épouse les limites des éléments choisis et
      // passe SOUS eux — sinon il les recouvre et capte leurs clics. Un cadre porte son contenu quand
      // on le déplace, donc encadrer une sélection revient à la grouper. Sans sélection, cadre vide
      // au centre du viewport.
      addFrame: () => {
        const st = useBoard.getState();
        const p = st.prefs;
        const picked = st.items.filter(
          (it) => st.selectedIds.includes(it.id) && it.kind !== "draw" && it.kind !== "frame",
        );
        if (picked.length) {
          const PAD = 28;
          const TOP = 52; // place pour l'étiquette du cadre, au-dessus du contenu
          const b = boundsOf(picked);
          const frame = makeFrameItem(b.x - PAD, b.y - TOP, { color: p.defaultFrameColor, fillMode: p.defaultFrameFill });
          frame.w = b.w + PAD * 2;
          frame.h = b.h + TOP + PAD;
          frame.z = Math.min(...picked.map((it) => it.z)) - 1;
          addItem(frame);
          return;
        }
        const c = centerPoint();
        addItem(makeFrameItem(c.x - 320, c.y - 210, { color: p.defaultFrameColor, fillMode: p.defaultFrameFill }));
      },
      fit,
      fitSelection,
      copySelection: async (cut = false) => {
        const st = useBoard.getState();
        const picked = st.items.filter((it) => st.selectedIds.includes(it.id) && it.kind !== "draw");
        if (!picked.length) return;
        const n = cut ? st.cutSelection() : st.copySelection();
        // Hors de l'app, un seul élément voyage : le premier média en PNG (rognage, miroirs et gris
        // cuits dedans), sinon le texte de la note. Le presse-papiers interne, lui, garde tout.
        try {
          const media = picked.find((it) => it.kind === "image" || it.kind === "video" || it.kind === "sequence");
          if (media) {
            const blob = await itemToPngBlob(media);
            if (blob) await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          } else if (picked[0].kind === "text" && picked[0].text) {
            await navigator.clipboard.writeText(picked[0].text);
          }
        } catch {
          // WebView2 peut refuser l'écriture hors geste utilisateur : le collage interne marche quand même.
        }
        st.setNotice({ kind: "ok", text: t(cut ? "board.cutDone" : "board.copiedDone", { count: n }) });
      },
      reset: () => commitView({ tx: 0, ty: 0, scale: 1 } satisfies BoardView),
      zoomBy: (factor: number) => {
        const r = rect();
        if (r) zoomAt(r.width / 2, r.height / 2, factor);
      },
    }),
    [ingest.addFiles, ingest.addVideoUrl, ingest.addUrl, ingest.addPath, ingest.addCut, ingest.addCuts, ingest.addSequence, ingest.addPaste, addItem, centerPoint, fit, fitSelection, commitView, zoomAt, t],
  );

  // Le chemin disque n'est pas dans l'objet `File` : il se résout par le pont WebView2. Sans chemin
  // (pont indisponible) ou sans action d'ouverture, on le DIT — un projet lâché ne retombe jamais en
  // silence, exactement comme sur l'accueil du board.
  const openDroppedProject = useCallback(
    async (file: File) => {
      const [filePath] = await nr.pathsForFiles([file]);
      if (filePath && onOpenProjectFile) { onOpenProjectFile(filePath); return; }
      logError("board:canvas", `dépôt .netsu sans ouverture — ${file.name} (chemin: ${filePath || "non résolu"})`);
      useBoard.getState().setNotice({ kind: "error", text: t("notice.dropProjectFailed", { name: file.name }) });
    },
    [onOpenProjectFile, t],
  );

  return (
    <div
      ref={containerRef}
      onWheel={onWheel}
      onPointerDownCapture={onPointerDownCapture}
      onPointerMoveCapture={onPointerMoveCapture}
      onPointerUpCapture={onPointerUpCapture}
      onPointerCancelCapture={onPointerUpCapture}
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
        // Un `.netsu` lâché est un PROJET, pas un média : il s'ouvre. Sans ce test il partait en
        // ingestion, où `kindFromPath` ne le reconnaît pas — le fichier disparaissait sans un mot.
        const dropped = Array.from(e.dataTransfer.files);
        const projectFile = dropped.find((f) => f.name.toLowerCase().endsWith(".netsu"));
        if (projectFile) { void openDroppedProject(projectFile); return; }
        // Un DOSSIER lâché s'importe en groupe (un cadre par dossier). On garde l'entrée ET l'objet
        // `File` que le drop place à côté : c'est LUI qui porte le chemin disque du dossier, donc la
        // voie rapide (parcours par le core, zéro copie). Tout doit être lu AVANT le moindre `await`
        // — le DataTransfer est vidé dès que le gestionnaire rend la main.
        const dirs = Array.from(e.dataTransfer.items ?? [])
          .map((it) => ({ entry: it.webkitGetAsEntry?.(), file: it.getAsFile?.() ?? null }))
          .filter((d): d is { entry: FileSystemDirectoryEntry; file: File | null } => !!d.entry && d.entry.isDirectory);
        // Un glisser depuis un navigateur porte le lien du média À CÔTÉ de ses octets : lu ici, avec
        // le reste du DataTransfer, sinon il a disparu au premier `await`.
        const dropSource = pastedSourceUrl(e.dataTransfer);
        const dropExtra = dropSource ? { sourceUrl: dropSource } : undefined;
        const r = rect();
        const dropAt = screenToBoard(useBoard.getState().view, e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0));
        if (dirs.length) {
          // Un dossier n'a pas de contenu exploitable dans `files` : on ne garde que les vrais fichiers.
          const files = dropped.filter((f) => f.type || f.size);
          void (async () => {
            for (const dir of dirs) await ingest.addDroppedEntry(dir.entry, dir.file, dropAt);
            if (files.length) ingest.addFiles(files, dropAt, dropExtra);
          })();
          return;
        }
        if (dropped.length) ingest.addFiles(dropped, dropAt, dropExtra);
        else void ingest.addPaste(e.dataTransfer);
      }}
      className={cn(
        "relative h-full w-full cursor-default touch-none overflow-hidden outline-none",
        over && "ring-2 ring-inset ring-primary",
      )}
    >
      {/* The background is a LAYER: its opacity reaches the fill and the dots, never the media.
          Below 1, what shows through is the window itself (see `nr-see-through`). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
        style={{ backgroundColor: background.color, opacity: background.opacity }}
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
      </div>
      {/* couche transformée : tous les items en coordonnées board (z 10 → le dessin peut passer
          devant (z 20) ou derrière (z 0) selon `drawBack`). `data-board-pan` : ciblée par le pan
          impératif (applyGesture). */}
      <div
        data-board-pan
        className="absolute left-0 top-0 z-10 origin-top-left will-change-transform"
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`, opacity: contentOpacity }}
      >
        {/* Cadre de la zone de pose : aplat très léger + contour, SOUS la couche des items (zIndex 0
            contre 1) — son aplat ne teinte donc jamais un média, quel que soit son plan.
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
              // Limits landmark: it follows the background opacity, unless set otherwise.
              opacity: seeThroughPlaceFrame ? background.opacity : 1,
            }}
          />
        )}
        {/* Couche des items : positionnée + zIndex 1 → CONTEXTE D'EMPILEMENT propre. Le z d'un item
            ne se compare qu'à celui des autres items ; « arrière-plan » (z négatif) le range derrière
            ses voisins sans jamais le faire passer sous le cadre de pose. */}
        <div className="absolute left-0 top-0" style={{ zIndex: 1 }}>
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
      </div>

      {/* Guides de l'aimant : lignes fines tracées pendant un geste, dans le repère board. */}
      <SnapGuides view={view} />

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
