# T03: Resolve publishing

## Question

Can Studio publish and recover both live NetsuFlow bindings and flattened
renders in Resolve?

## Scenarios

### Rendered

- render/import only;
- render/import/insert at explicit record frame;
- alpha and opaque artifacts;
- non-zero timeline start timecode;
- mismatched composition/timeline fps and resolution;
- update through a new versioned artifact;
- multiple uses of the prior MediaPoolItem remain untouched;
- disconnect/project switch/cancel at every transaction step;
- repair every partial state;
- save/reopen and Resolve restart.

### Live

- insert NetsuFlow OFX Generator by exact name;
- locate and set binding if the API permits;
- manual assignment fallback if it does not;
- constant and keyframed exposed parameters;
- source revision invalidation;
- duplicate timeline, copy/paste, save/reopen, restart;
- renderer unavailable/recovery and cached diagnostic behavior.

## Measurements

- placement and duration frame equality;
- alpha/color parity sample frames;
- publish latency and render contribution;
- identity survival and repair rate;
- number of manual steps;
- failure artifact inventory;
- unintended changes to other timeline/media items.

## Pass

Rendered publishing must pass for the first Studio release. Live publishing
passes either as automatic insertion/binding or as an honest guided assignment
workflow. No test may alter unrelated timeline uses.

