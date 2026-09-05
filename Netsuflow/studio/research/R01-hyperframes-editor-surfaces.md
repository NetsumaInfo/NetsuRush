# R01: HyperFrames editor surfaces

## Decision

Which HyperFrames packages and exports should NetsuFlow adopt for its custom
editor, and which should be replaced by NetsuRush-owned components?

## Current evidence

- SDK + Player is the documented starting point for a custom editor.
  [ST-HF-OVERVIEW]
- Studio exports complete and lower-level React components, but the lower-level
  parts require Studio state/callbacks and are not a drop-in editor.
  [ST-HF-STUDIO]
- SDK supports patches, overrides, source mutations, and iframe integration.
  [ST-HF-SDK-OPEN] [ST-HF-SDK-CANVAS] [ST-HF-OVERRIDES]
- Current NetsuRush React/Zustand versions satisfy the reported peer ranges.
  [ST-NR-PACKAGE]

## Questions

1. Which documented exports import and render in the current Vite/Tauri build?
2. What global CSS, Tailwind preset, context, and store dependencies leak in?
3. Can NetsuRush own state, selection, shortcuts, dialogs, history, and theme?
4. Can the timeline edit a caller-owned project through public callbacks?
5. Can preview retain playhead/selection after source refresh?
6. Can large timelines remain responsive in WebView2?
7. Which operations are source-safe for dynamic compositions?
8. What bundle/runtime footprint does each adopted layer add?

## Experiment

Implement T01 as an isolated route/fixture before adding a production module.
Test three variants against the same project:

- A: `StudioApp` reference baseline only;
- B: custom NetsuRush shell with selected Studio components;
- C: custom shell with SDK + Player and a minimal custom timeline.

Record behavior, dependency graph, bundle delta, preview latency, source
round-trip, keyboard conflicts, theming gaps, and memory after repeated open/
close cycles.

## Fixtures

- basic text/image/video/audio clips;
- nested compositions;
- declared variables;
- static and GSAP animated elements;
- dynamic runtime-created elements;
- invalid source retaining last valid preview;
- 10, 100, 1,000, and 5,000 timeline elements;
- Unicode project and asset paths.

## Decision rule

Adopt variant B only when each chosen component has public imports, caller-owned
state, acceptable styling, no unbounded global side effects, and a documented
fallback. Otherwise adopt variant C for that component.

Do not adopt `StudioApp` as the product shell regardless of benchmark outcome.

