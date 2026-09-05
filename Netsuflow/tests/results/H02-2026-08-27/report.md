# H02 partial result (fixture, alpha, determinism, adapter conformance, bridge, pixel path) — 2026-08-27

Status: PASS for the slice it covers

[H02](../../engines/hyperframes/H02-random-frame-and-alpha.md) asks which
capture path is correct and whether pixels are stable. This report covers the
first slice: a deterministic fixture exists, the real pinned engine renders it,
alpha survives, and repeated and out-of-order captures were byte-identical
across five runs. The full H02 matrix — WebGL, video, 4K, preview scale,
hostile buffers, and the long soak — is not covered.

Produced by Tasks 2, 3, 4, 5, 6 and 7 of the
[HyperFrames adapter plan](../../../plans/2026-08-27-hyperframes-renderer-adapter-implementation.md).

## Environment

| | |
|---|---|
| OS | Windows 11 Pro 10.0.26200, x64 |
| Node | v22.16.0 |
| `@hyperframes/engine` | 0.8.16 (exact pin) |
| Browser | `chrome-headless-shell` 152.0.7977.54, provisioned into the prototype, not the user's cache |
| Renderer | ANGLE / SwiftShader (software) |
| Capture mode | `screenshot` (BeginFrame is Linux-only) |
| Served by | NetsuFlow's own project server: loopback-only, per-run token, containment checked twice ([`project-server-tests.txt`](project-server-tests.txt)) |

## Commands

```text
npx @puppeteer/browsers install chrome-headless-shell@152.0.7977.54 --path ./.browser
node tools/reference-capture.mjs
npm test
```

Raw run in [`capture-run.txt`](capture-run.txt); per-frame checksums and samples
in [`references.json`](references.json).

## Results

### The fixture satisfies the engine contract

The engine's requirement of a page is small and public: expose
`window.__hf = { duration, seek }` with `duration > 0`, seeking in seconds. It
polls for exactly that expression before capturing. The fixture implements it
with pure arithmetic and no animation library, so a difference between two
captures of one frame cannot originate in the composition.

`pollHfReady` completed in 118 ms and `getCompositionDuration()` returned the
declared 10 s.

### Alpha survives, and it is straight, not premultiplied

| Sample | Measured |
|---|---|
| 50% white over transparency | `rgba(255, 255, 255, 128)` |
| untouched area | `rgba(0, 0, 0, 0)` |

Premultiplied alpha would have given `rgba(128, 128, 128, 128)` for the first
row. It did not. The PNG capture path delivers **straight** alpha, which is what
[`08-color-time-and-alpha.md`](../../../docs/08-color-time-and-alpha.md)
assumes, now measured rather than assumed for this path.

### Repeated and out-of-order captures were identical

Seven frames (0, 1, 2, 30, 89, 150, 299) were captured sequentially, then the
same seven out of order (299, 30, 0, 150, 1, 89, 2), then frame 150 three times
back to back. Every comparison was byte-identical across five full runs, and
every frame's painted marker matched the frame requested.

That is real evidence against R25 and R6 for this fixture, on this engine build,
on this machine. It is not yet a product claim: one fixture with hard-edged
content, five runs, on software rendering.

### Timing

`avgTotalMs` 95, `avgSeekMs` 4, `avgScreenshotMs` 67, p95 105 ms at 1080p, all
on the software renderer, and none of it cached. Against the provisional
250 ms warm-miss target in the risk register that is comfortable, and it says
the screenshot encode is the dominant stage — which is where H02's remaining
work should look first.

## Failures and observations

### The 45-second stall, and supporting both kinds of composition

The first run took **45,179 ms** to initialise a session. The engine polls for
`window.__timelines[id]`, which only a GSAP-driven composition registers, and
waits out the full 45 s `playerReadyTimeout` when it never appears. Its error
message names the opt-out: `data-no-timeline` on the element carrying
`data-composition-id`.

Hand-editing the fixture to add that attribute made init 129 ms, but it was the
wrong fix: a user's composition will not carry it, so the fixture stopped
representing the problem. The attribute was removed again and the case is
handled where it belongs — in a **timeline shim injected by the project server**,
so nothing on disk is modified. It offers three modes.

