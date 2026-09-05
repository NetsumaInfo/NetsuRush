# T06: Color, time, alpha, and scaling

## Question

Does NetsuFlow return the same intended frame and compositing result as the selected engine's standalone reference?

## Time matrix

- integer frame boundaries;
- frame 0, last frame, before/after duration;
- start-frame offset;
- 24, 25, 30, 60, and 30000/1001 fps;
- unequal host/source fps;
- fractional OFX time if observed;
- reduced render scale.

## Pixel fixtures

- flat channel-order chart;
- grayscale and color ramps;
- straight/premultiplied alpha patterns;
- antialiased text;
- blur/shadow over transparency;
- tagged/untagged image assets;
- canonical render then downscale versus direct scaled render.

## Comparison

Save HyperFrames reference PNGs and OFX output captures or raw buffers. Compare exact integer regions and tolerance-based antialiased regions, then composite over black, white, and saturated backgrounds in Fusion. Repeat the same own-engine-reference method when the Remotion adapter exists; cross-engine comparison belongs to X01.

## Pass

- No wrong frame, dimension, channel order, or alpha convention.
- Flat-color fixtures match exactly after defined conversion.
- Any browser/font/resampling tolerance is measured and documented.

The final contract updates `docs/08-color-time-and-alpha.md`.
