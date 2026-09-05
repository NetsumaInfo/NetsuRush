# Source registry

This is the canonical evidence list for active NetsuFlow documentation. Documents cite stable IDs such as `[S-OFX-RENDERING]`. Access dates are 2026-08-26 unless stated otherwise. HyperFrames sources were rechecked on 2026-08-27.

## Product reference

- **[S-VIDEO-SHADERTOY]** CloutVFX, “50,000+ FREE Shaders.. Shadertoy 1.0 Release | Davinci Resolve”: https://youtu.be/APf5KxBjXSI
- **[S-PRODUCT-SHADERTOY]** Shadertoy for DaVinci Resolve product page, describing a single OFX node with pasted GLSL and exposed controls: https://payhip.com/b/QwCcg
- **[S-REM-ISSUE-10235]** Remotion issue #10235, community signal for Resolve/Fusion integration: https://github.com/remotion-dev/remotion/issues/10235
- **[S-RESOLVE-STUDIO-OFX]** Vendor consensus that third-party OpenFX plugins require DaVinci Resolve Studio (free edition does not load them); community signal, verify locally in T01. Examples: BorisFX and FilmConvert system requirements pages.

## OpenFX

- **[S-OFX-CONTEXTS]** OpenFX Image Effect contexts, including Generator: https://openfx.readthedocs.io/en/main/Reference/ofxImageEffectContexts.html#the-generator-context
- **[S-OFX-RENDERING]** OpenFX rendering action and image access: https://openfx.readthedocs.io/en/main/Reference/ofxRendering.html
- **[S-OFX-THREADING]** OpenFX thread-safety declarations: https://openfx.readthedocs.io/en/latest/Reference/ofxThreadSafety.html
- **[S-OFX-PACKAGING]** OpenFX bundle layout, default paths, and `OFX_PLUGIN_PATH`: https://openfx.readthedocs.io/en/main/Reference/ofxPackaging.html
- **[S-OFX-SOURCE]** Academy Software Foundation OpenFX source and examples: https://github.com/AcademySoftwareFoundation/openfx
- **[S-OFX-PARAMETERS]** OpenFX parameter definition, value-at-time, keyframe, type, and describe-action rules: https://openfx.readthedocs.io/en/latest/Reference/ofxParameter.html
- **[S-OFX-PARAM-PROPERTIES]** OpenFX descriptor/instance property mutability, including labels, visibility, ranges, increments, animation, and choice options: https://openfx.readthedocs.io/en/main/Reference/ofxPropertiesByObject.html
- **[S-OFX-PARAM-API]** Official `ofxParam.h` API reference for parameter types and `paramDefine`/instance handles: https://openfx.readthedocs.io/en/main/Reference/api/file/ofxParam_8h.html
- **[S-OFX-INTERACTS]** OpenFX interact actions, viewer overlays, drawing, coordinate properties, and pointer motion/down/up: https://openfx.readthedocs.io/en/main/Reference/ofxInteracts.html
- **[S-OFX-OVERLAY-EXAMPLE]** Academy Software Foundation viewer-overlay example, including draw and pointer actions: https://github.com/AcademySoftwareFoundation/openfx/blob/main/Examples/Overlay/overlay.cpp
- **[S-BMD-OFX-README]** Local Resolve 21 Developer SDK, `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\OpenFX\README.txt`, updated 2026-05-12.
- **[S-BMD-OFX-HEADERS]** Local Resolve SDK OpenFX 1.4 headers, especially `ofxImageEffect.h`.
- **[S-BMD-OFX-PARAMS]** Local Resolve SDK `ofxParam.h` and Support wrapper `ofxsParam.h`, including multiline string parameters.
- **[S-BMD-OFX-GAIN]** Local Resolve SDK `OpenFX/GainPlugin/GainPlugin.cpp`, demonstrating animated double/boolean parameters read with `getValueAtTime()` and numeric range/increment declarations.
- **[S-BMD-OFX-OVERLAY]** Local Resolve 21 SDK `OpenFX/GainPlugin/GainPlugin.cpp`, demonstrating an Overlay V2 descriptor and Draw Suite primitives. API presence is evidence for a host test, not proof that the proposed Generator interaction is stable.
- **[S-BMD-SCRIPTING]** Local Resolve scripting README, including `InsertOFXGeneratorIntoTimeline(generatorName)`.

