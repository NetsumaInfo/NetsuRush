import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

// One resizable side panel: the grab handle, its gestures, and the persisted width. Shared by every
// view that carries the right-hand player (Découpage, Timeline Live, Collections) — the three had
// forked copies of the same drag, and only one of them ever got a fix.
//
// The gesture set is deliberately small and symmetric:
//   · drag or wheel over the handle           → resize
//   · push past the minimum by CLOSE_SLACK    → close (the width is NOT overwritten)
//   · same push, leftwards, on the closed edge → reopen at the remembered width

export interface PanelResizeOptions {
  /** localStorage key holding the width. */
  storageKey: string;
  min?: number;
  max?: number;
  defaultW?: number;
  /** Panel currently shown. */
  open: boolean;
  setOpen: (v: boolean) => void;
}

export interface PanelResize {
  panelW: number;
  setPanelW: React.Dispatch<React.SetStateAction<number>>;
  /** Attach to the panel element to get pixel-perfect drags without re-rendering its contents.
   *  Optional: with nothing attached the drag falls back to state updates, one per frame. */
  panelRef: RefObject<HTMLElement | null>;
  /** True while a drag is in flight — grids use it to skip their resize bookkeeping. */
  resizingRef: RefObject<boolean>;
  startPanelDrag: (e: ReactPointerEvent<HTMLElement>) => void;
  /** Ref callback for the open panel's handle: wires the wheel gesture (resize, then close). */
  handleRef: (el: HTMLElement | null) => void;
  /** Keyboard on the handle: arrows resize, and pushing past the minimum closes the panel. */
  onHandleKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  /** Ref callback for the thin strip left in place of the closed panel: wheel reopens it. */
  edgeRef: (el: HTMLElement | null) => void;
  /** Pointer drag on that strip: pulling left far enough reopens the panel. */
  startEdgeDrag: (e: ReactPointerEvent<HTMLElement>) => void;
}

// Overshoot past a stop, in pixels, before the panel toggles. Wide enough that merely bottoming out
// on the minimum never closes it by accident, short enough that "press a little harder" is the
// whole gesture.
const CLOSE_SLACK = 90;
// Panel pixels per wheel notch (~100 units of delta): the useful travel takes a handful of notches
// instead of a single notch crossing half the panel.
const WHEEL_SCALE = 0.45;
// Pixels to pull the closed edge leftwards before the panel comes back.
const REOPEN_DRAG = 40;
const KEY_STEP = 20;

