# Remotion project and render lifecycle

## Registration

Record canonical project root/entry, allowed assets, exact Remotion package
version, lockfile fingerprint, composition, validated props, source revision,
network/font policy, and browser build.

Use composition selection to resolve dimensions, fps, duration, and defaults.
[S-REM-SELECT]

## Lifecycle

```text
register/trust
 -> resolve matching project renderer
 -> bundle once
 -> select/describe composition
 -> open/reuse browser
 -> render requested frames
 -> invalidate on revision change
 -> close resources
```

Browser provisioning is an install/repair concern, never an unexpected render
download. [S-REM-ENSURE-BROWSER] [S-REM-ELECTRON]

## Baseline and experiments

`renderStill()` with explicit frame/props/PNG is the correctness reference.
[S-REM-STILL] Compare cold, warm-browser, random, sequential, range-prefetch, and
bounded-worker variants. The current implementation's per-call page lifecycle
makes real measurement essential. [S-REM-STILL-SOURCE]

## Invalidation

Source, lockfile, configuration, local assets, fonts, composition, normalized
props, renderer version, adapter version, browser build, and policy all affect
revisions/cache keys. Live remote data and nondeterministic inputs require cache
bypass or explicit fingerprinting.

## Exit

The adapter ships only when it passes the common conformance suite, its own frame
renderer tests, licensing review, and the same Resolve color/time/alpha tests as
HyperFrames.

