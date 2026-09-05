# H04: the real engine inside Resolve — 2026-08-27

First run of Task 9. Everything H01–H03 measured was outside the host, on a
software renderer, against fixtures. This is the first time a real browser
rendered a composition into DaVinci Resolve.

**Result: it renders.** A composition on disk travelled HTML → Chromium
screenshot → PNG → decode → protocol → OpenFX plugin → Fusion → Resolve's
still export, and the image that came out is the one the composition paints.
Two blockers were found on the way, neither of them in the pixel path.

## Environment

| | |
|---|---|
| Host | DaVinci Resolve **Studio 21.0.4.5**, Windows 11 Pro 26200 |
| Project | 1920x1080, **24 fps**, `davinciYRGB` |
| Plugin | `NetsuFlow (Experimental)`, per-user bundle, SHA-256 matches the build |
| Engine | `@hyperframes/engine` 0.8.16, HeadlessChrome 152.0.7977.54, SwiftShader |
| Composition | [`sandbox/index.html`](../../../prototypes/hyperframes-renderer/sandbox/index.html) |
| Driving | Resolve's own scripting API from Python 3.13, not by hand |

Raw host log in [`ofx-host.log`](ofx-host.log). Stills in
[`frame-50.png`](frame-50.png) and [`frame-98.png`](frame-98.png).

## What it took to get a first frame

Three separate things were wrong, and only the last one was a real defect.
Recording all three because each cost time that the runbook can now save.

### 1. The Binding and Mode are not defaults

`Binding` has no default and `Mode` starts on `Local Diagnostic`, so a freshly
inserted node renders the plugin's own CPU pattern and never contacts the
service at all. That is correct behaviour, and it looks exactly like a broken
bridge.

### 2. The service refused every frame, and said so nowhere

The host's `Status` field showed `renderer service returned an error` — the
same string for all six of the service's refusal reasons. The service itself
logged nothing. Diagnosing that from inside Fusion is guessing.

Fixed in [`server.mjs`](../../../prototypes/hyperframes-renderer/server.mjs):
every refusal now writes `[refused] <code>: <detail>`. The next run named the
cause on the first frame.

### 3. The plugin's revision can never match a fixture's

```
[refused] stale-revision: client requested revision 0, service has rev-0
```

`NetsuFlowGenerator.cpp:159` hardcodes `request.sourceRevision = "0"`, a
placeholder until NetsuRush supplies a real revision. Every fixture and the
`--project` default declare `rev-0`. The service rejects a revision mismatch
rather than answering — correctly, because answering would poison every cache
entry keyed on that revision.

So **out of the box the two never match**, and nobody could have run this test
without hitting it. Worked around with `--revision 0`; the plugin was not
touched, because a placeholder meeting a fixture default is not a
host-contract defect.

## The frame

With `Mode = Bridge`, `Binding = harness` and the service on `--revision 0`,
the host log shows real renders with no fallback:

