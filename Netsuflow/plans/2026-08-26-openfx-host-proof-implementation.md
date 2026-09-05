# OpenFX host proof implementation plan

> Scope: T00–T03 only. This plan deliberately stops before Remotion integration. Its purpose is to prove the Resolve host contract and safe out-of-process pixel delivery with deterministic fixtures.

## Progress — 2026-08-26

| Task | State |
|---|---|
| 1. Native test/build skeleton | done |
| 2. Minimum Generator | done — builds, reproducible, no undeclared DLL |
| 3. Resolve host proof (T01) | **partial pass** — loads, renders, correct frames; scrub/scale/Deliver unrun |
| 4. Inspector behaviour (T02) | **partial** — every control renders; Status works as a read-only field; matrix unrun |
| 5. Protocol with tests | done |
| 6. Fake renderer service | done, with 18 fault modes |
| 7. Bounded native client | done, plus fixes from an adversarial review |
| 8. Run T03 and decide | done out of host; in-host core path **passed** (kill/restart/recover in Resolve) |
| 9. Review and validation | done — `ctest` 4/4, `npm test` 25/25 |

Tasks 3, 4 and the in-host half of 8 need a human driving Resolve Studio:
[`tests/results/RUNBOOK-manual-resolve.md`](../tests/results/RUNBOOK-manual-resolve.md).

Two deviations from the plan as written, both recorded in the T00 report:

- The Generator declares **byte and float** depths rather than byte only. The
  host chooses the depth, and Resolve is reported to supply float; a byte-only
  declaration risked a misleading host-gate failure.
- The build links the CRT statically and passes `/Brepro`. The first build
  depended on the Visual C++ redistributable, which is exactly what T00's "no
  undeclared development-machine DLL" criterion rules out.

## Goal

Build a CPU-only `NetsuFlow Remotion (Experimental)` OpenFX Generator that renders a local diagnostic pattern, then requests the same deterministic pixels from a fake Node service through a versioned loopback protocol. Produce reproducible test reports; do not modify the production NetsuRush renderer flow yet.

## Proposed files

```text
Netsuflow/openfx/
  CMakeLists.txt
  README.md
  cmake/FindResolveOpenFX.cmake
  src/PluginMain.cpp
  src/NetsuFlowGenerator.hpp
  src/NetsuFlowGenerator.cpp
  src/BridgeClient.hpp
  src/BridgeClient.cpp
  src/Protocol.hpp
  src/Protocol.cpp
  src/DiagnosticFrame.hpp
  src/DiagnosticFrame.cpp
  tests/ProtocolTests.cpp
  tests/DiagnosticFrameTests.cpp
Netsuflow/prototypes/fake-renderer/
  package.json
  server.mjs
  protocol.mjs
  test/protocol.test.mjs
Netsuflow/tests/results/
  .gitkeep
```

Use the local Resolve SDK through `DAVINCI_RESOLVE_DEVELOPER_DIR` for this proof. Do not copy SDK files into the repository during this phase. The CMake configuration must fail with a clear message if the required OpenFX 1.4 headers and Support library are absent.

## Task 1: Add the native test/build skeleton

Files:

- Create `Netsuflow/openfx/CMakeLists.txt`.
- Create `Netsuflow/openfx/cmake/FindResolveOpenFX.cmake`.
- Create `Netsuflow/openfx/tests/DiagnosticFrameTests.cpp`.
- Create `Netsuflow/openfx/src/DiagnosticFrame.hpp` and `.cpp`.

Write a failing native test first for deterministic RGBA output:

```cpp
TEST_CASE("diagnostic frame encodes requested frame") {
  FrameSpec spec{64, 32, 42};
  const auto pixels = makeDiagnosticFrame(spec);
  REQUIRE(pixels.size() == 64U * 32U * 4U);
  REQUIRE(frameMarker(pixels, spec) == 42);
}
```

Implement only enough frame generation to pass. Keep the pixel contract explicit as RGBA8 with checked multiplication.

Configure and test from a Visual Studio developer shell:

```powershell
$env:DAVINCI_RESOLVE_DEVELOPER_DIR = 'C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer'
cmake -S Netsuflow/openfx -B Netsuflow/openfx/build -A x64 -DNETSUFLOW_BUILD_TESTS=ON
cmake --build Netsuflow/openfx/build --config Release
ctest --test-dir Netsuflow/openfx/build -C Release --output-on-failure
```

Expected: tests pass and no plugin installation occurs.

## Task 2: Implement the minimum Generator

Files:

- Create `Netsuflow/openfx/src/PluginMain.cpp`.
- Create `Netsuflow/openfx/src/NetsuFlowGenerator.hpp` and `.cpp`.
- Update `Netsuflow/openfx/CMakeLists.txt`.

Implement:

- Generator context only;
- RGBA output declaring byte and float depths (the host selects; Resolve is expected to supply float — record the negotiated depth in the T01 report);
- no tiles and no host frame threading;
- instance-safe declaration;
- `Binding`, `Props JSON`, `Start Frame`, `Mode`, `Reload`, and diagnostic-source parameters;
- local diagnostic rendering using OpenFX time, render window, and render scale;
- abort polling and exception containment across every OpenFX entry point.

Do not add network code yet. Build output must have the Windows layout:

```text
NetsuFlow.ofx.bundle/
  Contents/
    Win64/
      NetsuFlow.ofx
```

