# Color, time, and alpha contract

These are cross-engine correctness requirements.

## Time

Inputs are host time, host fps, source fps, start frame, duration, and optional
render scale/subframe data.

MVP with equal rates:

```text
sourceFrame = hostFrame - startFrame
```

Mixed-rate rule after validation:

```text
sourceFrame = floor((hostTimeSeconds - startSeconds) * sourceFps + epsilon)
```

HyperFrames documents seeking a requested frame and derives time from
`floor(frame) / fps`. [S-HF-DETERMINISM] Remotion also addresses explicit
zero-based frames. [S-REM-STILL] The common service owns host mapping; adapters
receive a normalized integer frame plus rational timing metadata.

## Duration

The binding descriptor provides width, height, fps, and finite duration. Outside
the interval, the explicit policy is transparent, hold, loop, or error. NetsuRush
may use Resolve scripting to insert/size a generator item where supported.
[S-BMD-SCRIPTING]

## Canonical internal pixels

First production contract:

- RGBA8;
- tightly packed declared stride;
- straight alpha;
- declared browser-like source color space;
- no hidden display transform.

The OpenFX plugin converts this canonical result to the byte or float buffer
requested by Resolve.

## Alpha tests

Use opaque and 50% alpha primaries, antialiased text, blur/glow, transparent RGB
with non-zero color, and composites over black/white/saturated backgrounds.

HyperFrames documents transparent PNG sequences and alpha-capable media outputs.
[S-HF-RENDERING] Remotion documents transparent output separately.
[S-REM-ALPHA] Neither claim replaces the end-to-end PNG decode, protocol,
OpenFX, and Fusion Merge test.

## Cross-engine references

A shared fixture subset should render in HyperFrames and Remotion:

- flat layout/text;
- transforms and opacity;
- SVG;
- image and local font;
- blur/shadow;
- Canvas/WebGL where both projects support equivalent behavior.

Compare each engine bridge result first against its own standalone reference.
Only then compare engines to each other. Browser, font, codec, GPU, and OS
differences may alter exact pixels; HyperFrames documents this reproducibility
limit. [S-HF-ENGINE-DOC]

## Scaling

Test requested scaled dimensions against canonical render plus defined
downsampling. CSS layout/text rasterization may differ between those paths.
Never allow preview scaling during final output without explicit policy.

## Tolerances

- Exact match for flat integer fixtures after defined conversion.
- Small recorded tolerance for antialiasing, fonts, browser builds, and
  resampling.
- Zero tolerance for wrong frame, dimensions, channel order, alpha convention,
  or stale props/source revision.

