# H01: HyperFrames engine API stability

## Known

`@hyperframes/engine` documents a low-level capture workflow and exports
capture-session helpers. [S-HF-ENGINE-DOC] The current source retains Browser
and Page state and exposes buffer capture/close functions.
[S-HF-FRAME-CAPTURE-SOURCE]

The custom FrameAdapter API is explicitly experimental v0 and may change before
v1. [S-HF-FRAME-ADAPTERS] HyperFrames itself is pre-1.0 and has documented
release channels. [S-HF-RELEASE-CHANNELS] The npm registry listed 371 published
versions on 2026-08-27, with a publish on the query date.

A 2026-08-27 source read already answers part of the export question and
sharpens the rest:

- `acquireBrowser`, `createCaptureSession`, `initializeSession`,
  `captureFrameToBuffer`, `closeCaptureSession`, `getCompositionDuration`,
  `getCapturePerfSummary`, and `prepareCaptureSessionForReuse` are exported from
  the package root, so no internal path import is required for the baseline.
  [S-HF-ENGINE-EXPORTS]
- `captureFrameToBuffer()` was written for the sequential streaming encode path
  that feeds FFmpeg stdin. Arbitrary-order seeking is exactly the property
  NetsuFlow depends on and exactly the property this API does not advertise.
  [S-HF-CAPTURE-BUFFER-PURPOSE]
- `createCaptureSession()` takes an `outputDir` even for buffer capture, so the
  wrapper must own a scratch directory and prove nothing is written to it during
  live rendering.

This turns the question from "which symbols exist" into "do the symbols that
exist behave correctly out of order, on Windows, on the pinned version".

## Questions

- Which imports are actually exported by the pinned npm package?
- Which types/functions are public versus internal implementation detail?
- Can capture sessions be created, initialized, captured, aborted, and closed
  without importing internal paths?
- Can a controlled project server and explicit browser executable be supplied?
- What changes across two adjacent package versions?
- Which browser pool APIs are necessary, and which can remain unused?

## Experiment

Install one exact version in an isolated fixture with a lockfile. Write the
smallest script using only package-root exports to:

1. create a session;
2. initialize one composition;
3. describe it;
4. capture frames 0, last, repeated, reverse, and random, then compare a
   randomly reached frame against the same frame reached sequentially;
5. close and prove no browser remains;
6. repeat after a deliberate source error;
7. run the same compile/test against the next selected version.

Record exported symbol lists, types, versions, runtime errors, process tree, and
source links.

## Exit

Select the smallest public surface and wrap it entirely in
`HyperFramesEngine`. If correct capture requires unstable internals, record the
exact pinned dependency and maintenance cost before continuing; stop product
integration if upgrades cannot be isolated by the adapter conformance suite.

