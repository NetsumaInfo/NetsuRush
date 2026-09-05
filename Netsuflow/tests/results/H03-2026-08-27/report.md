# H03: cache, scrubbing, and soak — 2026-08-27

Status: PASS

[H03](../../engines/hyperframes/H03-cache-scrubbing-soak.md) asks whether
HyperFrames stays useful and bounded under Resolve-like frame traces, and
[H03 session performance](../../../research/hyperframes/H03-session-performance.md)
asks which session lifecycle survives it. Both were run against the same bridge
server the OpenFX plugin talks to, so what is measured is the product's path
rather than a laboratory one.

Produced by Task 8 of the
[HyperFrames adapter plan](../../../plans/2026-08-27-hyperframes-renderer-adapter-implementation.md).

## Environment

| | |
|---|---|
| OS | Windows 11 Pro 10.0.26200, x64 |
| Node | v22.16.0 |
| `@hyperframes/engine` | 0.8.16 (exact pin) |
| Browser | `chrome-headless-shell` 152.0.7977.54, owned by the prototype |
| Renderer | ANGLE / SwiftShader (**software**) |
| Capture mode | `screenshot`, `capturePath: alpha` |

Every number below is on a software renderer. A GPU renderer should improve the
capture stage and change nothing about the cache or the bounds.

## Commands

```text
NETSUFLOW_H03_PHASES=a,b,c,d,e,g,h node tools/h03-soak.mjs
NETSUFLOW_H03_PHASES=f node tools/h03-soak.mjs
NETSUFLOW_H03_SOAK_TRACE=uniform NETSUFLOW_H03_PHASES=f node tools/h03-soak.mjs
NETSUFLOW_CONFORMANCE_CYCLES=100 node tools/engine-conformance.mjs
```

Raw output in [`h03-run.txt`](h03-run.txt), [`soak-repeat.txt`](soak-repeat.txt),
[`soak-uniform.txt`](soak-uniform.txt) and
[`conformance-100.txt`](conformance-100.txt). Every number below is from those
files; phases were run back to back, so they contend for the machine the way a
real workload would.

## Cold, warm miss, memory hit

| | 1080p | 4K |
|---|---:|---:|
| cold session + first frame | 5,452 ms | 6,737 ms |
| warm miss, p50 / p95 | 119.9 / 133.7 ms | 315.0 / 326.8 ms |
| — capture stage p50 | 94.3 ms | 205.6 ms |
| — decode stage p50 | 24.8 ms | 109.9 ms |
| decoded memory hit, p50 / p95 | 15.9 / **26.8 ms** | 60.1 / 69.6 ms |

Against the [risk register](../../../docs/10-risk-register.md)'s provisional
targets: the 1080p decoded memory hit had to stay under 33 ms at p95 and lands
at 26.8 ms; the warm miss had to stay under 250 ms and lands at 133.7 ms. Both
are asserted by the tool rather than merely printed, so a regression fails the
run.

26.8 ms is inside the 33 ms target but not comfortably. Measured alone rather
than after five other phases the same figure is 15.3 ms, so most of the gap is
contention from the run itself — which is the number worth keeping, because a
real service also shares its machine.

Capture dominates a miss at both resolutions — 79% at 1080p, 65% at 4K. The risk
register's rule for that case says to improve session and prefetch, or prefer
pre-render, rather than optimise pixels. That is what the mode default below
does.

Cold is the number that shapes the product. Five to seven seconds to launch a
browser, open a page, and reach the first frame is not something a user can be
asked to wait for on a timeline click, and it does not improve with cache. It
happens once per binding revision, which is why the service warms known bindings
at startup.

## Lifecycle

The [100-cycle conformance run](conformance-100.txt) on the current code: **13
checks, 0 failures**. A hundred open/close cycles left no scratch directory, no
orphaned browser process, and grew the adapter's resident set by 35 MiB — which
is the same shape measured at 3 cycles (24 MiB), so it is allocator lag rather
than a leak.

