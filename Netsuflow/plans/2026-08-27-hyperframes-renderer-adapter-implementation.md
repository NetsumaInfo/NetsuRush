# HyperFrames Renderer Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that one pinned HyperFrames capture session can serve arbitrary frames through the existing NetsuFlow protocol with correct alpha, bounded resources, and measured latency.

**Architecture:** Add an isolated Node prototype beside the existing fake renderer. It wraps all `@hyperframes/engine` calls in one adapter, serves a controlled fixture, captures PNG buffers, decodes them to canonical straight RGBA8, and plugs into the already-tested framed TCP server. No production NetsuRush or OpenFX behavior changes until the isolated gates pass.

**Tech Stack:** Node.js 22+, `@hyperframes/engine` pinned exactly, the engine's pinned browser/Puppeteer dependency, a small audited PNG decoder, Node test runner, existing NetsuFlow protocol and C++ bridge harness.

---

## Preconditions

- T00/T01/T03 reports remain immutable historical evidence.
- Do not rename the OpenFX identifier.
- Do not add HyperFrames code to `openfx/`.
- Record exact npm, lockfile, Node, browser, OS, and repository revisions.
- Run without launching or rebuilding the main Tauri app.

### Task 1: Freeze the prototype dependency surface — DONE 2026-08-27

Evidence: [`tests/results/H01-2026-08-27/report.md`](../tests/results/H01-2026-08-27/report.md)

**Files:**
- Created: `Netsuflow/prototypes/hyperframes-renderer/package.json`
- Created: `Netsuflow/prototypes/hyperframes-renderer/package-lock.json`
- Created: `Netsuflow/prototypes/hyperframes-renderer/test/packageExports.test.mjs`
- Created: `Netsuflow/prototypes/hyperframes-renderer/test/exports-baseline.json`
- Created: `Netsuflow/prototypes/hyperframes-renderer/test/runtimeManifest.test.mjs`
- Created: `Netsuflow/prototypes/hyperframes-renderer/runtimeManifest.mjs`

- [x] Write a failing test that imports only the package-root functions needed for session create/init/describe/capture/close.
- [x] Run: `node --test test/packageExports.test.mjs`. Failed before install, as intended.
- [x] Pin `@hyperframes/engine` exactly; do not use a caret/tilde. Pinned to 0.8.16.
- [x] Generate the lockfile with npm and record the resolved browser/runtime dependencies. 105 entries, SHA-256 recorded.
- [x] Install with `--ignore-scripts` so no package postinstall downloads a browser; browser provisioning is an explicit verified step of its own. Verified: no Chrome binary in the tree.
- [x] Assert the expected capture mode for the host platform, because BeginFrame is Linux-only and Windows always uses screenshot capture. [S-HF-CAPTURE-MODE]
- [x] Implement a runtime manifest that reports engine, adapter, Node, browser, and lockfile fingerprints.
- [x] Record the 191-symbol root export baseline and prove the drift test fails when the surface changes.
- [x] Audit the resolved dependency licences: 79 packages, no copyleft, and all five HyperFrames packages ship an Apache-2.0 LICENSE file despite absent npm metadata.
- [x] Rerun the test and save exact command/output in the H01 result directory. 8/8 pass.
- [ ] Commit only these prototype files if a commit is requested.

### Task 2: Build the deterministic fixture

A HyperFrames composition is a plain `index.html` with data attributes and no
build step, so the fixture is authored HTML, not a bundled TypeScript entry
point. [S-HF-COMPOSITIONS]

**Files:**
- Create: `Netsuflow/prototypes/hyperframes-renderer/fixture/index.html`
- Create: `Netsuflow/prototypes/hyperframes-renderer/fixture/styles.css`
- Create: `Netsuflow/prototypes/hyperframes-renderer/fixture/frame-code.js`
- Create: `Netsuflow/prototypes/hyperframes-renderer/fixture/assets/`
- Create: `Netsuflow/prototypes/hyperframes-renderer/fixture-broken/index.html`
- Create: `Netsuflow/prototypes/hyperframes-renderer/test/fixture.test.mjs`

