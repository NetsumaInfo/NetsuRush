// Operation contract the native document speaks (`src-tauri/src/collab/ops.rs`).
//
// The transport, the keys and the membership are indifferent to what a document holds; THIS file is
// not. Operations are validated field by field in Rust, which is why they are typed rather than a
// generic `set(path, value)`: a buggy or compromised renderer must not be able to build a state the
// module cannot represent. Each surface (a collection, a notebook) is a set of entries with field
// registers, mergeable texts and media manifests.

type MediaKind = "image" | "video" | "youtube" | "embed" | "text" | "frame" | "draw" | "sequence" | "palette";

export const COLLAB_PROTOCOL_VERSION = 1 as const;

export type Crop = { x: number; y: number; width: number; height: number };
export type Trim = { start: number; end: number; duration?: number };
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
  kind?: MediaKind;
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
export type SurfaceEntryKind = "notebook" | "page" | "block" | "database" | "collection" | "collectionItem";
export type SurfaceEntryProjection = { entryId: string; kind: SurfaceEntryKind; fields: Record<string, unknown>; texts: Record<string, string>; richTexts?: Record<string, { insert: string; attributes?: Record<string, string> | null }[]>; media: Record<string, MediaManifest> };

export type SurfaceProjection = { revision: number; entries: SurfaceEntryProjection[]; localHashes: string[] };

export type CollabOp =
  | { type: "surfaceRestoreEntry"; entryId: string }
  | { type: "surfaceTextFormat"; entryId: string; field: string; start: number; end: number; style: string; value: string | null }
  | { type: "surfaceSetEntry"; entryId: string; kind: SurfaceEntryKind; fields: Record<string, unknown> }
  | { type: "surfaceDeleteEntry"; entryId: string }
  | { type: "surfaceTextInsert"; entryId: string; field: string; index: number; text: string }
  | { type: "surfaceTextDelete"; entryId: string; field: string; index: number; length: number }
  | { type: "surfaceSetMedia"; entryId: string; field: string; manifest: MediaManifest | null };

export type OperationBatch = {
  protocol: typeof COLLAB_PROTOCOL_VERSION;
  baseRevision?: number;
  ops: CollabOp[];
};

export type ProjectRole = "owner" | "editor" | "viewer";
