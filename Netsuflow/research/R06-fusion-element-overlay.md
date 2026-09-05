# R06: Fusion element overlay and contextual controls

## Decision

Can the current NetsuFlow OpenFX Generator expose reliable viewer selection and
contextual element editing in Resolve Studio without weakening rendering,
parameter persistence, or cache correctness?

## Confirmed evidence

- OpenFX parameters are defined during describe and cannot be created later for
  an arbitrary composition. [S-OFX-PARAMETERS]
- OpenFX overlay interacts define drawing and pointer actions.
  [S-OFX-INTERACTS]
- Resolve 21's installed SDK contains Overlay V2 support and a GainPlugin Draw
  Suite example. [S-BMD-OFX-OVERLAY]
- HyperFrames supplies stable `data-hf-id` hit testing and draft/commit movement
  in a same-origin browser preview. [S-HF-SDK-CANVAS]
- NetsuFlow already renders pixels out of process and owns a fixed typed control
  bank. [S-NF-OPENFX]

These interfaces establish feasibility, not stable host behavior.

## Open questions

1. Does the Resolve Generator context instantiate Overlay V2 and deliver draw,
   focus, and pointer actions consistently?
2. Which viewer coordinate properties remain correct across zoom, pan, DPI,
   render scale, format, and contain placement?
3. Can overlay actions update parameters without render-thread contention or
   undo/persistence anomalies?
4. How does the plugin request frame-specific scene metadata without blocking
   ordinary renders?
5. Can selected IDs and promoted element/property slots survive save/reopen,
   copy/paste, binding changes, source revisions, and deleted elements?
6. Does Resolve reliably refresh instance-level label, visibility, range, and
   choice-option changes after create and project restoration?
7. What are the usable parameter count, Inspector latency, project-size, and
   keyframe costs for larger fixed banks?

## Competing architectures

### A. Inspector only

Keep declared variables in the current fixed bank and perform all element
selection in Studio. Lowest host risk, but no direct Fusion manipulation.

### B. Overlay selection plus contextual overrides

Draw and hit-test element metadata in Fusion, then commit safe constant edits as
HyperFrames overrides. This is the recommended first overlay architecture.

### C. Overlay plus native promotion

Allow an explicit selected element/property pair to consume a permanent Fusion
slot and become keyframeable. Best integration, highest persistence and
capacity risk. It follows B only after stable mapping is proven.

## Closure test

[`../tests/T11-fusion-element-overlay.md`](../tests/T11-fusion-element-overlay.md)
tests Inspector lifecycle first, then Overlay V2, scene coordinates, edits,
cache invalidation, persistence, and native promotion.

## Decision rule

- Choose A if Resolve overlay or coordinate behavior is unstable.
- Choose B when selection and constant edits are stable but native promotion
  cannot preserve identity.
- Choose C only when saved keyframes cannot retarget after selection or source
  changes.
- Pixel rendering must remain usable in every degraded mode.
