# RM01: Persistent Remotion frame renderer

## Question

Can a direct Remotion adapter satisfy the common engine contract without any
OpenFX or protocol change?

## Fixtures

Match the portable HyperFrames set, then add Remotion-specific React, SVG,
Canvas, Three.js/WebGL, Video/OffthreadVideo, font, and error cases.

## Variants

- cold and warm browser;
- official `renderStill()`;
- official `renderFrames()` for range prefetch;
- sequential/reverse/random;
- PNG to common RGBA normalizer;
- 1080p/4K;
- matching and deliberately mismatched project versions.

[S-REM-STILL] [S-REM-RENDER-FRAMES] [S-REM-VERSION-MATCH]

## Pass

- common conformance suite passes;
- requested frames match Remotion references;
- unsupported versions are refused precisely;
- resources stabilize and failures do not terminate core RPC;
- no plugin/protocol modification is required;
- performance data selects Live/Auto/Pre-render honestly.

