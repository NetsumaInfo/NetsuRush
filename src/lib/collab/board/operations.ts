import type { BoardItem, DrawShape } from "@/components/reference/referenceShared";
import type {
  Appearance,
  BoardPalette,
  CollabOp,
  EmbedMetadata,
  FrameStyle,
  Geometry,
  LinkMetadata,
  MediaAsset,
  MediaManifest,
  Playback,
  TextStyle,
  VectorShape,
} from "../types";

export type AssetResolver = (ref: string, item: BoardItem) => MediaAsset | null;

// Structural equality over the plain-data values the facet builders produce. The previous
// `JSON.stringify` pair serialized every facet of every item on every 150 ms flush — O(board) of
// string building to compare two objects that are usually identical. Matches stringify semantics
// where it matters: a property holding `undefined` counts as absent, and NaN equals NaN.
export function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "number" && typeof right === "number") {
    return Number.isNaN(left) && Number.isNaN(right);
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const l = left as unknown[];
    const r = right as unknown[];
    if (l.length !== r.length) return false;
    for (let index = 0; index < l.length; index += 1) {
      if (!same(l[index], r[index])) return false;
    }
    return true;
  }
  const l = left as Record<string, unknown>;
  const r = right as Record<string, unknown>;
  for (const key in l) {
    if (l[key] !== undefined && !same(l[key], r[key])) return false;
  }
  for (const key in r) {
    if (r[key] !== undefined && l[key] === undefined) return false;
  }
  return true;
}

/// Rust refuses a non-positive width or height, and it is right to: a shared document must not
/// carry a rectangle nobody can draw. But some board items legitimately have no size — the drawing
/// layer is a board-wide singleton whose content is its strokes, and an item can reach here before
/// it has ever been measured. Those get a minimal box instead of failing the whole share; their
/// real size is recomputed on the other side from the media or the strokes they carry.
const MIN_SIDE = 1;

function side(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : MIN_SIDE;
}

function geometry(item: BoardItem): Geometry {
  return {
    x: Number.isFinite(item.x) ? item.x : 0,
    y: Number.isFinite(item.y) ? item.y : 0,
    width: side(item.w),
    height: side(item.h),
    rotation: item.rotation,
    naturalWidth: item.natW,
    naturalHeight: item.natH,
    detached: item.detached ?? false,
  };
}

function appearance(item: BoardItem): Appearance {
  return {
    title: item.title,
    opacity: item.opacity,
    flipHorizontal: item.flipH ?? false,
    flipVertical: item.flipV ?? false,
  };
}

function textStyle(item: BoardItem): TextStyle {
  return {
    fontSize: item.fontSize,
    fontFamily: item.fontFamily,
    color: item.color,
    background: item.bg,
    highlight: item.highlight,
    lineHeight: item.lineHeight,
    indent: item.indent,
    bullet: item.bullet ?? false,
    numbered: item.numbered ?? false,
    strike: item.strike ?? false,
    align: item.align,
    bold: item.bold ?? false,
    italic: item.italic ?? false,
    underline: item.underline ?? false,
  };
}

function frameStyle(item: BoardItem): FrameStyle {
  return {
    fillMode: item.fillMode ?? (item.filled ? "solid" : undefined),
    fillColor: item.fillColor,
    titleBackground: item.titleBg,
  };
}

function playback(item: BoardItem): Playback {
  return {
    playMode: item.playMode,
    frame: item.frame,
    fps: item.fps,
    speed: item.speed,
    sequencePlaying: item.seqPlay ?? false,
    sequenceIn: item.seqIn,
    sequenceOut: item.seqOut,
  };
}

// Playback POSITION is local, as the document contract states: which frame a sequence is showing
// and whether it is currently running follow the person watching. Comparing them published one
// operation per displayed frame and dragged every other member's view along with it.
function playbackSettings(item: BoardItem) {
  const { frame: _frame, sequencePlaying: _playing, ...settings } = playback(item);
  return settings;
}