| Outcome | Count |
|---|---:|
| `status=bridge`, no fallback | 17 |
| `status=cached` (the plugin's own cache) | 4 |
| `status=bridge` with `fallback=errorFrame` | 3 (all before the revision fix) |

`frame 50` and `frame 98` were requested by moving `Start Frame`, and the
number the **browser itself printed** in the image matches the frame the host
asked for. That is the strongest available proof: it is not a shape comparison,
it is the composition reporting the time it was seeked to.

## Determinism in host

Alternating `Start Frame` between two values, five grabs:

```
A B A B A     3dcc3779… 57a39797… 3dcc3779… 57a39797… 3dcc3779…
```

Byte-identical on every repeat. This is H03's determinism result confirmed
through the host rather than through the adapter.

**Methodology warning, learned the hard way:** an earlier run of the same sweep
produced two different images for the same `Start Frame`. That was not
non-determinism — it was `GrabStill()` firing before the viewer finished
re-rendering. At 2.5 s of settle the grab returns the *previous* image; at 6 s
it does not. A still-grab harness that does not wait long enough will
manufacture a determinism bug that is not there.

## Host behaviour worth designing around

### Resolve caches hard, and does not re-ask

Scrubbing the timeline across the clip produced **zero** new render calls. The
host served its own cached image and the plugin was never invoked. Only a
parameter change invalidated it.

This cuts both ways. It means the frame cache's value in-host is smaller than
H03 suggests, because Resolve absorbs the repeats before they reach us — T01
had measured 21 render calls for one frame, and none of those reach the service
now. It also means **a stale service answer would persist visibly**, since
nothing re-asks on its own.

### Pixel depth is 8-bit here, not float

Every line reads `depth=1 components=1` — UByte RGBA. T01 recorded
`depth=4` (float RGBA) and the register treats float as settled. Both are
presumably right for their context; what is not established is which contexts
give which. **This needs pinning before any colour claim**, because the
conversion the plugin performs differs between them.

### `interactive` is still always false

`interactive=false` on all 28 lines, including during scrubbing. T03 recorded
the same. The interactive last-good-frame path has now never been taken in any
session.

## A drift the test caught in itself

The first correct render reported `frame 63` when frame 50 was requested. The
composition hardcoded `FPS = 30` while its binding declared 24, and **the
engine seeks in seconds** — so `50/24 s` fed to a page that multiplies by 30
gives 63. The pixels were right; the composition's own idea of what frame it
was on was wrong.

That is the dangerous shape of this class of bug: it renders, it looks
plausible, and nothing refuses it. The sandbox now reads both fps and duration
from its own `data-*` attributes so the two cannot drift apart.

## A host-contract defect, found by rendering a real component

The sandbox composition is a hard-edged opaque box on transparency, and it
renders correctly in host. A catalog component from hyperframes.dev — an SVG
stroke with a `drop-shadow` glow — does not.

| | |
|---|---|
| [Standalone](catalog-standalone-correct.png) | a thin violet stroke with a soft halo |
| [Through Resolve](catalog-in-host-WRONG.png) | a solid violet blob the size of the halo |

Same binding, same service, same frame 62, same parameters. The only difference
is the host.

**The plugin never declares its premultiplication state and never
premultiplies.** There is no `setPreMultiplication`, no remult step, nothing in
`openfx/src/` that touches alpha at all — the only match for the word in the
whole directory is the protocol's validation of the wire's `alphaMode` string.
It hands Fusion straight RGBA and lets Fusion assume its own convention.

Straight alpha keeps full-strength colour where alpha is near zero. Composited
as if premultiplied, that glow stops being a glow and becomes an opaque shape.

This is invisible on a hard edge, which is why every earlier check passed: the
sandbox, the diagnostic fixture, and H03's byte-comparisons are all
hard-edged or compared before compositing. **78% of the visible pixels in this
component carry partial alpha** — 265,198 against 76,538 opaque — and that is
what made it show.

It is a demonstrated host-contract defect, which is the condition the plan sets
for touching the plugin. Not fixed here: replacing the bundle requires closing
Resolve, and the fix is a real decision — premultiply on output, or declare the
output unpremultiplied through clip preferences and let the host convert.

## Not run

- Deliver render. Still never exercised, in any session.
- Service killed mid-scrub, and browser killed, **in host**.
- Proxy / render scale. The service refuses anything but 1:1; what Resolve does
  with that refusal has not been observed.
- A real composition — video, WebGL, heavy antialiasing. This is a coloured
  rectangle and a text label.
- The `--fixture diagnostic` equality check, which needs a 320x180 comp.

## Decision

The in-host path works and produces correct, deterministic pixels. Nothing here
argues against proceeding. Two items should be settled before the NetsuRush
integration plan:

1. **Where `sourceRevision` comes from.** The placeholder has to become real
   before any cache keyed on it means anything.
2. **Which pixel depth Resolve gives in which context.** A colour claim on top
   of an unpinned depth is not a claim.