## Remotion

- **[S-REM-STILL]** `renderStill()` API: https://www.remotion.dev/docs/renderer/render-still
- **[S-REM-STILL-SOURCE]** `renderStill()` implementation: https://github.com/remotion-dev/remotion/blob/main/packages/renderer/src/render-still.ts
- **[S-REM-OPEN-BROWSER]** Reusing a browser with `openBrowser()`: https://www.remotion.dev/docs/renderer/open-browser
- **[S-REM-ENSURE-BROWSER]** Browser provisioning with `ensureBrowser()`: https://www.remotion.dev/docs/renderer/ensure-browser
- **[S-REM-SELECT]** Composition selection and input props: https://www.remotion.dev/docs/renderer/select-composition
- **[S-REM-MEDIA]** `renderMedia()` API: https://www.remotion.dev/docs/renderer/render-media
- **[S-REM-ALPHA]** Transparent video/image rendering guidance: https://www.remotion.dev/docs/transparent-videos
- **[S-REM-ELECTRON]** Packaging Remotion and its browser in a desktop application: https://www.remotion.dev/docs/electron
- **[S-REM-LICENSING]** Remotion licensing: https://www.remotion.dev/docs/licensing
- **[S-REM-LICENSE-TERMS]** Remotion license text (free ≤3-person companies; selling/sublicensing a Remotion derivative prohibited): https://github.com/remotion-dev/remotion/blob/main/LICENSE.md and https://www.remotion.pro/license
- **[S-REM-RENDER-FRAMES]** `renderFrames()` public API: frame ranges rendered through a reused page pool: https://www.remotion.dev/docs/renderer/render-frames
- **[S-REM-VERSION-MATCH]** All Remotion packages must share one exact version; mismatches are unsupported: https://www.remotion.dev/docs/version-mismatch

## HyperFrames

