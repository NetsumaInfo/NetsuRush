# T01 result — 2026-08-26

Status: CONDITIONAL

Resolve discovers, instantiates, renders and destroys the Generator without
instability, and the frame/time mapping is correct. Several matrix rows were not
exercised, and they are listed under `## Not run` rather than assumed to pass.

## Environment

| Item | Value |
|---|---|
| Host | DaVinci Resolve **Studio 21** (`Resolve.exe` 21.0.4.5) |
| OS | Windows 11 Pro 10.0.26200 |
| CPU | AMD Ryzen 7 6800H |
| Project | user project, Fusion page, timeline 1920x1080 |
| Plugin SHA-256 | `9996B34DB53CF2678E7C101FD0496459439205DA8A5CBF6A2D97E35F4978AEEB` |
| Instrumentation | `NETSUFLOW_OFX_LOG=1`, log `ofx-34036.log`, 25 lines, 21 render calls |

Observations were made by the project owner driving Resolve; the log and a
screenshot of the Fusion page are the supporting artifacts.

## Results

### Discovery via `OFX_PLUGIN_PATH` — PASS

The bundle was installed to `%LOCALAPPDATA%\NetsuRush\ofx-plugins` with **no
elevation**, and `OFX_PLUGIN_PATH` was set at user scope. Resolve found the
plugin on the next launch:

- listed as **NetsuFlow Remotion (Experimental)**, group **NetsuFlow**;
- instantiates, renders, and appears in the node graph as
  `NetsuFlowRemotionExperimental1`.

`C:\Program Files\Common Files\OFX\Plugins` was never written to. It holds 18
third-party bundles (Sapphire, Twixtor, RE:Vision, Red Giant, BorisFX, …) and
none were touched.

**This is the main result of the session.** R6 assumed a per-user OpenFX install
was probably impossible and that a narrowly scoped elevated helper would be
needed. It is not: NetsuRush's existing per-user NSIS installer can ship the
plugin with no admin prompt at all. R04's strategy 2 is selected.

### Negotiated pixel format — both depths, in one session

| depth | Count | Meaning |
|---:|---:|---|
| 4 | 1 | `eBitDepthFloat` — the **first** render |
| 1 | 20 | `eBitDepthUByte` — every later render |

`components=1` (`ePixelComponentRGBA`) throughout. The Fusion tooltip reports the
node's own buffer as *Depth 32bit float (Mem)*, which is a different thing from
the depth handed to the render action.

Resolve chooses the depth **per call**, and the choice is not stable within a
session. A byte-only plugin would have failed the first render; a float-only
plugin would have failed the other twenty. Declaring both in `describe()` was
required, not merely cautious — and `docs/03`'s original "byte first, float only
after conversion tests" would have produced a misleading host-gate failure.

Why the first render differs is unexplained. It is worth re-checking once a
Deliver render is exercised, since that path may differ again.

### Time and frame mapping — PASS

`time=19` maps to `sourceFrame=19` with `Start Frame` at 0, and the on-screen
binary counter reads `0b10011` = 19, matching the playhead. Every render call
agreed. No sub-frame times appeared.

### Render window and tiling — PASS

All 21 calls: `win=(0,0)-(1920,1080)` against `imageW=1920 imageH=1080`. The
render window was never a partial tile, so `setSupportsTiles(false)` is honoured.
Render scale was `1.0` on every call.

### Threading — the UI and render threads are genuinely disjoint

| Action | Thread |
|---|---|
| `instanceCreated`, `instanceDestroyed`, `reload` | 4304 |
| all 21 `render` calls | 39604 |

One render thread, never concurrent for this instance, consistent with
`eRenderInstanceSafe`. But UI actions arrive on a **different** thread while
renders happen on 39604.

This settles a finding the T03 adversarial review could only rate PLAUSIBLE,
because it depended on Resolve's dispatch threading. It is real. The original
code had `changedParam` calling `lastGoodPixels_.clear()` and `bridge_->close()`
directly, which could free a buffer mid-copy and close a socket a render thread
was blocked reading. The log shows the window precisely:

```
331216 ms  thread=4304   action=reload    instance=ofx-1
331222 ms  thread=39604  action=render    reloaded=true
```

6 ms between the UI mutation and the render that consumed it. The fix — an atomic
flag raised on the UI thread and consumed on the render thread — is observed
working across the thread boundary.

### Instance lifecycle — PASS

`ofx-0` created, rendered 19 times, destroyed. `ofx-1` created, rendered, Reload
pressed, `reloaded=true` on the next render, then a further render with the flag
cleared. No leak of instances, no double destruction.

### Repeated identical requests — a design consequence, now measured

All 21 renders were for the **same** frame at the same size: `(time=19,
1920x1080)`. Gaps between consecutive calls went down to **23 ms**, with clusters
of 8-10 calls inside a few seconds.

`docs/05` already asserted that "request deduplication is still required because
hosts may repeat calls". That was a prediction; it is now a measurement, and the
magnitude is larger than the wording implied. In Phase 3 this would be 21 full
Remotion renders to display one image.

**Code changed in response:** the plugin now holds the single-frame cache
`docs/03` specified and the implementation had omitted. A render whose frame,
dimensions, render scale, mode, quality and binding all match the previous one
reuses the retained buffer and logs `cacheHit=true`. `Cache: Bypass` and
`Refresh` skip it, `Reload` clears it, and the retained buffer doubles as the
interactive last-good frame. Retention is capped at 4K RGBA8 so an instance
cannot hold 1 GiB.

