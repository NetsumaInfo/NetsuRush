# Active research questions

This directory separates unresolved research from product specification.
Research notes identify evidence, competing hypotheses, and the test that closes
the question.

ID convention: a research note and the test that closes it deliberately share an
ID, so `H01` names both the HyperFrames session-baseline question here and the
gate in `tests/engines/hyperframes/`. Remotion notes and tests use `RM` to keep
them distinct from the common `R0x` host-contract notes.

## Common

| Note | Question | Closure test |
|---|---|---|
| [`R01-openfx-host-contract.md`](R01-openfx-host-contract.md) | How does Resolve actually call the Generator? | T01, T02, T07 |
| [`R03-transport-selection.md`](R03-transport-selection.md) | Is the existing raw TCP path sufficient with a real engine? | HyperFrames H02/H03, T05 |
| [`R04-plugin-installation.md`](R04-plugin-installation.md) | Can install/update/removal stay per-user? | T08, T09 |
| [`R05-fusion-parameter-bridge.md`](R05-fusion-parameter-bridge.md) | Can typed HyperFrames variables become native, keyframeable Fusion controls? | T02, T10 |
| [`R06-fusion-element-overlay.md`](R06-fusion-element-overlay.md) | Can Fusion safely select and edit rendered HyperFrames elements? | T11 |

## HyperFrames

| Note | Question | Closure test |
|---|---|---|
| [`H01-engine-api-stability.md`](hyperframes/H01-engine-api-stability.md) | Which exact public APIs can NetsuFlow safely wrap? | HyperFrames H01 |
| [`H02-capture-modes-and-alpha.md`](hyperframes/H02-capture-modes-and-alpha.md) | Which capture/decode path is correct and fastest? | HyperFrames H02, T06 |
| [`H03-session-performance.md`](hyperframes/H03-session-performance.md) | Which persistent session/pool lifecycle is stable? | HyperFrames H01/H03, T05/T07 |

## Remotion

| Note | Question | Closure test |
|---|---|---|
| [`RM01-renderer-lifecycle.md`](remotion/RM01-renderer-lifecycle.md) | Which public renderer lifecycle is fast and supportable? | RM01, T05 |

Resolved findings move into `docs/`; raw measurements stay in dated reports.