- **[S-HF-REPO]** Official repository and README (Node 22+, FFmpeg, HTML/CSS/media/seekable animation positioning): https://github.com/heygen-com/hyperframes
- **[S-HF-ENGINE-DOC]** `@hyperframes/engine`, documented as the low-level API for browser management, seekable capture, buffers, diagnostics, and media extraction: https://github.com/heygen-com/hyperframes/blob/main/docs/packages/engine.mdx
- **[S-HF-FRAME-CAPTURE-SOURCE]** Capture-session source, including retained `Browser`/`Page`, initialization, `captureFrameToBuffer()`, and cleanup: https://github.com/heygen-com/hyperframes/blob/main/packages/engine/src/services/frameCapture.ts
- **[S-HF-TYPES-SOURCE]** Engine public and internal type definitions: https://github.com/heygen-com/hyperframes/blob/main/packages/engine/src/types.ts
- **[S-HF-BROWSER-MANAGER]** Browser pool, leases, release, and drain behavior: https://github.com/heygen-com/hyperframes/blob/main/packages/engine/src/services/browserManager.ts
- **[S-HF-DETERMINISM]** Determinism and frame-to-time guidance: https://github.com/heygen-com/hyperframes/blob/main/docs/concepts/determinism.mdx
- **[S-HF-FRAME-ADAPTERS]** FrameAdapter lifecycle and explicit experimental-v0 stability warning: https://github.com/heygen-com/hyperframes/blob/main/docs/concepts/frame-adapters.mdx
- **[S-HF-COMPOSITIONS]** Composition model and metadata. A composition is an `index.html` file whose root element carries `data-composition-id`, `data-width`, and `data-height`, with timed clips declared through `data-start`/`data-duration`. There is no build step and no TypeScript entry point: https://github.com/heygen-com/hyperframes/blob/main/docs/concepts/compositions.mdx
- **[S-HF-RENDERING]** Rendering guide, including PNG sequences and alpha-capable outputs: https://hyperframes.heygen.com/guides/rendering
- **[S-HF-PACKAGE]** Engine package manifest (Node requirement and runtime dependencies): https://github.com/heygen-com/hyperframes/blob/main/packages/engine/package.json
- **[S-HF-LICENSE]** Apache-2.0 repository license: https://github.com/heygen-com/hyperframes/blob/main/LICENSE
- **[S-HF-RELEASE-CHANNELS]** Release-channel policy: https://github.com/heygen-com/hyperframes/blob/main/docs/contributing/release-channels.mdx
- **[S-HF-VS-REMOTION]** Official HyperFrames/Remotion comparison: https://github.com/heygen-com/hyperframes/blob/main/docs/guides/hyperframes-vs-remotion.mdx
- **[S-HF-REMOTION-MIGRATION]** Official migration guide and documented unsupported/complex cases: https://github.com/heygen-com/hyperframes/blob/main/docs/prompting/remotion-migration.mdx
- **[S-HF-REMOTION-SKILL]** Official one-way Remotion-to-HyperFrames migration skill: https://github.com/heygen-com/hyperframes/blob/main/skills/remotion-to-hyperframes/SKILL.md
- **[S-HF-REMOTION-ADAPTER-PR]** Closed, unmerged experimental Remotion runtime-adapter proposal; architectural evidence only: https://github.com/heygen-com/hyperframes/pull/214
- **[S-HF-VARIABLES]** Official typed composition-variable schema, runtime resolution, validation, and programmatic metadata extraction: https://hyperframes.heygen.com/concepts/variables
- **[S-HF-SDK-EDITING]** Official SDK querying/editing guide, including `setVariableValue()`: https://github.com/heygen-com/hyperframes/blob/main/docs/sdk/guides/querying-and-editing.mdx
- **[S-HF-SDK-CANVAS]** Official same-origin iframe preview adapter, `data-hf-id` hit testing, selection, draft movement, and commit behavior: https://github.com/heygen-com/hyperframes/blob/main/docs/sdk/guides/canvas-integration.mdx
- **[S-HF-OVERRIDES]** Official embedded override mode, sparse deltas, patch events, and host-owned undo/redo: https://github.com/heygen-com/hyperframes/blob/main/docs/sdk/guides/embedded-override-mode.mdx
- **[S-HF-ENGINE-README]** Official low-level engine session example using acquire/create/initialize/capture/close: https://github.com/heygen-com/hyperframes/blob/main/packages/engine/README.md
- **[S-HF-ENGINE-EXPORTS]** Package-root export list. `acquireBrowser`, `createCaptureSession`, `initializeSession`, `captureFrameToBuffer`, `closeCaptureSession`, `getCompositionDuration`, `getCapturePerfSummary`, and `prepareCaptureSessionForReuse` are all reachable without importing internal paths: https://github.com/heygen-com/hyperframes/blob/main/packages/engine/src/index.ts
- **[S-HF-CAPTURE-MODE]** Capture-mode resolution in the browser manager. The deterministic `beginframe` mode requires `process.platform === "linux"`, a resolved headless-shell binary, and `--enable-begin-frame-control`; every other platform, Windows included, resolves to `screenshot`. The frame-capture source gates its BeginFrame paths on the same Linux check: https://github.com/heygen-com/hyperframes/blob/main/packages/engine/src/services/browserManager.ts
- **[S-HF-CAPTURE-BUFFER-PURPOSE]** `captureFrameToBuffer(session, frameIndex, time)` returns the screenshot as a Buffer instead of writing it to disk. Its documented consumer is the streaming encode pipeline that feeds FFmpeg stdin, which is sequential capture; `createCaptureSession()` still requires an `outputDir`: https://github.com/heygen-com/hyperframes/blob/main/packages/engine/src/services/frameCapture.ts

The npm registry reported `@hyperframes/engine` 0.8.16, Node `>=22`, and runtime dependencies including `puppeteer`, `puppeteer-core`, `hono`, `linkedom`, `@hyperframes/core`, and `@hyperframes/parsers` on 2026-08-27. The package metadata did not return a license field, so licensing claims use the repository license rather than inferring one from npm. The registry listed 371 published versions, with the most recent publish on the query date; that release rate is the direct evidence behind the API-drift risk. Exact versions belong in every test report because the project is pre-1.0 and changing quickly.

## NetsuRush and Tauri

