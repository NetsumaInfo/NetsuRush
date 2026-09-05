# Architecture candidates

## A1 - Full Remotion render and Fusion import

```text
NetsuRush core
  -> Remotion renderFrames/renderMedia
  -> PNG sequence or alpha video
  -> Resolve import
  -> Loader/MediaIn
```

### Components

- Remotion bundler and renderer in the existing Node core;
- project/composition/props resolver;
- content-addressed render cache;
- Resolve import and Fusion composition automation;
- NetsuRush UI for source selection, progress, cancellation, and refresh.

### Established capabilities

Remotion exposes supported APIs for a single still and complete media rendering. PNG supports alpha, while transparent video rendering is documented for supported codecs such as ProRes 4444. [S-REM-STILL] [S-REM-MEDIA] [S-REM-ALPHA]

Resolve scripting can insert a Fusion composition and timeline items can add, import, export, and cache Fusion compositions. NetsuRush already uses the import/export path. [S-BMD-SCRIPTING] [S-NR-FUSION-APPLY]

### Expected profile

- Fidelity: highest, because the official renderer is authoritative.
- Remotion compatibility: highest.
- Native editability: minimal.
- Update latency: proportional to rendered duration and composition cost.
- Development risk: low.
- Product role: mandatory fallback and final-quality path.

### Critical tests

T01, T04, and T07.

## A2 - On-demand frames through a persistent renderer

```text
Fusion requests frame N
  -> adapter/cache lookup
  -> NetsuRush Remotion service
  -> renderStill(N)
  -> PNG/cache entry
  -> Fusion output
```

### Components

- persistent bundle and browser pool;
- deterministic cache key;
- in-flight request deduplication;
- cancellation and bounded concurrency;
- playhead-aware prefetch;
- file-backed Fuse/Loader initially, with an optional OpenFX transport later.

### Established capabilities

`renderStill()` accepts an explicit frame and a reusable Puppeteer instance. Reusing Chromium avoids browser startup, but the implementation still creates and closes a page per call. [S-REM-STILL] [S-REM-OPEN-BROWSER] [S-REM-STILL-SOURCE]

### Expected profile

- Fidelity and compatibility: equivalent to the official renderer if the public renderer path is retained.
- Cold scrub performance: unknown and likely composition-dependent; T03 must measure it.
- Warm-cache performance: expected to be dominated by cache lookup and image loading, but must be measured in Fusion.
- Native editability: minimal.
- Development risk: medium.

### Critical tests

T03, T04, and T07.

## A3 - Remotion Player inside Resolve OGraf

```text
Remotion project
  -> browser bundle
  -> OGraf Web Component
  -> goToTime(timestamp)
  -> Remotion Player seekTo(frame)
  -> OGrafLoader output
```

### Components

- a bundler that emits a self-contained OGraf-compatible browser package;
- an OGraf lifecycle adapter;
- a Remotion Player host;
- manifest and Inspector property generation;
- asset and font packaging;
- compatibility scanner and fallback to A1.

Blackmagic documents the required Web Component lifecycle, schema-to-control mapping, and `.ograf`/`.drfx` packaging separately. [S-BMD-OGRAF-WEB-COMPONENT] [S-BMD-OGRAF-PROPERTIES] [S-BMD-OGRAF-PACKAGING]

### Established capabilities

Resolve 21's OGraf integration loads a Web Component in CEF, calls `goToTime()` for every frame, captures the browser output, and exposes schema properties as Fusion controls. Resolve requires deterministic non-real-time seeking, including backward and random jumps. [S-BMD-OGRAF-OVERVIEW] [S-BMD-OGRAF-INTEGRATION]

Remotion Player exposes `seekTo(frame)`. This confirms frame control at the React player layer, but does not prove that every Remotion project becomes synchronous or OGraf-compatible. [S-REM-PLAYER]

Blackmagic documents a maximum of 20 dynamic parameters and 10 custom action buttons. OGraf is supported on Windows and macOS, but not Linux; the installed Resolve 21 documentation describes Metal capture on macOS and CPU readback on Windows. [S-BMD-OGRAF-INTEGRATION]

### Expected profile

- User experience: potentially the best, because it behaves as a normal Fusion source.
- Fidelity: unknown until browser, media, font, CSS, and WebGL fixtures are compared.
- Remotion compatibility: potentially broad but lower than the official renderer.
- Native node editability: low; Inspector props are editable, internal layers are not.
- Development risk: medium, concentrated in deterministic lifecycle and asset readiness.

### Critical tests

T02 and T07.

## A4 - Native Remotion-subset compiler

```text
Constrained TSX
  -> Babel or TypeScript AST
  -> controlled static evaluation
  -> scene and animation IR
  -> Fusion compiler
  -> Text+, Transform, Merge, masks, splines
```

### Components

- supported-language specification;
- parser and unsupported-feature diagnostics;
- scene/animation IR;
- Fusion graph compiler;
- frame-math and coordinate conversion layer;
- visual regression suite against official Remotion renders.

### Established capabilities

Babel can parse JSX/TypeScript and traverse its AST; the TypeScript Compiler API can also parse and inspect source. These tools expose program structure, not rendered browser semantics. [S-BABEL-PARSER] [S-BABEL-TRAVERSE] [S-TS-COMPILER]

