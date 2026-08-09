import { useLayoutEffect, useState } from "react";

export interface ViewportPosition {
  left: number;
  top: number;
  maxHeight: number;
  placement: "top" | "bottom";
}

export function useViewportAnchor(
  open: boolean,
  getAnchorRect: () => DOMRect | null,
  size: { width: number; height: number; gap?: number },
): ViewportPosition {
  const [position, setPosition] = useState<ViewportPosition>({ left: 8, top: 8, maxHeight: size.height, placement: "bottom" });

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const measure = () => {
      const rect = getAnchorRect();
      if (!rect) return;
      const margin = 8;
      const gap = size.gap ?? 6;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const below = viewportHeight - rect.bottom - margin - gap;
      const above = rect.top - margin - gap;
      const placement = below >= Math.min(size.height, above) ? "bottom" : "top";
      const available = Math.max(96, placement === "bottom" ? below : above);
      const height = Math.min(size.height, available);
      const top = placement === "bottom" ? rect.bottom + gap : rect.top - gap - height;
      setPosition({
        left: Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - size.width - margin)),
        top: Math.max(margin, Math.min(top, viewportHeight - height - margin)),
        maxHeight: height,
        placement,
      });
    };
    const update = () => {
      measure();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [getAnchorRect, open, size.gap, size.height, size.width]);

  return position;
}
