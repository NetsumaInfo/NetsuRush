# Fusion element selection and contextual controls

## Product goal

NetsuFlow should support two complementary editing experiences inside Fusion:

1. stable composition controls in the Inspector for values intentionally
   exposed by the author; and
2. contextual element inspection in the viewer for selecting and adjusting a
   specific visual object.

The OpenFX node still outputs ordinary RGBA pixels. Element selection is an
additional interaction channel; it is not an attempt to reconstruct a DOM from
the flattened image.

```text
HyperFrames page at frame N
  -> RGBA pixels -------------------------------------> OpenFX output
  -> scene/element metadata -> OpenFX overlay interact -> viewer selection
  -> editable property schema -> contextual controls  -> edit operation
```

The same typed edit operations must also be consumable by NetsuFlow Studio.
Fusion and Studio are two clients of one editing model, not two independent
implementations with incompatible behavior.

## Current implementation baseline

The current plugin already declares a fixed control bank during
`describeInContext()` and reveals compatible slots after a `DESCRIBE` request.
[S-NF-OPENFX]

| Current slot type | Capacity | Current use |
| --- | ---: | --- |
| Double | 8 | declared numeric variables |
| String | 16 | declared text variables and unsupported scalar fallbacks |
| Boolean | 4 | declared toggles |
| RGB | 4 | declared colors |
| Choice | 4 | declared enums with per-instance options |

This differs from the older provisional capacities in
[`12-fusion-parameter-binding.md`](12-fusion-parameter-binding.md). The source
code is authoritative until a dated host report freezes a product limit.

### Why controls can appear inconsistently today

Code inspection identifies a concrete lifecycle gap:

- every generic slot is secret by default;
- the constructor fetches the slots but does not call `syncVariables()`;
- `syncVariables()` currently runs only after Source, Code, Binding, or Reload
  changes;
- a newly opened, copied, or restored node may therefore remain unmapped until
  one of those actions occurs;
- a failed or timed-out `DESCRIBE` also leaves the previous visibility state in
  place;
- overflow variables remain service-side and have no visible slot.

Resolve may add host-specific Inspector refresh behavior on top of this. The
initial synchronization gap is confirmed by source inspection; the exact host
symptoms and any additional refresh defect require the Fusion lifecycle test
defined below.

The product must not treat pressing Reload as the normal recovery mechanism.
An instance must restore its mapping automatically after create, project open,
copy/paste, service restart, and binding revision change.

## OpenFX constraints

OpenFX requires parameters to be defined during a plugin describe action.
Parameters cannot be created arbitrarily after a particular HyperFrames
composition is loaded. Parameter names and types are shared by every instance;
only writable instance properties and values may change later.
[S-OFX-PARAMETERS]

The fixed typed bank is therefore a necessary compatibility mechanism, not a
temporary workaround. Increasing the bank requires a new plugin build and must
preserve old parameter identities.

OpenFX 1.5 documents these parameter categories:

<!-- markdownlint-disable MD013 -->

| Category | Types | NetsuFlow relevance |
| --- | --- | --- |
| Integer | Integer, Integer2D, Integer3D | discrete values and pixel dimensions |
| Floating point | Double, Double2D, Double3D | scalar, point, scale, angle, opacity |
| Color | RGB, RGBA | color and optional alpha |
| Discrete | Boolean, Choice, StrChoice | toggles and enumerations |
| Text/path | String | text, file path, directory path, multiline code |
| Structured | Custom, Parametric | host-dependent advanced data/curve UI |
| Action/layout | PushButton, Group, Page | actions and Inspector organization |

<!-- markdownlint-enable MD013 -->

The current NetsuFlow build targets the OpenFX 1.4 headers bundled with Resolve
21. Features introduced later, including `StrChoice`, are not product
assumptions even when newer support-wrapper source happens to contain them.
[S-BMD-OFX-HEADERS]

Numeric and color parameter types animate by default in the OpenFX contract.
String, Boolean, Choice, and Custom animation depends on host capabilities and
must be measured in Resolve. Every render reads an animatable control with
`getValueAtTime(hostTime)`.

## Three control classes

### 1. Node and render controls

These always keep a fixed identity:

- source mode;
- code or app-managed binding;
- start frame;
- preview/final quality;
- composition format and custom dimensions;
- reload/open-editor actions;
- status and diagnostics.

They describe the node itself, not an authored visual element.

### 2. Declared composition variables

Declared variables are the safest native Fusion controls. Their stable variable
ID is mapped permanently to a compatible slot for that binding instance.

```text
composition variable ID
  -> persisted slot assignment
  -> Fusion value/keyframes
  -> evaluated value at frame N
  -> HyperFrames frame request
```

Supported first-class mappings are number, text, Boolean, RGB color, and enum.
Future point, RGBA, and integer mappings require measured host behavior and a
wire-format revision.

Slot assignments must use tombstones. A slot formerly assigned to `titleX`
must never silently become `logoScale` in a saved project, because existing
Fusion keyframes would then control the wrong meaning.