- **[S-TAURI-SIDECAR]** Tauri v2 sidecar documentation: https://v2.tauri.app/develop/sidecar/
- **[S-TAURI-CONFIG]** Tauri v2 bundle/resource configuration: https://v2.tauri.app/reference/config/#bundleconfig
- **[S-NR-ARCH]** NetsuRush runtime and IPC layout: [`../docs/architecture.md`](../docs/architecture.md)
- **[S-NR-DIST]** NetsuRush packaging, repair, and runtime requirements: [`../docs/distribution.md`](../docs/distribution.md)
- **[S-NR-RUST-CORE]** Core lifecycle owner: [`../src-tauri/src/lib.rs`](../src-tauri/src/lib.rs)
- **[S-NR-BUILD]** Windows staging and packaging script: [`../scripts/build.ps1`](../scripts/build.ps1)
- **[S-NR-PACKAGING-TEST]** Packaging contract tests: [`../test/packaging.test.cjs`](../test/packaging.test.cjs)

## IPC platform references

- **[S-NODE-NET]** Node.js TCP server/client API: https://nodejs.org/api/net.html
- **[S-WIN-NAMED-PIPES]** Windows named pipes: https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes
- **[S-WIN-FILE-MAPPING]** Windows file mapping/shared memory: https://learn.microsoft.com/en-us/windows/win32/memory/file-mapping

## Current NetsuFlow implementation evidence

- **[S-NF-OPENFX]** Current Generator identity, parameters, render path, and last-frame key: [`openfx/src/NetsuFlowGenerator.cpp`](openfx/src/NetsuFlowGenerator.cpp) and [`openfx/src/NetsuFlowGenerator.hpp`](openfx/src/NetsuFlowGenerator.hpp)
- **[S-NF-BRIDGE]** Current engine-neutral `FrameRequest` and bridge client: [`openfx/src/BridgeClient.hpp`](openfx/src/BridgeClient.hpp) and [`openfx/src/BridgeClient.cpp`](openfx/src/BridgeClient.cpp)
- **[S-NF-PROTOCOL]** Current versioned binary frame metadata contract: [`openfx/src/Protocol.hpp`](openfx/src/Protocol.hpp) and [`openfx/src/Protocol.cpp`](openfx/src/Protocol.cpp)
- **[S-NF-T00]** Reproducible native toolchain result: [`tests/results/T00-2026-08-26/report.md`](tests/results/T00-2026-08-26/report.md)
- **[S-NF-T01]** Resolve Studio 21 host result: [`tests/results/T01-2026-08-26/report.md`](tests/results/T01-2026-08-26/report.md)
- **[S-NF-T03]** Bridge, hostile-service, load, and recovery result: [`tests/results/T03-2026-08-26/report.md`](tests/results/T03-2026-08-26/report.md)
- **[S-NF-H01-DEPS]** Frozen HyperFrames dependency surface: pinned 0.8.16, 191 package-root exports with a drift test, 105-entry lockfile, resolved licence audit, and the measured capture mode on Windows: [`tests/results/H01-2026-08-27/report.md`](tests/results/H01-2026-08-27/report.md)
- **[S-NF-H02-FIXTURE]** Deterministic fixture driven by the real pinned engine through NetsuFlow's own project server: straight-alpha confirmation, byte-identical repeated and out-of-order captures, the 45 s `data-no-timeline` stall, the antialiasing observation, the README-versus-package signature drift, and the `${serverUrl}/index.html` navigation contract: [`tests/results/H02-2026-08-27/report.md`](tests/results/H02-2026-08-27/report.md)
- **[S-NF-TIMELINE-MODES]** Measured cost of each timeline mode against the real engine, including the case that fixes the default grace and the reproduced limitation of `auto`: [`tests/results/H02-2026-08-27/timeline-modes.txt`](tests/results/H02-2026-08-27/timeline-modes.txt) and [`prototypes/hyperframes-renderer/timelineShim.mjs`](prototypes/hyperframes-renderer/timelineShim.mjs)
- **[S-NF-H04]** First in-host run of the HyperFrames path, 2026-08-27, on
  DaVinci Resolve Studio 21.0.4.5 at 1920x1080/24fps, driven through Resolve's
  scripting API from Python. Report and artifacts in
  `tests/results/H04-2026-08-27/`. Establishes that the real engine renders
  correct, deterministic pixels into the host; also records the hardcoded
  `sourceRevision` blocker, Resolve's cache absorbing every repeat before it
  reaches the service, and `depth=1` where T01 recorded `depth=4`.

