# T11: Fusion element overlay and contextual controls

## Decision

Which Fusion integration level is safe to ship: Inspector only, viewer
selection with contextual overrides, or viewer selection plus promoted native
controls?

## Prerequisites

- T01/T02 host and Inspector baselines are reproducible.
- T10 stable declared-variable mapping is implemented or instrumented.
- A scene-snapshot fixture can return stable IDs and exact frame geometry.
- Resolve Studio 21 and the current installed Developer SDK are available.

## Phase 1: Inspector lifecycle regression

Record parameter visibility, labels, values, ranges, options, status, and
mapping revision for:

- new instance;
- project save/reopen;
- node copy/paste;
- Source, Code, and Binding changes;
- Reload;
- service unavailable, delayed start, restart, and timeout;
- schema growth, shrink, type change, and overflow;
- composition switch followed by undo/redo.

The run must confirm or refute the source-inspected initial-sync gap separately
from any Resolve Inspector refresh defect.

## Phase 2: Parameter capability matrix

For every current or proposed OpenFX type, record:

- Inspector presentation and editing;
- instance label/secret/enabled/range/option refresh;
- animation/keyframe/spline support;
- `getValueAtTime()` result;
- project persistence and node copy/paste;
- scripting visibility;
- host capability-property values;
- Inspector open and interaction latency.

Test at least Double, Double2D, Integer, Integer2D, RGB, RGBA, Boolean, Choice,
String, PushButton, Group, Page, Custom, and Parametric. Unsupported types are a
valid result and must not be silently replaced.

## Phase 3: Overlay V2 host proof

Adapt the installed GainPlugin pattern minimally:

1. draw a static rectangle and label;
2. receive pointer motion/down/up;
3. update one fixed harmless parameter;
4. seek and play;
5. zoom, pan, resize the viewer, and change DPI/display scale;
6. create/destroy, save/reopen, copy/paste, and switch pages;
7. render Deliver output with the overlay active and inactive.

Record Draw Suite availability, actions, focus, coordinates, event rate,
redraw latency, crashes, deadlocks, memory, and handles.

## Phase 4: Scene metadata and hit testing

Use frame-specific snapshots for nested DOM, overlap, transparency, SVG,
rotation, clipping, GSAP motion, dynamic elements, Canvas, and WebGL.

At multiple frames, formats, render scales, and viewer states:

- compare scene bounds/quads to browser reference geometry;
- compare overlay outlines to rendered pixels;
- click overlapping targets and verify stable IDs/z-order;
- verify stale source/control/frame snapshots cannot commit;
- disconnect metadata while continuing pixel renders.

## Phase 5: Constant contextual edit

Select one stable element and drag X/Y. Verify:

- one draft sequence and one committed operation;
- one undo entry;
- exact source/override revision;
- service and plugin cache invalidation;
- visible result at forward, reverse, and random frames;
- Studio/browser editor observes the same committed state when opened later;
- source conflict preserves or rejects the draft explicitly.

## Phase 6: Native promotion

Promote one element/property pair to a permanent typed Fusion slot. Keyframe it,
then change selection, reorder source, change schema, remove the element,
save/reopen, and copy/paste the node.

The slot must retain the same stable element/property identity or become an
explicit orphan. Any retargeting is an immediate failure for native promotion.

## Stress

- 10, 100, 1,000, and 5,000 selectable elements;
- sequential, reverse, and random scrubbing with selection active;
- continuous pointer motion with coalescing;
- repeated service restart and source revision changes;
- repeated node create/destroy and project reopen;
- fixed-bank capacity boundary and overflow.

## Pass criteria

- no Resolve crash, deadlock, render corruption, or persistent viewer state;
- no wrong-element or stale-revision commit;
- overlay geometry stays within the recorded tolerance;
- pixel rendering continues when metadata fails;
- Inspector mapping restores automatically and never leaks prior schema slots;
- one committed operation per drag;
- cache keys change for every committed property revision;
- saved or copied native slots never retarget another meaning;
- every unsupported behavior produces an explicit degraded state.

## Result

Create `tests/results/T11-YYYY-MM-DD/` with environment, versions, source and
fixture hashes, Inspector matrix, host capability values, action/coordinate
traces, latency and resource measurements, screenshots/captures, persistence
records, failures, and one decision:

- `INSPECTOR_ONLY`;
- `OVERLAY_CONTEXTUAL`;
- `OVERLAY_WITH_PROMOTION`;
- `BLOCKED`.
