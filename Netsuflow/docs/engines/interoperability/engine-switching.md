# Engine switching and shared bridge

## User model

One NetsuFlow node references one binding. The binding chooses the engine.

```text
OFX node(binding=title-main)
        |
        v
BindingRegistry
  title-main -> engine=hyperframes, revision=...
        |
        v
EngineRegistry.resolve('hyperframes')
```

Later, a user can create a Remotion binding or explicitly update the binding's
engine. The OpenFX plugin and project node identity do not change.

## What is reused

| Layer | HyperFrames | Remotion |
|---|---:|---:|
| OpenFX Generator | Same | Same |
| Plugin identifier | Same | Same |
| Session descriptor/auth | Same | Same |
| Wire protocol | Same | Same |
| Binding/project UI shell | Same | Same |
| Scheduler/dedup/backpressure | Same | Same |
| RGBA memory/disk cache | Same key schema | Same key schema |
| Pixel normalization | PNG baseline | PNG baseline |
| Diagnostics/error taxonomy | Same | Same |
| Engine session/discovery | Specific | Specific |
| Package/license policy | Specific | Specific |

## Binding change semantics

Switching engine is a content change:

1. create/validate the target engine project;
2. select a target composition;
3. map and validate props;
4. create a new immutable binding revision;
5. close/release the old session when unused;
6. invalidate plugin last-good/cache through resolved revision;
7. warm or pre-render the target;
8. switch only after the user accepts validation.

Never reuse frame cache entries across engine IDs, even if project names and
frame numbers match.

## Auto mode

Auto is a policy layer, not a translator:

- detect native HyperFrames versus Remotion project;
- choose a user-configured adapter;
- use live versus pre-render within that adapter;
- optionally recommend migration.

Auto cannot silently render Remotion source with HyperFrames unless an explicit
converted project exists and passes validation.

## Protocol evolution

The current plugin request already supplies an opaque binding.
[S-NF-BRIDGE] Engine choice therefore stays service-side. Add an engine field to
wire diagnostics only if useful; do not make old plugins understand engine
enumerations.

## Compatibility test

X02 creates two bindings with equivalent fixtures, alternates them on one node,
restarts each engine worker, invalidates props/source, and confirms no stale
cross-engine frame, plugin crash, or protocol change.

