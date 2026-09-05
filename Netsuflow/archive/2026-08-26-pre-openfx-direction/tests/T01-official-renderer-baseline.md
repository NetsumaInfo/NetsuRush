# T01 - Official renderer baseline

## Decision

Can NetsuRush render a Remotion composition with the official renderer, preserve alpha and frame identity, and import the result into Fusion without material visual changes?

This is the minimum viable architecture and the correctness oracle for every later experiment. Remotion officially supports explicit-frame still rendering, complete media rendering, props, and transparent outputs. [S-REM-STILL] [S-REM-MEDIA] [S-REM-ALPHA]

## Variants

- B1: PNG sequence, one `renderStill()` call per selected frame.
- B2: PNG sequence through the official multi-frame rendering path.
- B3: ProRes 4444/4444 XQ with alpha.
- B4: optional EXR exploration only if an official or verified path exists at test time.

B1 is the reference. B2 and B3 are delivery optimizations.

## Preconditions

- Node and Remotion versions pinned in the fixture lockfile.
- Resolve Studio open with a disposable project and external scripting enabled.
- Timeline frame rate set before media or Fusion composition creation.
- Timeline and composition FPS equal for the primary test.
- Resolve color management state recorded.

## Procedure

1. Render reference frames for F00-F09 using B1.
2. Render complete F00-F05 outputs using B2 and B3 where supported.
3. Record bundle time, browser startup, frame time, total time, and output size.
4. Verify dimensions, frame count, alpha, and diagnostic frame watermark before Resolve import.
5. Import the PNG sequence and alpha video into Resolve.
6. Connect the source through a minimal Fusion composition to `MediaOut`.
7. Export the same selected frames from Resolve using a lossless image format.
8. Compare Resolve outputs against B1 after applying the recorded color-transform policy.
9. Repeat with reverse timeline access and a trimmed clip start.
10. Repeat F00 at 24, 25, 30, 50, and 60 fps.
11. Run one explicit mismatched-FPS case and document the chosen mapping rather than silently accepting it.

Resolve scripting exposes Fusion composition insertion and import/export operations that NetsuRush can automate after the manual baseline is correct. [S-BMD-SCRIPTING] [S-NR-FUSION-APPLY]

## Required evidence

- reference PNGs and SHA-256 hashes;
- imported/exported comparison PNGs;
- RGB, alpha, and frame-identity metrics;
- Resolve timeline and color settings;
- render logs and timing CSV;
- PNG-sequence and ProRes disk usage;
- screenshot of the minimal Fusion graph.

## Pass gates

- All reference frames render with expected dimensions and alpha.
- Fusion shows the correct diagnostic frame at every tested timeline position.
- F00-F04 meet the shared RGB and alpha thresholds.
- Three exports produce the same selected-frame hashes after normalization.
- Missing frames and missing assets fail visibly without freezing Resolve.
- A source or props change invalidates the affected output.

## Failure interpretation

- Alpha/color-only failure: investigate Loader interpretation, premultiplication, and Resolve color management before rejecting the architecture.
- Frame-identity failure: stop later live tests until the offset/FPS contract is corrected.
- Official renderer failure: record the exact unsupported fixture; it defines a Remotion limitation or environment problem, not a Fusion adapter failure.

## Product decision effect

- Pass: automated render/import is viable and later paths gain a reference oracle.
- Partial: restrict supported formats/settings and continue only if a faithful fallback remains.
- Fail: NetsuFlow is blocked until the baseline environment or mapping is corrected.
