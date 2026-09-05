# NetsuFlow Studio source registry

Documents in this directory cite the stable IDs below. Sources were checked on
2026-08-27 unless another date is stated. Official documentation and installed
vendor SDKs outrank tutorials, videos, and community claims.

## HyperFrames editor surfaces

- **[ST-HF-OVERVIEW]** HyperFrames developer overview. It recommends SDK +
  Player for a custom editor and describes editable HTML as the shared source:
  https://github.com/heygen-com/hyperframes/blob/main/docs/developers/overview.mdx
- **[ST-HF-STUDIO]** `@hyperframes/studio` package documentation. It lists
  `StudioApp`, `EditorShell`, `NLEPreview`, `Timeline`, `PropertyPanel`,
  `SourceEditor`, `FileTree`, player stores, and editing utilities. It also says
  the lower-level exports are building blocks, not a drop-in embedded editor:
  https://github.com/heygen-com/hyperframes/blob/main/docs/packages/studio.mdx
- **[ST-HF-SDK-OPEN]** `openComposition()` reference: composition lifecycle,
  `find`, `setText`, `setStyle`, `serialize`, overrides, events, and disposal:
  https://github.com/heygen-com/hyperframes/blob/main/docs/sdk/reference/open-composition.mdx
- **[ST-HF-SDK-EDIT]** SDK querying and editing guide, including stable
  `data-hf-id` identities and typed mutations:
  https://github.com/heygen-com/hyperframes/blob/main/docs/sdk/guides/querying-and-editing.mdx
- **[ST-HF-SDK-CANVAS]** Canvas integration guide and iframe preview adapter:
  https://github.com/heygen-com/hyperframes/blob/main/docs/sdk/guides/canvas-integration.mdx
- **[ST-HF-OVERRIDES]** Embedded override mode, sparse deltas, patch events,
  and host-owned undo/redo:
  https://github.com/heygen-com/hyperframes/blob/main/docs/sdk/guides/embedded-override-mode.mdx
- **[ST-HF-UNDO]** HyperFrames SDK undo/redo and patch integration, including
  host-owned history with inverse patches:
  https://github.com/heygen-com/hyperframes/blob/main/docs/sdk/guides/undo-redo-and-patches.mdx
- **[ST-HF-STUDIO-SERVER]** Studio server package and adapter boundary for
  project listing, source mutation, previews, linting, thumbnails, and renders:
  https://github.com/heygen-com/hyperframes/blob/main/docs/packages/studio-server.mdx
- **[ST-HF-CORE]** Core composition, timeline, parser, generator, linter, and
  frame-adapter overview:
  https://github.com/heygen-com/hyperframes/blob/main/packages/core/README.md
- **[ST-HF-TIMELINE]** Timeline attributes and editing vocabulary:
  https://github.com/heygen-com/hyperframes/blob/main/docs/guides/video-editor-cheatsheet.mdx
- **[ST-HF-VARIABLES]** Typed composition variables that drive editing UI and
  runtime overrides:
  https://hyperframes.heygen.com/concepts/variables
- **[ST-HF-LICENSE]** HyperFrames repository license, Apache-2.0:
  https://github.com/heygen-com/hyperframes/blob/main/LICENSE
- **[ST-HF-REPO]** Official repository, package layout, release activity, and
  project source:
  https://github.com/heygen-com/hyperframes

The npm registry reported version `0.8.16` for `@hyperframes/sdk`,
`@hyperframes/player`, `@hyperframes/studio`, and
`@hyperframes/studio-server` on 2026-08-27. The Studio peer requirements were
React 19, React DOM 19, and Zustand 4 or 5. The registry did not return a
package-level license field in the query, so licensing relies on the repository
license and must be re-audited from the exact packaged tarballs before release.

## Resolve and Fusion

- **[ST-OFX-PARAMETERS]** OpenFX parameter types, describe-time definition,
  value-at-time, keyframes, host-optional animation, and custom interfaces:
  https://openfx.readthedocs.io/en/latest/Reference/ofxParameter.html
- **[ST-OFX-INTERACTS]** OpenFX viewer-overlay drawing and pointer actions:
  https://openfx.readthedocs.io/en/main/Reference/ofxInteracts.html
- **[ST-OFX-OVERLAY-EXAMPLE]** Official low-level Overlay example:
  https://github.com/AcademySoftwareFoundation/openfx/blob/main/Examples/Overlay/overlay.cpp

