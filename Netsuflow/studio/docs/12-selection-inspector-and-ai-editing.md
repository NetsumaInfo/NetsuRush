# Selection, inspector, and AI-assisted editing

## Product decision

NetsuFlow Studio uses one shared selection and typed edit model for three ways
of working:

- direct manipulation in the preview;
- manual property editing in an Inspector;
- AI-assisted changes scoped by explicit context attachments.

Simple edits must never require a prompt. The AI receives the same selection
and proposes the same typed operations that the manual interface can produce.
It is an optional collaborator for structural, multi-step, or generative work.

```text
Preview selection ---------+
Layer/timeline selection ---+-> SelectionRef -> Inspector
Code selection -------------+                 -> context attachments
Resolve asset selection ----+                 -> typed edit operations
                                               -> AI change-set proposal
```

## User outcome

The intended loop is:

1. click an element in the preview;
2. immediately see what it is and which properties are safely editable;
3. change common values directly;
4. optionally attach the selected element, frame, range, asset, or code region
   to an AI request;
5. inspect the proposed diff and preview before applying it;
6. publish the exact revision to Fusion or Resolve.

The same element ID should remain understandable when the user moves between
the NetsuRush module, the standalone/browser editor, and the Fusion node.

## Interface surfaces

### NetsuRush Studio module

The complete experience belongs in the main application:

```text
+-----------------------------------------------------------------------+
| Project  Composition  Frame  Engine  Validate  Publish                |
+----------------+----------------------------------+-------------------+
| Files / Layers | Preview                          | Inspector         |
| Media Pool     |  [hover + selection overlay]     | Selected element  |
| Compositions   |                                  | Properties        |
|                |                                  | Bindings/Origin   |
+----------------+----------------------------------+-------------------+
| Timeline / playhead / tracks / clips                                  |
+-----------------------------------------------------------------------+
| Prompt composer: [Title #hero-title] [Frame 42]  Ask for a change...  |
+-----------------------------------------------------------------------+
```

The prompt composer may collapse when the agent is disabled. Preview,
selection, Inspector, code editing, history, validation, and publishing remain
fully usable.

### Lightweight browser editor

The current editor remains a focused extension companion. Its first selection
scope is deliberately smaller:

- preview hit testing and selected outline;
- selected element name/ID;
- common safe properties;
- declared composition variables;
- send the committed revision back to the OpenFX node.

It does not need the full Media Pool, agent, project explorer, or publishing
orchestration. It should consume the same engine adapter and operation schemas
so edits remain portable to Studio.

### Fusion

Fusion provides the narrowest surface:

- viewer hover/selection overlay;
- direct X/Y movement first;
- stable declared variables in the native Inspector;
- a bounded contextual summary for the selected element;
- an **Open in NetsuFlow** action carrying the binding, element ID, and frame.

The technical design and host constraints are defined in
[`../../docs/13-fusion-element-selection-and-contextual-controls.md`](../../docs/13-fusion-element-selection-and-contextual-controls.md).

## Selection model

```ts
interface SelectionRef {
  projectId: string;
  compositionId: string;
  sourceRevision: string;
  elementIds: string[];
  primaryElementId?: string;
  frame: number;
  origin: "studio" | "browser-editor" | "fusion" | "agent";
}
```

Rules:

- selection is ephemeral and does not dirty the project;
- an edit always includes the base source revision;
- one selected element is the initial product requirement;
- additive/multiple selection may be exposed only after group transform
  semantics are defined;
- source reload attempts to restore by stable `data-hf-id`;
- a missing or duplicated identity clears selection and explains why;
- nested selection supports cycling or a breadcrumb instead of guessing which
  ancestor the user intended.

HyperFrames' iframe adapter already supports hit testing against the nearest
`data-hf-id`, selection events, draft movement, and a single committed move
operation. [ST-HF-SDK-CANVAS]

## Selection affordances

The preview should provide:

- a subtle hover outline;
- a stronger selected outline;
- element label and type near the outline when space allows;
- a breadcrumb for nested elements;
- transparent-region pass-through;
- an optional selectable-layer list for overlapping elements;
- Escape to clear selection;
- arrow-key nudging only when focus and coordinate semantics are unambiguous.

