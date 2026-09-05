# Renderer engines

## Strategy

NetsuFlow ships one OpenFX node and multiple optional renderer adapters.
HyperFrames is implemented first. Remotion remains documented so the common
architecture does not accidentally close that path.

| Criterion | HyperFrames first | Remotion later |
|---|---|---|
| Primary integration API | `@hyperframes/engine` capture session | `@remotion/renderer` |
| Warm state | Browser + page capture session | Reusable browser; page/range strategy must be measured |
| Requested frame | seek/capture frame | `renderStill(frame)` or measured range strategy |
| Initial pixel path | PNG buffer -> RGBA8 | PNG -> RGBA8 |
| Version policy | exact package/lock/browser pin | project packages exact-match; adapter supported range |
| Project compatibility | HyperFrames projects | Remotion projects |
| License posture | Apache-2.0 repository; audit transitive deps | separate current terms and customer review |
| Current priority | Active | Preserved future adapter |
| Main unknown | API churn and real random-frame latency | per-frame lifecycle, version/license coupling |

[S-HF-ENGINE-DOC] [S-HF-LICENSE] [S-REM-STILL]
[S-REM-VERSION-MATCH] [S-REM-LICENSE-TERMS]

## Directory map

- [`hyperframes/architecture.md`](hyperframes/architecture.md)
- [`hyperframes/architecture-options.md`](hyperframes/architecture-options.md)
- [`hyperframes/project-and-session-lifecycle.md`](hyperframes/project-and-session-lifecycle.md)
- [`hyperframes/capture-and-pixel-path.md`](hyperframes/capture-and-pixel-path.md)
- [`hyperframes/packaging-and-versioning.md`](hyperframes/packaging-and-versioning.md)
- [`remotion/architecture.md`](remotion/architecture.md)
- [`remotion/project-and-render-lifecycle.md`](remotion/project-and-render-lifecycle.md)
- [`interoperability/engine-switching.md`](interoperability/engine-switching.md)
- [`interoperability/remotion-to-hyperframes.md`](interoperability/remotion-to-hyperframes.md)

## Rule

Engine documentation may refine the common contract, but it cannot move
engine-specific logic into the OpenFX plugin or silently weaken shared
correctness/security requirements.