function palette(item: BoardItem): BoardPalette {
  return {
    colors: [...(item.colors ?? [])],
    sourceItemIds: [...(item.sourceIds ?? [])],
    showValues: item.showHex ?? false,
    colorFormat: item.colorFormat ?? "hex",
    layout: item.paletteLayout ?? "row",
  };
}

function embed(item: BoardItem): EmbedMetadata | null {
  return item.embed ? {
    level: item.embed.level,
    quality: item.embed.quality,
    marginSeconds: item.embed.marginSec,
  } : null;
}

function link(item: BoardItem): LinkMetadata | null {
  if (!item.link) return null;
  if (item.link.kind === "file") {
    if (!item.link.target.startsWith("collab:")) return null;
    return { ...item.link, target: item.link.target.slice("collab:".length) };
  }
  return item.link;
}

function automaticAsset(ref: string, item: BoardItem): MediaAsset | null {
  if (!ref) return null;
  if (item.kind === "youtube" && !/^https?:/i.test(ref)) {
    return { youtubeId: ref, displayName: "YouTube", mime: "video/youtube", size: 0, sourceUrl: item.sourceUrl };
  }
  if (!/^https?:/i.test(ref)) return null;
  let displayName = "remote-media";
  try {
    const segments = new URL(ref).pathname.split("/").filter(Boolean);
    displayName = segments[segments.length - 1] ?? displayName;
  } catch { /* Rust performs the authoritative URL validation. */ }
  return {
    remoteUrl: ref,
    displayName,
    mime: item.kind === "video" ? "video/*" : "image/*",
    size: 0,
    sourceUrl: item.sourceUrl,
  };
}

function mediaManifest(item: BoardItem, resolveAsset: AssetResolver): MediaManifest | null {
  const primary = resolveAsset(item.ref, item) ?? automaticAsset(item.ref, item);
  if (!primary) return null;
  const previousAsset = item.prevMedia
    ? resolveAsset(item.prevMedia.ref, item) ?? automaticAsset(item.prevMedia.ref, { ...item, kind: item.prevMedia.kind ?? item.kind })
    : null;
  const localAsset = item.localMedia
    ? resolveAsset(item.localMedia.ref, item) ?? automaticAsset(item.localMedia.ref, { ...item, kind: item.localMedia.kind })
    : null;
  return {
    primary,
    previous: item.prevMedia && previousAsset ? {
      kind: item.prevMedia.kind,
      asset: { ...previousAsset, sourceUrl: item.prevMedia.sourceUrl ?? previousAsset.sourceUrl },
      trim: item.prevMedia.trimIn !== undefined && item.prevMedia.trimOut !== undefined
        ? { start: item.prevMedia.trimIn, end: item.prevMedia.trimOut }
        : undefined,
      crop: item.prevMedia.crop
        ? { x: item.prevMedia.crop.x, y: item.prevMedia.crop.y, width: item.prevMedia.crop.w, height: item.prevMedia.crop.h }
        : undefined,
    } : undefined,
    local: item.localMedia && localAsset ? {
      kind: item.localMedia.kind,
      asset: localAsset,
      naturalWidth: item.localMedia.natW,
      naturalHeight: item.localMedia.natH,
    } : undefined,
  };
}

function mediaIdentity(item: BoardItem) {
  return {
    ref: item.ref,
    sourceUrl: item.sourceUrl,
    previous: item.prevMedia ? {
      kind: item.prevMedia.kind,
      ref: item.prevMedia.ref,
      trimIn: item.prevMedia.trimIn,
      trimOut: item.prevMedia.trimOut,
      crop: item.prevMedia.crop,
      sourceUrl: item.prevMedia.sourceUrl,
    } : null,
    local: item.localMedia ? {
      kind: item.localMedia.kind,
      ref: item.localMedia.ref,
      natW: item.localMedia.natW,
      natH: item.localMedia.natH,
    } : null,
  };
}

function crop(item: BoardItem) {
  return item.crop ? { x: item.crop.x, y: item.crop.y, width: item.crop.w, height: item.crop.h } : null;
}

