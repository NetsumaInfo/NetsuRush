# R05: Fusion-to-engine parameter bridge

## Questions

1. Does Resolve Studio 21 refresh parameter-instance labels, hints, visibility,
   ranges, increments, and choice options after a binding changes?
2. Which parameter types are actually keyframeable and spline-editable in
   Resolve/Fusion?
3. Can the pinned HyperFrames capture session apply different variable values
   before each arbitrary frame without page/session reinitialization?
4. Which composition patterns observe those live changes correctly?
5. What fixed bank size remains usable and below host limits?

## Known

OpenFX parameters must be defined during describe; they cannot be added
dynamically per project. [S-OFX-PARAMETERS] Labels, visibility, enabled state,
numeric ranges, increments, and choice options are writable on parameter
instances in the specification, but Resolve behavior remains an experiment.
[S-OFX-PARAM-PROPERTIES]

HyperFrames exposes typed composition-variable declarations and runtime
validation. [S-HF-VARIABLES] Its documented low-level engine loop initializes a
session and then seeks/captures frames. [S-HF-ENGINE-README] Current public
evidence does not establish universal live variable reinjection between captures.

## Experiments

### Host control bank

Build a diagnostic descriptor with fixed typed slots. On binding change, update
instance labels, hints, secret/enabled state, ranges, increments, digits, and
choice options. Observe Inspector refresh without recreating the node.

For each type, set constants, add keyframes, edit Fusion splines, undo/redo,
save/reopen, copy/paste, and render at boundary/intermediate frames.

### HyperFrames application

Compare:

1. variables supplied before session initialization;
2. SDK/editing override followed by capture;
3. page-side runtime override before `seek()`;
4. controlled reinitialization when values change.

Test compositions using declarative variable bindings and
`getVariables()`-based initialization separately.

### Load and limits

Test 8/16/32 doubles and representative mixed banks. Record host maximums,
Inspector load time, scroll length, keyframe responsiveness, project size,
render-callback overhead, and malformed/oversized schema handling.

## Exit

Choose the smallest bank and application mode that preserve manual edits,
keyframes, save/reopen stability, and cache correctness. If live reinjection
needs an opt-in runtime shim, document two compatibility tiers explicitly; do
not advertise arbitrary zero-change keyframing.