DOM and SVG elements can be inspectable when they have stable identities.
Canvas/WebGL content is one selectable surface unless an engine-specific scene
adapter supplies internal objects. Unsupported content still previews and
renders normally.

## Inspector information architecture

The Inspector is organized by meaning rather than raw CSS property order:

1. **Identity** — label, element ID, type, parent, source location.
2. **Layout** — position, size, anchor, alignment, overflow.
3. **Transform** — translate, scale, rotation, transform origin.
4. **Appearance** — opacity, colors, border, radius, shadow, filters.
5. **Typography** — text, font, size, weight, spacing, line height, alignment.
6. **Media** — source asset, crop/fit, volume where relevant.
7. **Timing** — start, duration, track, media offset.
8. **Bindings** — declared variable, inline value, stylesheet, runtime
   animation, inherited value, or engine-derived value.
9. **Diagnostics** — read-only reason, stale revision, unsupported pattern.

Only groups with meaningful properties appear. Search filters fields without
changing their identity.

### Property state

Every field displays enough provenance to avoid destructive edits:

<!-- markdownlint-disable MD013 -->

| State | UI behavior |
| --- | --- |
| Declared variable | edit control plus binding badge; native Fusion eligibility |
| Inline/attribute | direct edit or sparse override |
| Stylesheet rule | edit through a source operation with file/rule provenance |
| Inherited | read-only by default; offer explicit local override |
| Runtime animation | show current value and animation badge; use a supported animation operation or code |
| Computed only | read-only explanation |
| Unsupported | preserve renderability and offer code/AI proposal |

<!-- markdownlint-enable MD013 -->

Reset returns to the authored value by removing an override. It does not copy
the current computed value into source.

## Manual edit contract

Manual controls and canvas gestures emit typed operations:

```ts
type EditorOperation =
  | { type: "element.move"; elementId: string; dx: number; dy: number }
  | {
      type: "element.resize";
      elementId: string;
      width: number;
      height: number;
    }
  | { type: "element.setText"; elementId: string; value: string }
  | {
      type: "element.setStyle";
      elementId: string;
      values: Record<string, string>;
    }
  | {
      type: "element.setAttribute";
      elementId: string;
      name: string;
      value: string;
    }
  | { type: "variable.set"; variableId: string; value: unknown }
  | {
      type: "clip.setTiming";
      elementId: string;
      start: number;
      duration: number;
      track: number;
    };
```

The engine adapter validates whether a proposed operation has a safe source
meaning. Visual resemblance never authorizes rewriting arbitrary JavaScript.

During a drag, the preview may update at display rate without mutating the
model. Pointer-up commits one operation and one undo entry. HyperFrames
documents this draft/commit pattern. [ST-HF-SDK-CANVAS]

## Context attachments for AI

The interaction should resemble context attachments in code-oriented tools,
not an invisible dump of the entire project into a prompt.

Candidate attachment chips:

```text
[Element: Title · #hero-title]
[Frame: 42]
[Range: 42-78]
[Asset: interview-a.mov]
[Code: index.html · selected block]
[Diagnostic: invalid duration]
[Reference frame: variant B]
```

Each chip is removable and inspectable. It resolves to a bounded structured
snapshot, not merely a human-readable label.

```ts
interface AgentContextAttachment {
  id: string;
  kind: "element" | "frame" | "range" | "asset" | "code" | "diagnostic" | "reference";
  label: string;
  projectId: string;
  compositionId: string;
  sourceRevision: string;
  payloadRef: string;
}
```

The composer automatically suggests the current selection and frame but does
not silently attach unrelated files, the entire Media Pool, or project-wide
logs. The user can pin an attachment when they want it to survive selection
changes.

### Selection snapshot semantics

An ordinary attachment captures the selected stable ID and base revision when
the message is sent. Later selection changes do not retarget an in-flight agent
request. If the source revision changes before application, the proposed change
set enters conflict/rebase rather than editing whichever element currently has
focus.

## AI workflow

The agent never bypasses the editor model:

```text
request + attachments
  -> bounded context snapshot
  -> proposed typed operations/source patches
  -> capability and revision validation
  -> sandboxed candidate session
  -> property/source diff + preview frames
  -> user Apply / Revise / Reject
  -> atomic commit
  -> post-apply validation
```

