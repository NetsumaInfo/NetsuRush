# X01: HyperFrames and Remotion visual parity

## Question

For a deliberately portable fixture subset, how close are direct HyperFrames and
direct Remotion results?

## Method

1. Build equivalent projects from the same local assets/fonts/props.
2. Render standalone reference frames for each engine.
3. Render the same frames through each NetsuFlow adapter.
4. First compare each bridge output to its own engine reference.
5. Then compare the two engine outputs and classify differences.
6. Repeat at boundaries, random frames, alpha composites, and final pre-render.

## Result classes

- exact;
- tolerance-limited rasterization difference;
- semantically equivalent but visually different;
- unsupported/nonportable;
- adapter bug.

## Pass

Bridge-versus-own-reference correctness is mandatory. Cross-engine equality is
informational unless a migration claims parity. Record browser/font/codec/GPU
versions with every comparison.

