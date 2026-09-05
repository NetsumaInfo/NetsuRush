# T03 - Persistent frame service

## Decision

Can the NetsuRush Node core keep enough Remotion state alive to produce individual uncached frames quickly, deterministically, and safely enough for interactive updates?

The supported renderer can reuse a browser instance. Current source still creates and closes a page for each `renderStill()` call, so browser reuse and page reuse must be measured as separate variants. [S-REM-OPEN-BROWSER] [S-REM-STILL-SOURCE]

## Variants

- R0: new browser for every `renderStill()` call; control baseline.
- R1: public `renderStill()` with one reused browser.
- R2: R1 plus reused bundle/server metadata and content-addressed cache.
- R3: experimental persistent Remotion Player page, seek then capture.
- R4: browser-side `renderStillOnWeb()` comparison for supported fixtures only. Its documented rendering limitations must be reflected in compatibility scoring. [S-REM-WEB-RENDERER]

R3 must never silently replace R1 for final output until it matches R1 across the accepted fixture corpus.

## Service behaviors under test

- bundle invalidation after source, dependency, asset, and props changes;
- browser lifecycle and recovery after page/browser crash;
- bounded parallelism;
- same-frame in-flight deduplication;
- cancellation;
- sequential, reverse, and random requests;
- preview scaling;
- direction-aware prefetch;
- atomic cache publication;
- disk LRU and restart recovery.

## Procedure

1. Generate T01 references for the exact package versions used here.
2. Measure initialization and selected-frame latency for R0-R4 across F00-F09.
3. Run cold sequential requests for frames 0-99.
4. Repeat the same sequence warm from cache.
5. Run frames 99-0.
6. Run 200 seeded random requests with 10% duplicate requests.
7. Request one frame concurrently from 2, 4, and 8 clients; verify one rendered result and identical responses.
8. Cancel during bundle, page initialization, media readiness, capture, and file publication.
9. Modify source, props, local font, local image, and package lockfile one at a time; verify invalidation.
10. Kill the browser and then the Node worker; verify bounded recovery and an explicit error to callers.
11. Run 500 seeks and inspect memory stabilization.
12. Compare every R3/R4 accepted frame against R1, not only visually but through the shared pixel metrics.

## Required evidence

- per-variant latency histograms and raw timing CSV;
- peak/steady memory and process count;
- browser/page creation counters;
- cache hit, miss, invalidation, and eviction logs;
- cancellation and crash-recovery logs;
- visual difference reports against R1;
- cache directory manifest with hashes.

## Pass gates

- R1 output matches T01 references.
- Cache keys invalidate on every pixel-affecting input tested.
- Concurrent identical requests publish one valid cache entry.
- Cancelled/failed work never appears as a cache hit.
- Browser crash recovery does not require restarting NetsuRush or Resolve.
- Cached delivery meets the shared target.
- At least one correctness-preserving variant meets the uncached interactive-update target for F00-F04.
- Memory after 500 seeks stabilizes after warm-up and does not show unbounded page/process growth.

## Interpretation

- R1 fast enough: use supported renderer semantics for the live/update service.
- R1 slow, R3 correct and faster: keep R3 experimental for preview and R1 for final render.
- Only cache fast: use explicit `Update` plus pre-render/prefetch; do not promise live cold scrubbing.
- All uncached variants slow: retain A1 and stop pursuing per-frame rendering until upstream renderer behavior changes.

## Product decision effect

T03 selects renderer lifecycle and cache behavior. It does not select the Fusion adapter; T04 does that separately.