export function usePanelResize({
  storageKey, min = 260, max = 560, defaultW = 360, open, setOpen,
}: PanelResizeOptions): PanelResize {
  const clampW = (w: number) => Math.min(max, Math.max(min, w));

  const [panelW, setPanelW] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem(storageKey) || "", 10);
      return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : defaultW;
    } catch { return defaultW; }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, String(panelW)); } catch { /* noop */ }
  }, [storageKey, panelW]);

  // Width and toggle read by the native wheel listeners, which are attached once and must not
  // capture a stale render.
  const wRef = useRef(panelW);
  wRef.current = panelW;
  const openRef = useRef(setOpen);
  openRef.current = setOpen;
  // Overshoot accumulated at a stop. Shared by both wheel gestures — only one is mounted at a time.
  const overRef = useRef(0);

  const panelRef = useRef<HTMLElement>(null);
  const resizingRef = useRef(false);
  const dragRef = useRef<{ x: number; w: number; next: number; raf: number | null } | null>(null);

  function startPanelDrag(e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, w: panelW, next: panelW, raf: null };
    resizingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const finish = (commit: boolean) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.raf != null) cancelAnimationFrame(d.raf);
      dragRef.current = null;
      resizingRef.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (commit) {
        // A single final render resynchronises measurements, the video ceiling and persistence.
        if (panelRef.current) panelRef.current.style.width = `${d.next}px`;
        setPanelW(d.next);
      }
    };
    const onMove = (ev: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const raw = d.w + (d.x - ev.clientX);
      // Forced past the minimum: the panel closes. Nothing is committed, so the remembered width is
      // the one it reopens at.
      if (raw < min - CLOSE_SLACK) { finish(false); openRef.current(false); return; }
      d.next = clampW(raw);
      if (d.raf != null) return;
      d.raf = requestAnimationFrame(() => {
        const current = dragRef.current;
        if (!current) return;
        current.raf = null;
        // Direct DOM write when the panel element is known: flex and the CSS grid follow in real
        // time without re-rendering the view and its hundreds of cards on every pixel. Views that
        // do not expose the element fall back to state, still capped at one update per frame.
        if (panelRef.current) panelRef.current.style.width = `${current.next}px`;
        else setPanelW(current.next);
      });
    };
    const onUp = () => finish(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    e.preventDefault();
  }

  // A tilt wheel reports deltaX, a plain one deltaY: whichever moved more drives the panel.
  const wheelDelta = (ev: WheelEvent) => (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY);

  // Wheel over the handle: the drag gesture, one notch at a time. Native listener with
  // `passive: false` — React registers its `wheel` handlers passively at the root, so a JSX
  // `onWheel` cannot stop whatever sits under the cursor from scrolling while the panel resizes.
  const [handleEl, setHandleEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!handleEl) return;
    const onWheel = (ev: WheelEvent) => {
      const raw = wheelDelta(ev);
      if (!raw) return;
      ev.preventDefault();
      // Down / right pushes the handle right, i.e. narrows the panel.
      const next = wRef.current - raw * WHEEL_SCALE;
      const clamped = Math.min(max, Math.max(min, next));
      if (clamped !== wRef.current) {
        overRef.current = 0;
        wRef.current = clamped;
        setPanelW(clamped);
      }
      if (next < min) {
        overRef.current += min - next;
        if (overRef.current >= CLOSE_SLACK) { overRef.current = 0; openRef.current(false); }
      } else {
        overRef.current = 0;
      }
    };
    handleEl.addEventListener("wheel", onWheel, { passive: false });
    return () => handleEl.removeEventListener("wheel", onWheel);
  }, [handleEl, min, max]);

  function onHandleKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.key === "ArrowLeft") { e.preventDefault(); setPanelW((w) => clampW(w + KEY_STEP)); }
    else if (e.key === "ArrowRight") {
      e.preventDefault();
      // Already at the narrowest → the next press closes, mirroring the drag and the wheel.
      if (panelW <= min) setOpen(false);
      else setPanelW((w) => clampW(w - KEY_STEP));
    }
  }

  // Closed panel: the strip left at the edge takes the same two gestures in reverse.
  const [edgeEl, setEdgeEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!edgeEl) return;
    const onWheel = (ev: WheelEvent) => {
      const raw = wheelDelta(ev);
      if (!raw) return;
      ev.preventDefault();
      // Up / left pulls the edge back leftwards, i.e. reopens the panel.
      if (raw < 0) {
        overRef.current += -raw * WHEEL_SCALE;
        if (overRef.current >= CLOSE_SLACK) { overRef.current = 0; openRef.current(true); }
      } else {
        overRef.current = 0;
      }
    };
    edgeEl.addEventListener("wheel", onWheel, { passive: false });
    return () => edgeEl.removeEventListener("wheel", onWheel);
  }, [edgeEl]);

  function startEdgeDrag(e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    document.body.style.cursor = "col-resize";
    const stop = () => {
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    const onMove = (ev: globalThis.PointerEvent) => {
      // Short pull to the left = reopen at the remembered width; the handle then takes over.
      if (x0 - ev.clientX >= REOPEN_DRAG) { stop(); openRef.current(true); }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    e.preventDefault();
  }

  // Never leave a stale overshoot behind: reopening after a close must start from zero.
  useEffect(() => { overRef.current = 0; }, [open]);

  return {
    panelW, setPanelW, panelRef, resizingRef,
    startPanelDrag, handleRef: setHandleEl, onHandleKeyDown,
    edgeRef: setEdgeEl, startEdgeDrag,
  };
}
