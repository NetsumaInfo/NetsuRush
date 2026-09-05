# NetsuRush and Tauri integration

## Existing runtime boundary

NetsuRush is already structured as:

```text
Tauri Rust shell
  -> launches packaged portable Node runtime
  -> core/server.js on loopback
  -> RPC and SSE
  -> persistent Python Resolve bridge
```

The current architecture documents the Node core on loopback and a persistent JSON-lines Resolve helper. [S-NR-ARCH]

The release package stages portable Node, the core, Python, scripts, and other runtime resources into the Tauri bundle. New runtime dependencies must update staging, repair/install checks, packaged-runtime verification, and packaging tests in the same change. [S-NR-DIST]

Tauri supports bundling external binaries and resources, but NetsuRush currently packages its Node core as resources rather than `externalBin`. NetsuFlow should preserve this established application contract unless a measured requirement forces a change. [S-TAURI-SIDECAR] [S-TAURI-CONFIG] [S-NR-DIST]

## Recommended ownership

### Rust shell

Rust should initially own only:

- lifecycle of the existing Node core;
- packaged resource path discovery;
- shutdown and repair behavior already used by NetsuRush;
- any future native OpenFX installer operation that cannot live in Node.

Rendering orchestration should not be moved into Rust merely because the desktop shell is Rust.

### Node core

The existing core is the natural owner of:

- Remotion dependency and browser discovery;
- project validation and composition discovery;
- bundling and bundle invalidation;
- browser pool and render-job scheduling;
- frame/media cache;
- progress, cancellation, logs, and diagnostics;
- OGraf package generation;
- Resolve import orchestration.

This keeps Chromium and Remotion in their native Node ecosystem and reuses NetsuRush's existing RPC/lifecycle model. [S-REM-STILL] [S-NR-ARCH]

### Renderer UI

The future UI should call the core through the existing bridge. Any implementation must follow the project rule that a new RPC channel is represented in the core handler table, the typed client, and the mock bridge.

The UI contract should expose product concepts rather than renderer internals:

```text
Source project
Composition
Props
Mode: Auto | Live | Render | Native
Quality: Preview | Final
Cache state
Reload / Render / Cancel
Diagnostics
```

No UI copy should be implemented until wording is added to all six locales and locale parity is checked.

### Resolve/Fusion bridge

NetsuRush already manipulates timeline-item Fusion compositions by adding, exporting, rewriting, and importing a `.comp` representation. That path should be reused for Loader insertion and a future IR compiler. [S-NR-FUSION-APPLY] [S-NR-FUSION-COMP]

Resolve's scripting API documents `InsertFusionCompositionIntoTimeline()`, `AddFusionComp()`, `ImportFusionComp()`, `ExportFusionComp()`, and Fusion output-cache controls. [S-BMD-SCRIPTING]

## Proposed production module boundaries

These are planning targets, not files to create during the research phase.

```text
core/remotion/
├── project.js          project trust and validation
├── compositions.js     composition and props metadata
├── bundleCache.js      source fingerprint and bundle lifecycle
├── browserPool.js      renderer lifecycle and concurrency
├── frameCache.js       content-addressed frame cache
├── renderJobs.js       batch/still scheduling and cancellation
├── ografPackage.js     OGraf output and compatibility report
└── fusionImport.js     Loader/OGraf/Fusion graph orchestration

src/features/remotion/
├── api.ts
├── store.ts
├── RemotionPage.tsx
└── components/

test/remotion-*.test.cjs
src-tauri/resources/remotion/
```

The exact file plan must be written only after the architecture gates choose the first shipping mode.

## Cache contract

A frame cache key must include every input that can change pixels:

```text
renderer version
browser version and mode
bundle/source fingerprint
composition ID
canonical props hash
frame
width and height
fps and duration metadata
image format and scale
font and local-asset fingerprint
preview/final mode
```

Cache entries must be written atomically. Concurrent requests for the same key must share one in-flight render. Failed and cancelled renders must never publish a valid cache entry.

## Process and transport choices

### NetsuRush UI to renderer

Use the existing core RPC. A new localhost service is unnecessary inside the application.

### Fusion adapter to renderer

Test in this order:

1. no transport: OGraf executes the browser bundle directly;
2. shared filesystem: Loader or Fuse reads completed cache files;
3. authenticated loopback HTTP or named pipe for control metadata;
4. shared memory only if OpenFX and profiling justify it.

A loopback endpoint must use a per-session capability token, strict path validation, bounded payloads, and no wildcard browser access. Arbitrary Remotion projects execute JavaScript and must be treated as trusted local code in the first product version.

## Packaging implications

The packaged application must not depend on a developer-installed global Node, npm, Chrome, or Remotion CLI. Tauri can include resources and sidecars, while the current NetsuRush build already stages portable Node and core resources. [S-TAURI-SIDECAR] [S-TAURI-CONFIG] [S-NR-DIST]

Before choosing the packaging model, T07 must determine:

- whether Remotion downloads or locates Chrome Headless Shell at runtime;
- whether the browser can be shipped and discovered offline;
- the installed-size increase;
- code-signing and antivirus behavior;
- clean-install and repair behavior;
- whether the same package model is practical on macOS;
- whether OGraf assets must be installed globally, per user, or opened directly by Resolve.

## Licensing gate

Remotion's current licensing distinguishes individuals/small organizations from larger organizations and automated products. NetsuFlow must obtain a written interpretation for the intended NetsuRush distribution and usage model before a public or paid release. [S-REM-LICENSING]

This is a release gate, not a reason to avoid technical prototyping with an eligible development setup.
