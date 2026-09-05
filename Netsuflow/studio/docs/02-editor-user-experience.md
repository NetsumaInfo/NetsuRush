# Editor user experience

## Principle

The interface must look and behave like NetsuRush. HyperFrames components are
implementation material, not the product shell.

Studio is a new left-navigation module named `NetsuFlow`. It follows the
existing module registry, Base UI component system, custom tooltips, theme, and
compact desktop layout. [ST-NR-UI]

## Workspace

```text
+------------------------------------------------------------------+
| Project  Composition  Engine: HyperFrames  Validate  Publish     |
+--------------+----------------------------------+----------------+
| Project      |                                  | Inspector      |
| Files        |             Preview              | Properties     |
| Compositions |                                  | Variables      |
|              |                                  | Diagnostics    |
| Media Pool   |                                  | AI Assistant   |
+--------------+----------------------------------+----------------+
| Timeline: tracks, clips, playhead, zoom, in/out, keyframe hints   |
+------------------------------------------------------------------+
| Design | Code | Split                                             |
+------------------------------------------------------------------+
```

The layout may collapse into drawers on narrow windows, but the desktop default
keeps preview, timeline, and selected-property context visible together.

## Core workflows

### Open a project

1. Register a trusted project directory.
2. Detect engine and version.
3. List compositions and diagnostics.
4. Open the last composition and playhead.
5. Restore unsaved recovery data only after comparing source revisions.

### Add Resolve media

1. Open the Media Pool tab.
2. Browse bins and search known file-backed items.
3. Drag or activate an item onto the canvas/timeline.
4. Choose linked reference, copied project asset, or managed proxy when needed.
5. Generate the engine-specific source mutation through the adapter.

The UI never pretends that a missing file path is usable. It offers the
available conversion/export action or explains why the item cannot be linked.

### Edit

- **Design:** select elements, move/resize supported elements, edit exposed
  properties and timing.
- **Code:** edit HTML/CSS/JS for HyperFrames; TSX/TS for future Remotion.
- **Split:** edit code with synchronized preview and diagnostics.
- **Variables:** edit declared reusable parameters separately from source.
- **Timeline:** change supported clip start, duration, track, media offset, and
  declared motion controls.

Every structural edit becomes one typed operation with forward and inverse
patches. Code edits become source revisions. Crossing between them creates an
explicit history boundary rather than an ambiguous merged undo stack.

### Publish

The Publish button opens a compact target chooser:

| Target | Result | Update behavior |
|---|---|---|
| Live NetsuFlow | OpenFX Generator with binding | invalidate binding and frame cache |
| Render to Media Pool | encoded file with optional alpha | create a versioned asset |
| Render and insert | encoded file placed at playhead/range | import then append/position |
| Copy/export source | project/composition package | no Resolve mutation |

Before publishing, the UI shows resolution, fps, duration, alpha mode, output
location, binding/render revision, and expected Resolve action.

## AI experience

The AI panel is contextual but not omnipotent. It receives the selected
composition, playhead, selection, relevant diagnostics, and a bounded asset
catalog. It proposes change sets and preview frames before application.

```text
request -> plan -> proposed operations -> diff -> preview -> apply -> verify
```

The agent can be hidden without disabling Studio. All authoring workflows must
remain available manually.

## Engine switch

The engine selector changes the active project/adapter, not the language of the
current source file. HyperFrames HTML does not silently become Remotion TSX.

Portable project metadata may be shared:

- asset references;
- canvas and fps;
- publish targets;
- declared user-facing parameters;
- review markers and notes;
- agent conversation/change-set history.

Source, runtime, timeline semantics, and engine diagnostics remain specific.

## Error states

The workspace distinguishes:

- Resolve disconnected;
- project missing or untrusted;
- engine runtime missing;
- preview unavailable but source editable;
- render unavailable but preview usable;
- source parse/lint error;
- Media Pool asset offline or without a path;
- binding stale;
- publish partially completed;
- packaged dependency/version mismatch.

No generic `Something went wrong` replaces an actionable engine or host error.