### 3. Selected-element properties

Selected-element properties are contextual and may change when the user clicks
another object. Candidate properties include:

| Property | Preferred control | First editing mode |
| --- | --- | --- |
| X/Y position | Double2D or two Double values | viewer drag + numeric fields |
| Width/height | Integer2D or Double2D | numeric fields, later resize handles |
| Scale X/Y | Double2D | numeric fields, later handles |
| Rotation | angle Double | numeric field, later rotation handle |
| Anchor/origin | Double2D | advanced field |
| Opacity | scale Double | slider/numeric field |
| Text content | String | text field |
| Text size/spacing/line height | Double values | numeric fields |
| Foreground/background | RGB or RGBA | color control |
| Border width/radius | Double values | numeric fields |
| Visibility | Boolean | toggle |
| Blend/mode variant | Choice | enum when authorable |
| Media source | String/path or app picker | app-owned replacement workflow |
| Timing start/duration | Integer values | Studio timeline first |

These properties must not be automatically keyframeable merely because a
generic slot exists. A contextual slot changing from element A to element B
would make existing keyframes ambiguous.

The default policy is:

- contextual controls edit HyperFrames overrides or source operations;
- declared variables remain the normal Fusion-keyframe surface;
- a contextual property becomes a native animatable control only through an
  explicit **Promote to Fusion control** operation that creates a stable
  element-ID/property-ID binding and consumes a permanent typed slot.

If no stable slot is available, the property remains editable in Studio and may
still be changed as a constant from the Fusion overlay.

## Property capability model

Every property shown to a user carries its source and editability. A computed
value alone is not proof that it can be rewritten safely.

```json
{
  "id": "transform.translate.x",
  "label": "Position X",
  "type": "number",
  "value": 420,
  "unit": "px",
  "origin": "inline-style",
  "editMode": "override",
  "animated": true,
  "keyframeableInFusion": false,
  "range": { "min": -3840, "max": 3840, "step": 1 }
}
```

Required origins:

- `declared-variable`;
- `inline-style`;
- `attribute`;
- `stylesheet`;
- `inherited`;
- `runtime-animation`;
- `computed-only`;
- `engine-adapter`.

Required edit modes:

- `native-control`;
- `override`;
- `source-operation`;
- `agent-only-proposal`;
- `read-only`;
- `unsupported`.

A runtime GSAP transform may be inspectable but read-only until the adapter can
identify a safe authored target. Canvas and WebGL content is selectable only as
one canvas element unless the composition or engine adapter supplies internal
scene identities.

## Scene metadata contract

The rendering service knows the DOM and must produce a bounded scene manifest
for the exact frame being inspected. Fusion never analyzes pixels to infer
element identity.

```ts
interface SceneSnapshot {
  schemaVersion: number;
  bindingRevision: string;
  sourceRevision: string;
  controlValuesHash: string;
  frame: number;
  compositionWidth: number;
  compositionHeight: number;
  elements: SceneElement[];
}

interface SceneElement {
  id: string;
  parentId?: string;
  label: string;
  tag: string;
  bounds: { x: number; y: number; width: number; height: number };
  quad?: Array<{ x: number; y: number }>;
  zOrder: number;
  visible: boolean;
  selectable: boolean;
  properties: ElementProperty[];
}
```

The snapshot is keyed by source, controls, frame, layout resolution, and engine
adapter revision. IDs and strings are bounded and validated. The service should
return only visible/selectable elements by default and fetch complete property
details only for the selected element.

HyperFrames already documents stable `data-hf-id` identities, hit testing with
`elementAtPoint()`, selection, draft translation, and a single committed move
operation after pointer-up. [S-HF-SDK-CANVAS]

## Fusion viewer overlay

OpenFX overlay interacts can draw over the host viewer and receive pointer
motion, down, and up actions. Resolve's installed GainPlugin example attaches
an Overlay V2 descriptor and draws with the OpenFX Draw Suite.
[S-OFX-INTERACTS] [S-BMD-OFX-OVERLAY]

The proposed interaction loop is:

```text
viewer pointer
  -> convert host canonical coordinates to composition coordinates
  -> hit-test cached scene snapshot
  -> draw hover/selection outline
  -> pointer down starts a draft
  -> pointer motion sends coalesced deltas
  -> pointer up commits one typed operation
  -> service updates preview/source override
  -> revisions and frame caches invalidate
```

The coordinate transform must reuse the exact render placement calculation:

```text
viewer/canonical coordinates
  <-> render scale
  <-> destination frame and contain offset
  <-> composition layout pixels
```

Duplicating approximate Fit math would make overlays drift away from rendered
elements. Rotated or transformed elements use a quadrilateral when available;
an axis-aligned box is only a fallback.

### Phased interaction scope

1. draw all selectable bounds in a diagnostic mode;
2. hover and single selection;
3. selected-element property summary;
4. X/Y drag with one commit on pointer-up;
5. resize and rotation handles;
6. multi-selection and group transforms only after single-element persistence
   is proven.

