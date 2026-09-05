# H02: HyperFrames capture modes and alpha

## Known

The current frame-capture source offers in-memory encoded screenshot capture.
[S-HF-FRAME-CAPTURE-SOURCE] HyperFrames documents PNG sequences and
alpha-capable media outputs. [S-HF-RENDERING]

The deterministic `beginframe` capture mode is Linux-only; Windows always
resolves to Puppeteer screenshot capture. [S-HF-CAPTURE-MODE] Because NetsuFlow
is Windows-first, upstream determinism results measured under BeginFrame do not
transfer, and byte-stability of repeated identical requests becomes a primary
H02 pass condition rather than an assumption.

## Hypotheses

1. PNG buffer plus a bounded decoder is the simplest correct baseline.
2. PNG encode/decode may dominate simple uncached frames.
3. A raw screenshot path may be faster but may depend on browser/internal APIs.
4. Transparent browser background and straight/premultiplied conversion may not
   match Fusion without an explicit normalization step.
5. Screenshot-mode capture on Windows may not be byte-stable for repeated or
   out-of-order requests, which would invalidate live mode independently of
   latency.

## Matrix

- PNG buffer and, only if exposed supportably, raw alternative;
- transparent/opaque, antialiased, blur, SVG, Canvas, WebGL, image/font/video;
- 1080p and 4K;
- cold, warm, repeated, random;
- byte-level reference comparison;
- corrupt/truncated/oversized payload rejection.

Measure seek/media wait, screenshot encode, decode, allocation, cache insert,
transport, and copy separately.

## Exit

Choose the lowest-complexity path that preserves alpha and meets the provisional
latency/memory targets. PNG remains the correctness oracle even if a faster path
is selected.

