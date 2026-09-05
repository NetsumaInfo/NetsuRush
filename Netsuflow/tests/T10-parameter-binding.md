# T10: Fusion parameter binding

## Question

Can HyperFrames variables become stable native Fusion controls that support both
constant editing and keyframe animation without stale frames?

## Fixture schema

```json
[
  {"id":"speed","type":"number","label":"Speed","default":1,"min":0,"max":3,"step":0.05,"unit":"x"},
  {"id":"size","type":"number","label":"Size","default":100,"min":10,"max":500,"step":1,"unit":"px"},
  {"id":"enabled","type":"boolean","label":"Enabled","default":true},
  {"id":"accent","type":"color","label":"Accent","default":"#ff3366"},
  {"id":"style","type":"enum","label":"Style","default":"soft","options":[
    {"value":"soft","label":"Soft"},
    {"value":"hard","label":"Hard"}
  ]}
]
```

The rendered frame includes machine-readable patches encoding each effective
value so automation can distinguish a correct update from a visually plausible
stale frame.

## Host matrix

- double, integer presentation, Boolean, RGB, 2D point, choice, short string;
- constant edit;
- two and five keyframes;
- linear and curved interpolation where supported;
- rapid scrub, reverse, random, repeated frames;
- dynamic label/hint/range/step/choice/visibility refresh;
- binding switch;
- undo/redo;
- save/reopen;
- node copy/paste;
- schema overflow and remapping;
- service unavailable/restarted during parameter change.

## HyperFrames matrix

- variables at initialization;
- different values on consecutive captures in one session;
- different values on reverse/random captures;
- declarative variable bindings;
- composition reading `getVariables()` during initialization;
- opted-in NetsuFlow frame-control shim;
- reinitialize-on-change fallback;
- Live/Auto/Pre-render.

## Assertions

- The value read with `getValueAtTime(renderTime)` matches Fusion's displayed
  curve result.
- Every request contains schema revision and canonical control-values hash.
- The returned frame encodes exactly the effective values for that frame.
- Plugin last-frame, service memory/disk, and pre-render caches never cross
  control-value hashes.
- Stable slot assignment survives save/reopen and copy/paste.
- Enum storage uses stable values, not display indices alone.
- Invalid/NaN/infinite/out-of-range/oversized values are rejected or clamped only
  by an explicit schema rule.
- Unused slots remain hidden/disabled where the host supports it.
- No control change blocks Resolve indefinitely.

## Pass

Manual editing and keyframed animation work for the supported control types,
values reach HyperFrames before seek/capture, cache invalidation is exact, and
the supported compatibility tier is stated honestly.

A pass may be conditional if existing projects require reinitialization while
NetsuFlow-authored projects support the frame-control shim. That distinction
must appear in product UI and documentation.

