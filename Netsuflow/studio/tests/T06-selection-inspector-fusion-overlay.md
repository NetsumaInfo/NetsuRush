# T06: Selection, Inspector, and Fusion overlay

## Decision

Is the shared selection/property model reliable enough to expose manual and
AI-assisted element editing in NetsuFlow Studio and direct selection in Fusion?

## Prerequisites

- T01 has selected the HyperFrames editor surface and frozen exact package
  versions.
- A manual Studio session, source revision model, and host-owned history exist.
- The current OpenFX renderer and parameter lifecycle tests pass.
- Root T11 has selected an allowed Fusion interaction level.
- Resolve Studio and the renderer service are available for Fusion phases.

## Variants

<!-- markdownlint-disable MD013 -->

| Variant | Surface | Purpose |
| --- | --- | --- |
| A | SDK iframe fixture | element identity, hit testing, draft/commit baseline |
| B | NetsuRush Studio | custom overlay, Inspector, manual operations, context chips |
| C | Browser editor | lightweight selection and send-to-node behavior |
| D | Fusion Overlay V2 | host drawing, pointer input, scene snapshot, X/Y drag |

<!-- markdownlint-enable MD013 -->

## Fixtures

- static text, image, video, and nested containers;
- nested and overlapping stable `data-hf-id` elements;
- SVG, rotated and clipped elements;
- transparent image regions;
- declared variables bound to element properties;
- inline, stylesheet, inherited, and computed properties;
- static and GSAP transforms;
- runtime-created and removed elements;
- duplicate/missing IDs;
- Canvas and WebGL roots;
- 10, 100, 1,000, and 5,000 selectable elements;
- source conflict during drag and during an AI proposal.

## Procedure

### 1. Selection and identity

At fixed frames, click every fixture element and compare expected ID, tag,
parent, z-order, bounds/quad, and visible state. Repeat after seek, source
reload, save/reopen, undo/redo, and selection from another surface.

### 2. Property capability

For every selected element, compare Inspector value, authored source, edit mode,
units/range, animation status, and reset behavior against fixture expectations.
Unsupported values must explain why and remain read-only.

### 3. Manual edits

Edit text, X/Y, opacity, color, and one declared variable. Drag position in the
preview. Confirm one history entry per gesture, exact preview result, serialized
or override delta, cache invalidation, undo, redo, and reopen.

### 4. Context attachments and AI proposal

Attach one selected element, current frame, bounded source region, and one asset
independently. Inspect the structured context. Generate a proposal, preview it,
change selection before Apply, then apply or reject. The operation must remain
bound to the sent source revision and stable ID.

### 5. Fusion overlay

Draw scene bounds, hover/select, seek, change viewer zoom, and drag X/Y. Compare
overlay geometry to rendered pixels. Repeat with service unavailable, stale
snapshot, source conflict, project reopen, and node copy/paste.

### 6. Native promotion

Promote one selected X or opacity property to a stable Fusion control, keyframe
it, select another element, reorder source, remove the original, reopen, and
copy the node. The slot must retain its identity or become an explicit orphan;
it must never target the second element.

### 7. Stress and recovery

Scrub while selection is active, drag repeatedly, switch compositions, restart
the service, and open/close instances. Record stale selections, dropped commits,
wrong frames, leaks, and UI stalls.

## Pass criteria

- zero wrong-element edits;
- zero silent stale-revision applications;
- one committed operation per gesture;
- selection and edits survive save/reopen for supported cases;
- manual editing remains independent of AI availability;
- context attachments contain only the selected bounded data;
- Fusion overlay matches pixels within the documented coordinate tolerance;
- no native slot retargets a different element/property;
- unsupported Canvas/WebGL internals degrade to root selection or read-only;
- pixel rendering continues when scene metadata or inspection fails;
- no Resolve crash, deadlock, unbounded handle/memory growth, or persistent
  viewer state after node destruction.

## Evidence output

Create `results/T06-YYYY-MM-DD/` with:

- environment, Resolve, HyperFrames, browser, plugin, and app versions;
- fixture hashes;
- operation/property capability matrix;
- Inspector lifecycle matrix;
- coordinate and latency measurements;
- scene payload sizes;
- selection/undo/revision traces;
- AI context and proposed operation captures with private data removed;
- screenshots or short captures for overlay/selection claims;
- crash, memory, handle, and recovery observations;
- final `confirmed`, `constrained`, `refuted`, or `unknown` decision per surface.
