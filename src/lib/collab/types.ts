// Operation contract the native document speaks (`src-tauri/src/collab/ops.rs`).
//
// The transport, the keys and the membership are indifferent to what a document holds; THIS file is
// not. It describes the first document shape collaboration shipped with — the reference board — and
// its operations are validated field by field in Rust, which is why they are typed rather than a
// generic `set(path, value)`: a buggy or compromised renderer must not be able to build a state the
// module cannot represent. Geometry, crop, trim and every other group is ONE value, so two people
// dragging the same item produce one winner rather than Alice's position married to Bob's size.
//
// A surface with another shape (a collection, a notebook) adds its own operations here and in
// `ops.rs`; it does not reinterpret these.

import type { ItemKind } from "@/components/reference/referenceShared";

export const COLLAB_PROTOCOL_VERSION = 1 as const;

export type Geometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  naturalWidth?: number;
  naturalHeight?: number;
  detached: boolean;
};

export type Crop = { x: number; y: number; width: number; height: number };
export type Trim = { start: number; end: number; duration?: number };
export type Appearance = {
  title?: string;
  opacity?: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
};
export type TextStyle = {
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  background?: string;
  highlight?: string;
  lineHeight?: number;
  indent?: number;
  bullet: boolean;
  numbered: boolean;
  strike: boolean;
  align?: "left" | "center" | "right" | "justify";
  bold: boolean;
  italic: boolean;
  underline: boolean;
};
export type FrameStyle = {
  fillMode?: "none" | "tint" | "solid";
  fillColor?: string;
  titleBackground?: string;
};
export type Playback = {
  playMode?: "loop" | "pingpong" | "off";
  frame?: number;
  fps?: number;
  speed?: number;
  sequencePlaying: boolean;
  sequenceIn?: number;
  sequenceOut?: number;
};
export type MediaAsset = {
  contentHash?: string;
  remoteUrl?: string;
  youtubeId?: string;
  displayName: string;
  mime: string;
  size: number;
  sourceUrl?: string;
  // Small JPEG rendition stored as its own blob; peers fetch it before the original.
  previewHash?: string;
  previewSize?: number;
};
export type MediaVariant = {
  kind?: ItemKind;
  asset: MediaAsset;
  trim?: Trim;
  crop?: Crop;
  naturalWidth?: number;
  naturalHeight?: number;
};
export type MediaManifest = {
  primary: MediaAsset;
  previous?: MediaVariant;
  local?: MediaVariant;
};
export type LinkMetadata = { kind: "url" | "file" | "item"; target: string; label?: string };
export type EmbedMetadata = {
  level: "link" | "preview" | "margin" | "full";
  quality?: "eco" | "standard" | "high";
  marginSeconds?: number;
};
export type SequenceMetadata = { frames: MediaAsset[] };
export type BoardPalette = {
  colors: string[];
  sourceItemIds: string[];
  showValues: boolean;
  colorFormat: "hex" | "rgb" | "hsl" | "hsb" | "oklch";
  layout: "row" | "col" | "grid";
};
export type ShapeAnchor = { itemId: string; xFraction: number; yFraction: number };
export type VectorShape = {
  shapeId: string;
  kind: "line" | "arrow" | "rect" | "ellipse" | "diamond" | "text";
  color: string;
  width: number;
  points: number[];
  fill?: string;
  text?: string;
  controlPoint?: [number, number];
  startHead?: "none" | "arrow" | "triangle" | "dot" | "bar";
  endHead?: "none" | "arrow" | "triangle" | "dot" | "bar";
  dash?: "solid" | "dashed" | "dotted";
  route?: "straight" | "curved" | "elbow";
  opacity?: number;
  rounded: boolean;
  ownerItemId?: string;
  ownerPoints: number[];
  startAnchor?: ShapeAnchor;
  endAnchor?: ShapeAnchor;
  detached: boolean;
};
export type Stroke = {
  strokeId: string;
  color: string;
  width: number;
  opacity: number;
  encodedPoints: string;
  ownerItemId?: string;
  detached: boolean;
};

export type CollabOp =
  | { type: "addItem"; itemId: string; kind: ItemKind; geometry: Geometry }
  | { type: "deleteItem"; itemId: string }
  | { type: "setGeometry"; itemId: string; geometry: Geometry }
  | { type: "setCrop"; itemId: string; crop: Crop | null }
  | { type: "setTrim"; itemId: string; trim: Trim | null }
  | { type: "setAppearance"; itemId: string; appearance: Appearance }
  | { type: "setTextStyle"; itemId: string; style: TextStyle }
  | { type: "textInsert"; itemId: string; index: number; text: string }
  | { type: "textDelete"; itemId: string; index: number; len: number }
  | { type: "setFrameStyle"; itemId: string; frame: FrameStyle }
  | { type: "setPlayback"; itemId: string; playback: Playback }
  | { type: "setMediaManifest"; itemId: string; manifest: MediaManifest | null }
  | { type: "setLink"; itemId: string; link: LinkMetadata | null }
  | { type: "setEmbed"; itemId: string; embed: EmbedMetadata | null }
  | { type: "setSequence"; itemId: string; sequence: SequenceMetadata | null }
  | { type: "setPalette"; itemId: string; palette: BoardPalette }
  | { type: "moveItem"; itemId: string; before: string | null }
  | ({ type: "addStroke" } & Stroke)
  | { type: "deleteStroke"; strokeId: string }
  | ({ type: "upsertShape" } & VectorShape)
  | { type: "deleteShape"; shapeId: string };

export type OperationBatch = {
  protocol: typeof COLLAB_PROTOCOL_VERSION;
  ops: CollabOp[];
};

export type ProjectRole = "owner" | "editor" | "viewer";
