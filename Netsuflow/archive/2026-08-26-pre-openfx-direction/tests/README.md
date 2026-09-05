# Test program

## Purpose

These protocols produce the evidence required to select a NetsuFlow architecture. They are intentionally separated so a failed experimental path does not invalidate the official-renderer fallback.

## Execution order

| Order | Protocol | Decision unlocked |
|---:|---|---|
| 1 | T01 - Official renderer baseline | Proves the minimum useful pipeline and reference visuals |
| 2 | T02 - OGraf live runtime | Determines whether Resolve can host a Remotion-based live source |
| 3 | T03 - Persistent frame service | Determines whether uncached frame requests are usable |
| 4 | T04 - Fusion host adapters | Selects Loader, Fuse, OGraf, or OpenFX boundaries |
| 5 | T07 - Packaged product validation | Determines whether the preferred path can ship in NetsuRush |
| 6 | T05 - Native IR compiler | Determines whether a native editable subset is worth developing |
| 7 | T08 - Remotion import framework | Determines whether existing code can be classified and routed safely |
| 8 | T06 - Explicit hybrid composition | Determines whether native and rendered layers can coexist safely |

T01 through T04 are rendering architecture-selection tests. T05, T08, and T06 are product-expansion tests. T08 may begin with analysis-only fixtures after T01, but native-routing claims require T05 evidence.

## Shared fixture corpus

All rendering protocols use the same fixture IDs and exact composition metadata.

| ID | Contents | Purpose |
|---|---|---|
| F00 | `HELLO`, linear X translation, opacity, transparent background | Frame mapping, alpha, basic transform |
| F01 | Text using `spring()` for translation and scale | Temporal interpolation and deterministic seeking |
| F02 | Nested `Sequence` elements with overlapping layers | Local/global timing and layer order |
| F03 | Local font, multiline text, flex layout, borders, shadows | Browser layout and font fidelity |
| F04 | PNG, SVG, mask, blur, glow/filter, blend and clipping | Asset, filter, alpha, and compositing fidelity |
| F05 | Video element plus transparent overlays | Media seeking and readiness |
| F06 | Canvas, WebGL, and a minimal Three.js scene | Advanced browser compatibility |
| F07 | Hooks, conditions, loops, `.map()`, and a local npm component | Arbitrary React execution compatibility |
| F08 | Seeded randomness, clock access, and optional local data | Determinism and project-policy diagnostics |
| F09 | 4K, 300-frame multi-layer stress composition | Throughput, memory, cancellation, and export stability |

Fixture assets must be local and immutable. Network access is disabled except in the explicit F08 safety subtest.

## Reference outputs

T01 generates the authoritative reference frames with the official Remotion renderer. `renderStill()` is the supported API for an explicit frame and `renderMedia()` is the supported complete-media path. [S-REM-STILL] [S-REM-MEDIA]

Reference frames are captured at:

```text
0
1
duration / 4
duration / 2
duration - 2
duration - 1
```

F01, F02, and F05 add every transition boundary and one frame immediately before and after each boundary.

## Shared measurements

### Correctness

- output width, height, frame count, frame rate, and duration;
- alpha presence and alpha coverage;
- frame-number watermark in diagnostic fixtures;
- exact repeat hash for deterministic repeated requests;
- RGB and alpha pixel differences against the reference;
- visual report with difference images.

### Performance

- first initialization time;
- first uncached frame latency;
- subsequent uncached frame p50, p95, and maximum;
- cached frame p50, p95, and maximum;
- sequential, reverse, and random seek throughput;
- full-render wall time and frames per second;
- process working set and GPU memory where available;
- memory after warm-up and after 500 seeks;
- cancellation latency.

### Reliability

- 200 deterministic random seeks using a stored seed;
- three complete exports with matching frame hashes;
- source edit and cache invalidation;
- props edit and cache invalidation;
- reverse scrubbing;
- application and Resolve restart recovery;
- missing asset, renderer crash, and cancellation behavior.

## Initial quality thresholds

These are product decision targets, not claims about current performance.

- Simple-fixture RGB SSIM at least `0.995` against the official reference after applying the documented color transform.
- Alpha mean absolute error at most `1/255` and maximum error at most `2/255` for F00-F04.
- Ten requests for the same frame produce identical hashes.
- No incorrect frame in 200 seeded random seeks.
- No Resolve crash, project corruption, or unrecoverable renderer hang.
- Cached-frame delivery p95 at most `50 ms` before host decode/display.
- An uncached simple 1080p frame p95 at most `500 ms` qualifies as an interactive-update candidate.
- Sustained 1080p30 playback requires at least 95% of frames to meet the frame budget without incorrect output.

Thresholds may be revised only in the decision log with a user-experience justification; they must not be relaxed to make a favored architecture pass.

## Result schema

Every `result.json` should follow this shape:

```json
{
  "testId": "T02",
  "runId": "2026-08-26-windows-resolve-21.0.4",
  "status": "pass | partial | fail | blocked",
  "environment": "environment.json",
  "fixtures": [],
  "metrics": {},
  "gates": [],
  "artifacts": [],
  "sourceVersions": {},
  "notes": []
}
```

## Safety rules

- Use a disposable Resolve project for host experiments.
- Never test an unsigned or unbounded native plugin against valuable projects.
- Do not install npm dependencies from an untrusted Remotion project.
- Bind local services to loopback and use a session token.
- Keep renderer and Fusion logs for every failure.
- A crash is a failed gate, not an invitation to retry silently until one run passes.
