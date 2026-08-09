import { useEffect, useRef, type ReactNode } from "react";

interface DragState {
  startX: number;
  startWidth: number;
  ratio: number | null;
}

/** Cadre commun aux médias intégrés : largeur persistée, poignée discrète et limite au document. */
export function ResizableMediaFrame({
  children,
  width = 0,
  height = 0,
  ratio,
  onResize,
  className = "",
}: {
  children: ReactNode;
  width?: number;
  height?: number;
  ratio?: number;
  onResize?: (width: number, height?: number) => void;
  className?: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  const startResize = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = frame.current;
    if (!el || !onResize) return;
    const rect = el.getBoundingClientRect();
    const parentWidth = el.parentElement?.getBoundingClientRect().width || rect.width;
    drag.current = {
      startX: e.clientX,
      startWidth: rect.width,
      ratio: ratio || (height > 0 ? rect.width / height : null),
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      const maxWidth = Math.max(1, parentWidth);
      const minWidth = Math.min(240, maxWidth);
      const nextWidth = Math.round(Math.min(maxWidth, Math.max(minWidth, state.startWidth + ev.clientX - state.startX)));
      const nextHeight = state.ratio ? Math.round(nextWidth / state.ratio) : undefined;
      el.style.width = `${nextWidth}px`;
      if (nextHeight) el.style.height = `${nextHeight}px`;
    };
    const up = () => {
      const state = drag.current;
      if (state) {
        const rectNow = el.getBoundingClientRect();
        onResize(Math.round(rectNow.width), state.ratio ? Math.round(rectNow.height) : undefined);
      }
      drag.current = null;
      cleanup.current?.();
      cleanup.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", up, { once: true });
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  };

  const style: React.CSSProperties = {
    width: width > 0 ? `min(100%, ${width}px)` : "100%",
    ...(height > 0 ? { height } : {}),
    ...(ratio && height <= 0 ? { aspectRatio: String(ratio) } : {}),
  };

  return (
    <div ref={frame} contentEditable={false} className={`group group/media relative max-w-full ${className}`} style={style}>
      {children}
      {onResize && (
        <button
          type="button"
          aria-label="Redimensionner le média"
          onPointerDown={startResize}
          className="absolute bottom-1 right-1 z-20 h-3.5 w-3.5 cursor-nwse-resize touch-none text-muted-foreground opacity-0 transition-opacity group-hover/media:opacity-100 focus-visible:opacity-100"
       >
         <svg aria-hidden="true" viewBox="0 0 12 12" className="h-full w-full">
            <line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
            <line x1="11" y1="7" x2="7" y2="11" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
            <line x1="11" y1="11" x2="11" y2="11" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
         </svg>
       </button>
      )}
    </div>
  );
}
