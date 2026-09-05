# Editor architecture options

## Option A: Embed the complete HyperFrames Studio application

```text
NetsuRush module -> StudioApp -> HyperFrames Studio server
```

### Advantages

- fastest route to an existing timeline/editor;
- maximum behavioral similarity with upstream examples;
- smallest initial UI implementation.

### Limitations

- HyperFrames owns routing, state, layout, shortcuts, dialogs, and much of the
  interaction model;
- difficult to make the module feel native to NetsuRush;
- Resolve Media Pool, publish, and AI workflows become attachments around
  another application;
- large upgrade and styling blast radius.

### Decision

Use only as a reference baseline in T01. Do not ship as the product shell.
[ST-HF-STUDIO]

## Option B: Custom NetsuRush shell with selected Studio components

```text
NetsuRush UI
  -> wrapped NLEPreview / Timeline / hooks where accepted
  -> SDK + Player
  -> NetsuRush-owned core adapter
```

### Advantages

- reuses mature editing interactions selectively;
- preserves NetsuRush navigation, theme, project state, and host workflows;
- faster than rebuilding every timeline and canvas interaction;
- individual components can be replaced.

### Limitations

- public components may still depend on Studio contexts or styling;
- pre-1.0 changes can require wrapper updates;
- ownership of undo, file changes, and selection must be tested carefully.

### Decision

Recommended starting architecture. Every component has an independent adoption
gate and fallback. [ST-HF-STUDIO]

## Option C: Fully custom editor on SDK + Player

```text
NetsuRush UI -> custom canvas/timeline/inspector -> SDK + Player
```

### Advantages

- complete visual and state ownership;
- smallest coupling to HyperFrames UI internals;
- easiest common shell for future Remotion;
- accessibility and shortcuts follow NetsuRush conventions directly.

### Limitations

- highest implementation cost for timeline gestures, canvas transforms,
  thumbnails, nested compositions, and keyframes;
- greater risk of initially lagging behind HyperFrames Studio behavior.

### Decision

Component-level fallback and possible long-term destination, not the first
assumption. SDK + Player is the documented custom-editor foundation.
[ST-HF-OVERVIEW] [ST-HF-SDK-CANVAS]

## Option D: Build an engine-neutral visual IR first

```text
Custom editor -> portable motion IR -> HyperFrames compiler / Remotion compiler
```

### Advantages

- elegant multi-engine authoring for explicitly portable primitives;
- potentially valuable future motion framework;
- strongest control over the visual timeline.

### Limitations

- does not faithfully represent arbitrary existing HyperFrames or Remotion
  projects;
- requires designing a language, compiler, diagnostics, and migration model
  before the basic product workflow is proven;
- delays Media Pool and Resolve delivery.

### Decision

Deferred. A small portable primitive layer may emerge after both real adapters
prove common semantics. It is not a prerequisite for Studio.

## Comparison

| Criterion | A: Complete Studio | B: Selective components | C: SDK + custom UI | D: IR first |
|---|---:|---:|---:|---:|
| Fast prototype | Excellent | Good | Moderate | Poor |
| NetsuRush visual integration | Poor | Excellent | Excellent | Excellent |
| HyperFrames feature reuse | Excellent | Good–excellent | Moderate | Low |
| State/UX control | Poor | Good | Excellent | Excellent |
| Upgrade isolation | Poor | Good with wrappers | Excellent | Excellent |
| Remotion-ready shell | Poor | Good | Excellent | Excellent |
| Arbitrary project compatibility | Good | Good | Good for preview/code | Poor |
| Development cost | Low initially | Moderate | High | Very high |
| Product recommendation | No | **Yes** | fallback/long term | defer |

## Final architecture

Use Option B with Option C as the fallback for every component. The invariant is
not “reuse a specific percentage of Studio”; it is “NetsuRush owns the product
and HyperFrames stays behind a replaceable adapter.”

