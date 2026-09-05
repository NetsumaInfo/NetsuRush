# Feasibility assessment

## Conclusion

The design is technically feasible enough for a controlled prototype.
OpenFX already supplies the host-side image callback, and the current NetsuFlow
bridge has delivered validated RGBA frames inside Resolve. HyperFrames exposes a
low-level capture engine with persistent session objects and in-memory frame
capture. The remaining uncertainty is product quality: latency, deterministic
random seeking, alpha/color fidelity, long-session stability, and packaging.

## Confirmed host foundation

- The OpenFX Generator context creates images without a source clip.
  [S-OFX-CONTEXTS]
- A render action supplies time, render window, render scale, abort state, and a
  writable output image. [S-OFX-RENDERING]
- The current plugin loads and renders in Resolve Studio 21. [S-NF-T01]
- Its existing authenticated loopback client rejects malformed frames and
  recovers after service restart. [S-NF-T03]

## HyperFrames evidence

- `@hyperframes/engine` is the low-level integration API for seekable capture,
  browser management, buffers, diagnostics, and media extraction.
  [S-HF-ENGINE-DOC]
- `CaptureSession` retains a browser and page across calls; the exported
  lifecycle includes creation, initialization, frame capture, and close.
  [S-HF-FRAME-CAPTURE-SOURCE]
- `captureFrameToBuffer()` avoids a temporary output file, but returns an
  encoded screenshot buffer. NetsuFlow must decode PNG to RGBA8 unless a measured
  and supportable raw path is added. [S-HF-FRAME-CAPTURE-SOURCE]
- HyperFrames defines deterministic frame seeking and warns against wall-clock,
  unseeded random, and mutable external inputs. [S-HF-DETERMINISM]
- The public custom FrameAdapter surface is explicitly experimental v0, so the
  product adapter must wrap it rather than exposing it across NetsuFlow.
  [S-HF-FRAME-ADAPTERS]

## Why HyperFrames first

This is a hypothesis to test, not a quality claim:

- its low-level engine already models a long-lived seekable capture session;
- its repository license is Apache-2.0; [S-HF-LICENSE]
- it targets ordinary HTML/CSS/media and multiple seekable animation runtimes;
- the current package requires Node 22+, matching the project baseline.
  [S-HF-REPO] [S-HF-PACKAGE]

The disadvantages are equally explicit: pre-1.0 API churn, a younger ecosystem,
browser/font/codec variability, and still-unmeasured performance in Resolve.

## Remotion remains feasible

Remotion provides explicit-frame rendering, reusable browsers, range rendering,
composition selection, and transparent outputs. [S-REM-STILL]
[S-REM-OPEN-BROWSER] [S-REM-RENDER-FRAMES] [S-REM-ALPHA] Its per-project
version coupling and licensing/distribution rules are engine-specific concerns,
not reasons to redesign the host bridge. [S-REM-VERSION-MATCH]
[S-REM-LICENSE-TERMS]

## Feasible architecture

```text
OFX Render(time, binding)
  -> bounded FRAME request
  -> binding registry resolves engine
  -> persistent engine session
  -> encoded capture or cached frame
  -> common PNG decode / RGBA normalization
  -> validated OFX copy
```

## Approaches rejected as the baseline

| Approach | Reason |
|---|---|
| Translate arbitrary components into Fusion nodes | Cannot preserve general browser/JS rendering semantics |
| Transpile JS to Python/Lua | Changes syntax, not graphical meaning |
| Run Node/browser in Resolve | Unacceptable host stability and dependency boundary |
| Invoke a CLI per frame | Repeats startup/session cost and is unsuitable for scrubbing |
| Depend on Remotion-to-HyperFrames conversion | Conversion has documented complex/unsupported cases |
| Use a closed experimental PR as a dependency | The proposal is unmerged and absent from main |

[S-HF-REMOTION-MIGRATION] [S-HF-REMOTION-ADAPTER-PR]

## Recommendation

Finish the host tests, then implement an isolated pinned HyperFrames adapter and
run H01-H03. Connect it to the existing bridge only after its random-frame,
alpha, cleanup, and memory behavior are measured.

