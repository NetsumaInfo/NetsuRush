# H02: HyperFrames random frames, alpha, and pixel path

## Question

Does persistent HyperFrames capture produce correct arbitrary frames and
canonical straight RGBA8 pixels?

## Fixtures

- flat channel and frame-number chart;
- 0%, 50%, and 100% alpha primaries;
- antialiased text/local font;
- transforms and opacity;
- SVG, blur/shadow;
- Canvas and WebGL/Three where applicable;
- image;
- video/media;
- intentional error.

## Variants

- sequential, reverse, repeated, and 1,000 seeded random frames;
- 1080p and 4K;
- PNG buffer baseline;
- alternative raw path only if public/supportable;
- cache bypass, memory hit, and disk hit;
- preview scale and final scale.

## Measurements

Seek/media wait, screenshot encode, validation, decode, normalization, cache,
transport, copy, total latency, memory, and error rate.

## Pass

- Each bridge frame matches the standalone HyperFrames reference.
- No wrong frame/dimension/channel/alpha mode.
- Flat fixtures match exactly after defined normalization.
- Tolerances for browser/font/WebGL are quantified.
- Corrupt/oversized captures are rejected before large allocation/copy.
- The selected path is justified by split timings.

