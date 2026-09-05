# Cross-engine architecture and Remotion

## Goal

Add Remotion later without rebuilding the NetsuRush module, Resolve bridge,
publish pipeline, asset catalog, or AI change-set workflow.

## Shared versus engine-specific

| Concern | Shared | Engine-specific |
|---|---:|---:|
| project registration and trust | yes | detection rules |
| Resolve asset catalog | yes | insertion source syntax |
| preview shell/playhead controls | yes | Player implementation |
| code editor container | yes | language services |
| variables/props inspector | schema contract | schema extraction/application |
| timeline shell | capability-driven | semantic rows/keyframes |
| render and publish records | yes | renderer call |
| OpenFX binding and pixels | yes | frame adapter |
| source files | no | yes |
| arbitrary source conversion | no | optional migration tool |

## Engine switching

The UI engine switch selects another registered project/adapter. It does not
reinterpret the current file.

```text
HyperFrames project -> HyperFramesEditorAdapter
Remotion project    -> RemotionEditorAdapter
                              |
                              v
                 common Studio and Resolve services
```

A workspace may contain related projects from both engines and shared asset
references. They retain independent source revisions and publish records.

## Future Remotion adapter

Remotion already supplies a React Player that can be embedded and parameterized
at runtime. Its renderer can select and render a specific zero-indexed frame,
and can reuse an open browser instance. [ST-REM-PLAYER] [ST-REM-STILL]

The future adapter must provide:

- project bundling and composition discovery;
- React Player preview;
- props/schema extraction;
- source editing through a TypeScript-aware surface;
- frame and media rendering;
- common binding creation;
- capability reporting for visual/timeline editing.

The same visual editor affordances cannot be assumed. Arbitrary React component
logic does not expose the same stable DOM/source mutation contract as
HyperFrames HTML.

## Portable primitives

A future optional portable layer may describe only explicit constructs:

- canvas, fps, finite duration;
- asset placement and clip timing;
- text and simple shape elements;
- transforms and opacity;
- declared user parameters;
- a bounded animation expression set.

Projects authored entirely in that layer may compile to both engines. Existing
arbitrary projects remain native to their engine. The portable layer is not a
dependency for the first Studio.

## Timeline interchange

Remotion issue #10235 requests editable NLE timeline export, but it is open and
describes a separate interchange workflow. NetsuFlow cannot plan around an
unimplemented upstream feature. [ST-REM-ISSUE-10235]

NetsuFlow publishing continues through its own Resolve scripting and OpenFX
contracts. OTIO/FCPXML/EDL may be evaluated later for cut-oriented workflows,
not for reproducing arbitrary web graphics as native Resolve nodes.

## Licensing

HyperFrames and Remotion have different licensing models. The editor adapter,
package distribution, user-project execution, and product terms need separate
review before Remotion ships. [ST-HF-LICENSE] [ST-REM-LICENSING]