### A 29× measurement error, found by measuring

The first run reported a 4K memory hit at **1,455 ms** and a 1080p hit at
108 ms — far outside target, and impossible to reconcile with the C++ client
answering the same cached frame in 0.335 ms.

The cache was not the problem. The shared `MessageReader` in the prototypes'
protocol module concatenated every arriving socket chunk onto an accumulator,
which recopies everything received so far on each chunk: quadratic in message
size. Invisible on the small messages its own tests use, ruinous on a frame. A
4K RGBA body is 33 MiB in roughly 520 chunks, so reassembling it copied on the
order of gigabytes.

It now holds chunks in a list and copies each message exactly once, when it is
complete.

| Decoded memory hit, p95 | Before | After |
|---|---:|---:|
| 1080p | 131.2 ms | 15.3 ms |
| 4K | 1,564 ms | 53.7 ms |

Worth stating plainly because of what it nearly cost: this looked exactly like a
slow cache, and the honest conclusion from the unfixed number would have been
that Live mode is impossible at 4K. The defect was in the measuring instrument,
and the only reason it was caught is that the C++ client had already measured
the same operation at 0.335 ms and the two could not both be right.

## Scrub traces

Every frame in every trace is verified against the marker the diagnostic fixture
paints, so a fast answer that is the wrong frame fails rather than flatters.

| Trace | Frames | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| sequential | 300 | 66.7 ms | 69.2 ms | 72.6 ms |
| reverse | 300 | 66.5 ms | 68.5 ms | 69.5 ms |
| seeded random | 1,000 | 66.7 ms | 68.7 ms | 70.4 ms |
| short loop (25 frames) | 300 | 0.3 ms | 66.7 ms | 68.0 ms |

Zero wrong frames across 1,900 requests.

**Reverse and random seeking cost exactly what sequential costs.** That is the
direct answer to [R25](../../../docs/10-risk-register.md) — the concern that a
capture API written for sequential streaming would degrade under random access —
and to R6 on seek determinism. It was a real concern:
`captureFrameToBuffer` is built for the engine's sequential FFmpeg pipeline and
promises nothing about backward seeks. It simply does not degrade here.

The loop trace is what a user scrubbing a short range actually produces, and it
is the shape the cache was built for: p50 0.3 ms, with the p95 showing the
misses on the first pass through the range.

## Concurrent bindings

| Bindings | p50 | p95 | p99 | Browser processes | Working set |
|---|---:|---:|---:|---:|---:|
| 2 | 66.8 ms | 69.0 ms | 2,619 ms | 6 | 328 MiB |
| 4 | 66.6 ms | 69.4 ms | 3,122 ms | 8 | 482 MiB |

Frames never crossed between bindings: each carries its own revision, so a frame
answered from the wrong binding would be a key collision, and the painted marker
proves it did not happen.

Two things to be honest about. A "browser" is several OS processes — 6 for two
bindings, 8 for four — so process count is not binding count. And the p99 column
is not a stall: it is the cold start of each binding's session on its first
request, which is the same 5-second cost as Phase A seen through a percentile.
Steady-state p95 moves by 0.4 ms between two bindings and four, which is the
result that matters for the lifecycle choice.

**Lifecycle decision: one session per binding revision**, the simplest of the
five candidates in the research note. Nothing measured here argues for a page
pool or a lease manager: per-frame latency does not degrade with four
concurrent bindings, and memory grows predictably — 328 MiB for two, 482 MiB
for four, so roughly 155 MiB for the first and ~77 MiB per binding after it. A pool becomes worth its complexity only when binding count grows past
what memory allows, and that threshold should be measured on real projects
rather than guessed at now.

## Revision changes

40 rapid invalidation cycles: request frame 11, invalidate, request it again.
**40 of 40 re-rendered, 0 stale frames.** A cached frame that survived its
revision would have shown up as a request that did not increment the render
count.

