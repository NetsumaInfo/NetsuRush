# X02: Engine switching and fallback

## Question

Can one existing NetsuFlow node move between valid HyperFrames and Remotion
bindings without another plugin, protocol fork, stale pixels, or hidden
conversion?

## Procedure

- create equivalent HyperFrames and Remotion bindings;
- assign each in turn to one node;
- change props/source while frames are cached;
- restart each worker independently;
- make one engine unavailable;
- exercise Live/Auto/Pre-render;
- attempt an explicit Remotion-to-HyperFrames migrated project;
- reject the migration and return to direct Remotion.

## Pass

- plugin identifier/binary and protocol version remain unchanged;
- engine-specific errors name the resolved engine;
- no cache entry crosses engine/revision boundaries;
- switching is explicit and recoverable;
- unavailable engine does not corrupt the other;
- migration is optional and original Remotion binding remains intact.

