# C01: Renderer engine conformance

## Question

Can the fake renderer and every real engine satisfy one behavior contract
without engine-specific branches in the bridge or OpenFX plugin?

## Harness

Run the same adapter-level test vector against `fake`, `hyperframes`, and
later `remotion`:

- probe capabilities and reject incompatible version;
- descriptor with exact dimensions/fps/duration;
- frame 0, last, repeated, sequential, reverse, seeded random;
- normalized props and source-revision change;
- deadline and cancellation;
- invalid dimensions/format/payload;
- two identical concurrent requests;
- session failure/restart;
- close and process/resource cleanup.

## Pass

- Same normalized frame/error shape for every adapter.
- No adapter type crosses into protocol/OpenFX code.
- Repeated requests are idempotent.
- Old props/source revisions never return as current.
- Abort/timeout is bounded.
- Close leaves no session/browser/project server.
- Engine fingerprints participate in the service cache key.

This test must pass before an engine is exposed in production UI.

