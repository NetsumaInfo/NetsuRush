// Pen and touch input: what the board, the draw layer and the settings need in order to tell a
// stylus from a finger from a mouse. Pure functions over PointerEvent + one window-level watch,
// nothing React.
//
// The magic numbers are the Pointer Events spec's, not ours:
//  - the pen BARREL button reports `button === 2` / `buttons` bit 2, same slot as the right mouse;
//  - the pen ERASER tip reports `button === 5` / `buttons` bit 32;
//  - hardware with NO pressure sensor reports exactly 0.5 while in contact and 0 otherwise — which
//    is why a stroke only keeps its pressure samples once one of them differs from 0.5. A tablet
//    whose driver runs on WinTab without Windows Ink lands in that case: real pen, flat 0.5.

export const BUTTONS_BARREL = 2;
export const BUTTON_ERASER = 5;
export const BUTTONS_ERASER = 32;
// Pressure reported by hardware that cannot measure it (spec value, not a guess).
export const FLAT_PRESSURE = 0.5;

export type PointerKind = "mouse" | "pen" | "touch";

export const kindOf = (e: { pointerType: string }): PointerKind =>
  e.pointerType === "pen" || e.pointerType === "touch" ? e.pointerType : "mouse";

/** Eraser end of the stylus, whether it just came down or is already drawing. */
export const usesEraser = (e: { pointerType: string; button: number; buttons: number }): boolean =>
  e.pointerType === "pen" && (e.button === BUTTON_ERASER || (e.buttons & BUTTONS_ERASER) !== 0);

/** Barrel (side) button held. A pen click WITHOUT the barrel is `buttons === 1`. */
export const usesBarrel = (e: { pointerType: string; buttons: number }): boolean =>
  e.pointerType === "pen" && (e.buttons & BUTTONS_BARREL) !== 0;

// --- Palm rejection ----------------------------------------------------------------------------
// The OS rejects the palm when the digitiser can (it fires `pointercancel` and the spec says a page
// cannot opt out of that). Plenty of hardware cannot, and there the hand lands as an ordinary touch
// contact. Ours is the net under that: while a stylus has been seen recently, touch is not input.
// A window-level watch rather than a board-level one — the pen may have been hovering over the
// toolbar, and hover alone proves it is the pen that is working.

const PEN_MEMORY_MS = 900;
let lastPenAt = 0;
let everSawPen = false;
let watching = false;
const firstPenListeners = new Set<() => void>();

function notePen(e: PointerEvent) {
  if (e.pointerType !== "pen") return;
  lastPenAt = performance.now();
  if (everSawPen) return;
  everSawPen = true;
  for (const cb of [...firstPenListeners]) cb();
  firstPenListeners.clear();
}

/**
 * Runs `cb` the first time a stylus touches the app — immediately if one already has. This is what
 * the `auto` settings hang on: a machine cannot be asked whether a pen is plugged in, only told
 * once one is used. Returns an unsubscribe.
 */
export function onPenSeen(cb: () => void): () => void {
  watchPen();
  if (everSawPen) { cb(); return () => {}; }
  firstPenListeners.add(cb);
  return () => { firstPenListeners.delete(cb); };
}

/** Idempotent; capture phase so a stopped-propagation event still counts as pen activity. */
export function watchPen(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  for (const type of ["pointerdown", "pointermove", "pointerover"] as const) {
    window.addEventListener(type, notePen, { capture: true, passive: true });
  }
}

/** True while a stylus is in play — the window in which a touch contact is probably a palm. */
export const penIsActive = (): boolean => lastPenAt > 0 && performance.now() - lastPenAt < PEN_MEMORY_MS;

/** A touch contact to drop: enabled, it is a finger, and the pen was just here. */
export const isPalm = (e: { pointerType: string }, enabled: boolean): boolean =>
  enabled && e.pointerType === "touch" && penIsActive();

// --- Device probe ------------------------------------------------------------------------------
// What the `auto` settings resolve against. Read live rather than cached: a tablet gets plugged in,
// a Bluetooth mouse gets paired, and `matchMedia` follows.

export interface DeviceProbe {
  /** A mouse-grade pointer exists (mouse, trackpad, or a tablet reported as fine). */
  fine: boolean;
  /** A coarse pointer exists (finger). */
  coarse: boolean;
  /** The PRIMARY pointer can hover — false on a touch-first machine. */
  hover: boolean;
  /** Any attached pointer can hover (a pen hovers, so a Cintiq beside a mouse says true). */
  anyHover: boolean;
  touchPoints: number;
  /** A stylus has been used at least once this session. */
  penSeen: boolean;
}

const mq = (q: string): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(q).matches;

export function probeDevices(): DeviceProbe {
  return {
    fine: mq("(any-pointer: fine)"),
    coarse: mq("(any-pointer: coarse)"),
    hover: mq("(hover: hover)"),
    anyHover: mq("(any-hover: hover)"),
    touchPoints: typeof navigator !== "undefined" ? navigator.maxTouchPoints || 0 : 0,
    penSeen: everSawPen,
  };
}

/** Touch-first machine: fingers, no mouse-grade pointer. A Cintiq on a desktop is NOT this. */
export const isTouchFirst = (d: DeviceProbe = probeDevices()): boolean => !d.hover && d.touchPoints > 0;

// --- Pressure ----------------------------------------------------------------------------------

/**
 * Pressure samples of a finished stroke, or null when the hardware never measured any: every
 * sample flat at the spec's 0.5, or a mouse. Null means "store no pressure", which keeps the
 * stroke a plain constant-width one — the same shape a mouse draws.
 */
export function usablePressures(pressures: number[]): number[] | null {
  if (pressures.length < 2) return null;
  return pressures.some((v) => Math.abs(v - FLAT_PRESSURE) > 0.01) ? pressures : null;
}

/**
 * Width multiplier of one sample. `min` is the share of the nominal width left at zero pressure —
 * 1 disables thinning entirely. Pressure is squared-ish (0.65 exponent) because raw linear
 * pressure reads far too thin in the middle of the range on every tablet we tried.
 */
export function pressureWidth(pressure: number, min: number): number {
  const p = Math.max(0, Math.min(1, pressure));
  return min + (1 - min) * Math.pow(p, 0.65);
}

/**
 * Tilt as a 0..1 lean: 0 upright, 1 flat on the surface. Feeds the width of the tilt option — a
 * leaned pen lays down a broader mark, like the side of a pencil.
 */
export function tiltLean(tiltX: number, tiltY: number): number {
  const t = Math.min(90, Math.hypot(tiltX, tiltY));
  return t / 90;
}
