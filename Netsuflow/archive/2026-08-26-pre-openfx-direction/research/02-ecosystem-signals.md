# Ecosystem signals

## Remotion issue #10235

As checked on 2026-08-26, Remotion issue #10235 is open and requests export of a Remotion composition as EDL, FCPXML, Premiere XML, or OTIO so that Resolve or Premiere can receive editable cuts and original media references. [S-REM-ISSUE-10235]

The issue is relevant because it independently identifies demand for a Remotion-to-professional-NLE workflow. It is not the same proposal as NetsuFlow:

| Issue #10235 | NetsuFlow |
|---|---|
| Transfers edit decisions and source links | Transfers or hosts rendered motion graphics |
| Targets timeline interchange | Targets Fusion image generation and compositing |
| Primarily cuts, tracks, in/out points | Primarily pixels, alpha, animation, props, and optional nodes |
| EDL/FCPXML/XML/OTIO | PNG/alpha media, OGraf, Fuse/OpenFX, or Fusion `.comp` |

The only visible comment at the check date is from the issue author offering to implement an initial EDL exporter. No maintainer response in the issue currently commits Remotion to Resolve/Fusion integration. Therefore the issue is a **community demand signal**, not roadmap evidence or an API guarantee. [S-REM-ISSUE-10235]

## Possible future complement

If Remotion later exposes a supported timeline interchange model, NetsuRush could combine two independent outputs:

```text
Remotion project
  -> editorial structure -> FCPXML/OTIO -> Resolve Edit page
  -> graphics output      -> NetsuFlow    -> Fusion
```

This would improve end-to-end handoff but would not remove the need for NetsuFlow's rendering and Fusion tests.

## Similar integration patterns

The projects below are references for integration patterns only. None currently establishes a mature Remotion-inside-Fusion implementation.

- `daisy_chain` demonstrates an RPC-style bridge for controlling Resolve from external languages. [S-COMMUNITY-DAISY]
- `auto-subs` demonstrates a practical Resolve/Fusion integration using scripts and packaged Fusion assets. [S-COMMUNITY-AUTOSUBS]
- `ograf-devtool` provides a community development environment for OGraf graphics. [S-COMMUNITY-OGRAF]
- `davinci-resolve-ai-bridge` combines Resolve automation and Remotion-oriented workflows, but does not establish a per-frame Remotion Fusion source. [S-COMMUNITY-AI-BRIDGE]

Community code may suggest packaging or communication techniques. Product feasibility decisions still require the primary documentation and local protocols in this directory.