Full suite re-run after the change: `ctest` 4/4, fake-renderer 25/25.
New plugin SHA-256 `588A2C9240FFD54751E6D5E3D1A98D5437D04463062909215245A77DD697A58E`.

### Stability — PASS

No crash, no hang, no corrupt frame across the session. `result=done` on all 21
renders, `abortObserved=false` throughout.

### Inspector, first look (partial T02)

From the screenshot, every declared parameter renders and is laid out sensibly:
Binding, Start Frame (slider plus numeric field), Mode / Quality / Cache
(dropdowns), Props and Diagnostic Source (multiline boxes), Reload (button), and
Status, which displays as a greyed read-only field showing `not connected`.

A disabled string parameter therefore *does* work as a status readout in Resolve,
which was an open question. Full T02 still owed.

## Second session — scrub on the Fusion page, and Bridge mode

The first session produced renders at a single time value because the scrub
happened on the Edit page, where the Fusion comp is not re-rendered. Repeating it
on the Fusion page, with the cache-carrying build installed
(`588A2C9240FFD54751E6D5E3D1A98D5437D04463062909215245A77DD697A58E`), gave the
missing data. Log: `ofx-37408-session2.log`.

### Frame mapping under a scrub — PASS

Frames requested in order: 19, 12, 12, 0, 13, 13, 13, 13. Every one mapped to the
matching `sourceFrame`, and the on-screen counter agreed. Resolve jumps to
whatever frame the playhead lands on rather than walking a range, so a directional
prefetch heuristic has nothing to lock onto in this access pattern.

### The plugin frame cache works in host — PASS

Frame 12 was requested twice; the second render logged `status=cached`
`cacheHit=true` and produced no work. This is the cache added in response to the
first session's 21 identical requests, confirmed serving real host traffic.

### Bridge mode inside Resolve — PASS

With the fake renderer running and `Mode` set to `Bridge`, the node rendered
frame 13 with `status=bridge cacheHit=false` and no fallback. The project owner
confirms the viewer output is **visually identical to Local Diagnostic mode**.

That equality is the whole point of the shared fixture: the same pattern
arithmetic is implemented independently in C++ and JavaScript, so an identical
image means the pixels crossed the loopback protocol, the metadata validation and
the stride repack without alteration — inside Resolve, on a host render thread.

### Service unavailable — PASS, and unplanned

The first three Bridge renders ran before the fake service had written its session
descriptor. They logged `status=bridge: session descriptor not found`,
`fallback=errorFrame`, `result=done`, and the viewer showed the saturated error
colour. Resolve stayed responsive and the node recovered on a later render with no
Resolve restart.

This was an accident — the service had been started with an unexpanded shell
variable — but it is exactly row 1 of the status table in `docs/07` ("Service
unavailable → diagnostic frame"), verified in host rather than assumed. A failure
that reaches the viewer as an unmistakable colour, with the host still alive, is
the designed behaviour.

### Depth, second session

Every render in this session was `depth=1` (UByte); no float render occurred at
all, where the first session opened with one. The negotiated depth is therefore
not stable **between** sessions either. Supporting both remains mandatory.

### Abort — still never observed

`abortObserved=false` on all 8 renders, including during an active scrub. Across
both sessions Resolve has never asked this node to abort. The cancellation path in
the bridge client is correct but so far unexercised by the host: **the deadline,
not cancellation, is what actually protects the render thread.** That matters for
Phase 3, where a slow Remotion render is the expected case.

## Not run

- Killing the service while Resolve holds a request in flight, and recovery
  afterwards.
- Reduced render scale. `scaleX`/`scaleY` stayed at 1.0; the half-resolution
  path was not exercised, so it is unknown whether Resolve reduces `imageW`
  or sets a render scale.
- Deliver render, so `interactive=true` was never observed. Every logged call had
  `interactive=false`, including viewer renders — which means the interactive
  last-good fallback path has never actually been taken, and the flag may not
  mean what `docs/07` assumes.
- Host-issued abort. `abortObserved` was false on every call.
- Save / close / reopen parameter persistence.
- Timeline resolution change.
- Behaviour when the plugin is removed from an existing project.
- Free (non-Studio) edition. The host here is Studio 21, so
  [S-RESOLVE-STUDIO-OFX] remains community consensus rather than local evidence.

## Decision

The host gate passes for what was exercised: Resolve loads the Generator from a
per-user path, instantiates it, renders correct pixels at the correct frame,
respects the no-tiling declaration, and tears instances down cleanly. Nothing
observed suggests the host contract is wrong.

It is not a full pass. The scrub, render-scale, Deliver and persistence rows are
untested, and two of them (render scale, `interactive`) bear directly on
decisions already written into `docs/07` and `docs/08`.

## Follow-up

1. Re-run the scrub with the Fusion viewer active and confirm renders arrive at
   varying `time=` values; the cache added above should then show `cacheHit=true`
   on revisited frames and `false` on new ones.
2. Exercise half resolution and a Deliver render; those two answer the render
   scale and `interactive` questions together.
3. Explain the single float render. If Deliver also renders float, the byte path
   may be viewer-only.
4. Complete T02 against the parameter matrix.
