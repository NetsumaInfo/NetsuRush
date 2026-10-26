// Whole board as a looping animated image: the board is split into what moves and what does not.
//
// A playing video cannot be painted into a canvas frame by frame at any useful speed, so the board
// is not captured: it is described. Whatever moves keeps its place in the z order as a clip the
// core plays with ffmpeg, and everything between two clips is painted once, as a still layer the
// size of the output. The core stacks the lot (core/loopExport.js, `boardLoopArgs`).

import { nr, type BoardLoopEntry } from "@/lib/bridge";
import { isCollabRef, isCoreFileRef, isRemoteRef, parseVideoEmbed, type BoardItem } from "./referenceShared";
import { exportLayout, renderBoardCanvas, visibleItems, type RenderOptions } from "./boardRender";
import { ensureLocalMedia } from "./boardUpscale";
import { loopSpan } from "./boardLoopExport";

// How an item's motion reaches the core:
//  - "file"   a video or GIF already on disk;
//  - "stream" a YouTube item, read through the core's own relay — nothing is downloaded;
//  - "frames" an image sequence, as its list of frames;
//  - "fetch"  a remote medium or an embed card, brought to disk when the export starts.
export type LoopSourceKind = "file" | "stream" | "frames" | "fetch";

const isGif = (item: BoardItem) => /\.gif($|[?#])/i.test(item.ref) || /\.gif($|[?#])/i.test(item.sourceUrl ?? "");
const usable = (ref: string) => !!ref && !isCollabRef(ref) && !/^(data:|blob:)/i.test(ref);
// File kept from a download when the item was switched back to its online player.
const keptVideo = (item: BoardItem) =>
  item.localMedia?.kind === "video" && isCoreFileRef(item.localMedia.ref) ? item.localMedia.ref : null;

/** How the item would be animated, or null when it can only come out still. */
export function loopSourceKind(item: BoardItem): LoopSourceKind | null {
  if (item.missing) return null;
  if (item.kind === "video" || (item.kind === "image" && isGif(item))) {
    if (!usable(item.ref)) return null; // shared-board media are not files the core can open
    return isRemoteRef(item.ref) ? "fetch" : "file";
  }
  if (item.kind === "youtube") return keptVideo(item) ? "file" : "stream";
  if (item.kind === "embed") {
    if (keptVideo(item)) return "file";
    return parseVideoEmbed(item.sourceUrl || item.ref, true) ? "fetch" : null;
  }
  if (item.kind === "sequence") return sequenceFrames(item).length > 1 ? "frames" : null;
  return null;
}

/** Items the export would animate, in the given scope. */
export function animatedItems(items: BoardItem[], only?: Set<string>): BoardItem[] {
  return visibleItems(items, only).filter((item) => loopSourceKind(item) !== null);
}

// Frames of the sequence's own loop range, the ones the core can read.
function sequenceFrames(item: BoardItem): string[] {
  const all = item.frames ?? [];
  const first = Math.max(0, item.seqIn ?? 0);
  const last = Math.min(all.length - 1, item.seqOut ?? all.length - 1);
  return all.slice(first, last + 1).filter((frame) => isCoreFileRef(frame));
}

const sequenceFps = (item: BoardItem) => (item.fps && item.fps > 0 ? item.fps : 12) * (item.speed && item.speed > 0 ? item.speed : 1);

/**
 * Length of the item's loop in seconds, when it can be known without downloading anything.
 * A medium still to be fetched answers null unless its range was trimmed: the core measures it.
 */
export async function loopLength(item: BoardItem): Promise<number | null> {
  const kind = loopSourceKind(item);
  if (!kind) return null;
  if (kind === "frames") return sequenceFrames(item).length / sequenceFps(item);
  const span = loopSpan(item);
  if (span.sec != null) return span.sec;
  const start = item.trimIn ?? 0;
  if (kind === "stream") {
    const total = await nr.reference?.ytDuration(item.ref).catch(() => null);
    return total && total > start ? total - start : null;
  }
  if (kind === "file") {
    const file = item.kind === "video" || item.kind === "image" ? item.ref : keptVideo(item);
    const info = file ? await nr.reference?.playInfo(file).catch(() => null) : null;
    return info?.duration && info.duration > start ? info.duration - start : null;
  }
  return null;
}

type ClipSource = Pick<Extract<BoardLoopEntry, { x: number }>, "path" | "frames" | "fps" | "in" | "end" | "contain">;

// Where the core reads the item from. `null` = it could not be made readable: the item is then
// painted still with the rest, never dropped from the picture.
async function resolveSource(item: BoardItem): Promise<ClipSource | null> {
  const kind = loopSourceKind(item);
  if (!kind) return null;
  if (kind === "frames") return { frames: sequenceFrames(item), fps: sequenceFps(item) };
  const span = loopSpan(item);
  const range = { in: span.in, end: span.end };
  if (kind === "stream") {
    // The relay has no length of its own to offer the core: the end of the range is stated.
    const end = span.end ?? (await nr.reference?.ytDuration(item.ref).catch(() => null)) ?? undefined;
    return { path: nr.ytStreamUrl(item.ref), in: span.in, end };
  }
  if (kind === "file") {
    if (item.kind === "video") return { path: item.ref, ...range };
    if (item.kind === "image") return { path: item.ref };
    const kept = keptVideo(item);
    return kept ? { path: kept, ...(item.kind === "youtube" ? range : {}), contain: item.kind === "embed" } : null;
  }
  if (item.kind === "embed") {
    const got = await nr.reference?.extractMedia?.(item.sourceUrl || item.ref).catch(() => null);
    const video = got?.ok ? got.items?.find((entry) => entry.kind === "video") : undefined;
    // A card is not the shape of what it links to: the video fits inside it instead of filling it.
    return video ? { path: video.path, contain: true } : null;
  }
  const local = await ensureLocalMedia(item.ref).catch(() => null);
  if (!local) return null;
  return item.kind === "video" ? { path: local, ...range } : { path: local };
}

/**
 * The scope in z order, cut at each clip: `still` runs of item ids, each followed by the clip that
 * sits above it (none after the last run).
 */
export function loopRuns(
  items: BoardItem[],
  only: Set<string> | undefined,
  isClip: (item: BoardItem) => boolean,
): { still: string[]; clip?: BoardItem }[] {
  const runs: { still: string[]; clip?: BoardItem }[] = [];
  let still: string[] = [];
  for (const item of visibleItems(items, only)) {
    if (isClip(item)) {
      runs.push({ still, clip: item });
      still = [];
    } else still.push(item.id);
  }
  runs.push({ still });
  return runs;
}

function layerPng(canvas: HTMLCanvasElement): string {
  const url = canvas.toDataURL("image/png");
  return url.slice(url.indexOf(",") + 1);
}

/**
 * The stack sent to the core, bottom first. The first layer is always there: it carries the
 * background and gives the output its size. A later run with nothing to paint sends no layer.
 */
export async function buildBoardLoopStack(
  items: BoardItem[],
  opts: Pick<RenderOptions, "width" | "background" | "only">,
): Promise<{ stack: BoardLoopEntry[]; clips: number }> {
  const sources = new Map<string, ClipSource>();
  // One at a time: fetching goes through yt-dlp, which a burst gets rate-limited.
  for (const item of animatedItems(items, opts.only)) {
    const source = await resolveSource(item);
    if (source) sources.set(item.id, source);
  }

  const layout = exportLayout(items, opts);
  const runs = loopRuns(items, opts.only, (item) => sources.has(item.id));
  const hasShapes = !opts.only && items.some((it) => it.kind === "draw" && (it.shapes?.length ?? 0) > 0);
  const stack: BoardLoopEntry[] = [];

  for (let i = 0; i < runs.length; i += 1) {
    const { still, clip } = runs[i];
    const first = i === 0;
    const shapes = i === runs.length - 1 && hasShapes;
    if (first || still.length || shapes) {
      const canvas = await renderBoardCanvas(items, {
        width: opts.width,
        only: opts.only,
        background: first ? opts.background : null,
        paint: new Set(still),
        shapes,
      });
      stack.push({ png: layerPng(canvas) });
    }
    if (clip) {
      stack.push({
        ...sources.get(clip.id)!,
        x: (clip.x + clip.w / 2 + layout.dx) * layout.scale,
        y: (clip.y + clip.h / 2 + layout.dy) * layout.scale,
        w: clip.w * layout.scale,
        h: clip.h * layout.scale,
        crop: clip.kind === "video" || clip.kind === "image" ? clip.crop : undefined,
        flipH: clip.flipH,
        flipV: clip.flipV,
        rotation: clip.rotation || undefined,
        opacity: clip.opacity,
      });
    }
  }
  return { stack, clips: sources.size };
}