- **[S-NF-H03]** H03 cache/scrubbing/soak run, 2026-08-27, against the same
  bridge server the OpenFX plugin talks to:
  [`tests/results/H03-2026-08-27/report.md`](tests/results/H03-2026-08-27/report.md).
  Cold, warm-miss and memory-hit stage timings at 1080p and 4K; sequential,
  reverse, seeded-random and loop traces with every frame verified; two and four
  concurrent bindings; rapid revision invalidation; bounded waits; a
  10,000-request soak with process, handle and memory trends; browser kill and
  recovery; and a standalone-versus-bridge pixel comparison.
- **[S-NF-READER-QUADRATIC]** The prototypes' shared `MessageReader`
  concatenated each arriving socket chunk onto an accumulator, which is
  quadratic in message size. Measured before and after on the same cached frame:
  1080p p95 131.2 ms to 15.3 ms, 4K p95 1,564 ms to 53.7 ms.
  [`prototypes/fake-renderer/protocol.mjs`](prototypes/fake-renderer/protocol.mjs),
  [`tests/results/H03-2026-08-27/report.md`](tests/results/H03-2026-08-27/report.md).
- **[S-NF-CAPTURE-PATH]** Capture path latency, 2026-08-27, 24 distinct frames
  per path per composition, alternating order:
  [`tests/results/H02-2026-08-27/capture-path.txt`](tests/results/H02-2026-08-27/capture-path.txt).
- **[S-NF-PIXEL-BENCH]** Pixel path benchmark, 2026-08-27, 30 samples per stage
  at 1080p (real Chrome capture) and 4K:
  [`tests/results/H02-2026-08-27/pixel-bench.txt`](tests/results/H02-2026-08-27/pixel-bench.txt).
- **[S-NF-BRIDGE-E2E]** Task 6 end-to-end run, 2026-08-27: the real HyperFrames
  engine behind the existing bridge protocol, verified from both sides of the
  wire. Node side compares protocol responses against the JavaScript diagnostic
  generator; the C++ `BridgeClientHarness` — the exact client the plugin uses,
  deliberately not rebuilt — compares against `DiagnosticFrame.cpp`. 10 checks,
  0 failures. Raw output:
  [`tests/results/H02-2026-08-27/bridge-e2e.txt`](tests/results/H02-2026-08-27/bridge-e2e.txt).
- **[S-NF-CONFORMANCE]** The common engine conformance suite executed against the real HyperFrames adapter: descriptor, arbitrary frame order, both capture paths, alpha, error taxonomy, deadlines, invalidation, and 100 open/close cycles: [`tests/results/H02-2026-08-27/engine-conformance.txt`](tests/results/H02-2026-08-27/engine-conformance.txt) and [`prototypes/hyperframes-renderer/tools/engine-conformance.mjs`](prototypes/hyperframes-renderer/tools/engine-conformance.mjs)
- **[S-NF-PROJECT-SERVER]** NetsuFlow project server and its 18-case suite, including the traversal forms that defeated the engine's own file server: [`prototypes/hyperframes-renderer/projectServer.mjs`](prototypes/hyperframes-renderer/projectServer.mjs) and [`prototypes/hyperframes-renderer/test/projectServer.test.mjs`](prototypes/hyperframes-renderer/test/projectServer.test.mjs)
- **[S-NF-H01-EVAL]** Measured evaluation of the engine facilities that overlap NetsuFlow's own planned code: the `createFileServer` bind and root-escape probe, the `decodePng` bounds review, the two candidate alpha capture paths, and the transitive `lint`/`studio-server` footprint. Same report, plus the raw probe in [`tests/results/H01-2026-08-27/fileserver-probe.txt`](tests/results/H01-2026-08-27/fileserver-probe.txt)

## Evidence rules

- Official specifications, vendor SDKs, API documentation, and source code outrank tutorials.
- Product pages and videos demonstrate user experience, not API guarantees.
- Repository files describe current NetsuRush behavior and must be rechecked after architectural changes.
- Every benchmark records hardware, Resolve version, engine and adapter version, Node/browser versions, composition, resolution, bit depth, cache state, sample count, median, p95, and failures.
- An undocumented host behavior remains an experimental finding, not a portable contract.
