import type { BoardItem, DrawShape, ItemKind } from "@/components/reference/referenceShared";
// `embeds.ts` ne dépend que du modèle (aucun pont natif) : importable ici sans traîner le bridge.
import { embedSrc } from "@/components/reference/embeds";
import type {
  Appearance,
  BoardPalette,
  Crop,
  EmbedMetadata,
  FrameStyle,
  Geometry,
  LinkMetadata,
  MediaAsset,
  MediaManifest,
  Playback,
  SequenceMetadata,
  Stroke,
  TextStyle,
  Trim,
  VectorShape,
} from "../types";

export type NativeItem = {
  itemId: string;
  kind: ItemKind;
  geometry: Geometry;
  crop?: Crop | null;
  trim?: Trim | null;
  appearance?: Appearance;
  textStyle?: TextStyle;
  text?: string;
  frameStyle?: FrameStyle;
  playback?: Playback;
  media?: MediaManifest | null;
  link?: LinkMetadata | null;
  embed?: EmbedMetadata | null;
  sequence?: SequenceMetadata | null;
  palette?: BoardPalette;
  deleted?: boolean;
};

export type NativeProject = {
  revision: number;
  items: NativeItem[];
  order: string[];
  strokes: Stroke[];
  shapes: VectorShape[];
  /** Content hashes already present in the local blob store — the native side is the authority. */
  localHashes?: string[];
};

function assetRef(asset: MediaAsset): string {
  if (asset.remoteUrl) return asset.remoteUrl;
  if (asset.youtubeId) return asset.youtubeId;
  return asset.contentHash ? `collab:${asset.contentHash}` : "";
}

/**
 * Adresse d'affichage d'un média projeté. Un média HASHÉ est servi par le protocole natif (le
 * renderer ne peut pas la calculer) ; tout le reste suit la règle ordinaire du board — et c'est
 * elle qui manquait : sans `src`, un lecteur YouTube ou une carte embed arrivait vide chez le
 * destinataire, donc sans lecture, sans boucle et sans in/out.
 */
function displayFor(
  kind: ItemKind,
  ref: string,
  asset: MediaAsset | undefined,
  mediaUrl: (hash: string) => string,
): string {
  if (asset?.contentHash) return mediaUrl(asset.contentHash);
  if (kind === "youtube") return ref;
  if (kind === "embed") return embedSrc(ref);
  if (asset?.remoteUrl) return asset.remoteUrl;
  return "";
}

function shapeAnchor(anchor: VectorShape["startAnchor"]): DrawShape["a1"] {
  return anchor ? { id: anchor.itemId, fx: anchor.xFraction, fy: anchor.yFraction } : undefined;
}

