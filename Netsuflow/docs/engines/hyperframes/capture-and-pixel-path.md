# HyperFrames capture and pixel path

## Baseline

Use in-memory PNG capture for correctness:

```text
capture (see the two candidates below)
 -> encoded-size guard
 -> PNG signature/IHDR validation and dimension range check
 -> bounded decode
 -> dimensions/stride validation
 -> straight RGBA8 normalization
 -> common memory cache
 -> existing bridge
```

Two capture entry points are candidates, and H02 chooses between them on
measurement rather than assumption [S-NF-H01-DEPS]:

1. `captureFrameToBuffer(session, frameIndex, time)`;
2. `initTransparentBackground(page)` once at session init, then
   `captureAlphaPng(page, width, height)` per frame.

The second is the engine's own recommendation for sessions that capture many
frames, because `captureScreenshotWithAlpha()` pays two CDP round-trips per
call. It is also alpha-native, and alpha is the point of a Fusion generator
rather than an extra. Treat it as the likely baseline.

The decode step uses the engine's `decodePng`, which is zlib-only and needs no
new dependency, but **only behind NetsuFlow's own bounds check**. It calls
`inflateSync()` with no `maxOutputLength`, allocates from IHDR dimensions it
never range-checks, and does not verify chunk CRCs. It is a decoder for input we
produced, not a validator for input we must distrust. A second, independent
decoder exists solely for golden-reference comparison, because checking capture
output with the code that produced it is circular.

The source returns an encoded screenshot buffer and supports PNG/JPEG capture;
it does not document that this buffer is raw RGBA. [S-HF-FRAME-CAPTURE-SOURCE]
JPEG is excluded because it lacks alpha and is lossy.

`captureFrameToBuffer(session, frameIndex, time)` exists for the streaming
encode pipeline that feeds FFmpeg stdin, which always walks frames in order.
Nothing in its contract promises that a backward or random `frameIndex`
reproduces the same pixels as the sequential walk, so NetsuFlow must prove that
itself. [S-HF-CAPTURE-BUFFER-PURPOSE]

## Capture mode on Windows

The deterministic `beginframe` capture mode is Linux-only. The browser manager
selects it only when `process.platform === "linux"`, a headless-shell binary
resolved, and `--enable-begin-frame-control` is present in the launch arguments;
otherwise it resolves to `screenshot`, and the frame-capture source gates its
BeginFrame paths on the same check. [S-HF-CAPTURE-MODE]

NetsuFlow is Windows-first, so every capture runs through Puppeteer's screenshot
path. The engine still has its own synchronization (seek completion, image and
media readiness polling, paint waits), but its behavior under repeated identical
requests is a NetsuFlow measurement, not an inherited guarantee.

Concretely, H02 must show on Windows that:

- the same `frameIndex` captured twice produces byte-identical pixels;
- a frame reached by a backward or random seek equals the same frame reached
  sequentially;
- alpha survives the screenshot path, not only the BeginFrame path;
- animation libraries driven by the compositor settle before capture.

If identical requests are not byte-stable on Windows, live mode is unusable
regardless of latency, and pre-render becomes the supported product mode.

## Required tests

- transparent canvas and semi-transparent edges;
- browser default background versus explicit transparent background;
- CSS text, shadow, blur, SVG, Canvas, WebGL, images, fonts, and video;
- 1x1, odd dimensions, 1080p, 4K, and maximum rejected dimensions;
- preview scale and full-size final;
- repeated, reverse, and random frames;
- corrupt/truncated/oversized encoded buffers;
- PNG decode time and memory pressure.

## Alpha

Do not infer alpha mode from “PNG supports transparency.” Confirm actual pixels
with straight/premultiplied fixtures, then normalize exactly once. HyperFrames'
rendering guide describes transparent output options but the bridge requires its
own end-to-end proof. [S-HF-RENDERING]

## Alternative paths

Evaluate in this order:

1. PNG buffer baseline.
2. Decoded-frame memory cache.
3. Adjacent-frame capture/prefetch.
4. Browser screenshot/raw capture option only if supported and stable.
5. Shared memory only if bridge copying is material.
6. GPU upload only if CPU conversion/copy is material.

Each alternative must produce the same canonical bytes as the baseline within
documented tolerance.

## Engine facilities worth reusing

The package root already exposes work NetsuFlow would otherwise duplicate.
Evaluate each before writing an equivalent. [S-HF-ENGINE-EXPORTS]

| Export | NetsuFlow use |
|---|---|
| `getCompositionDuration(session)` | Populate `CompositionDescriptor.durationFrames` from the engine instead of guessing |
| `getCapturePerfSummary(session)` | Per-stage capture timings, which the diagnostics contract already demands |
| `prepareCaptureSessionForReuse(...)` | Candidate for warm reuse across binding revisions; measure before trusting |
| `buildChromeArgs(...)`, `resolveHeadlessShellPath(...)` | Reproducible launch arguments and browser path, both recorded in the runtime manifest |
| `classifyCaptureFailure`, `isTransientBrowserError`, `isMemoryExhaustionError` | Map engine failures onto the common `FRAME_*`/`SESSION_*` taxonomy instead of matching error strings |
| `releaseBrowser(...)`, `drainBrowserPool()` | Deterministic lease release, and a supervisor drain during update or shutdown |

None of these may leak past the adapter boundary.

Two limits are worth stating because they are easy to assume away:

- `computeStaticFrameSet()` is exported from the capture source but **not** from
  the package root, so using it would require an internal import. It stays out
  of the baseline. [S-HF-ENGINE-EXPORTS]
- the package publishes compiled ESM (`dist/index.js`, `"type": "module"`) and a
  documented `./alpha-blit` subpath. The subpath is a candidate for the alpha
  work in H02, but only after its behaviour is measured against our own
  normalizer, never as a substitute for it.

## Performance accounting

Report cold and warm separately. For a miss, time:

```text
queue + session lookup + seek/media wait + screenshot encode
+ PNG validation/decode + cache insert + protocol + OpenFX conversion/copy
```

For a hit, report memory and disk paths independently.