- [x] Write tests that parse the fixture HTML and assert `data-composition-id`, `data-width`, `data-height`, fps, and total duration are present and finite.
- [x] Give the root element explicit `data-width="1920"`, `data-height="1080"`, and a finite clip timeline through `data-start`/`data-duration`. Clips tile 0-10 s with no gap or overlap.
- [x] Render a machine-readable frame code, reusing the diagnostic-frame convention already implemented in C++ and JS so a captured frame can be identified without human inspection. Verified: every captured frame's marker matched the frame requested.
- [x] Add flat RGBA patches, a 50 percent alpha edge, text, a CSS transform, an SVG, and a Canvas draw, each in its own addressable region.
- [x] Serve every asset and font from the fixture root; forbid external network, wall clock, and unseeded random. Enforced by test against the comment-stripped source.
- [x] Derive all animation state from the seeked composition time, never from elapsed real time, so a random seek and a sequential seek agree. Measured identical over five runs.
- [x] Set `data-no-timeline` on the composition root. Without it the engine waits out its 45 s GSAP-timeline poll on every session: measured 45,179 ms against 129 ms. [S-NF-H02-FIXTURE]
- [x] Isolate antialiased edges in one tolerated probe region, keeping every other region byte-exact. The first run's only unstable pixels were diagonal SVG edges sharing a layer with animated content.
- [x] Add `fixture-broken/index.html` with one deliberate runtime error for the recovery path.
- [x] Capture reference frames standalone with the real pinned engine, store their checksums and a fixture digest, and record the exact engine and browser build that produced them.
- [x] Provision `chrome-headless-shell` 152.0.7977.54 into the prototype and pass `chromePath` explicitly, rather than relying on the engine's `~/.cache` fallback.

### Task 3: Implement controlled project serving

**Files:**
- Create: `Netsuflow/prototypes/hyperframes-renderer/projectServer.mjs`
- Create: `Netsuflow/prototypes/hyperframes-renderer/test/projectServer.test.mjs`

Decided in [H01](../tests/results/H01-2026-08-27/report.md): the engine's own
`createFileServer` is **not adopted**. Measured on 0.8.16 it binds `0.0.0.0` and
one encoded-separator form escapes the served root on Windows, and its options
expose no hostname to narrow. The engine never calls it internally and
`createCaptureSession` takes a caller-supplied URL, so writing our own costs
nothing and inherits nothing.

- [x] Write failing tests for loopback-only binding, path traversal, MIME, byte range, missing assets, and shutdown. 18 cases.
- [x] Include the measured `createFileServer` failures as named regression cases: bind must not answer on a non-loopback address, and every encoded separator form (`%2f`, `%5c`, `%2e%2e`, and their combinations) must 404 on both Windows and POSIX separators. 11 traversal forms, including the one that defeated the engine's server.
- [x] Borrow only what is sound: its MIME table, and the head/body script-injection idea, which is a candidate mechanism for the later frame-control shim. Injection applies to the entry point only and disables ranges while rewriting.
- [x] Implement canonical-root checks and a random per-run path/token. Containment is checked twice: after `resolve()` and again after `realpath()`, so a symlink inside the root cannot lead out of it.
- [x] Add bounded request/body/header/log limits. URL 2 KiB, headers 16 KiB, file 512 MiB, header and request timeouts, `GET`/`HEAD` only, and every refusal returns an identical 404 so the server is not a filesystem oracle.
- [x] Verify no registered asset can escape the fixture root.
- [x] Verify the server closes and releases its port after every test.
- [x] Mutation-test the guards. A fully naive `join`-and-read server fails the traversal and symlink cases; binding without a host fails the loopback case; dropping the token fails the token cases. Removing only one of the two containment checks does **not** fail, which is the defence in depth working as intended.
- [x] Serve the URL without a trailing slash. The engine navigates to `${serverUrl}/index.html`, so a trailing slash produced `//index.html`, whose leading slash made `resolve()` treat it as absolute and land outside the root. Empty path segments are now collapsed as well. [S-NF-H02-FIXTURE]
- [x] Capture the fixture's reference frames through this server with the real engine, end to end.

