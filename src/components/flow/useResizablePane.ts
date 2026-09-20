import { useCallback, useEffect, useRef, useState } from "react";

/// A pane the user can drag, collapse, and find at the same width next time.
///
/// Pointer capture rather than window listeners: without it the drag stops the
/// moment the cursor crosses the preview iframe, because the iframe swallows
/// the events. That is why a naive mousemove handler feels broken here
/// specifically, and it is the whole reason this is a hook rather than a
/// couple of inline handlers.
export function useResizablePane({ storageKey, initial, min, max }: {
  storageKey: string;
  initial: number;
  min: number;
  max: number;
}) {
  const clamp = useCallback(
    (value: number) => Math.min(max, Math.max(min, value)),
    [min, max],
  );

  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      return Number.isFinite(stored) && stored > 0 ? clamp(stored) : initial;
    } catch {
      // Blocked or full storage is not a reason to refuse a layout.
      return initial;
    }
  });
  const [collapsed, setCollapsed] = useState(false);
  const dragging = useRef(false);

  useEffect(() => {
    try { localStorage.setItem(storageKey, String(width)); } catch { /* best effort */ }
  }, [storageKey, width]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    dragging.current = true;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;

    const onMove = (move: PointerEvent) => {
      if (!dragging.current) return;
      setWidth(clamp(startWidth + (move.clientX - startX)));
    };
    const onUp = () => {
      dragging.current = false;
      try { handle.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }, [width, clamp]);

  return {
    width: collapsed ? 0 : width,
    collapsed,
    toggle: () => setCollapsed((value) => !value),
    /// Double-clicking the divider is the shortcut everyone tries; it puts the
    /// pane back where it started rather than requiring a careful drag.
    reset: () => setWidth(initial),
    onPointerDown,
  };
}