NetsuRush already exports a real Fusion composition, rewrites its `.comp` representation, and imports it back. This is the appropriate existing backend seam for a future IR compiler. [S-NR-FUSION-APPLY] [S-NR-FUSION-COMP]

### Initial supported candidate subset

- `AbsoluteFill` and explicit layer order;
- an explicit `Text` primitive, not arbitrary HTML text layout;
- `Img` with local deterministic assets;
- `Sequence` timing;
- `interpolate()` and a defined subset of `spring()`;
- translate, scale, rotate, anchor, and opacity;
- explicit rectangle, ellipse, blur, and glow primitives.

### Expected profile

- Native editability and cached playback: highest.
- Universal Remotion compatibility: impossible under this contract.
- Fidelity: high only within the explicitly defined subset.
- Development and maintenance cost: high.

### Critical tests

T05.

## A5 - Explicit hybrid native/rendered composition

```text
Composition manifest
  -> native sections -> IR -> Fusion nodes
  -> rendered sections -> Remotion alpha layers
  -> ordered Fusion merges
```

Automatic partitioning of arbitrary React output is not assumed. Boundaries must be author-declared or emitted by a constrained NetsuFlow component library.

This restriction prevents hidden CSS layout, parent opacity, masks, blend modes, stacking contexts, Canvas, or WebGL state from crossing a guessed native/rendered boundary.

### Expected profile

- Editability: better than pure rendering but limited to native sections.
- Compatibility: preserved through rendered fallback sections.
- Complexity: highest because timing, geometry, alpha, layer order, and invalidation cross both engines.
- Product role: long-term mode only after A1 and at least one live path are stable.

### Critical tests

T06.

## A6 - OpenFX source backed by the Remotion service

```text
Fusion/OpenFX render callback
  -> local IPC or shared memory
  -> persistent Remotion renderer
  -> RGBA buffer
  -> OpenFX output image
```

OpenFX provides native render actions with time, render windows, image buffers, and host concurrency rules. It is technically the strongest substrate for a true custom source, but requires a native plugin per platform and introduces host-process stability risk. [S-OFX-IMAGE] [S-OFX-RENDERING] [S-OFX-THREADING]

### Expected profile

- Host integration and buffer control: highest.
- Fidelity and compatibility: highest when backed by the official renderer.
- Implementation and maintenance cost: highest.
- Product role: escalation path only if OGraf and file-backed adapters fail measured requirements.

### Critical tests

T04 and T07.

## A7 - Remotion import and translation framework

```text
Existing Remotion project
  -> project importer
  -> static and runtime-safe analysis
  -> compatibility report
  -> policy engine
     -> Native compiler when fully proven
     -> OGraf when live-compatible
     -> official Remotion renderer otherwise
```

A7 is a cross-cutting architecture rather than a fourth rendering engine. Its purpose is to let users import existing Remotion code without first rewriting it into a NetsuFlow-specific DSL.

The framework combines:

- project and composition discovery;
- JavaScript/TypeScript/JSX analysis;
- a versioned capability registry;
- the A4 scene/animation IR for safely translatable constructs;
- explicit backend selection;
- source-located compatibility diagnostics;
- a decision manifest that explains why Native, OGraf, or Render was selected.

Babel and the TypeScript Compiler API can provide syntax and symbol information, while Remotion's supported renderer remains the correctness oracle and fallback. [S-BABEL-PARSER] [S-BABEL-TRAVERSE] [S-TS-COMPILER] [S-REM-STILL]

### Version-one policy

Translation is all-or-nothing at composition level:

```text
all required semantics proven native-safe -> A4 native compiler
otherwise live-safe for OGraf             -> A3 OGraf
otherwise                                 -> A1/A2 official renderer
```

An unknown component, dynamic construct, CSS behavior, or dependency can reduce optimization but must not prevent faithful rendering when the official renderer supports the project. Automatic partial native/rendered partitioning remains outside version one because hidden layout and compositing dependencies can cross component boundaries.

### Expected profile

- Existing-project usability: potentially highest.
- Fidelity: preserved by conservative fallback.
- Native editability: available only for fully proven compositions in version one.
- Development cost: high, because compatibility decisions and diagnostics become a maintained product contract.
- Product role: long-term orchestration framework after A1 and at least one optimized backend pass independently.

### Critical tests

T01, T02, T05, T08, and T07.

## Architectures not selected for primary testing

### JavaScript to Python to Lua transpilation

Rejected as a rendering abstraction. Language translation does not define how React reconciliation, DOM layout, CSS painting, Canvas, or WebGL map to Fusion nodes. AST tools remain useful for a constrained semantic compiler. [S-BABEL-PARSER] [S-TS-COMPILER]

### Visual reconstruction by a multimodal model

Retained only as an assistant for graph suggestions. Pixel sequences do not uniquely identify an editable graph, and generated graphs cannot be treated as deterministic without the same regression tests as A4. This path must never replace the official renderer reference.

### Workflow Integration as the renderer

Resolve Workflow Integration plugins are Electron applications that can call Resolve's JavaScript APIs and show an HTML window. They are useful control surfaces, not documented per-frame image tools. NetsuRush already provides the external application UI, so this is not a first-line architecture. [S-BMD-WORKFLOW]
