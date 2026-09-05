# T06 - Explicit hybrid composition

## Decision

Can author-declared native and rendered sections be combined without timing, geometry, alpha, layer-order, or cache-invalidation errors?

This protocol explicitly excludes automatic partitioning of arbitrary React output.

## Proposed boundary model

One of these contracts may be tested:

```tsx
<NativeLayer id="title">...</NativeLayer>
<RenderedLayer id="three-scene">...</RenderedLayer>
```

or a manifest with ordered layers:

```json
{
  "layers": [
    {"id": "background", "mode": "native"},
    {"id": "three-scene", "mode": "render"},
    {"id": "title", "mode": "native"}
  ]
}
```

Rendered layers must have an explicit isolated canvas, alpha contract, time range, coordinate system, and z-order. A rendered child may not depend on an unrendered native parent's CSS layout or inherited effects.

## Preconditions

- T01 passes.
- T05 passes for at least text, transform, opacity, and timing.
- At least one rendered-layer path from T02 or T03/T04 passes.

## Procedure

1. Create H00: native text over one rendered transparent layer.
2. Create H01: rendered layer between two native layers.
3. Animate all layers over overlapping time ranges.
4. Test clip start offsets, trims, reverse/random seeks, and mismatched local durations.
5. Test parent-level opacity, mask, and color correction only when explicitly applied after the merge in Fusion.
6. Modify only the native title and verify the rendered-layer cache remains valid.
7. Modify only the rendered Three.js fixture and verify native graph identity remains stable.
8. Export the combined Fusion output and compare it with one official full Remotion reference composition.
9. Reopen the project without NetsuRush running; document offline behavior for already rendered assets and live layers.

## Required evidence

- boundary manifest/IR;
- generated Fusion graph and ordered node list;
- cache dependency graph;
- frame comparisons at every overlap boundary;
- invalidation logs;
- reopen/offline behavior report.

## Pass gates

- Layer order, alpha, transform, and timing match the official full-render reference.
- Native-only edits do not rerender independent rendered layers.
- Rendered-only edits do not rewrite unrelated native nodes.
- Unsupported cross-boundary dependencies fail with a clear diagnostic.
- The resulting Fusion graph remains understandable.

## Rejection triggers

- Correctness requires inspecting arbitrary runtime DOM relationships.
- Cache invalidation regularly expands to the whole composition without user benefit.
- The hybrid graph is less understandable than a single rendered source.
- Visual equivalence cannot be maintained at boundary masks/blends.

## Product decision effect

A passing result permits an explicit `Auto` or `Hybrid` mode for projects authored to the NetsuFlow contract. It does not justify automatic conversion of existing arbitrary Remotion projects.
