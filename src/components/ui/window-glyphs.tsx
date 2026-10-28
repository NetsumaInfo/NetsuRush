import { Minus, Square, X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The usual window glyphs, with one small move when their button is hovered (the button carries `group`).
 * Kept plain on purpose: the window controls must look like the system's.
 */
const MOVE = "transition-transform duration-200 ease-out motion-reduce:transition-none";

type GlyphProps = { className?: string };

export function MinimizeGlyph({ className }: GlyphProps) {
  return <Minus className={cn(MOVE, "group-hover:translate-y-0.5", className)} />;
}

export function MaximizeGlyph({ className }: GlyphProps) {
  return <Square className={cn(MOVE, "group-hover:scale-110", className)} />;
}

/** Two overlapping windows, the usual "restore down" sign: the back one shows only its top and right edges. */
export function RestoreGlyph({ className }: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={cn("size-4", className)}>
      <path d="M9 8V6a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2" className={cn(MOVE, "group-hover:translate-x-px group-hover:-translate-y-px")} />
      <rect x={5} y={9} width={10} height={10} rx={1} className={cn(MOVE, "group-hover:-translate-x-px group-hover:translate-y-px")} />
    </svg>
  );
}

export function CloseGlyph({ className }: GlyphProps) {
  return <X className={cn(MOVE, "group-hover:rotate-90", className)} />;
}
