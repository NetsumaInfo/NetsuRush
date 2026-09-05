# Resolve Media Pool bridge

## Goal

Expose Resolve media as safe, traceable editor assets without pretending that
the scripting API is a media streaming API.

## Existing base

NetsuRush already traverses the Media Pool, returns file properties, and imports
files through the external scripting bridge. Its Python aggregation avoids
multiple proxy round trips per clip. [ST-NR-MEDIA]

Studio extends the returned shape instead of adding a parallel Resolve bridge.

## Required asset descriptor

```ts
interface ResolveAssetDescriptor {
  projectId: string;
  mediaPoolId: string;
  mediaId: string;
  itemId: string;
  binId: string;
  binPath: string;
  name: string;
  filePath: string | null;
  mediaType: "video" | "audio" | "image" | "unknown";
  durationFrames: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  availability: "ready" | "offline" | "proxy-required" | "unsupported";
  fingerprint: string;
}
```

The current SDK exposes project, Media Pool, folder, and item unique IDs plus
`GetMediaId()` and clip properties. [ST-BMD-SCRIPTING-LOCAL]

## Reference modes

### Linked

The composition refers to the original absolute file. Fast and space-efficient,
but the project is not portable and the source must stay available.

### Copied project asset

NetsuFlow copies an explicitly chosen file into the Studio project after
checking size, free space, conflicts, and user intent. The copy is content-
hashed and recoverable; originals are never deleted.

### Managed proxy

NetsuFlow creates a supported preview/render proxy for media that is too heavy,
unsupported in the browser, remote, or not directly file-backed. The descriptor
retains the Resolve item identity and proxy provenance.

## Unsupported and ambiguous items

The first release does not silently manufacture a path for:

- Fusion compositions and generators;
- compound or multicam clips without a direct supported asset path;
- offline items;
- image sequences whose consolidation cannot be represented safely;
- remote/cloud assets not materialized locally;
- timeline-only synthetic audio/video.

The UI reports why an item is unavailable and offers a tested proxy/export path
when one exists.

## Browse and refresh

- Preserve Resolve bin hierarchy.
- Search by name, bin, type, and known metadata.
- Use explicit refresh plus bounded signature polling.
- Cancel stale enumeration when the active Resolve project changes.
- Cache thumbnails separately from the asset descriptor.
- Never use a file name as the stable identity.

## Drag/drop operation

Tauri native drag/drop is not required. `dragDropEnabled` remains unchanged.
Studio uses internal pointer/keyboard operations:

```text
Media Pool row
  -> create internal drag payload with asset ID
  -> drop target requests adapter insertion proposal
  -> show duration/track/asset mode
  -> apply one change set
```

The UI never exposes an unrestricted filesystem path as executable HTML. Asset
URLs are rewritten through the tokenized loopback project server.

## Relink and identity

An asset retains both the Resolve identity and the current path. If the path
changes:

1. match exact stable IDs inside the same project;
2. compare expected media properties and fingerprints;
3. present the proposed relink;
4. update the asset revision only after confirmation or an explicit trusted
   automatic rule;
5. invalidate preview/render/binding caches.

Path-only fuzzy matching is a recovery aid, not identity.

## Required test evidence

T02 covers nested bins, duplicate names, duplicate paths, renamed items, offline
media, sequences, video/audio/image, project switches, Unicode paths, network
paths, very large pools, cancellation, and proxy-required states.