Verify bundle contents and DLL dependencies, then write `tests/results/T00-<date>/report.md` using T00.

## Task 3: Run the Resolve host proof

Files:

- Create `Netsuflow/openfx/README.md` with manual developer installation and removal commands.
- Create `Netsuflow/tests/results/T01-<date>/report.md` after the manual test.

Before copying, Resolve must be closed. Resolve loading is a manual runtime gate; do not automate process termination.

Developer copy target:

```powershell
$sourceBundle = (Resolve-Path 'Netsuflow\openfx\build\Release\NetsuFlow.ofx.bundle').Path
$targetRoot = 'C:\Program Files\Common Files\OFX\Plugins'
Copy-Item -LiteralPath $sourceBundle -Destination $targetRoot -Recurse
```

This operation requires an elevated PowerShell and explicit user action. Run the complete T01 matrix in Resolve 21, collect instrumented logs, and mark failures honestly. Remove only the exact `NetsuFlow.ofx.bundle` when cleaning up.

While Resolve is set up for T01, also spend a few minutes on the per-user discovery question: remove the bundle from `Common Files\OFX\Plugins`, place it in a user-writable directory, set a user-level `OFX_PLUGIN_PATH` to that directory, restart Resolve, and record whether the plugin is discovered. A positive result de-risks R6/T08 early; either way the observation goes into the T01 report.

## Task 4: Validate Inspector behavior

Files:

- Update `Netsuflow/openfx/src/NetsuFlowGenerator.cpp` only as required for the T02 matrix.
- Create `Netsuflow/tests/results/T02-<date>/report.md`.

Test multiline Unicode strings, large source values, choices, buttons, animation, undo/redo, save/reopen, duplicate, and render invalidation. Conclude whether production code editing stays in the Inspector or moves entirely to NetsuRush.

Do not create the NetsuRush UI in this phase.

## Task 5: Specify the protocol with tests

Files:

- Create `Netsuflow/openfx/src/Protocol.hpp` and `.cpp`.
- Create `Netsuflow/openfx/tests/ProtocolTests.cpp`.
- Create `Netsuflow/prototypes/fake-renderer/protocol.mjs`.
- Create `Netsuflow/prototypes/fake-renderer/test/protocol.test.mjs`.

Write failing tests for:

- header round trip;
- unsupported version;
- lengths above configured maximum;
- truncated header/body;
- wrong width/height/stride/body length;
- invalid authentication;
- request/response ID mismatch;
- checked 4K allocation;
- unknown message types.

Use a fixed header with magic, protocol version, type, flags, request ID, metadata length, and body length. Metadata must state RGBA8, straight alpha, width, height, stride, frame, and content revision.

Run:

```powershell
ctest --test-dir Netsuflow/openfx/build -C Release --output-on-failure
npm --prefix Netsuflow/prototypes/fake-renderer test
```

## Task 6: Implement the fake renderer service

Files:

- Create `Netsuflow/prototypes/fake-renderer/package.json`.
- Create `Netsuflow/prototypes/fake-renderer/server.mjs`.
- Extend its tests.

Use only Node built-ins for the prototype. Listen on `127.0.0.1` with an OS-assigned port, write an atomic session descriptor in an explicit test directory, require a random token, and return the same deterministic RGBA fixture as the native implementation.

Add test-controlled modes: delay, partial response, disconnect, malformed size, wrong revision, and clean restart. Never listen on `0.0.0.0`.

## Task 7: Add the bounded native client

Files:

- Create `Netsuflow/openfx/src/BridgeClient.hpp` and `.cpp`.
- Update Generator and native tests.

Implement:

- strict session-descriptor parsing;
- loopback-only connection;
- handshake/token authentication;
- connect, header, body, and total deadlines;
- maximum sizes and checked allocations;
- cancellation when OpenFX reports abort;
- reconnection after service instance changes;
- no exceptions escaping the plugin ABI;
- a per-instance last-good frame used only for interactive error mode.

Do not implement shared memory, HTTP, WebSocket, compression, or Remotion.

## Task 8: Run T03 and decide

Files:

- Create `Netsuflow/tests/results/T03-<date>/report.md`.
- Update `Netsuflow/STATUS.md`, relevant research note, and risk register from measured evidence.

Run every scenario in T03 at 1080p and 4K. Preserve raw timing data and logs. The gate passes only if Resolve remains responsive, malformed responses cannot corrupt output, deadlines work, service restart recovers, and resources stabilize.

If the gate fails, stop. Fix the native host/protocol boundary before introducing Remotion.

## Task 9: Review and validation

Run only checks relevant to the new standalone prototype:

```powershell
ctest --test-dir Netsuflow/openfx/build -C Release --output-on-failure
npm --prefix Netsuflow/prototypes/fake-renderer test
git diff --check
```

Because this phase does not change the NetsuRush renderer/core/Tauri application, do not run or rebuild the open Tauri app. If later implementation touches production Node, UI, Python, or Rust files, use the commands and restart constraints from the repository `AGENTS.md`.

## Completion criteria

- T00, T01, T02, and T03 have immutable dated reports.
- A minimal Generator works in Resolve and survives lifecycle tests.
- The fake-service protocol is versioned, authenticated, bounded, and failure-tested.
- Resolve can reconnect after service restart.
- The documentation contains measured results instead of feasibility assumptions.
- No Remotion or product UI work begins until these gates pass.
