# Remotion import and translation framework

## Product intent

The primary user does not begin by learning a new NetsuFlow DSL. They select an existing Remotion project and composition. NetsuFlow analyzes that code, translates only semantics it can prove, and preserves a faithful Remotion-backed output for everything else.

```text
Existing Remotion code
        -> import
        -> analyze
        -> explain compatibility
        -> select Native, OGraf, or Render
        -> create a Fusion-usable result
```

The framework is therefore a conservative import compiler and backend orchestrator. It is not a universal React-to-Fusion transpiler.

## User contract

The importer must answer four questions before creating output:

1. Can the composition be rendered by the supported Remotion renderer?
2. Can it run deterministically through the validated OGraf path?
3. Can every pixel-affecting semantic be represented by the native IR?
4. Which output is recommended, and what editability will the user retain?

The result should be explicit:

```text
Composition: Main
Selected mode: Render
Visual fidelity: Official Remotion renderer
Native editability: None

Native blockers:
- ThreeCanvas at src/Main.tsx:42
- unsupported backdrop-filter at src/Title.tsx:18

Live OGraf blockers:
- asynchronous remote font
```

An optimization failure is not an import failure when the official renderer can still produce the composition.

## Framework layers

### 1. Project importer

Responsibilities:

- validate a trusted project root;
- locate package metadata and candidate Remotion entry points;
- discover compositions and input-prop requirements through supported Remotion APIs;
- fingerprint source, dependencies, local assets, fonts, and configuration;
- refuse implicit package installation or execution outside the approved project root.

Remotion's renderer accepts a bundled project, composition metadata, input props, and an explicit frame. It remains the baseline import/render contract. [S-REM-STILL] [S-REM-MEDIA]

### 2. Static analyzer

Responsibilities:

- parse JavaScript, TypeScript, JSX, and TSX;
- resolve local imports and known Remotion imports;
- detect known components, hooks, animation functions, styles, and assets;
- identify dynamic or unresolved constructs;
- retain source locations for diagnostics.

Babel exposes JavaScript/JSX/TypeScript AST parsing and traversal, while the TypeScript Compiler API can add module, type, and symbol information. [S-BABEL-PARSER] [S-BABEL-TRAVERSE] [S-TS-COMPILER]

Static analysis is evidence about source structure, not proof of rendered semantics. Unknown control flow, external components, runtime data, DOM measurement, CSS layout, Canvas, and WebGL fail closed for native translation.

### 3. Capability registry

Every recognized construct maps to a versioned capability record:

```json
{
  "capability": "remotion.interpolate",
  "native": "supported",
  "ograf": "supported",
  "render": "supported",
  "constraints": {
    "inputRange": "finite numeric array",
    "outputRange": "numeric array",
    "extrapolation": ["clamp", "extend"]
  }
}
```

The registry must distinguish:

- **native-safe**: the construct has a tested IR and Fusion mapping;
- **live-safe**: the construct passed OGraf deterministic-seek and export tests;
- **render-required**: the official renderer is the only validated path;
- **blocked**: the project cannot be safely loaded or rendered under product policy.

Capabilities are tied to tested Remotion, browser, Resolve, and NetsuFlow versions. A version change invalidates assumptions until the regression corpus passes.

### 4. Semantic IR

Only native-safe semantics are lowered into the scene/animation IR defined by A4/T05. The IR represents graphical meaning and timing, not source-language syntax.

Examples:

```text
<Sequence from={10} durationInFrames={30}>
```

becomes a local time interval, while:

```text
interpolate(frame, [0, 30], [-500, 0])
```

becomes a typed animation expression. The framework must never preserve arbitrary JavaScript inside the IR as a shortcut.

### 5. Backend policy engine

Version-one selection is deliberately conservative:

```text
Native requested
  -> select Native only when the entire composition is native-safe
  -> otherwise return diagnostics without generating approximate nodes

Auto requested
  -> Native when the entire composition is native-safe
  -> otherwise OGraf when the entire composition is live-safe
  -> otherwise official Render

Render requested
  -> always use the official renderer when the project is renderable
```

The selected mode and the exact reasons are stored in a decision manifest beside the generated output.

### 6. Backends

- **Native backend**: IR to Fusion tools, splines, masks, and merges through the existing NetsuRush `.comp` path. [S-NR-FUSION-APPLY] [S-NR-FUSION-COMP]
- **OGraf backend**: packaged Web Component using the validated exact-time lifecycle. [S-BMD-OGRAF-OVERVIEW] [S-BMD-OGRAF-INTEGRATION]
- **Render backend**: official Remotion frames/media plus Loader/MediaIn automation. [S-REM-STILL] [S-REM-MEDIA] [S-BMD-SCRIPTING]

## Why version one is composition-level

Existing React components can share layout, inherited styles, masks, opacity, blend modes, stacking contexts, data, and runtime state. An AST match for one child does not prove that the child can be separated without changing pixels.

Therefore version one does not report percentages as permission to partially translate. A compatibility percentage may be shown as diagnostic information, but backend selection is binary at composition level.

Future hybrid translation requires explicit author boundaries or a proven isolation contract. It belongs to A5/T06, not the first importer.

## What the framework is not

- It is not JavaScript-to-Python or JavaScript-to-Lua transpilation.
- It is not a browser engine implemented in Fusion nodes.
- It is not a promise that arbitrary npm components become editable.
- It is not a visual approximation system that silently accepts differences.
- It is not a requirement that users rewrite their project before Render mode works.

## Proposed internal outputs

Each analysis produces:

```text
analysis.json          normalized findings and source locations
capabilities.json      versioned capability decisions
decision.json          selected backend and reasons
composition.ir.json    only when fully native-safe
artifacts/              OGraf package, frames, or generated Fusion data
```

The formats are internal until T08 proves that their boundaries remain stable across the fixture corpus.

## Success criteria

The framework is worth building when:

- existing supported Remotion projects import without source rewrites;
- the same project always receives the same classification under the same version set;
- no native false positive occurs in the accepted corpus;
- diagnostics identify the source construct that prevented optimization;
- Render mode remains faithful even when Native and OGraf are unavailable;
- users understand the selected mode and resulting editability before conversion;
- adding a backend does not require redesigning the importer or IR.

## Development order

1. Complete T01 and retain the official renderer as oracle.
2. Complete T02 and record live-safe capabilities.
3. Complete the smallest T05 native IR slice.
4. Run T08 as an analysis-only framework prototype.
5. Connect T08 to proven backends without adding automatic hybrid partitioning.
6. Run T07 before treating framework decisions as shippable product behavior.
