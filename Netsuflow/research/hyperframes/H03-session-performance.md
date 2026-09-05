# H03: HyperFrames persistent-session performance

## Known

A capture session retains Browser and Page, and HyperFrames also implements
browser pooling/leases. [S-HF-FRAME-CAPTURE-SOURCE] [S-HF-BROWSER-MANAGER]

## Competing lifecycles

1. One browser/page session per active binding revision.
2. One browser with several bounded pages.
3. Documented browser pool with leased sessions.
4. Worker-per-project with idle eviction.
5. Full pre-render for compositions whose misses remain too slow.

## Workloads

- first session/first frame;
- 300 sequential frames;
- reverse scrub;
- 1,000 seeded random frames;
- repeated same frame;
- rapid props/source invalidation;
- two and four bindings;
- browser crash and worker restart;
- 10,000-request soak after caches reach bounds;
- embedded media and WebGL stress.

Measure latency distributions, stage timings, CPU/GPU, private/working memory,
handles, child processes, queue depth, cancellations, and teardown.

## Exit

Adopt the simplest lifecycle with stable resource use and correct arbitrary
seeks. If no live lifecycle is acceptable, retain the same adapter but make
Auto/pre-render the supported product mode.