### Task 4: Wrap the HyperFrames session

**Files:**
- Create: `Netsuflow/prototypes/hyperframes-renderer/hyperframesEngine.mjs`
- Create: `Netsuflow/prototypes/hyperframes-renderer/test/hyperframesEngine.test.mjs`

- [x] Write the descriptor and arbitrary-frame conformance tests first.
- [x] Implement `probe`, `open`, `describe`, `renderFrame`, `invalidate`, and `close` behind the documented common contract.
- [x] Keep every HyperFrames import in this file/module boundary. `hyperframesEngine.mjs` and `pixel/pngToRgba.mjs` are the only files that import it.
- [x] Retain one initialized session across repeated/reverse/random requests. 12 requests over 8 distinct frames, every repeat idempotent, every painted marker matching the frame asked for.
- [x] Bound session start with a configurable deadline. The engine's `playerReadyTimeout` is 45 s, so a composition that throws during setup took **46 s** to report; behind a Resolve render that reads as a hang. Default is now 20 s, measured at 21 s to failure. It is in session identity because under `gsap` mode the engine's timeline wait *warns* rather than throws when it expires, so a shorter deadline can change pixels rather than merely change whether the session starts.
- [x] Implement both capture paths behind one switch and compare them. **They produce byte-identical output**, so the choice is purely about speed.
- [x] Surface the timeline shim's decision as a session diagnostic naming `timelineMode: 'gsap'` as the fix.
- [x] Allocate a per-session scratch `outputDir`, which `createCaptureSession()` requires even for buffer capture, and assert after every close that it is empty and removed. Measured empty after every cycle: the live path never touches the disk. [S-HF-CAPTURE-BUFFER-PURPOSE]
- [x] Do **not** release the browser lease separately. This checkbox was written from the engine's README, where the caller owns the lease; the pinned 0.8.16 has `createCaptureSession` acquire it internally and `closeCaptureSession` release it idempotently, with a force-release fallback. Releasing it again would be the bug. Proven by the cycle test rather than by reading.
- [x] Prove that a frame reached by a random seek is byte-identical to the same frame reached sequentially, under Windows screenshot capture. [S-HF-CAPTURE-MODE] [S-NF-CONFORMANCE]
- [x] Implement both candidate capture paths behind one adapter switch. **Measured byte-identical**, so the switch is two routes to one picture and the choice is purely about speed. [S-NF-CONFORMANCE]
- [x] Forward deadline/cancellation where supported and enforce an outer deadline regardless. The engine offers no cancellation for a capture in flight, so the race stops the *caller* waiting rather than the work — the distinction that matters when the caller is a host render thread, and T01 measured that Resolve never aborts a render on this node.
- [x] Normalize engine exceptions to stable error codes, reading the engine's own `classifyCaptureFailure`, `isTransientBrowserError`, and `isMemoryExhaustionError` rather than matching message text, which would break on the next release.
- [x] Bound session start with a configurable deadline. The engine's `playerReadyTimeout` is 45 s, so a composition that throws during setup took **46 s** to report; behind a Resolve render that reads as a hang. Default 20 s, measured 21 s to failure. It belongs in session identity because under `gsap` mode the engine's timeline wait *warns* rather than throws when it expires, so a shorter deadline can change pixels and not merely whether the session starts.
- [x] Support both kinds of composition through a `timelineMode` binding option, rather than only rescuing the non-GSAP case. [S-NF-TIMELINE-MODES]
  - `auto` (default): a shim injected by the project server waits a bounded grace, then stops waiting on any host that has not registered a timeline. Measured 45,181 ms to 3,136 ms.
  - `gsap`: no shim, the engine's own wait applies in full. For a project whose setup is slower than any grace worth paying.
  - `none`: opt out as soon as the DOM parses. Measured 136 ms, for a composition known not to use timelines.