| Composition | Mode | Init | Outcome |
|---|---|---:|---|
| registers no timeline | none (no shim) | 45,181 ms | the problem |
| registers no timeline | `auto` | 3,136 ms | shim marked the host after the grace |
| registers no timeline | `none` | 136 ms | opted out as soon as the DOM parsed |
| registers a timeline | `auto` | 103 ms | untouched; the shim never had to fire |
| registers a timeline | `gsap` | 98 ms | untouched, no shim injected |

Lowering the engine's `playerReadyTimeout` would have been the wrong lever: the
same timeout also bounds the wait for `window.__hf`, so a composition that
legitimately needs seconds to expose it would start failing.

GSAP itself is not vendored to test this. What the engine requires is the
registration, not the library, so the timeline-side fixture registers a minimal
object directly — which also avoids GreenSock's no-charge licence, whose terms
do not cover redistribution in a sold product.

### `auto` has a window, and it is measured rather than assumed

A composition whose timeline registers *after* the grace is captured while its
animation does not yet exist, and nothing reports an error. That is the one way
this design can be silently wrong, so it is reproduced on purpose.

`fixture-gsap-late` registers its timeline at 2,500 ms and paints red until it
does:

| Mode | Init | Marker pixel |
|---|---:|---|
| `auto`, 500 ms grace | 1,311 ms | `rgb(255,23,68)` — **captured before the timeline existed** |
| `auto`, default 3 s grace | 2,766 ms | `rgb(0,200,83)` — animation was ready |
| `gsap` | 2,613 ms | `rgb(0,200,83)` — animation was ready |

The default grace of 3 s was chosen from this, not from taste: it covers a
realistically slow setup — fonts, decoded media, an async data step — while
staying 14× better than the stall it replaces, and session init happens once per
binding revision rather than once per frame.

Two consequences the adapter owes the user. It must **warn whenever the shim
actually marks a host**, because that is precisely the case where NetsuFlow made
a judgement call about someone else's project, and the warning should name
`gsap` mode as the fix. And `timelineMode` must enter the binding revision and
every cache key, because two modes can produce different pixels for one frame.

### Antialiased edges were the only unstable pixels

Before the fixture was restructured, three of seven out-of-order captures
differed from their sequential counterparts. The difference was 28 to 83 pixels
out of 2,073,600 — 0.004% — with a maximum channel delta of 21, and **every
differing pixel fell inside the SVG region**, on the diagonal edges of a
polygon that shared its SVG with an animating rectangle.

The polygon does not move. The rectangle beside it does. The most likely
mechanism is that re-rasterising the layer re-rasterises its antialiased edges,
and does not always land on the same values. **This was not isolated to a proven
cause**, and it did not reproduce after the restructure, so it is recorded as an
observation, not a diagnosis.

The fixture now separates the two concerns: hard-edged content that is required
to be byte-exact, and one antialias probe with a triangle, a circle, and its own
animating rectangle, compared with a tolerance. The probe keeps an animated
element on purpose — a static SVG layer is cached and never varies, so a probe
without one silently stops probing.

The practical warning for the product: instability lives where antialiased
content shares a layer with animated content, which is most real compositions.
H02's remaining matrix should target exactly that.

### The engine's README does not match the shipped package

The README shows `createCaptureSession({ browser, url, width, height, fps })`.
The installed 0.8.16 exports
`createCaptureSession(serverUrl, outputDir, options, onBeforeCapture?, config?)`
and acquires its own browser lease internally from `config.chromePath`. Anyone
following the README against this version writes code that cannot work.

This is the doctrine of pinning and verifying against the installed package
paying for itself on the first use.

### BeginFrame would not have helped alpha anyway

The capture source states that BeginFrame's compositor does not preserve alpha,
and that callers wanting transparent PNG output should set
`forceScreenshot: true`.