## Cross-surface selection

Fusion, the browser editor, and NetsuFlow Studio share a stable selection
reference:

```ts
interface SelectionRef {
  projectId: string;
  compositionId: string;
  sourceRevision: string;
  elementIds: string[];
  frame: number;
  origin: "fusion" | "studio" | "browser-editor" | "agent";
}
```

Selection itself is ephemeral. Edits and promoted native-control mappings are
persistent. A stale selection revision may be re-resolved by stable element ID,
but an edit must stop for confirmation if that ID now refers to a different
source node or no longer exists.

## Persistence and undo

- Fusion-native parameter values and keyframes remain stored by Resolve.
- Stable slot mapping metadata is encoded in bounded OpenFX string/custom
  parameters so project save, reopen, copy, and paste are reconstructible.
- HyperFrames visual edits use sparse overrides or explicit source operations.
- Studio owns cross-surface undo entries and records forward/inverse patches.
- A Fusion overlay drag produces one history entry, not one per mouse event.
- External source changes create a revision conflict; they are never silently
  overwritten.

HyperFrames embedded override mode explicitly supports host-owned undo through
patch and inverse-patch events. [S-HF-OVERRIDES]

## Performance rules

- Never send a complete DOM manifest with every render request.
- Fetch a compact scene snapshot only while interaction/inspection is active or
  when frame/selection/revision changes.
- Coalesce pointer motion to at most one draft update per viewer refresh.
- Cache geometry by frame, source revision, control hash, format, and fit.
- Fetch full property schemas only for selected elements.
- Bound element count, property count, strings, nesting depth, and payload size.
- Scene metadata failure must never block pixel rendering.

## Failure and degraded modes

<!-- markdownlint-disable MD013 -->

| Condition | Required behavior |
| --- | --- |
| Renderer unavailable | keep last-good pixels if preview policy allows; disable inspection |
| Scene snapshot stale | show stale state; reject commit until refreshed |
| Missing stable ID | render normally; element is not selectable |
| Dynamic/unsafe property | show origin and read-only reason |
| Control bank overflow | keep value in Studio; show explicit Fusion capacity warning |
| Resolve overlay unsupported | retain Inspector controls and Studio selection |
| Canvas/WebGL internal object | select canvas root unless an adapter supplies metadata |
| Source conflict | preserve draft separately; require rebase or discard |

<!-- markdownlint-enable MD013 -->

## Security boundary

- The OpenFX process never executes HTML or JavaScript.
- Scene and edit payloads use versioned bounded binary/JSON structures with
  authenticated loopback transport.
- Element labels and text are data, never Inspector markup or code.
- Property IDs come from an allowlist/schema, not arbitrary JavaScript paths.
- Source operations are validated and applied by the engine worker.
- An overlay interaction cannot request filesystem or Resolve timeline access.

## Required evidence tests

### F01: Inspector lifecycle

Test create, project save/reopen, node copy/paste, Source switching, Code edit,
Binding edit, Reload, service restart, delayed service start, invalid source,
schema expansion/reduction, and overflow. Record visible labels/options and
values without manually touching unrelated parameters.

Pass condition: a valid restored node reaches the correct mapping
automatically; stale or failed state is explicit; no previous-composition slot
remains visible.

### F02: Parameter capability matrix

For every OpenFX type used or proposed, record Inspector rendering,
instance-label refresh, visibility refresh, value editing, keyframes, spline
behavior, save/reopen, copy/paste, and scripting exposure in Resolve Studio 21.
Read host capability properties instead of assuming optional animation support.

### F03: Overlay host proof

Start from the installed Resolve GainPlugin Overlay V2 pattern. Draw a static
box, receive pointer actions, update one harmless parameter, save/reopen, and
verify no viewer or render-thread instability.

### F04: Scene metadata fidelity

Fixtures cover nested DOM, SVG, opacity, clipping, rotation, CSS transforms,
scroll-free composition coordinates, transparent images, GSAP motion, dynamic
elements, Canvas, and WebGL. Compare service bounds against reference browser
screenshots at multiple frames and formats.

### F05: Selection and drag

Select and move an identified DOM element in Fusion, observe the exact same
selection and result in Studio, undo, redo, reopen the project, and verify frame
cache invalidation. A drag must create one committed change.

### F06: Stable native promotion

Promote one element property to a Fusion control, keyframe it, change selection,
edit source, reopen, copy the node, and remove the source element. The mapping
must never retarget another element.

## Product decision

The recommended product model is layered:

1. keep declared variables as stable, keyframeable Fusion parameters;
2. add contextual viewer selection and safe override/source edits;
3. let users explicitly promote selected properties to stable native controls;
4. keep the full Inspector and AI workflow in NetsuFlow Studio when Fusion's
   fixed parameter surface is too constrained.

This provides the strongest Fusion integration possible without pretending that
an OpenFX host can dynamically mirror an arbitrary DOM as unlimited native
parameters.
