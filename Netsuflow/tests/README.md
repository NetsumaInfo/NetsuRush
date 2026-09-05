# Experimental test program

Tests are evidence gates, not implementation milestones. Every run creates a
dated report under `tests/results/<test-id>-<date>/` with environment, exact
versions/commands, artifacts, raw measurements, conclusion, and revisions.
Never overwrite earlier reports.

## Common host and bridge

| Order | Test | Decision unlocked |
|---:|---|---|
| 0 | [`T00-toolchain.md`](T00-toolchain.md) | Can the machine reproducibly build the OFX bundle? |
| 1 | [`T01-ofx-generator.md`](T01-ofx-generator.md) | Does Resolve accept the Generator contract? |
| 2 | [`T02-inspector.md`](T02-inspector.md) | Which compact controls are usable? |
| 3 | [`T03-fake-service-ipc.md`](T03-fake-service-ipc.md) | Is bounded out-of-process rendering host-safe? |
| 4 | [`C01-engine-conformance.md`](common/C01-engine-conformance.md) | Is the adapter abstraction real rather than nominal? |

## HyperFrames first-engine gate

| Order | Test | Decision unlocked |
|---:|---|---|
| H1 | [`H01-session-baseline.md`](engines/hyperframes/H01-session-baseline.md) | Can the pinned public API sustain one session? |
| H2 | [`H02-random-frame-and-alpha.md`](engines/hyperframes/H02-random-frame-and-alpha.md) | Are arbitrary frames and pixels correct? |
| H3 | [`H03-cache-scrubbing-soak.md`](engines/hyperframes/H03-cache-scrubbing-soak.md) | Is the live/Auto experience stable and useful? |

## Common product gates

| Order | Test | Decision unlocked |
|---:|---|---|
| 5 | [`T05-cache-and-scrubbing.md`](T05-cache-and-scrubbing.md) | Are cache/invalidation/scheduling correct? |
| 6 | [`T06-color-time-alpha.md`](T06-color-time-alpha.md) | Are pixels and frame mapping correct in Resolve? |
| 7 | [`T07-failure-concurrency.md`](T07-failure-concurrency.md) | Does it survive lifecycle/concurrency stress? |
| 8 | [`T08-windows-packaging.md`](T08-windows-packaging.md) | Can NetsuRush ship/repair it on Windows? |
| 9 | [`T09-macos.md`](T09-macos.md) | Can macOS be claimed? |
| 10 | [`T10-parameter-binding.md`](T10-parameter-binding.md) | Can declared variables become constant and keyframed native Fusion controls? |
| 11 | [`T11-fusion-element-overlay.md`](T11-fusion-element-overlay.md) | Can viewer selection, contextual edits, and stable native promotion ship? |

## Future Remotion and cross-engine gates

| Test | Decision unlocked |
|---|---|
| [`RM01-frame-renderer.md`](engines/remotion/RM01-frame-renderer.md) | Does a direct Remotion adapter pass the common contract? |
| [`X01-visual-parity.md`](cross-engine/X01-visual-parity.md) | Where are equivalent projects visually interchangeable? |
| [`X02-switching-and-fallback.md`](cross-engine/X02-switching-and-fallback.md) | Can one node switch engines without stale state or protocol changes? |

## Report template

```markdown
# <test-id> result — YYYY-MM-DD
Status: PASS | CONDITIONAL | FAIL | BLOCKED

## Environment
## Versions and revisions
## Commands
## Fixtures
## Raw artifacts
## Results
## Failures and observations
## Decision
## Follow-up
```

## Measurement rules

- Use release builds for performance conclusions.
- Separate cold start, warm start, capture miss, memory hit, and disk hit.
- Report median, p95, p99, min/max, errors, and sample count.
- Preserve reference images, logs, process snapshots, and checksums.
- Record Resolve, OS, hardware, engine/adapter/package, Node, browser, FFmpeg,
  compiler, protocol, and plugin revisions.
- Use seeded request traces.
- A manual observation states who performed it and what was visible.