function trim(item: BoardItem) {
  if (item.trimIn === undefined || item.trimOut === undefined) return null;
  // Le document REFUSE une sortie au-delà de la durée du média, et un lot rejeté l'est en ENTIER :
  // une borne posée avant que la durée exacte ne soit connue (elle s'affine au chargement) suffisait
  // alors à faire tomber le partage complet, donc à publier un board qui semblait réinitialisé.
  // Une sortie qui dépasse le média n'a de toute façon pas de sens : elle vaut la fin du média.
  // Les DEUX bornes sont ramenées dans le média : une durée révisée à la baisse (elle s'affine au
  // chargement, et deux sources l'écrivent désormais) laissait sinon une ENTRÉE hors bornes, que le
  // document refuse tout autant — donc le même lot entier perdu.
  const limit = item.dur;
  const start = limit !== undefined && item.trimIn > limit ? limit : item.trimIn;
  const end = limit !== undefined && item.trimOut > limit ? limit : item.trimOut;
  return { start, end: Math.max(start, end), duration: limit };
}

export function diffText(itemId: string, previous: string, next: string): CollabOp[] {
  const before = Array.from(previous);
  const after = Array.from(next);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  const removed = before.length - prefix - suffix;
  const inserted = after.slice(prefix, after.length - suffix).join("");
  const ops: CollabOp[] = [];
  if (removed) ops.push({ type: "textDelete", itemId, index: prefix, len: removed });
  if (inserted) ops.push({ type: "textInsert", itemId, index: prefix, text: inserted });
  return ops;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function encodeStroke(shape: DrawShape): string {
  if (shape.t !== "pen" || shape.p.length < 2 || shape.p.length % 2 !== 0) {
    throw new Error("a finished pen stroke needs complete x/y points");
  }
  const count = shape.p.length / 2;
  const pressure = Boolean(shape.pw?.length === count);
  const stride = pressure ? 12 : 8;
  const bytes = new Uint8Array(6 + count * stride);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  bytes[1] = pressure ? 1 : 0;
  view.setUint32(2, count, true);
  for (let index = 0, offset = 6; index < count; index += 1, offset += stride) {
    view.setFloat32(offset, shape.p[index * 2], true);
    view.setFloat32(offset + 4, shape.p[index * 2 + 1], true);
    if (pressure) view.setFloat32(offset + 8, shape.pw![index], true);
  }
  return encodeBase64(bytes);
}

function anchor(value: DrawShape["a1"]) {
  return value ? { itemId: value.id, xFraction: value.fx, yFraction: value.fy } : undefined;
}

function vectorShape(shape: DrawShape): VectorShape {
  if (shape.t === "pen") throw new Error("pen strokes use their immutable binary operation");
  return {
    shapeId: shape.id,
    kind: shape.t,
    color: shape.c,
    width: shape.w,
    points: [...shape.p],
    fill: shape.fill,
    text: shape.text,
    controlPoint: shape.cp,
    startHead: shape.h1,
    endHead: shape.h2,
    dash: shape.dash,
    route: shape.route,
    opacity: shape.op,
    rounded: shape.r ?? false,
    ownerItemId: shape.own,
    ownerPoints: [...(shape.ownPts ?? [])],
    startAnchor: anchor(shape.a1),
    endAnchor: anchor(shape.a2),
    detached: shape.detached ?? false,
  };
}

// Items whose `ref` could not be turned into a shareable asset during the last diff. The document
// can only hold a content hash, a remote URL or a YouTube id — never a local path — so an item in
// this set travels without its media. Erasing the media it already carries would turn a transient
// import failure into permanent data loss, so the diff simply emits nothing for it and the caller
// is told which items were affected.
const unresolved = new Set<string>();

function addItemOps(item: BoardItem, resolveAsset: AssetResolver): CollabOp[] {
  const ops: CollabOp[] = [
    { type: "addItem", itemId: item.id, kind: item.kind, geometry: geometry(item) },
    { type: "setAppearance", itemId: item.id, appearance: appearance(item) },
    { type: "setTextStyle", itemId: item.id, style: textStyle(item) },
    { type: "setFrameStyle", itemId: item.id, frame: frameStyle(item) },
    { type: "setPlayback", itemId: item.id, playback: playback(item) },
  ];
  if (item.crop) ops.push({ type: "setCrop", itemId: item.id, crop: crop(item) });
  if (trim(item)) ops.push({ type: "setTrim", itemId: item.id, trim: trim(item) });
  const manifest = mediaManifest(item, resolveAsset);
  if (manifest) ops.push({ type: "setMediaManifest", itemId: item.id, manifest });
  else if (item.ref) unresolved.add(item.id);
  if (item.link) ops.push({ type: "setLink", itemId: item.id, link: link(item) });
  if (item.embed) ops.push({ type: "setEmbed", itemId: item.id, embed: embed(item) });
  if (item.frames?.length) {
    const frames = item.frames
      .map((ref) => resolveAsset(ref, item) ?? automaticAsset(ref, item))
      .filter((frame): frame is MediaAsset => frame !== null);
    if (frames.length === item.frames.length) {
      ops.push({ type: "setSequence", itemId: item.id, sequence: { frames } });
    } else {
      unresolved.add(item.id);
    }
  }
  if (item.kind === "palette") ops.push({ type: "setPalette", itemId: item.id, palette: palette(item) });
  if (item.text) ops.push({ type: "textInsert", itemId: item.id, index: 0, text: item.text });
  for (const shape of item.kind === "draw" ? item.shapes ?? [] : []) {
    if (shape.t === "pen") {
      ops.push({
        type: "addStroke",
        strokeId: shape.id,
        color: shape.c,
        width: shape.w,
        opacity: shape.op ?? 1,
        encodedPoints: encodeStroke(shape),
        ownerItemId: shape.own,
        detached: shape.detached ?? false,
      });
    } else {
      ops.push({ type: "upsertShape", ...vectorShape(shape) });
    }
  }
  return ops;
}

function diffDraw(previous: DrawShape[], next: DrawShape[]): CollabOp[] {
  const before = new Map(previous.map((shape) => [shape.id, shape]));
  const after = new Map(next.map((shape) => [shape.id, shape]));
  const ops: CollabOp[] = [];
  for (const shape of next) {
    const old = before.get(shape.id);
    if (old && same(old, shape)) continue;
    if (shape.t === "pen") {
      if (old) ops.push({ type: "deleteStroke", strokeId: shape.id });
      ops.push({
        type: "addStroke", strokeId: shape.id, color: shape.c, width: shape.w,
        opacity: shape.op ?? 1, encodedPoints: encodeStroke(shape), ownerItemId: shape.own,
        detached: shape.detached ?? false,
      });
    } else {
      ops.push({ type: "upsertShape", ...vectorShape(shape) });
    }
  }
  for (const shape of previous) {
    if (after.has(shape.id)) continue;
    ops.push(shape.t === "pen"
      ? { type: "deleteStroke", strokeId: shape.id }
      : { type: "deleteShape", shapeId: shape.id });
  }
  return ops;
}

// The board stacks with `z`, not with the position of the item in the array: bring-to-front only
// rewrites `z` and leaves the array untouched. Diffing the raw array order therefore transmitted
// nothing, and the projection — which numbers `z` from the document order — flattened the stack
// back on the next read. Both sides are compared in render order instead.
function stackOrder(items: BoardItem[]): BoardItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => ((left.item.z ?? 0) - (right.item.z ?? 0)) || (left.index - right.index))
    .map((entry) => entry.item);
}

