# H03: HyperFrames cache, scrubbing, and soak

## Question

Can HyperFrames remain useful and bounded under Resolve-like frame traces?

## Traces

- repeated same frame;
- forward/reverse scrub;
- seeded random jumps;
- short loop;
- rapid props edits and source revision changes;
- two/four bindings;
- worker/browser kill during capture;
- 10,000 requests after cache/session limits are reached;
- full pre-render of representative short compositions.

## Variants

- one session per binding;
- bounded page/browser pool only after baseline;
- prefetch off/on;
- Live, Auto, and Pre-render;
- cold, warm, memory hit, disk hit.

## Pass

- no stale frames after revision changes;
- no unbounded memory, handles, sessions, queue, or waits;
- requested work always outranks prefetch;
- worker restart does not require Resolve restart;
- cached-hit target remains met;
- measurements support an honest Live/Auto/Pre-render product default.

If misses remain slow but pre-render is robust, mark Live as limited rather than
failing the entire bridge.