- **[ST-BMD-SCRIPTING-LOCAL]** Installed Resolve 21 scripting documentation:
  `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\README.txt`.
  Relevant APIs include `GetMediaPool`, `GetClipList`, `GetMediaId`,
  `GetUniqueId`, `ImportMedia`, `AppendToTimeline`, `CreateTimelineFromClips`,
  `InsertOFXGeneratorIntoTimeline`, `GetItemListInTrack`, markers with
  `customData`, `ReplaceClip`, and render operations.
- **[ST-BMD-SCRIPTING-WEB]** Public mirror of the scripting documentation. It
  is useful for linking, but the installed current SDK is authoritative:
  https://wiki.dvresolve.com/developer-docs/scripting-api
- **[ST-BMD-NEW-FEATURES]** Resolve 20.2 scripting additions and pointer to
  Help > Documentation > Developer:
  https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_20.2_New_Features_Guide.pdf
- **[ST-BMD-OFX-OVERLAY]** Installed Resolve 21 SDK
  `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\OpenFX\GainPlugin\GainPlugin.cpp`.
  It attaches an Overlay V2 descriptor and draws lines, an ellipse, and text
  through the Draw Suite. This proves the bundled API/example surface, not the
  stability of NetsuFlow's proposed Generator overlay.
- **[ST-NF-OFX]** Existing engine-neutral OpenFX and binding architecture:
  [`../docs/02-system-architecture.md`](../docs/02-system-architecture.md),
  [`../docs/04-engine-contract.md`](../docs/04-engine-contract.md), and
  [`../docs/12-fusion-parameter-binding.md`](../docs/12-fusion-parameter-binding.md).

## NetsuRush application

- **[ST-NR-ARCH]** Current Tauri, Node core, RPC, Resolve bridge, and renderer
  architecture: [`../../docs/architecture.md`](../../docs/architecture.md).
- **[ST-NR-INVARIANTS]** Timeline and host-integration correctness rules:
  [`../../docs/invariants.md`](../../docs/invariants.md).
- **[ST-NR-DIST]** Runtime dependency and packaging requirements:
  [`../../docs/distribution.md`](../../docs/distribution.md).
- **[ST-NR-MEDIA]** Current Media Pool traversal and import implementation:
  [`../../core/resolve.js`](../../core/resolve.js) and
  [`../../core/resolve_helper.py`](../../core/resolve_helper.py).
- **[ST-NR-AGENT]** Current agent registry, Resolve tools, permissions, session,
  and renderer store. These are audit inputs, not proof that the present UX is
  suitable:
  [`../../core/agent/tools/registry.js`](../../core/agent/tools/registry.js),
  [`../../core/agent/tools/resolve.js`](../../core/agent/tools/resolve.js),
  [`../../core/agent/permissions.js`](../../core/agent/permissions.js), and
  [`../../src/store/chat.ts`](../../src/store/chat.ts).
- **[ST-NR-UI]** Current module registry and left-navigation source:
  [`../../src/lib/modules.ts`](../../src/lib/modules.ts) and
  [`../../src/components/nav.ts`](../../src/components/nav.ts).
- **[ST-NR-PACKAGE]** Current React 19 and Zustand 5 dependency baseline:
  [`../../package.json`](../../package.json).

## Remotion future adapter

- **[ST-REM-PLAYER]** Remotion Player for embedding a composition in a React
  application and controlling it at runtime:
  https://www.remotion.dev/docs/player
- **[ST-REM-STILL]** `renderStill()` for a selected zero-indexed frame, input
  props, and reusable browser instance:
  https://www.remotion.dev/docs/renderer/render-still
- **[ST-REM-ISSUE-10235]** Open community request for EDL/FCPXML/OTIO-style
  timeline export. It is evidence of demand, not an implemented API:
  https://github.com/remotion-dev/remotion/issues/10235
- **[ST-REM-LICENSING]** Current Remotion licensing documentation:
  https://www.remotion.dev/docs/licensing

## Evidence rules

- A documented export is a candidate, not proof it works in NetsuRush WebView2.
  This is already measured, not hypothetical: the engine README documents a
  `createCaptureSession` signature that does not exist in the published 0.8.16
  package ([`../tests/results/H02-2026-08-27/report.md`](../tests/results/H02-2026-08-27/report.md)).
  Every `.mdx` claim above must be re-verified against the installed tarball
  before T01 promotes it.
- A successful browser example is not proof of packaged Tauri behavior.
- A Resolve method is not proof that the resulting timeline item exposes every
  parameter needed for automatic binding.
- A benchmark must record exact versions, hardware, project, resolution, fps,
  cache state, sample count, median, p95, failures, and memory/handle deltas.
- Every claim promoted to confirmed requires a dated report under
  `studio/tests/results/`.