- [x] Inject the shim rather than editing the user's file. The project server rewrites only the entry point in flight; nothing on disk changes.
- [x] Never override an author's explicit `data-no-timeline`, and never mark a host that has registered a timeline.
- [x] Warn whenever the shim actually marks a host. That is the case where NetsuFlow took a judgement call about someone else's project, and a late-registering timeline is captured before its animation exists with nothing else reporting it. The warning names `timelineMode: 'gsap'` as the fix, and rides on every `EngineFrame` as a diagnostic.
- [x] Carry `timelineMode`, its grace, and the start deadline into session identity: all three can change the pixels for one frame.
- [x] Carry the same three into the service-side and plugin cache keys, once the cache exists in Task 7. `timelineMode`, `timelineGraceMs` and `startDeadlineMs` are all in `FRAME_KEY_FIELDS` and in `REVISION_FIELDS`, with a table test that fails if any of them stops moving the key. `capturePath` joined them: the two paths were measured byte-identical on 0.8.16, but that is a fact about one build rather than a promise, and a key that assumes it would serve wrong pixels the day it stops holding.
- [x] Prove close removes page/browser/server resources over 100 cycles. [S-NF-CONFORMANCE]
- [x] Decide the default capture path from the H02 latency measurement now that correctness is settled. **Default is `alpha`.** Measured at 1080p: alpha p50 117 ms against buffer 126 ms, and 66.4 against 66.6 ms at 320x180 — a difference inside run-to-run noise with overlapping p95 ranges, so speed does not decide it. What decides it is that NetsuFlow is a transparency workflow and `initTransparentBackground` once per session plus `captureAlphaPng` per frame is the path the engine documents for transparent output, at no measured cost. [S-NF-CAPTURE-PATH]

### Task 5: Validate and decode PNG

**Files:**
- Create: `Netsuflow/prototypes/hyperframes-renderer/pixel/pngToRgba.mjs`
- Create: `Netsuflow/prototypes/hyperframes-renderer/test/pngToRgba.test.mjs`
- Create: `Netsuflow/prototypes/hyperframes-renderer/test/fixtures/png/`

Decided in [H01](../tests/results/H01-2026-08-27/report.md): use the engine's
`decodePng`, which is zlib-only, dependency-free, and targets exactly Chrome's
screenshot output, but keep NetsuFlow's bounds check in front of it. It calls
`inflateSync()` without `maxOutputLength`, allocates from unvalidated IHDR
dimensions, and does not verify CRCs, so it is a decoder and not a validator.

- [x] Cap the encoded buffer, then parse and range-check IHDR **before** calling `decodePng`, and verify the decoded length against the requested dimensions after. Also require IEND, because a stream whose IDAT happens to inflate to a full image but which was cut short is still truncated.
- [x] Write hostile tests for truncated, corrupt, oversized, wrong-dimension, palette, grayscale, and alpha PNGs, asserting the guard rejects them before any allocation happens. 12 cases in `test/pngToRgba.test.mjs`.
- [x] Check the PNG signature before the length. Reporting "too short" for a buffer that is plainly not a PNG named the wrong problem.
- [x] Add one independent third-party decoder for golden-reference comparison only, never on the hot path: validating capture output with the code that produced it is circular. `pngjs` 7.0.0 (MIT, zero dependencies, exact pin, devDependency). It shares no code with the engine, and the comparison targets where the risk actually is — the five per-row filter reconstruction paths, four of which read already-reconstructed neighbours. 6 golden tests: every filter alone, mixed per-row filters, 1x1 edge cases, RGB and RGBA, plus the seven real Chrome captures. All byte-identical.
- [x] Write hostile tests for truncated, corrupt, oversized, wrong-dimension, palette, grayscale, and alpha PNGs. 13 cases, including the one that justifies the guard's cost (below).
- [x] Bound encoded and decoded sizes before allocation.
- [x] Normalize to tightly packed RGBA8 straight alpha. Also normalized to a `Buffer` **view** over the decoder's own memory: the engine returns a bare `Uint8Array`, so every consumer wanting a Buffer was paying `Buffer.from(pixels)` — a full-frame copy, 8.3 MiB at 1080p, on the per-frame path. Pinned by a test.
- [x] Test exact flat pixels and compositing of 50% alpha edges.
- [x] Benchmark validation/decode independently at 1080p and 4K. [S-NF-PIXEL-BENCH] 1080p: guard 6.5 ms, decode 15.3 ms, together 23.8 ms. 4K: guard 107 ms, decode 197 ms, together 303 ms. The guard is not a rounding error — it nearly doubles decode cost at 4K — and the benchmark's real result was proving it must stay anyway: a **complete, valid** deflate stream declaring 64 rows and carrying 8 decodes without error against the pinned engine, and the 56 missing rows come back as uninitialized memory rather than zeroes. The re-inflate is the only check that catches it.