This is [R11](../../../docs/10-risk-register.md) and R22 — stale frames after a
props or parameter change — closed for the service-side cache. The plugin's own
last-frame cache is a separate layer and is covered by T05/T10.

## Bounded waits

An impossible deadline (1 ms) is refused in **1.9 ms** with `FRAME_TIMEOUT`,
rather than blocking until the capture finishes.

This matters more than it looks. T01 measured that Resolve never aborts a render
on this node, so the deadline is the only thing standing between a slow engine
and a permanently stuck host render thread. Cancellation cannot do that job
because the engine offers none for a capture in flight; the race stops the
*caller* waiting, which is the distinction that matters when the caller is
Resolve.

## Standalone versus bridge

Eight frames — repeated, sequential, reverse, random, and one asked for twice so
a cached answer is compared as well as a fresh one — rendered through the
adapter directly and through the bridge in the same process. **All eight
byte-identical**, with matching dimensions, stride and alpha mode.

All eight carried partial alpha, and the test fails if none does: a
premultiplying step anywhere in the chain would pass a shape check and quietly
destroy compositing, so the comparison has to be made on pixels that would
reveal it.

That covers [R5](../../../docs/10-risk-register.md): everything between the
adapter and the caller — PNG decode, the RGBA normalizer, the cache, the
framing, the socket — is a chance to alter or truncate pixels, and none of them
did.

## Browser kill and recovery

All five browser processes killed mid-session, filtered by executable path so
only this prototype's browsers were touched.

The next request for an uncached frame failed in **4.2 ms** with
`render-failed`, and a new binding opened a fresh browser in the same service
process without restarting anything.

Failing fast is the point. A hang behind a Resolve render is indistinguishable
from a crash, and T01 measured that Resolve will wait indefinitely, so the
requirement is a named error rather than silence. `worker restart does not
require Resolve restart` from the H03 pass criteria holds.

## Soak: 10,000 requests

| | |
|---|---|
| Requests | 10,000 |
| Wall clock | 669 s |
| Latency | p50 66.6 ms, p95 68.1 ms, p99 68.9 ms, max **72.3 ms** |
| Trace | uniform random over 4,000 frames |
| Wrong frames | 0 |
| Failures | 0 |
| Browser processes | 5 throughout |
| Browser working set | 260 → 266 MiB (**+6 MiB**) |
| Handles | 2,060 → 2,039 (**−21**) |
| Node RSS | 120 → 146 MiB, oscillating 113–146 |
| Cache | pinned at its 4.0 MiB bound from the first checkpoint |

Raw run in [`soak-uniform.txt`](soak-uniform.txt).

The strongest single number is `max 72.3 ms`. Across ten thousand requests the
worst case is 9% above the median — no stalls, no growing tail, no pause that
would read as a freeze in a host.

**The cache hit rate was 0.5%, and that was an accident worth keeping.** The
trace generator was written to imitate Resolve's measured behaviour of repeating
one frame many times, but a misplaced state advance meant the repeat counter
never took effect and the trace came out uniformly random over 4,000 frames.
With 4,000 distinct frames and a 4 MiB cache holding about 18 of them, almost
nothing hit — which the 669 s wall clock confirms, being very close to
10,000 × 66.6 ms.

So this is not the soak that was designed. It is a harder one: ten thousand
consecutive real browser captures, which is a far better test of whether
resources stay bounded than a run mostly served from memory. The bug is fixed
and the shaped trace is available, with a second run below; this result is kept
because it is the stronger evidence for R7.

Handles going *down* over 9,000 requests, and the browser working set moving
6 MiB, is the answer to [R7](../../../docs/10-risk-register.md) — browser and
session memory growing during scrubbing. Node's RSS oscillating between 113 and
146 MiB is garbage collection, not a trend: it falls as often as it rises.

### The same soak with the intended trace

Re-run with the repeat counter fixed, so the trace holds each frame for 3–20
requests the way Resolve does. Raw run in [`soak-repeat.txt`](soak-repeat.txt).

