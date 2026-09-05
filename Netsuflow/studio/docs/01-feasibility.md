# Feasibility

## Conclusion

The custom editor is technically feasible. HyperFrames exposes the right
categories of building blocks, Resolve exposes enough external scripting for
media discovery and timeline delivery, and NetsuRush already has the required
Tauri/Node/Resolve process boundary. The complete user experience is not yet
proven because several host-specific interactions require measured prototypes.

## Confirmed by official interfaces

### HyperFrames

- The SDK can open HTML, find stable elements, mutate text/style/attributes,
  emit patches, serialize source, and dispose the composition.
  [ST-HF-SDK-OPEN] [ST-HF-SDK-EDIT]
- An iframe preview adapter can reflect canvas edits. [ST-HF-SDK-CANVAS]
- The adapter documents `data-hf-id` hit testing, selection, draft translation,
  and a single committed move operation. [ST-HF-SDK-CANVAS]
- Sparse overrides and host-owned undo/redo are supported. [ST-HF-OVERRIDES]
- The Player provides isolated, seekable playback. [ST-HF-OVERVIEW]
- The Studio package exports preview, timeline, source, property, and file-tree
  building blocks, while warning that they require state and callbacks rather
  than acting as a drop-in editor. [ST-HF-STUDIO]
- The Studio server exposes an adapter boundary for custom hosts.
  [ST-HF-STUDIO-SERVER]

### Resolve

- Projects expose the Media Pool and current timeline.
- Media Pool folders and items can be enumerated.
- Media items expose stable IDs, properties, and metadata.
- Files can be imported and placed at explicit timeline positions.
- A timeline can insert an OFX Generator by name.
- The installed OpenFX SDK includes Overlay V2 support and a Draw Suite example;
  the proposed Generator interaction remains subject to an in-host test.
  [ST-BMD-OFX-OVERLAY]
- Timeline, item, and marker IDs/custom data can support relationship tracking.

These are present in the installed current SDK. [ST-BMD-SCRIPTING-LOCAL]

### NetsuRush

- The existing external scripting bridge already polls Resolve and returns Media
  Pool assets in one Python round trip, with a proxy fallback. [ST-NR-MEDIA]
- The persistent Node core is the right owner for project files, HyperFrames
  ESM workers, browser sessions, render jobs, and Resolve calls. [ST-NR-ARCH]
- The existing NetsuFlow binding keeps source code outside the OpenFX node and
  lets the node request pixels for an opaque binding. [ST-NF-OFX]

## Feasible with explicit restrictions

### Arbitrary source

Arbitrary HyperFrames projects can open in code + preview mode. Visual
inspection and mutation require stable identities and known editing
affordances. A dynamic script that creates elements at runtime may be previewed
and rendered without being representable as editable timeline rows.

The product therefore has three capability levels:

| Level | Experience | Requirement |
|---|---|---|
| Renderable | preview and publish | valid finite HyperFrames composition |
| Inspectable | selection and properties | stable discoverable DOM identities |
| Structurally editable | timeline and visual mutations | supported timing/source patterns |

Unsupported visual editing must degrade to code editing, never source damage.

### Resolve assets

File-backed Media Pool items can become project asset references. Generated,
offline, compound, remote, or otherwise non-file-backed items need a proxy,
still, render, or explicit unsupported state. Media Pool access is not a raw
pixel-streaming API.

### Timeline synchronization

Publishing a rendered file is supported by documented import and append APIs.
Inserting an OFX Generator is documented. Automatically selecting the inserted
NetsuFlow tool and assigning its binding parameter remains an experiment.

Resolve's public scripting documentation does not define a general event
subscription stream for project/timeline/media changes. The initial design uses
bounded polling plus explicit refresh and stable fingerprints, matching the
current NetsuRush architecture. [ST-NR-ARCH]

## Open questions

1. Which `@hyperframes/studio` exports can be themed and composed without
   importing the complete application state?
2. Can Studio source mutations and the SDK coexist with an external code editor
   without losing cursor, selection, or undo history?
3. How do nested compositions and GSAP keyframes surface through the current
   timeline components?
4. Can WebView2 safely preview local user assets through NetsuFlow's tokenized
   project server?
5. Can the inserted OFX Generator be configured automatically through the
   Fusion scripting surface on every supported Resolve version?
6. What is the correct update path for an existing flattened timeline result
   without changing unrelated uses of the MediaPoolItem?
7. What source-change latency remains acceptable while Resolve and Studio share
   the same HyperFrames worker/cache?
8. Which computed DOM/SVG properties can be mapped back to safe authored
   operations, and which must remain read-only?
9. Does Resolve preserve and refresh the proposed overlay/parameter state over
   create, save/reopen, copy/paste, and service restart?

Each question maps to an experiment under `studio/tests/`.
