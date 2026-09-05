# Source registry

Checked on 2026-08-26 unless another date is stated. Primary sources are preferred. Local Blackmagic sources are part of the Resolve 21.0.4 developer installation on the research machine.

## Remotion

### S-REM-ISSUE-10235

- Type: GitHub issue, community signal.
- Source: [Feature Request: Export timeline / edit decision list for DaVinci Resolve and Premiere Pro](https://github.com/remotion-dev/remotion/issues/10235)
- Supports: existence and exact scope of the request; open state; visible discussion.
- Does not support: a maintainer roadmap commitment, Fusion-node support, or technical feasibility.

### S-REM-STILL

- Type: official documentation.
- Source: [`renderStill()`](https://www.remotion.dev/docs/renderer/render-still)
- Supports: single-frame rendering, explicit frame, composition, props, output formats, scale, and reusable `puppeteerInstance`.

### S-REM-OPEN-BROWSER

- Type: official documentation.
- Source: [`openBrowser()`](https://www.remotion.dev/docs/renderer/open-browser)
- Supports: keeping and reusing a Chrome/Chromium instance across renderer calls to avoid repeated browser startup.

### S-REM-STILL-SOURCE

- Type: official source code.
- Source: [`packages/renderer/src/render-still.ts`](https://github.com/remotion-dev/remotion/blob/main/packages/renderer/src/render-still.ts)
- Supports: current renderer lifecycle, including `browserInstance.newPage()`, exact-frame seek, capture, and page closure when a browser instance is supplied.

### S-REM-MEDIA

- Type: official documentation.
- Source: [`renderMedia()`](https://www.remotion.dev/docs/renderer/render-media)
- Supports: complete composition rendering and codec/output configuration.

### S-REM-ALPHA

- Type: official documentation.
- Source: [Rendering transparent videos](https://www.remotion.dev/docs/transparent-videos)
- Supports: PNG transparency and documented transparent video settings/codecs.

### S-REM-PLAYER

- Type: official documentation.
- Source: [Remotion Player](https://www.remotion.dev/docs/player/player)
- Supports: embedding a composition in React and controlling it through `PlayerRef`, including `seekTo(frame)`.

### S-REM-WEB-RENDERER

- Type: official documentation.
- Sources: [`renderStillOnWeb()`](https://www.remotion.dev/docs/web-renderer/render-still-on-web), [client-side rendering limitations](https://www.remotion.dev/docs/client-side-rendering/limitations), [experimental HTML-in-canvas](https://www.remotion.dev/docs/client-side-rendering/html-in-canvas)
- Supports: browser-side Canvas rendering and its compatibility limitations.

### S-REM-LICENSING

- Type: official policy/documentation.
- Source: [Remotion licensing](https://www.remotion.dev/docs/licensing)
- Supports: current license categories and the need to evaluate automated product use.
- Note: commercial terms can change and must be rechecked before release.

## Blackmagic Design / DaVinci Resolve / Fusion

### S-BMD-OGRAF-OVERVIEW

- Type: official locally installed documentation.
- Source: `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\OGraf HTML Templates\Documentation\01-OGraf-Overview.md`
- Supports: OGraf manifest and Web Component model, CEF loading, native Fusion controls, `OGrafLoader`, and per-frame browser capture.

### S-BMD-OGRAF-INTEGRATION

- Type: official locally installed documentation.
- Source: `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\OGraf HTML Templates\Documentation\02-Resolve-Integration.md`
- Supports: non-real-time lifecycle, `goToTime()`, deterministic random/backward seeking, frame-rate behavior, property limits, RCM handling, platform support, and Windows/macOS capture characteristics.

### S-BMD-OGRAF-WEB-COMPONENT

- Type: official locally installed documentation.
- Source: `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\OGraf HTML Templates\Documentation\03-Web-Component-API.md`
- Supports: required Web Component methods and action lifecycle.

### S-BMD-OGRAF-PROPERTIES

- Type: official locally installed documentation.
- Source: `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\OGraf HTML Templates\Documentation\05-Properties-and-Controls.md`
- Supports: mapping manifest schema fields to Resolve/Fusion controls.

### S-BMD-OGRAF-PACKAGING

- Type: official locally installed documentation.
- Source: `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\OGraf HTML Templates\Documentation\06-Packaging-and-Installation.md`
- Supports: `.ograf`, `.drfx`, template locations, packaging, and installation.

### S-BMD-FUSE

- Type: official locally installed PDF.
- Source: `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Fusion Fuse\Fusion Fuse SDK.pdf`
- Public copy: [Fusion Fuse SDK](https://documents.blackmagicdesign.com/UserManuals/Fusion_Fuse_SDK.pdf)
- Supports: custom Lua tools, `Process(req)`, image creation, input controls, current request time, and `OutImage:Set(req, image)`.
- Does not establish: a supported asynchronous HTTP/WebSocket/subprocess model inside a Fuse render callback.

### S-BMD-SCRIPTING

- Type: official locally installed documentation.
- Source: `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\README.txt`
- Supports: Resolve/Fusion scripting entry points; timeline insertion; Fusion composition add/import/export; Fusion output-cache controls.

### S-BMD-WORKFLOW

- Type: official locally installed documentation.
- Source: `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\README.txt`
- Supports: Electron Workflow Integration plugins, Resolve JavaScript API access, UIManager scripts, sandbox/context-isolation guidance, and Workspace menu integration.

## OpenFX

### S-OFX-IMAGE

- Type: official API documentation.
- Source: [OpenFX Image Effect API](https://openfx.readthedocs.io/en/main/Reference/ofxImageEffectAPI.html)
- Supports: image effects, render actions, image access, time, and render windows.

### S-OFX-RENDERING

- Type: official API documentation.
- Source: [OpenFX rendering](https://openfx.readthedocs.io/en/main/Reference/ofxRendering.html)
- Supports: render action behavior and host/plugin rendering responsibilities.

### S-OFX-THREADING

- Type: official API documentation.
- Source: [OpenFX thread safety](https://openfx.readthedocs.io/en/latest/Reference/ofxThreadSafety.html)
- Supports: host threading and plugin thread-safety obligations.

## Parsing and intermediate representation

### S-BABEL-PARSER

- Type: official documentation.
- Source: [Babel parser](https://babeljs.io/docs/babel-parser)
- Supports: parsing JavaScript, JSX, and TypeScript syntax into an AST.

### S-BABEL-TRAVERSE

- Type: official documentation.
- Source: [Babel traverse](https://babeljs.io/docs/babel-traverse)
- Supports: AST traversal and transformation.

### S-TS-COMPILER

- Type: official project documentation.
- Source: [Using the TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
- Supports: parsing, inspecting, and transforming TypeScript programs.

## Tauri

### S-TAURI-SIDECAR

- Type: official Tauri v2 documentation.
- Source: [Embedding external binaries](https://v2.tauri.app/develop/sidecar/)
- Supports: shipping and invoking external binaries with a Tauri application.

### S-TAURI-CONFIG

- Type: official Tauri v2 configuration reference.
- Source: [Tauri configuration reference](https://v2.tauri.app/reference/config/#bundleconfig)
- Supports: bundle resources and external binary configuration.

## NetsuRush repository

### S-NR-ARCH

- Type: current project documentation.
- Source: `docs/architecture.md`
- Supports: Tauri shell, loopback Node core, RPC/SSE, and persistent Resolve Python bridge.

### S-NR-DIST

- Type: current project documentation.
- Source: `docs/distribution.md`
- Supports: portable Node/core resource packaging and mandatory runtime-dependency packaging checks.

### S-NR-FUSION-APPLY

- Type: current project source and tests.
- Sources: `core/transfer/fusion/apply.js`, `test/transfer-fusion-apply.test.cjs`
- Supports: current Fusion composition add/export/rewrite/import workflow.

### S-NR-FUSION-COMP

- Type: current project source.
- Source: `core/transfer/fusion/compText.js`
- Supports: generating and inserting native Fusion tool/animation text into an exported composition.

## Community examples

### S-COMMUNITY-DAISY

- Type: third-party project.
- Source: [jonnyhyman/daisy_chain](https://github.com/jonnyhyman/daisy_chain)
- Use: external-language RPC integration pattern for Resolve.

### S-COMMUNITY-AUTOSUBS

- Type: third-party project.
- Source: [tmoroney/auto-subs Resolve integration](https://github.com/tmoroney/auto-subs/tree/main/Resolve-Integration)
- Use: practical Resolve/Fusion script and asset integration pattern.

### S-COMMUNITY-OGRAF

- Type: third-party project.
- Source: [SuperFlyTV/ograf-devtool](https://github.com/SuperFlyTV/ograf-devtool)
- Use: OGraf development and test tooling reference.

### S-COMMUNITY-AI-BRIDGE

- Type: third-party project.
- Source: [flamexnreal/davinci-resolve-ai-bridge](https://github.com/flamexnreal/davinci-resolve-ai-bridge)
- Use: adjacent Resolve automation and Remotion workflow reference.

## Source maintenance

- Recheck all web sources before an implementation decision or release.
- Preserve the access date when a decision uses version-sensitive behavior.
- Record exact package, browser, Resolve, and SDK versions in test evidence.
- If local Blackmagic documentation changes after a Resolve update, rerun affected protocols rather than assuming compatibility.
