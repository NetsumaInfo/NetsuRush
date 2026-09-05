# T02: Inspector controls

## Question

Which OpenFX parameter types and interactions provide an acceptable Fusion experience?

## Matrix

- single-line string;
- multiline string with 1 KB, 10 KB, and 100 KB source samples;
- choice, integer, double, boolean, RGBA color, 2D point;
- push/reload action if supported by the wrapper/host;
- disabled/read-only-like status presentation;
- parameter animation and undo/redo;
- project save/reopen and copy/paste node.

OpenFX parameter support and the local wrapper's multiline type are the API baseline. [S-BMD-OFX-PARAMS]

## Observe

- editing latency and truncation;
- quoting/newlines/Unicode preservation;
- when changed values reach render callbacks;
- whether programmatic status changes refresh safely;
- whether dynamic choice contents are reliable;
- whether instance label/hint/range/increment/visibility changes refresh after a binding change;
- whether the host reports and actually supports Boolean/Choice animation;
- Inspector size and usability.

## Decision

Select the smallest production parameter set. If large source editing is poor, keep only a diagnostic snippet field and use NetsuRush as the editor.

## Pass

Binding, props, timing, mode, cache, and reload controls survive save/reopen and reliably invalidate renders.

T02 establishes host presentation behavior. T10 then validates the full
HyperFrames variable-to-keyframed-control data path.
