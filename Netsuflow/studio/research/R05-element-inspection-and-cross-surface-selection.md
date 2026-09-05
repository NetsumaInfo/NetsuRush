# R05: Element inspection and cross-surface selection

## Decision

Can NetsuFlow provide reliable element selection, property inspection, and
typed manual/AI edits across the browser preview, NetsuRush Studio, and Fusion
without corrupting arbitrary HyperFrames source?

## Current evidence

- HyperFrames documents same-origin iframe hit testing against `data-hf-id`,
  selection events, draft translation, and one committed move operation.
  [ST-HF-SDK-CANVAS]
- The SDK documents stable element queries, text/style/attribute mutations, and
  source serialization. [ST-HF-SDK-OPEN] [ST-HF-SDK-EDIT]
- Embedded override mode supports sparse deltas and host-owned undo/redo through
  patch and inverse-patch events. [ST-HF-OVERRIDES] [ST-HF-UNDO]
- OpenFX defines fixed parameters during describe and supports viewer overlays
  with draw and pointer actions. [ST-OFX-PARAMETERS] [ST-OFX-INTERACTS]
- Resolve 21 ships an Overlay V2 GainPlugin example using the Draw Suite.
  [ST-BMD-OFX-OVERLAY]
- The current NetsuFlow plugin has a fixed typed bank, but source inspection
  shows no initial variable sync in its instance constructor. Mapping currently
  occurs only after Source/Code/Binding/Reload changes. [ST-NF-OFX]
- Root research R06 and T11 own the independent Resolve/OpenFX feasibility gate;
  this note owns the shared application model and cross-surface behavior.

## Questions

1. Which HyperFrames package exports used by hit testing and embedded override
   mode exist in the exact pinned version selected for Studio?
2. Can the iframe preview retain stable IDs and selection through seek, source
   refresh, nested compositions, and dynamic element creation?
3. Which DOM/SVG properties have a safe authored mutation target rather than
   only a computed runtime value?
4. How should nested, overlapping, transparent, clipped, and rotated elements
   be represented and hit-tested?
5. Can Resolve's Overlay V2 draw and pointer actions be used in the Generator
   context without viewer, render, or teardown instability?
6. Does Resolve refresh per-instance labels, visibility, ranges, and choice
   options after project open and service reconnect?
7. Which parameter types are keyframeable, spline-editable, persistent, and
   script-visible in the supported Resolve versions?
8. Can a stable element/property mapping survive save/reopen, node copy/paste,
   source revision changes, and deleted elements without retargeting keyframes?
9. What compact scene metadata contract keeps Fusion overlays frame-accurate
   without sending a complete DOM on every render?
10. Can manual and AI edits share one operation/change-set model without making
    simple edits slower or agent-dependent?

## Experiment phases

### Phase A: SDK and authorability matrix

Build an isolated same-origin fixture using the exact pinned HyperFrames SDK.
For every fixture element, record:

- stable ID and nearest selectable ancestor;
- hit-test result;
- computed value;
- authored origin;
- supported edit operation;
- patch/inverse patch;
- serialized/override result;
- selection restoration after reload.

Fixtures include inline styles, stylesheet rules, inherited styles, CSS custom
properties, GSAP transforms, nested SVG, transparent PNG regions, dynamic DOM,
Canvas, WebGL, nested compositions, and invalid source retaining last-good
preview.

### Phase B: Inspector lifecycle in Resolve

Instrument the current fixed bank and record the lifecycle matrix:

```text
create
save/reopen
copy/paste
Source switch
Code edit
Binding edit
Reload
service restart
service starts after Resolve
schema grows/shrinks
pool overflow
invalid DESCRIBE
```

For each step capture visible/secret/enabled state, label, range, option list,
value, keyframes, status text, mapping revision, and plugin/service logs.

The test must distinguish the confirmed missing initial sync from any separate
Resolve Inspector refresh defect.

### Phase C: OpenFX overlay proof

Execute the root
[`../../tests/T11-fusion-element-overlay.md`](../../tests/T11-fusion-element-overlay.md)
host proof. Use the installed Resolve GainPlugin Overlay V2 pattern as the
minimum source:

1. draw a static rectangle and text;
2. receive pointer move/down/up;
3. update one harmless fixed parameter from the interaction;
4. seek and transform the viewer;
5. save/reopen and copy the node;
6. run repeated create/destroy and timeline playback.

Record Draw Suite availability, coordinate spaces, render scale, DPI, viewer
zoom, event frequency, focus behavior, redraw latency, crashes, and leaks.

### Phase D: Scene snapshot and coordinate fidelity

The HyperFrames service returns a bounded frame-specific scene snapshot. Compare
its bounds/quads against browser reference output and the Fusion overlay at
multiple resolutions, aspect ratios, viewer zooms, render scales, and node
formats.

The overlay and pixel placement must call one shared Fit/contain transform
implementation or pass an exact transform matrix in the snapshot response.

### Phase E: Cross-surface edit and undo

Select the same element from Studio, browser editor, and Fusion. Move it, edit a
safe property, undo, redo, change source externally, and reopen. Confirm:

- one stable selection identity;
- one operation per gesture;
- exact source/override revision;
- no stale frame cache hit;
- no silent rebase;
- no retargeting after element deletion or ID collision.

### Phase F: AI context attachments

Run a fixed corpus with and without an agent:

1. manually make a selected title red;
2. ask the agent to make the attached title red;
3. attach one frame and request alignment of two selected elements;
4. attach a bounded code block and request a timing repair;
5. change source while a proposal is pending;
6. attach a deleted/stale element;
7. request an unsupported Canvas-internal edit.

Compare resulting operation equivalence, unrelated edits, latency, context
size, preview correctness, repair turns, and conflict behavior.

## Recorded metrics

- SDK/package versions and export fingerprint;
- element count and scene payload bytes;
- hit-test, property extraction, overlay draw, and commit latency;
- pointer events received/coalesced;
- browser, service, Resolve, and plugin memory/handle trends;
- source/override byte delta per edit;
- selection restoration success rate;
- property capability classification accuracy;
- wrong-element and stale-revision count;
- cache invalidation correctness;
- project save/reopen and copy/paste fidelity;
- AI operation validity, unrelated edit count, context bytes, latency, and cost.

## Decision rules

- Ship browser/Studio single selection only when stable IDs, hit testing, undo,
  and source revision conflicts are deterministic for supported DOM/SVG cases.
- Ship Fusion selection only when Overlay V2 and coordinate fidelity pass on the
  supported Resolve versions; otherwise keep Studio selection and native
  declared-variable controls.
- Ship direct manipulation only for properties with a validated authored target
  or explicit sparse override.
- Ship native promotion only when slot persistence cannot retarget keyframes.
- Keep Canvas/WebGL at root-surface selection until an explicit adapter contract
  is proven.
- Do not give an AI broader source access because visual authorability is
  missing; it may propose a bounded source patch with diff and preview instead.
