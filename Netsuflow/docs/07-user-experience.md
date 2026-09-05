# User experience

## Principle

The Fusion node behaves like one normal source. NetsuRush owns code editing,
project trust, engine selection, dependency setup, logs, and cache controls.

## OpenFX Inspector

```text
NetsuFlow

Source
  Binding          Main Title
  Start Frame      0
  Props Override   { ... }

Rendering
  Mode             Auto | Live | Pre-render
  Quality          Preview | Final
  Cache            Auto | Bypass | Refresh

Status
  HyperFrames · Ready · cached 34/150
  Reload
  Open in NetsuRush

Composition Controls
  Speed            1.00x        ◇
  Size             100 px       ◇
  Accent           #ff3366      ◇
  Enabled          On           ◇
  Style            Soft         ◇
```

The engine shown in Status is informational. The binding resolves it. The exact
button/read-only behavior remains a T02 host test.

The diamond represents the normal host keyframe control. HyperFrames variables
are discovered from their typed schema and assigned to stable native slots.
Users can keep a constant value or animate the same control in Fusion. Overflow,
unsupported types, and projects requiring session reinitialization are shown
explicitly rather than hidden. See
[`12-fusion-parameter-binding.md`](12-fusion-parameter-binding.md).

## NetsuRush workspace

```text
Project             Composition       Engine
/title-project      Main              HyperFrames

Source / Props / Console / Cache

[Save] [Reload] [Pre-render] [Insert in Resolve]
```

Essential functions:

- import a project or create a managed snippet project;
- choose `HyperFrames`, later `Remotion`, or eventually `Auto`;
- discover composition dimensions, fps, duration, and inputs;
- validate and canonicalize props;
- show source/browser errors with file and line when available;
- create and assign a binding;
- display plugin/runtime versions and repair state;
- inspect/clear cache and restart a renderer session.

## Engine selection

- **HyperFrames:** first supported engine and default for HyperFrames projects.
- **Remotion:** appears only after its adapter passes the same conformance tests.
- **Auto:** may detect a project type or use an explicit fallback policy, but
  never silently converts a project or chooses a visually different renderer.

Changing engines creates a new binding revision and invalidates engine-dependent
cache entries. The existing OFX node can keep its identity.

## Render modes

- **Live:** requested frames render on demand.
- **Pre-render:** a complete alpha-preserving artifact provides predictable
  playback and can carry audio outside the OFX path.
- **Auto:** uses live/cache for editing and schedules pre-render for expensive
  content without changing intended pixels.

## Error states

| State | Node output | NetsuRush action |
|---|---|---|
| Service unavailable | Bounded diagnostic | Start/repair service |
| Binding missing | Diagnostic | Relink or recreate |
| Engine unavailable | Diagnostic naming engine/version | Install/repair adapter |
| Project untrusted | Diagnostic | Ask for explicit trust |
| Source error | Diagnostic | Open exact engine log |
| Cache miss | Wait within mode deadline | Render and cache |
| Final-render error | Hard failure | Preserve logs and retry |

## Framework later

The first framework package should describe portable controls, assets, timing,
and determinism. It can generate a stable prop editor for both engines while the
original engine still renders pixels. A component DSL is a separate later
product decision, not part of the bridge MVP.
