# Evidence-gated roadmap

## Phase 0: Freeze the engine-neutral contract

- Preserve the existing OpenFX plugin identifier and wire protocol semantics.
- Define bindings, renderer capabilities, sessions, frame results, errors, and
  invalidation independently from HyperFrames and Remotion.
- Add props revision and engine fingerprint to the service-side content key.
- Reserve an engine-neutral typed control schema and frame-scoped value hash;
  do not bake HyperFrames variable names into the OpenFX protocol.
- Exit when the fake renderer passes the common engine conformance suite.

## Phase 1: Finish the OpenFX host proof

Status: **conditional pass in Resolve Studio 21.** Existing T00/T01/T03 evidence
is preserved. Complete scrubbing across frames, reduced render scale, Deliver,
parameter persistence, and remaining failure cases.

## Phase 2: HyperFrames isolated renderer proof

- Pin `@hyperframes/engine`, Node, Chromium/Puppeteer, and the lockfile.
- Serve a controlled fixture over loopback HTTP.
- Create and initialize one persistent capture session.
- Capture sequential and random requested frames to memory.
- Decode PNG to tightly packed straight RGBA8 and compare to references.
- Measure startup, seek, screenshot, decode, memory, and teardown independently.
- Exit only after H01–H03 answer API stability, alpha, and session performance.
  **All three have run** ([H01](tests/results/H01-2026-08-27/report.md),
  [H02](tests/results/H02-2026-08-27/report.md),
  [H03](tests/results/H03-2026-08-27/report.md)). What remains before production
  integration is Task 9: none of it has run inside Resolve, and every number is
  on a software renderer and on fixtures rather than real compositions.

## Phase 3: HyperFrames through the existing bridge

- Implement `HyperFramesEngine` behind the common adapter interface.
- Resolve the engine from the binding registry; do not add HyperFrames logic to
  the OpenFX plugin.
- Reuse the scheduler, deduplication, protocol, diagnostics, and cache layers.
- Run the common conformance suite plus Resolve random-scrub tests.
- Decide Live/Auto/Pre-render positioning from measurements.

## Phase 4: NetsuRush integration

- Let the Rust shell keep ownership of core/renderer startup and shutdown.
- Add generic `webMotion.*` RPC for bindings, engines, compositions, props,
  invalidation, health, and cache management.
- Add HyperFrames project registration and composition discovery.
- Keep engine-specific APIs behind adapters and the OFX Inspector compact.
- Discover HyperFrames variable metadata and persist stable control-slot maps.
- Stage and verify every runtime dependency through existing packaging checks.

## Phase 4.5: Native Fusion composition controls

- Declare a bounded fixed bank of typed OpenFX controls.
- Map HyperFrames variables to stable slots with explicit overflow handling.
- Support constants and `getValueAtTime()` keyframe evaluation.
- Carry schema/effective-value hashes through plugin and service cache keys.
- Measure session variables, an opt-in frame-control shim, and reinitialization
  fallback before claiming zero-change live animation.
- Exit only after T10 passes save/reopen, copy/paste, random scrub, cache, and
  session-restart cases.

## Phase 4.6: Optional Fusion element interaction

- Run T11's Inspector lifecycle phase before adding overlay behavior.
- Add a bounded frame-specific scene metadata request independent from pixels.
- Prove Overlay V2 drawing, coordinates, pointer events, and teardown in Resolve.
- Ship hover, single selection, and constant X/Y override before resize,
  rotation, multi-selection, or native promotion.
- Promote a contextual property to a Fusion control only through a permanent
  stable element/property slot; never recycle existing keyframes.
- Fall back to stable declared controls plus Studio selection if any host or
  persistence gate fails.

## Phase 5: Windows product hardening

- Installer, repair, update, uninstall, crash recovery, trust boundaries,
  dependency notices, offline browser provisioning, and long-session tests.
- Finish color/alpha/time validation in Resolve.
- Make pre-render the supported fallback if uncached live rendering misses the
  usability target.

## Phase 6: NetsuFlow Studio — manual HyperFrames authoring

- Follow the independent evidence roadmap in
  [`studio/plans/00-evidence-roadmap.md`](studio/plans/00-evidence-roadmap.md).
- Prove SDK/Player and every selected Studio component before adoption.
- Add the custom NetsuRush shell, project/composition lifecycle, code/preview,
  declared variables, and a bounded clip timeline.
- Extend the existing Resolve bridge with stable Media Pool asset descriptors.
- Deliver rendered import/insert first; enable automatic live binding only when
  the host test proves insertion, parameter assignment, persistence, and repair.
- Keep the module manually usable without an AI agent.
- Reuse the same selection, property, and typed-operation model in the app,
  lightweight editor, and any T11-approved Fusion overlay.

## Phase 7: Studio agent redesign

- Treat the current general-purpose agent as audit input, not accepted UX.
- Measure manual editing and current-agent baselines on a fixed task corpus.
- Prototype typed change sets with source diff, diagnostics, preview frames,
  explicit apply, and separate Resolve publish approval.
- Ship no agent by default if it does not materially improve the measured tasks.

## Phase 8: Remotion adapter

- Implement `RemotionEngine` against the same contract.
- Reuse the same binding model, bridge protocol, cache, scheduler, pixel
  normalizer, NetsuRush UI shell, and OpenFX binary.
- Keep Remotion's project-version loading and licensing behavior isolated in its
  adapter.
- Run the same conformance and cross-engine visual tests.
- Offer `Auto | HyperFrames | Remotion` only after both adapters are measured.
- Reuse the Studio shell, asset catalog, publish records, change-set envelope,
  Resolve bridge, and OpenFX contract; keep source/timeline semantics in the
  Remotion adapter.

## Phase 9: Optional migration and framework layer

- Treat Remotion-to-HyperFrames migration as an explicit project conversion
  assistant with diagnostics and visual comparison, never as runtime fallback.
- First framework feature: portable parameter/composition metadata shared by
  both engines.
- Consider an authoring DSL/TSX layer only after the bridge has stable users and
  the common contract has survived both engines.

## Phase 10: macOS and advanced transport

- Validate actual arm64/x86_64 bundle, signing/notarization, browser packaging,
  Resolve discovery, and shutdown on real hardware.
- Introduce shared memory or GPU transfer only if profiling proves the current
  transport/copy is a dominant cost.