That materially softens [R24](../../../docs/10-risk-register.md). Windows never
getting BeginFrame looked like a lost determinism guarantee; in fact an
alpha-capable workflow has to force the screenshot path on **every** platform,
Linux included. NetsuFlow was never going to use BeginFrame. The risk is not
"Windows is worse than Linux", it is "no platform gets the deterministic
compositor path", and it applies to any engine consumer that needs transparency.

### The engine appends `/index.html` to the URL it is given

Discovered when the reference capture was moved onto NetsuFlow's own project
server, which scopes URLs under a per-run token. The server returned its URL
with a trailing slash so relative assets would resolve; the engine builds
`${serverUrl}/index.html`, producing `//index.html`. After the server stripped
its token prefix that left a leading slash, `resolve()` treated it as an
absolute path, and the request landed outside the served root and 404ed.

The symptom was the full 45-second `window.__hf` readiness timeout with
`__hf=false, duration=-1` — an error that names neither the URL nor the missing
file. The server now returns its URL without a trailing slash and collapses
empty path segments defensively, both pinned by tests.

Worth stating plainly because any adapter that composes a URL hits it: the
engine does not navigate to the URL you hand it, it navigates to that URL plus
`/index.html`.

### The browser lives with the prototype, not in the user's cache

`resolveHeadlessShellPath` falls back to `~/.cache/hyperframes` and
`~/.cache/puppeteer`. NetsuFlow passes `config.chromePath` explicitly instead,
which is what
[packaging-and-versioning](../../../docs/engines/hyperframes/packaging-and-versioning.md)
requires: an application-owned, verified runtime rather than whatever a shared
home cache happens to contain.

## Adapter conformance

The common contract from [`04-engine-contract.md`](../../../docs/04-engine-contract.md),
executed against the real adapter. 13 checks, 0 failures, full output in
[`engine-conformance.txt`](engine-conformance.txt).

What it establishes beyond what is already above:

- **Arbitrary frame order is idempotent.** 12 requests over 8 distinct frames —
  first, repeated, sequential, reverse, random — every repeat byte-equal and
  every painted marker matching the frame requested.
- **The two capture paths are one picture.** `captureFrameToBuffer` and
  `initTransparentBackground` + `captureAlphaPng` returned identical pixels, so
  choosing between them is purely a latency question.
- **A broken composition fails in 21 s, not 46.** The engine's own
  `playerReadyTimeout` is 45 s, so a composition that throws during setup spent
  all of it before reporting. Behind a Resolve render that reads as a hang. The
  adapter now bounds start with its own configurable deadline, defaulting to
  20 s. That value is part of session identity, because under `gsap` mode the
  engine's timeline wait *warns* rather than throws when it expires — so a
  shorter deadline can change the pixels and not merely whether the session
  starts.
- **Nothing leaks over 100 open/close cycles.** No scratch directory survived,
  no orphaned `chrome-headless-shell` process remained, and the adapter's own
  resident set grew 38 MiB. The number that matters is the comparison rather
  than the value: 3 cycles cost 24 MiB and 100 cycles cost 38 MiB, so 33× the
  work bought 1.6× the memory. That shape is garbage-collection lag, not a leak;
  a real leak at 8.3 MiB of pixels per cycle would have reached hundreds of
  megabytes.
- **The scratch `outputDir` was empty every time.** The engine demands one even
  for buffer capture, and anything appearing in it would mean the live path
  touches the disk.

The browser lease needs no separate release. The plan said otherwise, copying
the engine's README, where the caller owns it; in the pinned package
`createCaptureSession` acquires it and `closeCaptureSession` releases it
idempotently with a force-release fallback. Releasing it again would be the bug.

## Bridge end to end: the real engine behind the real wire

Task 6, executed. The bridge server ([`server.mjs`](../../../prototypes/hyperframes-renderer/server.mjs))
puts the real adapter behind the exact protocol the fake renderer speaks — it
imports the fake renderer's `protocol.mjs` directly, so there is one wire
format and zero drift by construction. 10 checks, 0 failures, raw output in
[`bridge-e2e.txt`](bridge-e2e.txt).

