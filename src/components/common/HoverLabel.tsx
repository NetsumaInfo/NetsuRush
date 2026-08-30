// Shared hover tooltip for a dense grid (emojis, lucide glyphs: 300 to 1800 cells). One
// `Tooltip.Root` per cell costs a store, a context and positioning hooks each — that is what made
// the icon tab slow to open and janky on hover. Here a single bubble serves the whole grid, anchored
// on the hovered cell, and hovering goes through native event delegation, so the grid never
// re-renders.
//
// Usage: mark each cell `data-hover-label="…"`, put a ref on the scrolling container and render
// `<HoverLabel containerRef={ref} />` next to it.
import { useEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent } from "@/components/ui/tooltip";

// Matches the app's TooltipProvider `delay`: the bubble must not pop on the first pixel crossed in
// a grid of 1800 cells.
const OPEN_DELAY_MS = 600;

export function HoverLabel({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const [hit, setHit] = useState<{ el: HTMLElement; label: string } | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const clear = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
    // Closing keeps `hit`: the popup stays mounted for its exit animation, and clearing the label
    // here would fade out an empty bubble. The next hovered cell replaces it.
    const close = () => {
      clear();
      setOpen(false);
    };
    const over = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-hover-label]") ?? null;
      if (!el) {
        close();
        return;
      }
      const label = el.dataset.hoverLabel ?? "";
      setHit((prev) => (prev?.el === el ? prev : { el, label }));
      // Already open: the bubble jumps from cell to cell without re-arming the delay (how a group
      // of tooltips behaves). Otherwise wait for the open delay.
      setOpen((wasOpen) => {
        if (wasOpen) return true;
        clear();
        timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
        return false;
      });
    };
    root.addEventListener("pointerover", over);
    root.addEventListener("pointerleave", close);
    root.addEventListener("pointerdown", close);
    root.addEventListener("scroll", close, { passive: true });
    return () => {
      clear();
      root.removeEventListener("pointerover", over);
      root.removeEventListener("pointerleave", close);
      root.removeEventListener("pointerdown", close);
      root.removeEventListener("scroll", close);
    };
  }, [containerRef]);

  return (
    <Tooltip open={open && hit != null}>
      <TooltipContent anchor={hit?.el ?? null}>{hit?.label}</TooltipContent>
    </Tooltip>
  );
}
