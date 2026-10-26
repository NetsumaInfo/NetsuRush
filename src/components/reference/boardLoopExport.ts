// Export of a board clip as a looping animated image (animated WebP or GIF): what can be exported,
// over which range, and the choices the dialog offers. The encoding itself is core/loopExport.js.

import type { LoopFormat } from "@/lib/bridge";
import { isCollabRef, type BoardItem } from "./referenceShared";

// Same ceiling as the core, which refuses anything longer.
export const MAX_LOOP_SEC = 60;

export const LOOP_FORMATS: LoopFormat[] = ["webp", "gif"];
// 0 = the source's own width / cadence.
export const LOOP_WIDTHS = [0, 1280, 960, 720, 480, 360];
export const LOOP_FPS = [0, 30, 24, 15, 12];
export const LOOP_QUALITY_DEFAULT = 80;

/** A video the core can read as a file: local, or remote and resolvable to one. */
export function loopExportable(item: Pick<BoardItem, "kind" | "ref">): boolean {
  return item.kind === "video" && !/^(data:|blob:)/i.test(item.ref) && !isCollabRef(item.ref);
}

/**
 * Range the export covers, in seconds: the loop bounds when the item has them, else the whole
 * file. `sec` is null while the duration of an untrimmed file is not known yet.
 */
export function loopSpan(item: Pick<BoardItem, "trimIn" | "trimOut" | "dur">): { in?: number; end?: number; sec: number | null } {
  const start = item.trimIn && item.trimIn > 0 ? item.trimIn : 0;
  const end = item.trimOut && item.trimOut > start ? item.trimOut : item.dur;
  return {
    in: start > 0 ? start : undefined,
    end: item.trimOut && item.trimOut > start ? item.trimOut : undefined,
    sec: end && end > start ? end - start : null,
  };
}

/** File name proposed in the save dialog. */
export function loopFileName(title: string | undefined, format: LoopFormat): string {
  const base = (title || "loop").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[\\/:*?"<>|]+/g, "_").trim() || "loop";
  return `${base}.${format}`;
}
