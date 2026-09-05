# RM01: Persistent Remotion lifecycle

## Known

`renderStill()` accepts a frame, composition, props, output format, and reusable
browser. [S-REM-STILL] [S-REM-OPEN-BROWSER] Its current implementation still
creates/closes page resources per call. [S-REM-STILL-SOURCE]
`renderFrames()` reuses a page pool across ranges. [S-REM-RENDER-FRAMES]

Renderer and project packages must share one exact Remotion version.
[S-REM-VERSION-MATCH]

## Experiments

1. Cold official `renderStill()`.
2. Warm browser plus `renderStill()`.
3. Sequential/reverse/random frames.
4. `renderFrames()` small ranges for prefetch/pre-render.
5. Bounded browser/page pool.
6. Only if required, a version-pinned internal persistent-page experiment.

Load matching renderer packages from the fixture project. Measure bundle,
browser, page/navigation, seek, capture, encode, decode, transport, memory, and
cleanup independently.

## Exit

Select the lowest-complexity public lifecycle that passes the common engine
conformance suite. A negative live result moves Remotion to Auto/pre-render; it
does not require a different OpenFX plugin.