The proof has two independent halves. A new diagnostic fixture composition
paints, per frame, exactly the pixels `openfx/src/DiagnosticFrame.cpp`
computes. The Node side then compares protocol responses against the
JavaScript mirror of that generator, and the C++ `BridgeClientHarness` — the
exact client the OpenFX plugin uses, **deliberately not rebuilt** since it was
compiled against the fake renderer — compares against the C++ original. Both
agree byte for byte through HTML canvas → Chromium screenshot → PNG → decode →
protocol → C++ client:

| Harness command | Result |
|---|---|
| `frame 320 180 7` | `pixelsMatch=true`, 230,400 bytes |
| `repeat × 20` | 0 mismatches, p50 66.7 ms |
| `sequence × 30` | 0 mismatches, p50 66.6 ms |
| `soak × 40` pseudo-random | 0 mismatches, p50 66.7 ms |
| `reconnect` | first/reconnect/second all Ok |
| `abort` | Aborted, 0 bytes |
| `expect-error` (64×64 vs 320×180 binding) | explicit ServiceError |

An unchanged, already-compiled C++ client working against the new service is
the claim "no OpenFX source change was necessary" executed rather than
asserted.

Two traps were found by running rather than reading. A synchronous spawn of
the harness deadlocks: the bridge server lives in the same Node process, and
`spawnSync` blocks the event loop the server answers from, so the harness
times out waiting for a HELLO_OK that can never arrive. And the harness soak
draws frames in [0, 4096) — a composition shorter than 4110 frames clamps the
seek and silently answers with its last frame, which surfaced as a soak
mismatch at frame 807 against the first 10-second fixture.

Wire-level behaviour — authentication, validation before any engine work,
typed retryable errors, session-per-binding with serialized renders,
descriptor lifecycle — is pinned by 11 browser-free tests against a stub
engine ([`server.test.mjs`](../../../prototypes/hyperframes-renderer/test/server.test.mjs)),
including one that asserts the response metadata carries exactly the fake
renderer's key set: the client cannot tell which service answered.

One consequence for production: the harness allows 5 s per request and a cold
browser start spends ~1.6 s of it, so the service warms its known bindings at
startup (`warm()`) instead of paying that on the first frame Resolve asks for.

### What the cache is worth, measured through the C++ client

T01 measured Resolve issuing **21 render calls for one frame**, some 23 ms
apart. At the capture rate above that is 2.4 s of browser work for one picture.
With the scheduler's in-flight deduplication and byte-bounded cache wired into
the bridge, the harness's own repeat command answers the question:

| Harness command | Before | After |
|---|---:|---:|
| `repeat 320 180 7 20` | p50 66.7 ms | **p50 0.335 ms** |
| `sequence 320 180 30` | p50 66.6 ms | p50 66.5 ms |
| `soak 320 180 40` | p50 66.7 ms | p50 66.5 ms |

199× on the repeated frame, `mismatches=0` throughout — the pixels are still
compared against the C++ generator on every one of those fast answers, so this
is a cache hit and not a skipped check. `sequence` and `soak` are unchanged,
which is the correct result rather than a disappointing one: distinct frames
have nothing to hit, and a cache that appeared to speed them up would mean it
was returning the wrong frame.

The cache is bounded in **bytes**, not entries. One 1080p frame is 8.3 MiB, so
an entry count is not a bound at all when the entry size is set by whatever
resolution the host asked for.

Two things the scheduler refuses to do, both because T01 measured that Resolve
never aborts a render. Requested work is never dropped when a queue fills — it
is refused with a retryable error, because a dropped request strands a host
render thread. And prefetch is the only work allowed to disappear; a real
request arriving for a frame queued as prefetch promotes it rather than waiting
behind speculation.

Wiring it up surfaced a defect in the scheduler that its own unit tests had not:
`close()` rejected queued work but left work already *running* pending forever.
It appears only when a shutdown lands mid-render, which is exactly when nobody
is watching.

## The pixel path, measured

30 samples per stage, raw output in [`pixel-bench.txt`](pixel-bench.txt).

