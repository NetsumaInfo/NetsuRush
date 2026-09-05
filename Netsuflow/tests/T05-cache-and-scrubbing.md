# T05: Cache, invalidation, and scrubbing

## Question

Can cache and scheduling make normal editing useful without serving stale frames?

## Request traces

- repeated same frame;
- forward playback and scrub;
- reverse scrub;
- random jumps;
- short loop;
- rapid parameter edits;
- source edit while frames are in flight;
- engine/adapter/browser version change;
- switch between two engine bindings;
- two node instances sharing one composition;
- memory pressure and disk eviction.

## Validate

- in-flight deduplication;
- memory and disk hit latency;
- prefetch benefit/cost;
- foreground priority over prefetch;
- content revision invalidation;
- normalized props revision and engine fingerprint invalidation;
- atomic cache writes and corrupt-entry recovery;
- byte-budget eviction;
- cache persistence across application restart;
- bypass and hard refresh semantics.

## Pass

- Every returned frame carries the requested content revision.
- No frame crosses an engine, props, source, or browser-build key boundary.
- Cache hits meet the provisional target on the reference machine.
- Editing source or props cannot show an old revision as current.
- Cache and worker memory remain within configured bounds.

## Product output

Choose defaults for memory budget, disk budget, prefetch window, preview deadline, and when Auto schedules a pre-render.