function vectorToBoard(shape: VectorShape): DrawShape {
  return {
    id: shape.shapeId,
    t: shape.kind,
    c: shape.color,
    w: shape.width,
    p: [...shape.points],
    fill: shape.fill,
    text: shape.text,
    cp: shape.controlPoint,
    h1: shape.startHead,
    h2: shape.endHead,
    dash: shape.dash,
    route: shape.route,
    op: shape.opacity,
    r: shape.rounded || undefined,
    own: shape.ownerItemId,
    ownPts: shape.ownerPoints.length ? [...shape.ownerPoints] : undefined,
    a1: shapeAnchor(shape.startAnchor),
    a2: shapeAnchor(shape.endAnchor),
    detached: shape.detached || undefined,
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Version 1: byte version, byte flags, u32 point count, then x/y f32 and optional pressure f32. */
export function decodeStroke(stroke: Stroke): DrawShape | null {
  try {
    const bytes = decodeBase64(stroke.encodedPoints);
    if (bytes.length < 6 || bytes[0] !== 1) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pressure = (bytes[1] & 1) !== 0;
    const count = view.getUint32(2, true);
    const stride = pressure ? 12 : 8;
    if (count === 0 || bytes.length !== 6 + count * stride) return null;
    const points: number[] = [];
    const widths: number[] = [];
    for (let index = 0, offset = 6; index < count; index += 1, offset += stride) {
      points.push(view.getFloat32(offset, true), view.getFloat32(offset + 4, true));
      if (pressure) widths.push(view.getFloat32(offset + 8, true));
    }
    return {
      id: stroke.strokeId,
      t: "pen",
      c: stroke.color,
      w: stroke.width,
      p: points,
      pw: pressure ? widths : undefined,
      op: stroke.opacity,
      own: stroke.ownerItemId,
      detached: stroke.detached || undefined,
    };
  } catch {
    return null;
  }
}

function nativeToBoard(item: NativeItem, z: number, mediaUrl: (hash: string) => string): BoardItem {
  const { geometry } = item;
  const board: BoardItem = {
    id: item.itemId,
    kind: item.kind,
    ref: item.media ? assetRef(item.media.primary) : "",
    src: "",
    x: geometry.x,
    y: geometry.y,
    w: geometry.width,
    h: geometry.height,
    rotation: geometry.rotation,
    z,
  };
  board.src = displayFor(item.kind, board.ref, item.media?.primary, mediaUrl);
  // Le type déclaré par le document : une adresse par empreinte ne porte pas d'extension, et sans
  // lui un GIF partagé n'est plus reconnu comme animé (« Tout figer » ne l'arrêtait pas).
  if (item.media?.primary.mime) board.mime = item.media.primary.mime;
  if (geometry.naturalWidth !== undefined) board.natW = geometry.naturalWidth;
  if (geometry.naturalHeight !== undefined) board.natH = geometry.naturalHeight;
  if (geometry.detached) board.detached = true;

  const appearance = item.appearance;
  if (appearance?.title !== undefined) board.title = appearance.title;
  if (appearance?.opacity !== undefined) board.opacity = appearance.opacity;
  if (appearance?.flipHorizontal) board.flipH = true;
  if (appearance?.flipVertical) board.flipV = true;

  if (item.crop) board.crop = { x: item.crop.x, y: item.crop.y, w: item.crop.width, h: item.crop.height };
  if (item.trim) {
    board.trimIn = item.trim.start;
    board.trimOut = item.trim.end;
    if (item.trim.duration !== undefined) board.dur = item.trim.duration;
  }

  const style = item.textStyle;
  if (style) {
    board.fontSize = style.fontSize;
    board.fontFamily = style.fontFamily;
    board.color = style.color;
    board.bg = style.background;
    board.highlight = style.highlight;
    board.lineHeight = style.lineHeight;
    board.indent = style.indent;
    board.bullet = style.bullet;
    board.numbered = style.numbered;
    board.strike = style.strike;
    board.align = style.align;
    board.bold = style.bold;
    board.italic = style.italic;
    board.underline = style.underline;
  }
  if (item.text !== undefined) board.text = item.text;

  const frame = item.frameStyle;
  if (frame) {
    board.fillMode = frame.fillMode;
    board.filled = frame.fillMode === "solid";
    board.fillColor = frame.fillColor;
    board.titleBg = frame.titleBackground;
  }

  const playback = item.playback;
  if (playback) {
    board.playMode = playback.playMode;
    board.frame = playback.frame;
    board.fps = playback.fps;
    board.speed = playback.speed;
    board.seqPlay = playback.sequencePlaying;
    board.seqIn = playback.sequenceIn;
    board.seqOut = playback.sequenceOut;
  }
  if (item.media?.primary.sourceUrl) board.sourceUrl = item.media.primary.sourceUrl;
  if (item.media?.previous) {
    const previous = item.media.previous;
    board.prevMedia = {
      kind: previous.kind,
      ref: assetRef(previous.asset),
      src: "",
      trimIn: previous.trim?.start,
      trimOut: previous.trim?.end,
      crop: previous.crop
        ? { x: previous.crop.x, y: previous.crop.y, w: previous.crop.width, h: previous.crop.height }
        : undefined,
      sourceUrl: previous.asset.sourceUrl,
    };
    board.prevMedia.src = displayFor(
      previous.kind ?? item.kind, board.prevMedia.ref, previous.asset, mediaUrl,
    );
  }
  if (item.media?.local?.kind) {
    const local = item.media.local;
    const boardLocal: NonNullable<BoardItem["localMedia"]> = {
      kind: local.kind!,
      ref: assetRef(local.asset),
      src: "",
      natW: local.naturalWidth,
      natH: local.naturalHeight,
    };
    boardLocal.src = displayFor(local.kind!, boardLocal.ref, local.asset, mediaUrl);
    board.localMedia = boardLocal;
  }
  if (item.link) {
    board.link = {
      kind: item.link.kind,
      target: item.link.kind === "file" ? `collab:${item.link.target}` : item.link.target,
      label: item.link.label,
    };
  }
  if (item.embed) {
    board.embed = {
      level: item.embed.level,
      quality: item.embed.quality,
      marginSec: item.embed.marginSeconds,
    };
  }
  if (item.sequence) board.frames = item.sequence.frames.map(assetRef);
  if (item.palette) {
    board.colors = [...item.palette.colors];
    board.sourceIds = [...item.palette.sourceItemIds];
    board.showHex = item.palette.showValues;
    board.colorFormat = item.palette.colorFormat;
    board.paletteLayout = item.palette.layout;
  }
  return board;
}

/** Total projection: an empty authoritative project always replaces the renderer with an empty board. */
export function projectBoard(project: NativeProject, mediaUrl: (hash: string) => string = () => ""): BoardItem[] {
  const byId = new Map(project.items.filter((item) => !item.deleted).map((item) => [item.itemId, item]));
  const drawings = [
    ...project.strokes.map(decodeStroke).filter((shape): shape is DrawShape => shape !== null),
    ...project.shapes.map(vectorToBoard),
  ];
  const output: BoardItem[] = [];
  project.order.forEach((id, z) => {
    const native = byId.get(id);
    if (!native) return;
    const board = nativeToBoard(native, z, mediaUrl);
    if (board.kind === "draw") board.shapes = drawings;
    output.push(board);
  });
  return output;
}
