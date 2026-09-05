# Studio research program

Research files define decisions that cannot be settled from documentation
alone. They state the question, current evidence, experiment, recorded metrics,
and decision rule. Results belong in dated directories under
`../tests/results/`.

## Ordered research

1. [`R01-hyperframes-editor-surfaces.md`](R01-hyperframes-editor-surfaces.md)
   determines the reusable HyperFrames UI/runtime surface.
2. [`R02-resolve-editor-bridge.md`](R02-resolve-editor-bridge.md) determines
   Media Pool, item identity, placement, and live binding behavior.
3. [`R03-ai-agent-redesign.md`](R03-ai-agent-redesign.md) replaces assumptions
   about the present agent with user-task and quality evidence.
4. [`R04-remotion-future-adapter.md`](R04-remotion-future-adapter.md) proves the
   common contracts are not accidentally HyperFrames-only.
5. [`R05-element-inspection-and-cross-surface-selection.md`](R05-element-inspection-and-cross-surface-selection.md)
   determines safe property authorability, selection persistence, Fusion
   overlay behavior, and manual/AI operation equivalence.

R01 may begin as an isolated spike after the OpenFX renderer gate passes. R02
requires Resolve Studio. R03 begins with research and fixtures but should not
ship before the manual editor exists. R04 is a contract stub first and a real
Remotion runtime later. R05 begins with the SDK fixture after T01 and requires
Resolve Studio only for its OpenFX phases.
