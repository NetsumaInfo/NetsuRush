# Engine-Neutral NetsuRush Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the proven HyperFrames adapter into NetsuRush while preserving a clean path for a later Remotion adapter and reusing the current OpenFX bridge.

**Architecture:** The existing Tauri shell continues to own lifecycle. A new CommonJS `core/webMotion/` subsystem owns bindings, engine registry, worker supervision, scheduling, cache, and the hardened OFX bridge. The UI and RPC are generic; only `core/webMotion/engines/hyperframes/` imports HyperFrames. A later Remotion directory implements the same contract.

**Tech Stack:** NetsuRush Tauri v2/Rust shell, CommonJS Node 22 core, TypeScript/React renderer, existing C++ OpenFX plugin and binary TCP protocol, Node test runner.

---

## Gate

Do not execute this plan until HyperFrames H01-H03 and the optional in-Resolve
proof have produced acceptable evidence. Core changes require a Tauri restart;
never claim runtime verification without it.

### Task 1: Add common contracts and binding registry

**Files:**
- Create: `core/webMotion/contracts.js`
- Create: `core/webMotion/bindingRegistry.js`
- Create: `test/webMotionBindingRegistry.test.cjs`

- [ ] Write tests for immutable binding snapshots, canonical props, revisions, validation, relink, and engine switch.
- [ ] Implement stable IDs and canonical path/root validation.
- [ ] Ensure engine, source, props, adapter, package, and browser fingerprints affect revisions.
- [ ] Persist no secrets in logs or user-visible binding IDs.
- [ ] Run: `node --test test/webMotionBindingRegistry.test.cjs`.

### Task 2: Add engine registry and conformance harness

**Files:**
- Create: `core/webMotion/engineRegistry.js`
- Create: `core/webMotion/engines/fakeEngine.js`
- Create: `test/webMotionEngineConformance.test.cjs`

- [ ] Port the common C01 vectors into one reusable adapter harness.
- [ ] Register fake engine and prove unknown/unsupported engines fail precisely.
- [ ] Keep all adapter values runtime-validated.
- [ ] Run conformance tests with the fake engine before HyperFrames.

### Task 3: Port the proven HyperFrames adapter

**Files:**
- Create: `core/webMotion/engines/hyperframes/hyperframesEngine.js`
- Create: `core/webMotion/engines/hyperframes/projectServer.js`
- Create: `core/webMotion/pixel/pngToRgba.js`
- Create: `test/webMotionHyperFrames.test.cjs`

- [ ] Move behavior from the proven prototype without changing the common contract.
- [ ] Keep HyperFrames imports inside the adapter subtree.
- [ ] Pin exact runtime dependencies and preserve license notices.
- [ ] Run common conformance and golden-frame tests.
- [ ] Verify no current `openfx/` file imports or names HyperFrames.

### Task 4: Add session manager, scheduler, and cache

**Files:**
- Create: `core/webMotion/sessionManager.js`
- Create: `core/webMotion/frameScheduler.js`
- Create: `core/webMotion/frameCache.js`
- Create: `test/webMotionSessionManager.test.cjs`
- Create: `test/webMotionFrameScheduler.test.cjs`
- Create: `test/webMotionFrameCache.test.cjs`

- [ ] Test bounded sessions, leases, idle eviction, cancellation, crash restart, and shutdown.
- [ ] Test exact canonical key fields and corrupt-entry recovery.
- [ ] Implement decoded memory LRU first, encoded disk cache second.
- [ ] Ensure final requests are never silently dropped/downgraded.
- [ ] Verify props/source/engine changes invalidate all relevant paths.

### Task 5: Integrate the hardened OFX bridge server

**Files:**
- Create: `core/webMotion/bridgeServer.js`
- Create: `core/webMotion/sessionDescriptor.js`
- Create: `test/webMotionBridgeServer.test.cjs`
- Reuse protocol fixtures from: `Netsuflow/prototypes/fake-renderer/`

- [ ] Port the already-tested protocol behavior rather than redesigning it.
- [ ] Preserve loopback binding, token authentication, limits, deadlines, and reconnection.
- [ ] Dispatch only through `BindingRegistry -> EngineRegistry`.
- [ ] Re-run the hostile-service and C++ harness matrix.
- [ ] Verify the existing OpenFX binary can consume HyperFrames frames unchanged.

### Task 6: Add generic application RPC

