// Focus of the application WINDOW (not of a DOM element), and the board reaction to losing it —
// driven by the `blurBehavior` preference. The board is used beside another application: whether
// the selected item's bar should stay, vanish, or take the selection with it is a matter of taste,
// hence a setting rather than a hard-coded rule.

import { useEffect, useRef, useState } from "react";
import { useBoard } from "./useReferenceBoard";

// `document.hasFocus()` is the arbiter, never the raw `blur` event: giving the keyboard to an
// embedded player's iframe blurs the top window although the application itself never left the
// foreground — reacting to `blur` alone would make the bar disappear on a click inside the board.
// The read is deferred by a tick because the state is not settled while the event is dispatched.
function useWindowFocus(enabled: boolean): boolean {
  const [focused, setFocused] = useState(true);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) { setFocused(true); return; }
    const sync = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setFocused(document.hasFocus()), 0);
    };
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [enabled]);
  return enabled ? focused : true;
}

/** `true` when the item bar must be hidden right now (mode `hide`, window in the background). */
export function useHideOnBlur(): boolean {
  const mode = useBoard((s) => s.prefs.blurBehavior);
  const focused = useWindowFocus(mode === "hide");
  return mode === "hide" && !focused;
}

/**
 * Mode `deselect` : drops the selection when the window goes to the background. Mounted once,
 * beside the board.
 *
 * Text being typed and a crop in progress are left alone: dropping the selection ends both, and
 * clicking another application to fetch a reference is not a request to abandon them.
 */
export function useDeselectOnBlur(): void {
  const mode = useBoard((s) => s.prefs.blurBehavior);
  const focused = useWindowFocus(mode === "deselect");
  useEffect(() => {
    if (mode !== "deselect" || focused) return;
    const s = useBoard.getState();
    if (s.editingId || s.croppingId) return;
    if (s.selectedId || s.selectedIds.length) s.select(null);
  }, [mode, focused]);
}