### Task 6: Connect the existing bridge protocol

**Files:**
- Create: `Netsuflow/prototypes/hyperframes-renderer/server.mjs`
- Create: `Netsuflow/prototypes/hyperframes-renderer/fixture-diagnostic/index.html`
- Create: `Netsuflow/prototypes/hyperframes-renderer/test/server.test.mjs`
- Create: `Netsuflow/prototypes/hyperframes-renderer/tools/bridge-e2e.mjs`
- Reuse: `Netsuflow/prototypes/fake-renderer/protocol.mjs` (imported directly: one wire format, two services, zero drift)
- Reuse: `Netsuflow/openfx/tests/BridgeClientHarness.cpp` (the already-compiled binary, deliberately not rebuilt)

- [x] Write an end-to-end test that requests the fixture's known frame through the existing metadata/pixel protocol. `tools/bridge-e2e.mjs`, plus a diagnostic fixture composition that paints exactly what `DiagnosticFrame.cpp` computes — so the C++ harness's own pixel comparison becomes the cross-language proof. [S-NF-BRIDGE-E2E]
- [x] Resolve `binding -> HyperFrames session` in the Node prototype. One session per binding, memoized, renders serialized per binding (two seeks in flight on one page is a race, not parallelism), failed opens retried on the next request rather than poisoning the binding.
- [x] Return the same RGBA metadata shape as the fake renderer. Pinned by a test that asserts the exact key set; the client cannot tell which service answered.
- [x] Preserve authentication, length limits, deadlines, and explicit errors. 11 protocol tests run without a browser against a stub engine, including validation-before-engine-work, typed retryable errors, and descriptor lifecycle.
- [x] Run the C++ bridge harness against the real prototype. All 7 commands pass: frame/repeat/sequence/soak byte-match the C++ generator through the real engine, p50 66.7 ms at 320x180, reconnect and abort behave, expect-error proves the refusal path. Two traps found by running rather than reading: a synchronous spawn deadlocks the harness against the in-process server, and the soak draws frames in [0, 4096) so the diagnostic composition must cover 4110 frames or its seek clamp silently answers with the last frame.
- [x] Confirm no OpenFX source change was necessary. The harness binary compiled against the fake renderer ran unchanged against the real one — the claim executed, not asserted.
- [ ] Pre-open sessions in production: the harness allows 5 s per request and a cold browser start spends ~1.6 s of it; `warm()` exists and the service should call it for known bindings at startup.

### Task 7: Add revision-aware cache and scheduling

**Files:**
- Create: `Netsuflow/prototypes/hyperframes-renderer/frameKey.mjs`
- Create: `Netsuflow/prototypes/hyperframes-renderer/frameScheduler.mjs`
- Create: `Netsuflow/prototypes/hyperframes-renderer/test/frameKey.test.mjs`
- Create: `Netsuflow/prototypes/hyperframes-renderer/test/frameScheduler.test.mjs`
- Modify: `Netsuflow/prototypes/hyperframes-renderer/server.mjs` (wired in, not left as an unused library)