**Files:**
- Modify: `core/rpc.js`
- Modify: `src/lib/coreClient.ts`
- Modify: `src/lib/bridge.ts`
- Create: `test/webMotionRpc.test.cjs`

- [ ] Add `webMotion.*` handlers for engine status, projects, compositions, bindings, props, invalidation, cache, and diagnostics.
- [ ] Add typed `NrApi` methods.
- [ ] Add mock implementations in the same change.
- [ ] Test validation and error shapes.
- [ ] Run: `npm run check:core`, `npm run build`, and the focused Node tests.

### Task 7: Supervise renderer lifecycle from Tauri/core startup

**Files:**
- Modify only after inspecting current lifecycle: `src-tauri/src/lib.rs`
- Modify: `core/server.js`
- Create: `test/webMotionLifecycle.test.cjs`

- [ ] Start bridge/session management with existing core lifecycle.
- [ ] Close sessions/server on normal shutdown.
- [ ] Recover engine workers independently from core RPC.
- [ ] Avoid hard-coded dev paths.
- [ ] Run `cargo check --locked` in `src-tauri/`; do not run a Tauri build.
- [ ] Request a Tauri window restart before any runtime claim.

### Task 8: Add the compact NetsuRush workspace

**Files:**
- Create: `src/components/webMotion/WebMotionWorkspace.tsx`
- Create: `src/components/webMotion/EngineProjectPanel.tsx`
- Create: `src/components/webMotion/BindingPanel.tsx`
- Add locale keys to all six `src/locales/<lang>/` files.

- [ ] Implement project trust/register, composition selection, props validation, binding creation, diagnostics, cache, and repair state.
- [ ] Default to HyperFrames; hide Remotion until its adapter is available.
- [ ] Keep source editing in NetsuRush and the OFX Inspector compact.
- [ ] Use project shadcn/Base UI components and project Tooltips.
- [ ] Run `npm run check:i18n` and `npm run build`.

### Task 9: Correct the plugin's props/revision gap and visible label

The separate
[`2026-08-27-fusion-parameter-binding-implementation.md`](2026-08-27-fusion-parameter-binding-implementation.md)
extends this task with the fixed native control bank. Execute its schema, slot,
protocol, and cache tasks before exposing keyframeable composition controls.

**Files:**
- Modify: `Netsuflow/openfx/src/NetsuFlowGenerator.cpp`
- Modify: `Netsuflow/openfx/src/NetsuFlowGenerator.hpp`
- Modify: `Netsuflow/openfx/src/BridgeClient.hpp`
- Modify: `Netsuflow/openfx/src/BridgeClient.cpp`
- Modify: `Netsuflow/openfx/src/Protocol.hpp`
- Modify: `Netsuflow/openfx/src/Protocol.cpp`
- Modify focused native tests under `Netsuflow/openfx/tests/`

- [ ] Preserve `com.netsurush.netsuflow.generator`.
- [ ] Rename only the visible label to engine-neutral NetsuFlow.
- [ ] Make normalized props/binding revision invalidate plugin last-frame state.
- [ ] Version any wire addition and preserve precise mismatch handling.
- [ ] Run native unit tests and T03 hostile regression suite.
- [ ] Validate in Resolve only after closing/restarting the host as required.

### Task 10: Package, repair, and release-gate the runtime

**Files:**
- Modify: `scripts/build.ps1`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `test/packaging.test.cjs`
- Update: `docs/distribution.md`
- Add exact notices under the existing licensing structure.

- [ ] Stage exact Node/HyperFrames/browser assets and manifest.
- [ ] Prove no global Node/npm/browser dependency and no first-render download.
- [ ] Add checksum, missing/corrupt repair, update-with-Resolve-open refusal, and uninstall tests.
- [ ] Run `npm run check:core`, `npm run check:i18n`, `npm run build`, all focused Node tests, Python tests if touched, and `cargo check --locked`.
- [ ] Perform T08 on a clean supported Windows account before a product claim.

### Task 11: Prove the second-engine seam before declaring architecture complete

**Files:**
- Create: `core/webMotion/engines/remotion/README.md`
- Create: `test/webMotionSecondEngineSeam.test.cjs`

- [ ] Add a non-rendering stub Remotion adapter implementing the common interface.
- [ ] Switch a binding between fake, HyperFrames, and the stub.
- [ ] Prove no OpenFX/protocol/UI contract change is necessary.
- [ ] Keep the real Remotion implementation deferred until RM01.
- [ ] Record any leaked HyperFrames assumption as an architecture defect and fix it before release.
