# Product scope

## Product statement

NetsuFlow Studio is a custom NetsuRush module for authoring, previewing, and
publishing code-driven motion compositions into DaVinci Resolve. HyperFrames is
the first authoring engine. Remotion follows through a separate adapter.

The user should be able to:

1. open or create a web-motion project;
2. choose a composition;
3. browse usable media from the current Resolve Media Pool;
4. place media and timed elements in a composition;
5. edit visually, through declared parameters, through source code, or through
   an AI-assisted change set;
6. preview and seek the composition inside NetsuRush;
7. publish it as a live NetsuFlow OpenFX source or a rendered asset;
8. update the result without rebuilding the project manually in Resolve.

## Immediate sequencing

Studio is not the current implementation target. The current target is the
small NetsuFlow OpenFX extension and its HyperFrames frame service. Studio
implementation starts only after its common renderer gates pass.

```text
OpenFX host + real HyperFrames renderer
  -> cache, controls, packaging, recovery proven
  -> Studio embedding spikes
  -> custom Studio foundation
  -> Resolve publishing workflows
  -> redesigned AI agent
  -> Remotion editor adapter
```

## Ownership

NetsuRush owns:

- navigation, layout, theme, accessibility, shortcuts, and dialogs;
- project registration, trust, persistence, and backups;
- Resolve Media Pool and timeline communication;
- engine-neutral assets, parameters, preview controls, publish targets, and
  diagnostics;
- AI context, change sets, approval, undo, and audit history;
- rendering lifecycle, cache, OpenFX binding, packaging, and repair.

HyperFrames owns only the engine-specific composition semantics and selected
editor/runtime facilities. [ST-HF-OVERVIEW] [ST-HF-STUDIO]

## First Studio milestone

The first useful Studio is deliberately smaller than a general NLE:

- one registered HyperFrames project;
- composition/file explorer;
- seekable preview;
- code editor;
- Media Pool asset browser;
- declared-variable inspector;
- basic clip timeline for start, duration, track, and media offset;
- validation and diagnostics;
- render/import and live-binding publish buttons;
- explicit save, undo, redo, and recovery.

## Non-goals

- Rebuilding every feature of Resolve's Edit page.
- Universal visual editing of arbitrary JavaScript, CSS, Canvas, WebGL, or
  Three.js behavior.
- Translating arbitrary HyperFrames HTML/GSAP into Remotion TSX or the reverse.
- Storing an entire source project inside an OpenFX parameter.
- Treating the current NetsuPilot behavior as an accepted Studio agent.
- Allowing an agent to mutate project files or Resolve silently.
- Starting the public motion framework or portable IR before editor and bridge
  evidence justifies it.

## Success criteria

Studio becomes a product candidate only when a clean supported Windows machine
can complete this loop:

```text
Resolve project and Media Pool
  -> open NetsuFlow Studio
  -> add a Media Pool file to a HyperFrames composition
  -> edit timing and one declared variable
  -> preview the exact requested frame
  -> publish to Resolve
  -> reopen NetsuRush and Resolve
  -> recover the project, binding, and timeline relationship
```

The user must always know whether the timeline contains a live binding or a
flattened render.

