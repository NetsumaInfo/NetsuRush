# Fusion parameter binding

## Product goal

A HyperFrames composition can declare editable values such as speed, size,
position, opacity, color, text, toggles, and styles. NetsuFlow exposes compatible
values as native Fusion/OpenFX controls. Users can both set a constant value and
animate it with Fusion keyframes or spline curves without editing source code.

```text
HyperFrames variable schema
          |
          v
NetsuRush binding + control mapping
          |
          v
fixed typed OpenFX control bank
          |
          v
getValueAtTime(host frame)
          |
          v
validated frame-scoped control values
          |
          v
HyperFrames apply values -> seek -> capture
```

## Confirmed capabilities

HyperFrames variables already provide the primary schema:

- `string`;
- `number` with optional `min`, `max`, `step`, and `unit`;
- `color`;
- `boolean`;
- `enum` with labeled options.

Variables include stable IDs, labels, defaults, runtime validation, and
programmatic metadata extraction through `@hyperframes/core`.
[S-HF-VARIABLES] The SDK also exposes `setVariableValue()` for composition
editing. [S-HF-SDK-EDITING]

OpenFX provides integer, double, Boolean, choice, RGB/RGBA, 2D/3D, string,
button, group, page, and custom/parametric types. Value parameters can be read at
an exact render time, and the parameter suite supports keyframe operations.
[S-OFX-PARAMETERS] The local Resolve SDK examples read animated parameters with
`getValueAtTime()`. [S-BMD-OFX-GAIN]

## Fundamental OpenFX constraint

A plugin must define its parameter set during a describe action; arbitrary new
parameters cannot be defined later for each bound project. Those definitions are
common to every instance of the plugin. [S-OFX-PARAMETERS] [S-OFX-PARAM-API]

Therefore NetsuFlow cannot discover a composition containing `speed`,
`headlineSize`, and `accent` and then create three brand-new native parameter
identities inside an already-loaded generic plugin.

## Selected architecture: fixed typed control bank

The generic OpenFX descriptor declares a bounded bank once:

| Bank | Current implementation capacity | HyperFrames mapping |
|---|---:|---|
| Double | 8 | number, scale, angle, opacity, speed-like scalar |
| Boolean | 4 | boolean |
| Color | 4 | color |
| Choice | 4 | enum |
| String | 16 | short string/content value and scalar fallback |

These counts match the current C++ descriptor, not a permanent product limit.
Integer, point, and RGBA mappings remain proposed extensions rather than
declared pools. T10 measures Resolve Inspector size and host parameter limits
before freezing a supported product matrix.

All slots exist in the descriptor but are hidden and disabled when unused. After
a binding is selected, the plugin applies instance-level label, hint,
enabled/secret state, numeric range/display range, increment/digits, and choice
options where Resolve honors them. OpenFX marks these properties writable on
parameter instances, but actual Inspector refresh behavior is host-specific and
must be measured. [S-OFX-PARAM-PROPERTIES]

If Resolve does not refresh instance labels/options reliably, the safe fallback
is numbered visible slots plus a read-only mapping summary, while the complete
friendly editor stays in NetsuRush.

## Mapping manifest

HyperFrames schema is the default source. An optional engine-neutral
`netsuflow.controls.json` sidecar at the registered project root adds
presentation information that HyperFrames does not express:

```json
{
  "schemaVersion": 1,
  "controls": {
    "speed": {
      "label": "Speed",
      "slotType": "double",
      "display": "scale",
      "animatable": true
    },
    "headlineSize": {
      "label": "Size",
      "slotType": "double",
      "display": "pixels",
      "animatable": true
    },
    "accent": {
      "label": "Accent",
      "slotType": "color",
      "animatable": true
    },
    "position": {
      "label": "Position",
      "slotType": "point2d",
      "variables": ["x", "y"],
      "animatable": true
    }
  }
}
```

The sidecar cannot change variable meaning or bypass HyperFrames validation. It
only groups variables, selects a compatible OpenFX presentation, supplies units,
and states whether frame-scoped updates are supported.

## Type mapping

| HyperFrames/metadata | OpenFX | Notes |
|---|---|---|
| `number` | Double | Default mapping; retain min/max/step |
| whole-step number | Integer | Only through explicit NetsuFlow presentation metadata |
| `boolean` | Boolean | Animate only if Resolve reports Boolean animation support |
| `color` | RGB | HyperFrames currently documents hex RGB rather than alpha |
| `enum` | Choice | Binding persists index-to-value mapping; display order alone is never identity |
| `string` | String | Constant editing required; animation is host-tested, not assumed useful |
| two numbers | Double2D | Explicit grouping only; never infer from names |
| button/action | PushButton | NetsuFlow action, not a HyperFrames variable |

OpenFX lets the host interpret doubles as plain values, scale, angle, time, or
spatial coordinates. [S-OFX-PARAM-API] NetsuFlow must use explicit metadata
rather than guessing that a variable named `size` is pixels or that `speed`
means timeline retiming.

