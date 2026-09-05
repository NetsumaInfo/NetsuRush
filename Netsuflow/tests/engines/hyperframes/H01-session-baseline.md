# H01: HyperFrames session baseline

## Question

Can one exact public `@hyperframes/engine` version create, initialize, describe,
capture, and close a persistent session without internal imports?

## Fixture

A minimal finite 30 fps composition with deterministic background, text,
position, opacity, and a frame-number pixel code. No external network or media.

## Procedure

1. Pin package, lockfile, Node, and browser.
2. Start a controlled loopback project server.
3. List package-root exports used by the adapter.
4. Create/initialize one capture session.
5. Read descriptor.
6. Capture 0, 1, 30, 29, 30, last, and seeded random frames.
7. Trigger a source error and recover with a new revision.
8. Close, inspect process tree/handles, repeat 100 sessions.
9. Compile/run the wrapper against the next candidate version without modifying
   common bridge code.

## Measurements

Server/browser/session startup, initialization, each seek/capture, close,
working/private memory, handles, child processes, and errors.

## Pass

- Package-root public imports are sufficient.
- Requested frames are correct and repeated seeks are idempotent.
- Descriptor matches fixture.
- Resource counts return to baseline after close.
- API drift is isolated to the HyperFrames adapter.

