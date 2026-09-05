# T04 - Fusion host adapters

## Decision

Which Fusion/Resolve boundary can expose the selected renderer path without blocking, destabilizing Resolve, or making packaging unreasonable?

## Adapter matrix

### H1 - Resolve script plus Loader/MediaIn

NetsuRush renders files, then uses the existing Resolve bridge to create/import a Fusion composition containing a Loader or timeline media item.

Resolve scripting documents Fusion composition insertion, import/export, and output-cache control. NetsuRush already exercises add/export/rewrite/import operations. [S-BMD-SCRIPTING] [S-NR-FUSION-APPLY]

Expected role: lowest-risk product baseline.

### H2 - OGrafLoader

NetsuRush installs or references an OGraf package and inserts the corresponding source/title. Resolve captures CEF output per frame through `OGrafLoader`. [S-BMD-OGRAF-OVERVIEW]

Expected role: preferred live adapter if T02 passes.

### H3 - File-backed Fuse

A source Fuse exposes Inspector controls and returns cached image frames. The Fuse SDK establishes per-request processing and image output, but not a supported asynchronous external-service contract. [S-BMD-FUSE]

Expected role: a cache-aware source wrapper, not the renderer itself.

### H4 - Service-calling Fuse

A Fuse attempts a bounded local request only on cache miss.

Expected role: feasibility probe only. Reject if the call blocks Fusion interaction, if Lua networking depends on undocumented modules, or if cancellation cannot be respected.

### H5 - OpenFX source

A native plugin receives render actions and returns image buffers, while rendering remains in an isolated Node process. OpenFX defines the native image-effect and threading contracts. [S-OFX-IMAGE] [S-OFX-RENDERING] [S-OFX-THREADING]

Expected role: high-cost escalation path.

### H6 - Workflow Integration panel

Test only as an optional Resolve-side control surface. Blackmagic documents it as an Electron/UI integration that calls Resolve APIs, not a per-frame image callback. NetsuRush already supplies the primary application UI. [S-BMD-WORKFLOW]

## Procedure

1. Implement the smallest disposable H1 composition using an existing T01 sequence.
2. Measure insertion, reload, trim, reopen, cache, and final-export behavior.
3. Reuse the accepted T02 package for H2 and record insertion/Inspector behavior.
4. Build H3 with only project path, composition ID, cache directory, status, and image output controls.
5. Test H3 against complete, missing, partially written, invalidated, and deleted cache entries.
6. Attempt H4 only in a disposable Resolve project with strict timeouts and a renderer that can be killed externally.
7. Build a minimal H5 checkerboard source before connecting Remotion; validate host time, output format, cancellation, concurrency, and crash isolation.
8. Connect H5 to a fake external frame service, then to T03 only if the fake-service test passes.
9. Test accepted adapters during sequential playback, random seeks, background cache rendering, final export, Resolve restart, and NetsuRush restart.
10. Verify uninstall and upgrade behavior for every installed host component.

## Required evidence

- screenshots and exported `.comp`/manifest data;
- adapter latency separated from renderer latency;
- Resolve UI responsiveness traces;
- cache-miss and partial-file behavior;
- render-thread/concurrency logs where available;
- crash, timeout, restart, install, upgrade, and uninstall reports;
- final-export comparison frames.

## Pass gates

### H1

- Automated insertion and refresh succeed without manual path repair.
- Missing output produces a clear recoverable state.
- Final export matches T01.

### H2

- Must satisfy all T02 correctness/export gates.

### H3

- Cache hits return the correct frame without blocking on rendering.
- Partial/missing files never appear as valid frames.
- Inspector changes and clip offsets map to the intended cache key/frame.

### H4

- No host freeze beyond the configured timeout.
- Cancellation and renderer failure return control to Resolve.
- All required Lua capabilities are documented or shipped and isolated.

### H5

- Host-requested time and output buffer are correct under concurrent/random rendering.
- Renderer death cannot crash Resolve.
- Plugin installation, signing, upgrade, and removal are repeatable on Windows and macOS.

## Selection rule

Choose the first adapter in this order that satisfies the selected product path:

1. OGrafLoader for a passing live OGraf path;
2. script plus Loader for faithful render/import;
3. file-backed Fuse if a single-source-node experience materially improves usability;
4. OpenFX only when measured requirements cannot be satisfied above;
5. never select service-calling Fuse solely because a prototype works once.