## Constant and animated values

The same native control supports both use cases:

- no keyframes: `getValueAtTime(t)` returns the constant value;
- keyframed: it returns Fusion's evaluated value at the requested host time.

For every render, the plugin sends the evaluated typed values, not the keyframe
curve itself:

```json
{
  "controlSchemaRevision": "schema-42",
  "controlValues": {
    "speed": 1.25,
    "headlineSize": 180,
    "accent": "#ff3366"
  },
  "controlValuesHash": "..."
}
```

The service validates IDs, types, ranges, finite numbers, enum membership, total
count, and payload size against the immutable binding schema.

Resolve's current SDK is OpenFX 1.4, where Choice values are integer indices.
The binding therefore persists the exact index-to-enum-value table. Existing
options cannot be reordered or recycled in place after keyframes exist; a
schema change retains tombstoned slots or requires an explicit remap/new binding.

## HyperFrames application modes

HyperFrames variables are documented primarily as render-time inputs. Typical
composition code reads `window.__hyperframes.getVariables()` during
initialization, while the low-level capture loop seeks and captures frames.
[S-HF-VARIABLES] [S-HF-ENGINE-README] The official evidence does not yet prove
that arbitrary variable changes can be injected between two captures and update
every existing composition without reinitialization.

NetsuFlow must support and measure three levels:

1. **Session variables:** apply values before initialization. Correct for
   constant controls; a change rebuilds or refreshes the session.
2. **Frame variables through a NetsuFlow frame-control shim:** an opted-in composition
   receives values before each seek and updates DOM/CSS/GSAP state
   deterministically. This is the preferred path for smooth keyframed controls.
3. **Reinitialize on change:** compatibility fallback for an existing project
   that reads variables only once. Correct but likely too slow for uncached live
   animation; Auto/pre-render remains available.

No documentation may claim zero-source-change animated variables until T10
proves an official live reinjection path for the pinned engine version.

## Frame request and cache correctness

The current `propsRevision` gap becomes more important with animation. The
common frame request must include:

- binding/source revision;
- control schema revision;
- evaluated control values or a canonical typed encoding;
- control-values hash;
- requested frame/time;
- engine/adapter/browser fingerprints.

Every plugin, in-flight, memory, disk, and pre-render cache key includes the
control-values hash. A changed slider or keyframe must never hit the previous
value's last-good frame.

Static binding props and animated instance controls are distinct:

- **binding props:** project-level defaults stored in NetsuRush;
- **instance controls:** values/keyframes stored in the Resolve project;
- **effective values:** validated merge used for this exact frame.

Instance controls override binding defaults only for mapped IDs.

## Time and speed semantics

A composition variable called `speed` is an ordinary authored value unless its
manifest explicitly assigns a time role.

For a global animated playback-rate control, this is wrong:

```text
sourceTime = hostTime * speed(hostTime)
```

When speed changes over time, correct retiming requires the integral of the speed
curve plus an offset. That is a separate time-mapping feature and must not be
silently inferred from a variable name. The first parameter-binding prototype
passes the evaluated `speed` value to the composition; global retiming gets its
own later specification and test.

## Overflow and unsupported controls

When a schema exceeds the native bank:

- expose the highest-priority mapped controls in Fusion;
- keep every variable editable in NetsuRush;
- show a precise capacity warning;
- allow the user to choose which variables occupy slots;
- never drop a value silently.

A binding stores the stable variable-to-slot assignment, including tombstones
for removed controls, so reopening or copying a node cannot remap existing
keyframes to a different variable.

## Implementation plan

The executable tasks, file boundaries, protocol additions, and Resolve test
sequence are in
[`../plans/2026-08-27-fusion-parameter-binding-implementation.md`](../plans/2026-08-27-fusion-parameter-binding-implementation.md).

## Engine-neutrality

The OpenFX control bank and frame payload are not HyperFrames-specific. A future
Remotion adapter can map declared input props to the same control schema. The
engine adapter is responsible only for applying effective values before
rendering.

## Security and limits

- Maximum control count and metadata/payload size.
- UTF-8 validation and bounded labels/options.
- Finite numbers only; reject NaN and infinity.
- Canonical color encoding.
- Enum values separated from display labels.
- No code execution in parameter metadata.
- No project path, secret, or arbitrary HTML in Inspector labels.
- Deterministic serialization for hashes.

## Product acceptance

This feature is ready only when T10 demonstrates:

- manual edits and Fusion keyframes;
- exact value-at-time transmission;
- correct HyperFrames output;
- cache invalidation;
- save/reopen/copy/paste stability;
- dynamic labels/ranges/options or a documented fallback;
- bounded overflow behavior;
- no stale values during rapid scrubbing;
- acceptable session behavior for frame-scoped updates.

Element-level contextual properties, viewer overlays, and explicit promotion to
stable native controls are specified separately in
[`13-fusion-element-selection-and-contextual-controls.md`](13-fusion-element-selection-and-contextual-controls.md).