- [x] Write table tests covering engine/adapter/package/browser/project/composition/props/frame/size/scale/quality/pixel policies. 23 fields, one plausible perturbation each, every one required to move the key and none allowed to collide with another. A second test fails if the table falls behind `FRAME_KEY_FIELDS`, so adding a field without testing it cannot pass quietly.
- [x] Implement canonical props hashing and immutable revisions. `JSON.stringify` was not enough: it preserves insertion order, so the same props hash differently depending on how they were built, and it drops `undefined` members silently. Canonical form sorts keys, rejects non-finite numbers and functions, and folds `-0` into `0`.
- [x] Add identical in-flight deduplication and bounded interactive/final queues. Also a third priority: prefetch, which is the only work allowed to disappear when a queue fills — a requested frame has a host render thread blocked on it and T01 measured that Resolve never aborts, so refusing it retryably is the honest answer. A real request arriving for something queued as prefetch promotes it.
- [x] Prove source or props changes cannot return an old frame. Two ways, both tested: the revision is part of the key so a change cannot hit the old entry, and `invalidate()` drops every cached frame of that revision at every size and **rejects** callers still waiting rather than serving them stale pixels.
- [x] Add bounded decoded-memory cache; defer disk cache until correctness passes. Bounded by **bytes**, not entries: one 1080p frame is 8.3 MiB, so an entry count is not a bound at all when the entry size is whatever resolution the host asked for. A frame larger than the whole budget is not cached, because caching it would evict everything and then evict itself.
- [x] Verify requested work outranks prefetch.
- [x] Wire it into the bridge and measure it. **The T01 case, through the real C++ client: `repeat 320 180 7 20` went from p50 66.7 ms to p50 0.335 ms — 199× — with `mismatches=0`.** `sequence` and `soak` are unchanged at 66.5 ms, which is the correct result: distinct frames have nothing to hit. [S-NF-BRIDGE-E2E]
- [x] Fix found while testing: `close()` rejected queued work but left work already *running* pending forever. It only appears when a shutdown lands mid-render, which is exactly when nobody is watching.

### Task 8: Run H01-H03 and produce evidence

**Files:**
- Created: `Netsuflow/tests/results/H01-2026-08-27/report.md`
- Created: `Netsuflow/tests/results/H02-2026-08-27/report.md`
- Created: `Netsuflow/tests/results/H03-2026-08-27/report.md`
- Created: `Netsuflow/prototypes/hyperframes-renderer/tools/h03-soak.mjs`

- [x] Run package/public-API and 100-cycle lifecycle tests. Public API pinned against a 191-export baseline in `npm test`; 100 open/close cycles re-run on the current code. [S-NF-CONFORMANCE]
- [x] Run standalone-versus-bridge pixel/alpha/random-frame tests. 8 frames — repeated, sequential, reverse, random, and one served from cache — byte-identical between the adapter and the bridge, with matching stride and alpha mode. All 8 carried partial alpha, and the check fails if none does: a premultiplying step anywhere in the chain would pass a shape comparison and quietly destroy compositing. [S-NF-H03]
- [x] Run cold/warm, sequential/reverse/random, 1080p/4K stage benchmarks. 1080p warm miss p95 133.7 ms, memory hit p95 26.8 ms under load; 4K 326.8 ms and 69.6 ms. Capture is 80% of a 1080p miss. **Reverse and seeded-random traces cost what sequential costs** — 0 wrong frames across 1,900 requests, which is R25 and R6 answered by measurement rather than argument. [S-NF-H03]
- [x] Run 10,000-request bounded soak and worker-kill recovery. Twice: uniform (0.5% hits, 669 s, max 72.3 ms) and repeat-shaped (91.9% hits, 60 s, p50 0.3 ms). Both +6 MiB browser working set, browser count flat, cache pinned at its bound. All 5 browser processes killed mid-session: reported in 4.2 ms with a named error, recovered in-process. [S-NF-H03]
- [x] Record p50/p95/p99, memory, handles, process tree, failures, and raw artifacts. In [`H03-2026-08-27/`](../tests/results/H03-2026-08-27/report.md) with three raw runs.
- [x] Choose Live/Auto/Pre-render default from results. **Auto**, and not because misses are slow — they are not. The cold session is **5.5 s at 1080p and 6.7 s at 4K**, once per binding revision, and no cache touches it. Auto is the only mode that can warm a session before a frame is demanded rather than after.
- [x] Stop before production integration if correctness, cleanup, or bounded failure does not pass. All six H03 pass criteria hold.
- [x] Fix found by running: the prototypes' shared `MessageReader` reassembled frames quadratically. It looked exactly like a slow cache — 4K memory hit p95 **1,564 ms** — and the honest conclusion from the unfixed number would have been that Live is impossible at 4K. Now 53.7 ms. Caught only because the C++ client had already measured the same operation at 0.335 ms and the two could not both be right. [S-NF-READER-QUADRATIC]