| Stage | 1080p (real capture) | 4K |
|---|---:|---:|
| guard only (chunk walk + re-inflate) | 6.5 ms | 107 ms |
| engine `decodePng` only | 15.3 ms | 197 ms |
| `decodePngToRgba` (guard + decode) | 23.8 ms | 303 ms |
| pngjs, reference only | 39.6 ms | 335 ms |

The guard is not a rounding error. It re-inflates the IDAT purely to measure it,
and at 4K that nearly doubles the cost of the decode it protects.

**It has to stay, and the benchmark is what proved it.** Looking for a way to
make it cheap turned up the case it exists for. A PNG whose deflate stream is
*complete and valid* but which declares 64 rows while carrying 8 decodes
without any error against the pinned engine — and the 56 rows the stream never
described come back as **uninitialized memory**, not zeroes: the decoder
allocates with `Buffer.allocUnsafe` and writes only what it decoded. Observed
leaking a recognizable byte pattern from a previously freed buffer.

Nothing else catches it. The deflate stream is well-formed so `inflateSync`
succeeds, IEND is present, and the decoded length matches the header exactly.
Without the re-inflate, NetsuFlow would hand Resolve — and whoever watches that
render — most of a frame made of whatever was in that memory. It is now pinned
by a test that says so, and it is worth reporting upstream alongside the two
issues H01 already listed.

Separately, the engine returns pixels as a bare `Uint8Array`, so every consumer
wanting a `Buffer` was calling `Buffer.from(pixels)` — a full-frame copy,
8.3 MiB at 1080p, on the per-frame path. The guard now normalizes once, as a
view over the same memory.

### An independent decoder, to check the decoder

Every other test here compares the engine's decode against expectations derived
from the engine, which cannot catch the engine being wrong. pngjs 7.0.0 (MIT,
zero dependencies, exact pin, fixtures only — never the hot path) shares no code
with it, and the comparison targets where the risk actually lives: PNG's five
per-row filters are five separate reconstruction paths, four of them reading
already-reconstructed neighbours, and Chrome picks them per row. A decoder can
be perfect on filter 0 and wrong on filter 4.

Every filter alone, mixed per-row filters, 1×1 edge cases, RGB and RGBA, and the
seven real Chrome captures: all byte-identical. pngjs is also 1.7× slower at
1080p, so the choice of decoder now has a number attached rather than a
preference.

## The capture path default

Correctness was already settled — the two paths return byte-identical pixels —
so this was only ever a latency question. 24 distinct frames per path, orders
alternated, raw output in [`capture-path.txt`](capture-path.txt).

| Composition | `buffer` p50 | `alpha` p50 |
|---|---:|---:|
| opaque, 1080p | 125.8 ms | 117.2 ms |
| diagnostic canvas, 320×180 | 66.6 ms | 66.4 ms |

The honest reading is that they are the same speed: the 1080p gap is 6.9% with
overlapping p95 ranges, and the small composition shows nothing at all.

So speed does not decide it, and **the default is `alpha` for a different
reason**. NetsuFlow is a transparency workflow — a Fusion generator whose output
composites — and `initTransparentBackground` once per session plus
`captureAlphaPng` per frame is the path the engine documents for transparent
output. Choosing the path built for the job, at no measured cost, beats choosing
the other one and hoping.

## Decision

Tasks 2, 3, 4, 5, 6 and 7 pass. The decoder guard is in place with its hostile
matrix and an independent golden reference. The fixture is a usable measuring instrument: it satisfies the
engine contract, renders every content class the pixel path has to survive,
identifies its own frames byte-exactly, and is guarded by tests that fail on
drift, on a stale reference set, and on a lost `data-no-timeline`. The bridge
run closes the loop the architecture promised: the plugin's own client, built
against a fake, cannot tell the real engine apart.

## Follow-up

- The adapter must warn whenever the shim marked a host, and must carry
  `timelineMode` into the binding revision and every cache key.
- H02: pursue antialiased-content-beside-animated-content specifically, at 4K
  and at preview scale, and on a GPU renderer rather than SwiftShader.
- Re-check `createCaptureSession`'s signature on every engine upgrade; the
  README is not a reliable guide to it.
- Consider reporting the README drift upstream alongside the two issues H01
  already listed.
