# T03: Fake service and bounded IPC

## Question

Can an OFX render callback safely request frames from an external service without involving Remotion?

## Fixture

A Node test server returns deterministic RGBA patterns and can deliberately delay, disconnect, corrupt lengths, send wrong dimensions, restart, or reject authentication.

## Procedure

1. Implement session descriptor and handshake.
2. Request 1080p and 4K frames over framed loopback TCP.
3. Scrub sequentially and randomly in Resolve.
4. Exercise delays before/after headers and partial payloads.
5. Kill/restart the service while requests are active.
6. Trigger host abort and verify cancellation.
7. Send oversized, truncated, unknown-version, wrong-stride, and unauthenticated messages.
8. Run at least 10,000 requests with bounded cache.

## Pass

- Resolve never crashes or waits beyond the documented deadline.
- Invalid pixels never reach the output buffer.
- Restart/reconnect requires no Resolve restart.
- Cache-hit 1080p round trip plus copy meets the provisional p95 target.
- Memory and handle counts stabilize.

## Stop

Do not add Remotion if malformed or delayed fake responses can destabilize Resolve.
