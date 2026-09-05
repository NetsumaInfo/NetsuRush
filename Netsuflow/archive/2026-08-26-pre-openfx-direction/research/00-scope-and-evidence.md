# Research scope and evidence policy

## In scope

- Render a Remotion composition into a Fusion-compatible image source.
- Request a specific Remotion frame from a persistent local renderer.
- Test Remotion Player inside Resolve 21 OGraf.
- Automate Fusion composition creation and media import through NetsuRush.
- Compare Loader, Fuse, OGraf, and OpenFX as host adapters.
- Define a constrained Remotion-like subset that can compile to native Fusion nodes.
- Package the selected runtime in the existing Tauri application for Windows and macOS.

## Out of scope until the evidence gates pass

- A universal React, DOM, CSS, Canvas, WebGL, or Three.js to Fusion translator.
- JavaScript-to-Python-to-Lua transpilation as a product architecture.
- Automatic partitioning of arbitrary React trees into native and rendered subtrees.
- Production UI, marketplace distribution, Reactor packaging, or public API stability.
- Claims of real-time scrubbing without repeatable timing measurements inside Resolve.

## Evidence hierarchy

Use sources in this order:

1. locally installed Blackmagic SDK documentation matching the installed Resolve version;
2. official Remotion documentation and source code;
3. official Tauri and OpenFX documentation;
4. current NetsuRush source and packaging documentation;
5. reproducible local experiments;
6. third-party projects as examples only;
7. issue discussions as demand signals only.

An issue or community project does not prove that an API is supported or that a feature is on a maintainer roadmap.

## Citation rules

- Technical claims use one or more source identifiers from `SOURCES.md`.
- Local measurements cite an evidence artifact path once the test is executed.
- Inferences are introduced with **Inference** or **Hypothesis**.
- Unsupported claims are not promoted to conclusions.
- Source access dates and source types are recorded centrally.

## Test artifact policy

Each executed protocol gets a stable evidence directory:

```text
Netsuflow/evidence/<test-id>/<run-date>-<platform>/
├── environment.json
├── commands.log
├── result.json
├── report.md
├── frames/
├── metrics/
└── logs/
```

`environment.json` must include at least:

- NetsuRush commit and dirty-worktree flag;
- Resolve version and edition;
- operating system, CPU, GPU, RAM, and display scaling;
- Node, Remotion, Chromium, and Tauri versions;
- timeline resolution, frame rate, and color-management settings;
- fixture ID, composition ID, props hash, and source hash.

Binary evidence that is too large for Git should be retained outside Git with SHA-256 hashes recorded in `result.json`.

## Decision discipline

The official renderer baseline is the visual reference because `renderStill()` is Remotion's supported single-frame renderer and accepts a frame number, props, and a reusable browser instance. [S-REM-STILL] [S-REM-OPEN-BROWSER]

The source implementation shows that reusing the browser does not reuse the page: `renderStill()` creates a new page and closes it when a supplied browser instance is reused. This makes persistent-browser rendering feasible but leaves per-call page setup overhead to measure in T03. [S-REM-STILL-SOURCE]

OGraf is tested early because Resolve loads its Web Component in CEF, invokes `goToTime()` per requested frame, maps schema properties to native Fusion controls, and captures the result through `OGrafLoader`. [S-BMD-OGRAF-OVERVIEW] [S-BMD-OGRAF-INTEGRATION]

Native compilation is evaluated separately because syntax translation cannot by itself reproduce browser layout and rendering semantics. Babel and the TypeScript compiler expose ASTs, but neither converts React/CSS semantics into a Fusion graph. [S-BABEL-PARSER] [S-TS-COMPILER]
