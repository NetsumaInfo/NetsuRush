# T01: Minimal OpenFX Generator in Resolve

## Question

Does Resolve load, instantiate, render, cache, save, reopen, and unload a CPU Generator using the intended declarations?

## Fixture

Generate RGBA pixels from frame number, coordinates, render window, and scale. Include a visible frame counter encoded as color bars, not external text rendering.

## Procedure

1. Install the bundle manually with Resolve closed.
2. Start Resolve and confirm discovery/name/category.
3. Insert the Generator in Fusion and, if applicable, through Resolve scripting. [S-BMD-SCRIPTING]
4. Scrub forward, backward, and randomly.
5. Change resolution and proxy/render scale.
6. Save, close, reopen, duplicate, and delete instances.
7. Render from Deliver and inspect logs.
8. Repeat after plugin removal to observe project failure behavior.

## Record

All actions, time values, render windows, scales, threads, aborts, instance lifecycles, and visible output.

## Pass

- Correct frame pixels in viewer and final render.
- No crash, hang, corrupt frame, or persistent leak.
- Project reopen preserves parameters.

## Stop

If a minimal local CPU Generator is unstable, do not implement IPC or Remotion until the host contract is corrected.