function reorderOps(previous: BoardItem[], next: BoardItem[]): CollabOp[] {
  // Set membership, not `some`: the previous pair of linear scans made every flush O(n²) even when
  // nothing moved.
  const nextIds = new Set(next.map((item) => item.id));
  const previousIds = new Set(previous.map((item) => item.id));
  const current = previous.map((item) => item.id).filter((id) => nextIds.has(id));
  const desired = next.map((item) => item.id).filter((id) => previousIds.has(id));
  const ops: CollabOp[] = [];
  for (let index = 0; index < desired.length; index += 1) {
    if (current[index] === desired[index]) continue;
    const from = current.indexOf(desired[index], index + 1);
    if (from < 0) continue;
    const [id] = current.splice(from, 1);
    const before = current[index] ?? null;
    current.splice(index, 0, id);
    ops.push({ type: "moveItem", itemId: id, before });
  }
  return ops;
}

/** Item ids the last `diffBoard` could not give a shareable media to. Read it right after. */
export function unresolvedMediaItems(): string[] {
  return [...unresolved];
}

export function diffBoard(
  previous: BoardItem[],
  next: BoardItem[],
  resolveAsset: AssetResolver = () => null,
): CollabOp[] {
  unresolved.clear();
  previous = stackOrder(previous);
  next = stackOrder(next);
  const before = new Map(previous.map((item) => [item.id, item]));
  const after = new Map(next.map((item) => [item.id, item]));
  const ops: CollabOp[] = [];
  for (const item of next) {
    const old = before.get(item.id);
    if (!old) {
      ops.push(...addItemOps(item, resolveAsset));
      continue;
    }
    // The store patches immutably: an untouched item keeps its object identity between flushes,
    // and the projection reconciler preserves it too. Nothing to compare facet by facet.
    if (old === item) continue;
    if (!same(geometry(old), geometry(item))) ops.push({ type: "setGeometry", itemId: item.id, geometry: geometry(item) });
    if (!same(appearance(old), appearance(item))) ops.push({ type: "setAppearance", itemId: item.id, appearance: appearance(item) });
    if (!same(textStyle(old), textStyle(item))) ops.push({ type: "setTextStyle", itemId: item.id, style: textStyle(item) });
    if (!same(frameStyle(old), frameStyle(item))) ops.push({ type: "setFrameStyle", itemId: item.id, frame: frameStyle(item) });
    if (!same(playbackSettings(old), playbackSettings(item))) {
      ops.push({ type: "setPlayback", itemId: item.id, playback: playback(item) });
    }
    if (!same(crop(old), crop(item))) ops.push({ type: "setCrop", itemId: item.id, crop: crop(item) });
    if (!same(trim(old), trim(item))) ops.push({ type: "setTrim", itemId: item.id, trim: trim(item) });
    if (!same(mediaIdentity(old), mediaIdentity(item))) {
      const manifest = mediaManifest(item, resolveAsset);
      // `manifest: null` is the operation that clears an item's media. It is only legitimate when
      // the item really has no media left; emitting it because an import failed is what made a
      // media the board still displays disappear from the document for good.
      if (manifest) ops.push({ type: "setMediaManifest", itemId: item.id, manifest });
      else if (!item.ref) ops.push({ type: "setMediaManifest", itemId: item.id, manifest: null });
      else unresolved.add(item.id);
    }
    if (!same(link(old), link(item))) ops.push({ type: "setLink", itemId: item.id, link: link(item) });
    if (!same(embed(old), embed(item))) ops.push({ type: "setEmbed", itemId: item.id, embed: embed(item) });
    if (!same(old.frames ?? [], item.frames ?? [])) {
      const frames = (item.frames ?? [])
        .map((ref) => resolveAsset(ref, item) ?? automaticAsset(ref, item))
        .filter((frame): frame is MediaAsset => frame !== null);
      // Same rule as the manifest: only an emptied sequence clears the sequence.
      if (frames.length && frames.length === item.frames?.length) {
        ops.push({ type: "setSequence", itemId: item.id, sequence: { frames } });
      } else if (!item.frames?.length) {
        ops.push({ type: "setSequence", itemId: item.id, sequence: null });
      } else {
        unresolved.add(item.id);
      }
    }
    if (item.kind === "palette" && !same(palette(old), palette(item))) {
      ops.push({ type: "setPalette", itemId: item.id, palette: palette(item) });
    }
    ops.push(...diffText(item.id, old.text ?? "", item.text ?? ""));
    if (item.kind === "draw") ops.push(...diffDraw(old.shapes ?? [], item.shapes ?? []));
  }
  for (const item of previous) {
    if (!after.has(item.id)) ops.push({ type: "deleteItem", itemId: item.id });
  }
  ops.push(...reorderOps(previous, next));
  return ops;
}