### Task 9: Optional in-Resolve proof

**Files:**
- Updated: `Netsuflow/tests/results/RUNBOOK-manual-resolve.md` — Step 5 written,
  and the plugin's visible name corrected in Step 1: the runbook still told the
  operator to look for `NetsuFlow Remotion (Experimental)`, a label that has not
  existed since the renderer decision.
- Create: `Netsuflow/tests/results/H04-YYYY-MM-DD/report.md`

This task needs a human at Resolve. Everything that could be prepared without one
is prepared: the bundle is installed per-user and its SHA-256 matches the build,
`OFX_PLUGIN_PATH` and `NETSUFLOW_OFX_LOG` are set, the service takes
`--session` to write where the plugin reads, and the `diagnostic` fixture paints
what the plugin's own Local Diagnostic mode computes — so the first in-host check
is that toggling `Mode` changes nothing on screen.

- [x] Start the prototype externally. Driven through Resolve's own scripting API from Python rather than by hand, which is what made the sweeps repeatable. [S-NF-H04]
- [x] Use the already-installed Generator and a HyperFrames binding. Bundle SHA-256 matches the build; no rebuild, no plugin change.
- [x] Capture host logs and reference screenshots. [`H04-2026-08-27/`](../tests/results/H04-2026-08-27/report.md) — host log, two stills, and the composition's own frame labels matching the frames requested.
- [x] Do not modify the plugin unless a host-contract defect is demonstrated. None was. The one blocker — `sourceRevision` hardcoded `"0"` against a `rev-0` fixture default, so **the two can never match out of the box** — is a placeholder meeting a default, worked around with `--revision 0`.
- [x] Fix found by running: the service logged nothing when it refused a frame, and the host shows one generic string for all six refusal reasons. Every refusal now logs its code and detail; the next run named the cause on the first frame. [S-NF-H04]
- [ ] Test repeated, sequential, reverse, random, unavailable-service, restart, and final render. **Partly.** Repeated and out-of-order frames confirmed byte-identical in host. Deliver, service-killed and browser-killed in host, and proxy scale are all still unrun — and Resolve's own cache absorbs scrubbing so completely that the plugin was never re-invoked, which changes how the remaining cases must be staged.
- [x] Inspector redesign (user-directed, 2026-08-27): the node is now Source (Code / NetsuRush / Diagnostic) + a Code field + Quality/Start Frame, with the dead Props/Diagnostic Source/Cache controls removed. Pasted code spools to `%LOCALAPPDATA%/NetsuRush/netsuflow/paste/` with its FNV-1a64 hash as revision; DESCRIBE carries declared composition variables onto a pre-declared control pool; per-frame variable values ride the FRAME request and rebuild the session on change. Output is premultiplied in the copy loop, which is the H04 soft-edge fix. Plugin v0.2 built; native 3/3, prototype 127/127, bridge e2e 10/10. **Bundle swap pending: Resolve holds the binary.**
- [ ] Only after this pass begin the NetsuRush integration plan. Two items to settle first: where `sourceRevision` comes from, and which pixel depth Resolve gives in which context — this run logged `depth=1` (8-bit) throughout where T01 recorded `depth=4` (float).

