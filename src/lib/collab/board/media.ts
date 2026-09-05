import type { BoardItem, ItemKind } from "@/components/reference/referenceShared";
import { nr } from "@/lib/bridge";
import { collabErrorMessage, importMedia, mediaPath } from "../client";
import { currentCollabProject } from "../currentProject";
import type { AssetResolver } from "./operations";
import {
  describeUnresolved,
  UnreadableMediaError,
  type UnresolvedMedia,
} from "../session";
import type { MediaAsset } from "../types";

function mimeFor(path: string, kind: ItemKind): string {
  const extension = path.split(/[?#]/, 1)[0].split(".").pop()?.toLowerCase();
  const known: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", avif: "image/avif", svg: "image/svg+xml",
    mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
    mkv: "video/x-matroska", avi: "video/x-msvideo", mpg: "video/mpeg", mpeg: "video/mpeg",
  };
  return (extension && known[extension]) || (kind === "video" ? "video/*" : "image/*");
}

function localRefs(items: BoardItem[]): Array<{ ref: string; item: BoardItem; kind: ItemKind }> {
  const refs = new Map<string, { ref: string; item: BoardItem; kind: ItemKind }>();
  const add = (ref: string | undefined, item: BoardItem, kind: ItemKind) => {
    if (!ref || /^(https?:|data:|blob:|collab:)/i.test(ref)) return;
    // A YouTube item's `ref` is a video id, not a path. Handing it to the file importer asked the
    // native side to read a file named after the video and reported the board as carrying an
    // unreadable media; the document takes the id as it is.
    if (kind === "youtube") return;
    refs.set(ref, { ref, item, kind });
  };
  for (const item of items) {
    add(item.ref, item, item.kind);
    item.frames?.forEach((ref) => add(ref, item, "image"));
    add(item.prevMedia?.ref, item, item.prevMedia?.kind ?? item.kind);
    add(item.localMedia?.ref, item, item.localMedia?.kind ?? item.kind);
  }
  return [...refs.values()];
}

async function importPreview(projectId: string, ref: string): Promise<{ hash: string; size: number } | null> {
  try {
    const rendered = await nr.reference?.collabPreview(ref);
    if (!rendered?.ok || !rendered.path) return null;
    const imported = await importMedia(projectId, rendered.path, "image/jpeg");
    return { hash: imported.hash, size: imported.size };
  } catch {
    // A media without its preview is a slower first paint, never a failed share.
    return null;
  }
}

export type AssetImport = { resolve: AssetResolver; missing: UnresolvedMedia[] };

// `UnresolvedMedia`, `UnreadableMediaError` and `describeUnresolved` belong to the publication
// boundary, which is the same for every surface; they are re-exported so the board's own callers
// keep one import.
export { describeUnresolved, UnreadableMediaError };
export type { UnresolvedMedia };

/**
 * Imports every local file the board points at. A file that cannot be imported is reported, never
 * hidden: the document can only carry a content hash, a remote URL or a YouTube id, so an item
 * whose media failed to import would otherwise enter the shared board stripped of it — silently and
 * irreversibly. The caller decides what to do with `missing`; the one thing it must not do is
 * publish a manifest that erases the media.
 */
export async function importBoardAssets(
  projectId: string,
  items: BoardItem[],
  cache: Map<string, MediaAsset> = new Map(),
  failures: Map<string, string> = new Map(),
): Promise<AssetImport> {
  const missing: UnresolvedMedia[] = [];
  for (const { ref, item, kind } of localRefs(items)) {
    if (cache.has(ref)) continue;
    // A file that could not be read stays unreadable until something changes on disk. Retrying it
    // on every edit turned one dead reference into an IPC round trip per keystroke; the failure is
    // remembered and only the explicit retry clears it.
    const known = failures.get(ref);
    if (known !== undefined) {
      missing.push({ ref, cause: known });
      continue;
    }
    const importAt = async (sourcePath: string) => {
      const imported = await importMedia(projectId, sourcePath, mimeFor(sourcePath, kind));
      // The preview travels first on the other side: a 40 MB image or a video shows something
      // within one small transfer. Only the item's own displayed media earns one — frames and
      // held-back variants would multiply ffmpeg runs for tiles nobody sees first. Optional by
      // construction: a board without previews stays a working board.
      const preview = ref === item.ref && (kind === "image" || kind === "video")
        ? await importPreview(projectId, sourcePath)
        : null;
      cache.set(ref, {
        contentHash: imported.hash,
        displayName: imported.name,
        mime: imported.mime,
        size: imported.size,
        sourceUrl: item.sourceUrl,
        ...(preview ? { previewHash: preview.hash, previewSize: preview.size } : null),
      });
    };
    try {
      await importAt(ref);
    } catch (error) {
      // Last resort before reporting the media unreadable: the same bytes may live at another
      // address — the file name carries its content fingerprint, and the core knows every store.
      const located = await nr.reference?.locateMedia([ref])
        .then((result) => result?.moves?.[ref])
        .catch(() => undefined);
      if (located) {
        try {
          await importAt(located);
          continue;
        } catch { /* the original failure stays the reported cause */ }
      }
      // The native boundary rejects with a plain `{ code, message }`, which `String()` renders as
      // "[object Object]" — the one thing that cannot be acted on.
      const cause = collabErrorMessage(error, "unreadable");
      failures.set(ref, cause);
      missing.push({ ref, cause });
    }
  }
  return { resolve: (ref) => cache.get(ref) ?? null, missing };
}

/**
 * Replaces every `collab:<hash>` with the PATH of its bytes on this disk.
 *
 * The Node service only knows files: handing it a shared board as it stands wrote a `.netsu` whose
 * every media was a "relocate" placeholder — while reporting the export a success. A media still
 * travelling has no path: its item is passed through UNTOUCHED, so the core reports it missing
 * rather than silently emptied.
 */
export async function withLocalMediaPaths<T extends BoardItem>(items: T[]): Promise<T[]> {
  const project = currentCollabProject();
  if (!project) return items;
  const wanted = new Set<string>();
  const collect = (ref?: string) => {
    if (ref && ref.startsWith("collab:")) wanted.add(ref);
  };
  for (const item of items) {
    collect(item.ref);
    item.frames?.forEach(collect);
    collect(item.prevMedia?.ref);
    // `localMedia` too: the file held in reserve behind an embed would otherwise leave as a raw
    // `collab:` in the .netsu — that is, as a placeholder, the very thing this function prevents.
    collect(item.localMedia?.ref);
  }
  if (!wanted.size) return items;

  const paths = new Map<string, string>();
  await Promise.all([...wanted].map(async (ref) => {
    const found = await mediaPath(project, ref.slice("collab:".length)).catch(() => null);
    if (found) paths.set(ref, found);
  }));
  if (!paths.size) return items;

  const swap = (ref?: string) => (ref ? paths.get(ref) ?? ref : ref);
  return items.map((item) => {
    const ref = swap(item.ref);
    const frames = item.frames?.map((frame) => swap(frame) as string);
    const prev = item.prevMedia ? { ...item.prevMedia, ref: swap(item.prevMedia.ref) as string } : undefined;
    const local = item.localMedia ? { ...item.localMedia, ref: swap(item.localMedia.ref) as string } : undefined;
    if (ref === item.ref && !frames && !prev && !local) return item;
    return {
      ...item,
      ...(ref !== item.ref ? { ref, src: "" } : null),
      ...(frames ? { frames } : null),
      ...(prev ? { prevMedia: prev } : null),
      ...(local ? { localMedia: local } : null),
    };
  });
}