| | Uniform (all miss) | Repeat-shaped |
|---|---:|---:|
| Cache hit rate | 0.5% | **91.9%** |
| Wall clock | 669 s | **60 s** |
| p50 | 66.6 ms | **0.3 ms** |
| p95 | 68.1 ms | 62.7 ms |
| p99 | 68.9 ms | 65.6 ms |
| max | 72.3 ms | 111.7 ms |
| Browser working set | +6 MiB | +6 MiB |
| Handles | −21 | +33 |
| Browser count | 5, flat | 5, flat |

Same ten thousand requests, eleven times less wall clock, and identical resource
behaviour. The p95 barely moves because it is measuring the same misses in both
runs; what changes is that most requests are no longer misses at all.

The one number worth not overselling is `max 111.7 ms`, higher than the
all-miss run's 72.3 ms. Servicing a hit while a miss is in flight puts it behind
that miss, so the cache buys a much better median at the cost of a slightly
worse worst case. At 112 ms it is still well inside any interactive budget.

## Mode default

The measurements support **Auto as the product default, with Live available and
Pre-render as the escape hatch** — and the reason is not the miss latency.

A warm miss at 1080p is 133.7 ms at p95, comfortably interactive. A memory hit
is 26.8 ms under load. Under a realistic trace nine requests in ten never touch
the browser at all. Live is genuinely viable at 1080p on a software renderer,
which is the worst case this project will ship into.

What is not viable is the cold start: **5.5 s at 1080p, 6.7 s at 4K**, once per
binding revision, and no cache helps it. A user who clicks a NetsuFlow node on a
timeline and waits six seconds for the first frame will conclude the node is
broken, whatever the second frame costs.

So the mode default is chosen against the cold path rather than the warm one:

- **Auto (default)** — warms a binding's session when the node becomes visible
  rather than when the first frame is demanded, serves live from cache and
  capture, and schedules a pre-render for content whose misses are expensive.
  This is the mode the measurements support because it is the only one that
  hides the 5-to-7-second cost the others expose.
- **Live** — offered, and honest at 1080p. It should say plainly that the first
  frame after a source change costs seconds.
- **Pre-render** — required rather than optional, for two reasons neither of
  which is speed: it is the only path that can carry audio outside the OFX
  contract, and it is what makes a final render predictable when a composition's
  miss cost is unbounded.

H03's own escape clause — "if misses remain slow but pre-render is robust, mark
Live as limited rather than failing the entire bridge" — does not need to be
invoked. Misses are not slow. The cold session is, and warming is a scheduling
decision rather than an engine limitation.

Two things this does **not** establish. Every number is on a software renderer
and on hard-edged fixtures; a real composition with video, WebGL or heavy
antialiasing has not been measured, and H02 already flagged antialiased content
beside animated content as the least stable case there is. And none of it has
run inside Resolve — Task 9 is what would say whether the host agrees.

## Pass criteria

| H03 requires | Result |
|---|---|
| no stale frames after revision changes | 40/40 re-rendered, 0 stale |
| no unbounded memory, handles, sessions, queue, or waits | +6 MiB browser, −21 handles, 5 browsers flat, cache pinned at bound |
| requested work outranks prefetch | enforced and unit-tested in the scheduler |
| worker restart does not require Resolve restart | verified by killing all 5 browser processes |
| cached-hit target remains met | 26.8 ms p95 at 1080p under load, 15.3 ms measured alone, against a 33 ms target |
| measurements support an honest Live/Auto/Pre-render default | above |

## Follow-up

- Measure a real composition — video, WebGL, heavy antialiasing — before any of
  these numbers becomes a product promise.
- Re-run on a GPU renderer: capture is 80% of a miss, so it is the only stage
  where hardware changes the answer.
- Task 9: none of this has run inside Resolve.
- Report the `MessageReader` fix pattern nowhere upstream — it is NetsuFlow's own
  code — but do re-check it whenever the protocol module is touched, because the
  quadratic version passed every test it had.
