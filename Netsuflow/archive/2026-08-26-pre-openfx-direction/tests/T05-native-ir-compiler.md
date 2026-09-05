# T05 - Native IR compiler

## Decision

Can a deliberately constrained Remotion-like syntax compile to editable Fusion nodes while remaining visually honest and diagnostically strict?

Babel and the TypeScript Compiler API can parse and inspect JSX/TypeScript source. They do not supply browser layout or a Fusion semantic model, so the test defines both explicitly. [S-BABEL-PARSER] [S-BABEL-TRAVERSE] [S-TS-COMPILER]

NetsuRush's existing `.comp` export/rewrite/import path is the candidate backend. [S-NR-FUSION-APPLY] [S-NR-FUSION-COMP]

## Prototype language

Only explicit NetsuFlow primitives are accepted initially:

```text
Composition
Layer
Text
Image
Rectangle
Ellipse
Sequence
Transform
Opacity
Blur
Glow
interpolate
spring
```

Arbitrary `div`, CSS layout, DOM measurement, Canvas, WebGL, Three.js, network calls, arbitrary hooks, and external React components must produce a structured unsupported-feature diagnostic.

## IR responsibilities

The IR must encode:

- canvas dimensions, fps, and duration;
- ordered layers and explicit parent relationships;
- local/global frame intervals;
- coordinate system, anchor, and transform order;
- opacity and blend semantics;
- text/font properties that have a defined Fusion mapping;
- local assets;
- animation functions and extrapolation behavior;
- masks and supported effects;
- fallback boundary metadata.

The IR must not contain Python, Lua, JSX, or Fusion `.comp` syntax.

## Procedure

1. Define a JSON Schema for the smallest IR needed by F00.
2. Parse F00 and emit a normalized, stable IR document.
3. Reject one unsupported construct with source location and remediation.
4. Compile the IR into a Fusion graph using the existing composition seam.
5. Render the Fusion graph and compare selected frames to T01.
6. Add `Sequence`, `interpolate()`, then the selected `spring()` definition one at a time.
7. Add text, image, rectangle, ellipse, blur, glow, and masks only after each prior primitive passes.
8. Test frame boundaries, negative local time, extrapolation, anchors, transform order, and nested sequences.
9. Modify generated nodes manually in Fusion; verify the graph remains understandable and editable.
10. Recompile into a fresh composition and verify deterministic graph text apart from known host-generated identifiers.

## Required evidence

- supported-language grammar/specification;
- IR JSON Schema and golden IR fixtures;
- unsupported-feature diagnostics;
- generated `.comp` files and graph screenshots;
- per-primitive visual difference reports;
- node-count and generation-time metrics;
- manual editability notes from Fusion.

## Pass gates

- Unsupported syntax fails closed; it is never silently rendered differently.
- F00-F02 equivalents built only from supported primitives meet the shared visual thresholds.
- Frame 0, final frame, sequence boundaries, and spring settling frames map correctly.
- Generated tools and splines are editable and sensibly named.
- Repeated compilation is deterministic.
- The supported subset can be explained in one concise compatibility document.

## Rejection triggers

- Correctness requires emulating a general browser layout engine.
- Unsupported constructs leak through as plausible but incorrect nodes.
- Fusion and Remotion spring/interpolation behavior cannot be reconciled within the declared subset.
- Generated graphs are technically native but too opaque to be meaningfully edited.

## Product decision effect

- Pass with user value: add an optional `Native` mode.
- Pass without meaningful editability benefit: retain the IR only as an internal experiment.
- Fail: keep official rendering and OGraf; do not replace the IR with syntax transpilation.