For a simple request such as “make this title red,” the proposal should be the
same `element.setStyle` or `variable.set` operation the color field would emit.
The AI is useful when intent spans several elements, animation code, layout,
media, diagnostics, or alternative variants.

The existing agent redesign contract remains authoritative for permissions,
provider neutrality, preview, and publication approval.
[`07-ai-agent-redesign.md`](07-ai-agent-redesign.md)

## Code and visual editing

Code edits and visual operations share revisions but not a falsely unified
character-level undo stack:

- visual/Inspector edits create typed operations and inverse patches;
- code edits create source revisions;
- applying valid code atomically replaces the preview session;
- invalid code remains editable while the last valid preview is marked stale;
- external file watcher changes create an explicit conflict;
- selection is restored by stable ID only after the new document validates.

The UI may show the source location related to the selected element, but must
not claim a unique line when an element is produced dynamically.

## Engine-neutral boundary

The common application owns selection references, property schemas, context
attachments, change sets, preview comparisons, history, and publishing.

The HyperFrames adapter owns:

- `data-hf-id` discovery and iframe hit testing;
- DOM/SVG property capability analysis;
- HyperFrames SDK patches and overrides;
- source serialization and engine diagnostics.

A future Remotion adapter may expose React element/component identities and
declared props through the same common contracts, but it is not required to
support every HyperFrames visual operation. Capability flags remain explicit.

## Cross-surface synchronization

```text
Studio/browser/Fusion selection
  -> selection service (ephemeral, revisioned)
  -> active clients receive stable IDs

Studio/browser/Fusion edit
  -> validated operation
  -> project/session revision advances
  -> preview and scene caches invalidate
  -> OpenFX binding observes committed revision
```

Fusion edits must not depend on the NetsuRush UI being open, but the renderer
service must be available. Studio may reconnect later and reconstruct committed
state from project overrides/source plus the binding record.

## Error behavior

<!-- markdownlint-disable MD013 -->

| Condition | User-facing result |
| --- | --- |
| Element has no stable identity | selectable only as its nearest stable ancestor, or not selectable |
| Property is runtime-computed | current value shown with read-only reason |
| Source changed during edit | candidate preserved; rebase/discard choice |
| Preview failed | code and diagnostics remain available; last valid preview marked stale |
| AI produced unsupported operation | validation rejects it before preview/apply |
| Fusion cannot expose another native slot | property stays available in Studio; explicit capacity message |
| Resolve disconnected | authoring continues; publish and live-host actions disabled |

<!-- markdownlint-enable MD013 -->

## Performance and accessibility

- Selection and manual Inspector editing must remain responsive without an AI
  provider or network connection.
- Hit testing and drag preview stay local to the preview surface.
- Property extraction is incremental and selected-element scoped.
- Long property lists use collapsed semantic groups and virtualization only
  after measurement.
- All direct-manipulation operations have keyboard/numeric alternatives.
- Selection colors and handles remain legible over light, dark, and transparent
  compositions.
- Focus order distinguishes preview, timeline, Inspector, and prompt composer.

## First milestone

The first shippable selection milestone is:

1. stable single-element selection in the browser preview;
2. identity, position, text, opacity, and color Inspector fields when safe;
3. one-operation drag with undo/redo;
4. context chips for selected element, frame, and bounded code region;
5. AI proposal preview using the existing typed change-set contract;
6. Fusion overlay proof for hover, selection, and X/Y drag;
7. explicit degraded states for dynamic, Canvas, and unsupported properties.

Resize, rotation handles, multi-selection, internal Canvas/WebGL objects, and
automatic native-control promotion follow only after the first milestone passes
the decision test.

## Acceptance criteria

- A user can select a stable DOM element and identify why each shown property
  is editable or read-only.
- Common edits are possible without AI and survive save/reopen.
- An AI request can attach exactly one element and frame without sending the
  whole project.
- AI and manual editing produce compatible typed operations and undo entries.
- Browser editor and Studio resolve the same stable element IDs.
- Fusion selection never relies on visual pixel inference.
- Source revision conflicts cannot retarget an operation silently.
- Rendering remains available when inspection is unsupported.
