# Remotion adapter architecture

## Status

Preserved future engine. It is not the first renderer implementation, and no
current Remotion research or source evidence is discarded.

```text
BindingSnapshot(engine=remotion)
 -> load compatible renderer from project
 -> bundle/select composition
 -> reusable browser and measured page/range strategy
 -> explicit frame capture
 -> PNG validation/decode
 -> canonical RGBA8
 -> common cache/bridge/OpenFX
```

## Why it fits the common contract

Remotion exposes explicit frame rendering, composition selection with props,
browser reuse, frame-range rendering, and transparent output.
[S-REM-STILL] [S-REM-SELECT] [S-REM-OPEN-BROWSER]
[S-REM-RENDER-FRAMES] [S-REM-ALPHA]

The OpenFX plugin therefore needs no Remotion-specific field. The binding selects
the adapter, and the adapter returns the same descriptor/frame/error types as
HyperFrames.

## Engine-specific constraints

- all Remotion packages in a project must use exactly one version;
  [S-REM-VERSION-MATCH]
- the service should load the project's matching renderer and refuse unsupported
  adapter versions precisely;
- public `renderStill()` page lifecycle must be benchmarked rather than assumed
  interactive; [S-REM-STILL-SOURCE]
- licensing and redistribution require a fresh product review;
  [S-REM-LICENSE-TERMS]
- arbitrary React/DOM/CSS/Canvas/WebGL/npm behavior is rendered, never translated
  into Fusion nodes.

## Optimization ladder

1. Official `renderStill()` with reusable browser.
2. Common encoded and decoded caches.
3. Official `renderFrames()` for directional prefetch/pre-render.
4. Bounded browser/page pool.
5. Version-pinned internal optimization only if public APIs miss targets.
6. Pre-render fallback.

## Boundary

A Remotion adapter is the compatibility path for projects that cannot or should
not be migrated. Optional conversion to HyperFrames is separate and must never
replace this direct renderer without explicit user choice and visual validation.

