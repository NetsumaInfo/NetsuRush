# HyperFrames adapter architecture

## Decision

Use `@hyperframes/engine`, not the CLI, for live frame requests. The package is
the documented low-level API for applications that own browser/session capture.
[S-HF-ENGINE-DOC]

```text
BindingSnapshot
  -> controlled local project server
  -> acquireBrowser(chromeArgs, config) -> browser lease
  -> createCaptureSession(serverUrl, scratchDir, options)
  -> initializeSession(session)
  -> persistent Browser + Page
  -> captureFrameToBuffer(session, frameIndex, frameIndex / fps)
  -> PNG validation/decode
  -> canonical RGBA8
  -> common cache/bridge
  -> closeCaptureSession(session) + lease release
```

These names and signatures were read from the package-root exports on
2026-08-27 and must be re-verified against the pinned version by H01. They are
not a promise of pre-1.0 stability. [S-HF-ENGINE-EXPORTS]
[S-HF-FRAME-CAPTURE-SOURCE]

The fixture at the head of this pipeline is an `index.html` composition, not a
bundled TypeScript entry point. HyperFrames compositions are plain HTML with
`data-composition-id`, `data-width`, `data-height`, and clip timing attributes,
and they run without a build step. [S-HF-COMPOSITIONS]

## Adapter modules

- **ProjectProbe:** validates Node version, package version, entry point, assets,
  and composition discovery.
- **ProjectServer:** serves only the registered root over loopback using a
  generated random path/token and explicit MIME/range handling.
- **HyperFramesSession:** owns capture session, descriptor, and lifecycle.
- **HyperFramesCapture:** translates normalized frame requests into engine seek
  and screenshot calls.
- **PixelNormalizer:** common validated PNG decode to straight RGBA8.
- **DiagnosticsAdapter:** maps engine/browser errors and stage timings into the
  common error model.

## API-coupling rule

All imports from `@hyperframes/engine` live behind this adapter. No OpenFX,
bridge, cache, or UI module imports HyperFrames types. Experimental FrameAdapter
APIs may be used inside the fixture project, but cannot become part of
NetsuFlow's public or cross-engine contract. [S-HF-FRAME-ADAPTERS]

## Browser ownership

Start with one session per active binding revision. Only introduce the documented
browser pool/lease APIs after the single-session baseline is correct and
measured. [S-HF-BROWSER-MANAGER] A global supervisor caps active sessions and
can drain them during update/shutdown.

## Correctness fallback

For a complex composition or slow live session, render an alpha PNG sequence or
alpha-capable media artifact and serve frames from it. HyperFrames documents PNG
and alpha-capable output paths. [S-HF-RENDERING] Pre-render is a normal mode,
not a hidden visual substitution.

## Stop conditions

Do not connect the adapter to Resolve if:

- random requests cannot deterministically seek;
- alpha cannot survive capture and decode;
- sessions leak browser/page processes after close;
- the chosen API requires unbounded dependence on unstable internals;
- a malformed project can escape the defined trust/path boundary;
- measured misses make even Auto/pre-render unusable.

