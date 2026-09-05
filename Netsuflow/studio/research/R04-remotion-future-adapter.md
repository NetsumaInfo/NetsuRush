# R04: Remotion future adapter

## Decision

Does the common Studio contract genuinely allow a later Remotion adapter, or do
HyperFrames assumptions leak into project, preview, asset, parameter, publish,
and agent layers?

## Evidence

Remotion offers an embeddable React Player and a renderer for a selected frame.
[ST-REM-PLAYER] [ST-REM-STILL]

This does not prove structural source editing or visual timeline equivalence.

## Contract-stub experiment

Before hardening the HyperFrames UI, implement a fake Remotion adapter that:

- returns one project and composition;
- advertises preview/code/props but no canvas/timeline editing;
- returns deterministic preview frames;
- accepts a props change set;
- creates the common binding and render artifact records;
- emits Remotion-specific diagnostics.

Run the same UI and publish-contract tests used by HyperFrames. No Remotion
runtime dependency is needed for this first leakage test.

## Real-runtime experiment

Later, replace the stub with a minimal pinned Remotion fixture using Player,
composition selection, props, and `renderStill()`. Do not attempt arbitrary AST
conversion in this experiment.

## Decision rule

The common contract passes when adding the stub and real adapter requires no
branch inside Resolve, publish records, asset catalog, OpenFX protocol, or
generic Studio shell. Capability-driven UI differences are expected.

