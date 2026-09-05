# T02 - OGraf live runtime

## Decision

Can Resolve 21 host a bundled React/Remotion composition as an OGraf Web Component and return the correct frame during playback, random seeking, and final export?

Resolve loads OGraf Web Components into CEF, calls `goToTime()` for each requested frame, and captures the result through `OGrafLoader`. The same timestamp must always yield the same visual, including backward and random seeks. [S-BMD-OGRAF-OVERVIEW] [S-BMD-OGRAF-INTEGRATION]

Remotion Player exposes `seekTo(frame)`, which makes a direct frame-controlled experiment possible but does not prove synchronous React/media readiness under OGraf capture. [S-REM-PLAYER]

## Hypotheses

- O1: a self-contained React bundle can load inside Resolve's CEF.
- O2: `goToTime(timestamp)` can map deterministically to a Remotion frame.
- O3: simple React state updates become visible before Resolve captures the frame.
- O4: Player media, fonts, Canvas, and WebGL are ready in time or can be rejected before use.
- O5: OGraf output is fast enough for useful Windows playback despite documented CPU readback. [S-BMD-OGRAF-INTEGRATION]

## Variants

- O-A: plain JavaScript OGraf fixture from Blackmagic, used as host baseline.
- O-B: React only, frame value rendered as text.
- O-C: Remotion component controlled by explicit frame prop without Player.
- O-D: Remotion Player controlled through `PlayerRef.seekTo(frame)`.
- O-E: `@remotion/web-renderer` only as a comparison; its documented DOM/CSS limitations prevent treating it as an automatic fidelity path. [S-REM-WEB-RENDERER]

## Procedure

1. Package and load O-A; verify the documented OGraf lifecycle.
2. Load O-B and prove frame text changes under `goToTime()`.
3. Run `0 -> 30 -> 5 -> 30 -> 0`; compare repeated-frame hashes.
4. Load O-C with F00-F04 and compare selected frames to T01.
5. Load O-D with F00-F09 and repeat the same comparison.
6. Change each supported Inspector property and verify `updateAction()` updates pixels.
7. Test exactly 20 parameters and verify behavior beyond the documented limit without relying on it. Blackmagic documents 20 dynamic parameters and 10 custom actions. [S-BMD-OGRAF-INTEGRATION]
8. Test local fonts, local images, local video, SVG, Canvas, WebGL, and Three.js independently.
9. Disable network access and repeat all accepted fixtures.
10. Perform forward playback, reverse scrubbing, seeded random seeking, trim-offset playback, and three final exports.
11. Measure 1080p and 4K on Windows; repeat the accepted corpus on macOS before product selection.
12. Enable and disable Resolve Color Management and verify the behavior documented for OGraf's sRGB conversion. [S-BMD-OGRAF-INTEGRATION]

The lifecycle implementation, property mapping, and packaging steps must follow the installed Blackmagic Web Component, controls, and installation references rather than assumptions from a normal browser application. [S-BMD-OGRAF-WEB-COMPONENT] [S-BMD-OGRAF-PROPERTIES] [S-BMD-OGRAF-PACKAGING]

## Timing mapping to test

The initial mapping is explicit:

```text
seconds = timestampMilliseconds / 1000
frame = floor(seconds * compositionFps + epsilon)
```

Alternative rounding policies must be compared at exact frame boundaries. The selected policy must never depend on accumulated playback time.

## Required evidence

- generated `.ograf`/`.drfx` package and manifest;
- CEF/OGraf logs;
- per-fixture compatibility table;
- exact-seek hash table;
- T01 comparison frames and difference images;
- Inspector property screenshots;
- 1080p/4K timing and memory results;
- final-export frame hashes;
- Windows and macOS environment records.

## Pass gates for preferred live mode

- O-B, O-C, F00-F04, and F07 load without network access.
- No incorrect frame in 200 seeded random seeks.
- Ten repeated visits to each selected timestamp produce identical hashes.
- F00-F04 meet the shared visual thresholds.
- Inspector prop updates are reflected in preview and final export.
- No missing first frame after opening, reloading, or changing props.
- Three final exports are deterministic.
- 1080p30 reaches the shared playback target for accepted fixtures on the supported Windows baseline.
- Failures in F05/F06 are detected before insertion or automatically routed to Render mode.

## Rejection triggers

- React updates appear one frame late or nondeterministically.
- Media/font readiness cannot be made deterministic without delaying `goToTime()` asynchronously.
- Resolve export differs from preview for supported fixtures.
- CEF crashes or hangs cannot be isolated.
- The package requires undeclared network or machine-global dependencies.

## Product decision effect

- Full pass: OGraf becomes the preferred `Live` implementation for compatible projects.
- Subset pass: OGraf becomes an opt-in/automatic compatible path with Render fallback.
- Performance-only failure: OGraf may remain a macOS or preview-quality path.
- Correctness failure: reject OGraf for Remotion hosting and continue with T03/T04.
