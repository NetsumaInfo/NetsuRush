# HyperFrames architecture options

## Decision frame

The goal is not merely to “run HyperFrames.” It is to expose its visual result
as a dependable Fusion source while preserving a future Remotion adapter.

| Option | How it works | Fidelity | Fusion editability | Interactive potential | Development complexity | Product outlook |
|---|---|---:|---:|---:|---:|---|
| 1. Full pre-render | HyperFrames renders PNG sequence or alpha media; Fusion loads artifact | Very high | Low after source | Excellent after render | Low | Strong fallback/MVP |
| 2. Requested-frame service | Persistent session captures only Fusion's requested frame; common cache returns RGBA | Very high | Node-level only | Medium/high if warm/cache succeeds | Medium | Best core direction |
| 3. Native-node translation | Parse project and create Text+/Transform/Merge graph | Low to high only for subset | Very high | Native after compile | Very high | Separate constrained product |
| 4. Operational hybrid | Same source node chooses live/cache/pre-render, pixels always from HyperFrames | Very high | Node-level only | Best practical UX | Medium/high | Best product baseline |
| 5. Native/render hybrid | Translate simple layers, rasterize complex layers | Mixed; compositing edge cases | Partial | Uncertain | Extreme | Research only |
| 6. Portable metadata/IR | Describe controls/timing/assets; original engine still renders pixels | Engine fidelity | Better controls, not native graph | Same as selected engine | Medium | Valuable later common layer |

HyperFrames documents both low-level frame capture and finished alpha-capable
rendering, which makes options 1, 2, and 4 directly grounded in supported
concepts. [S-HF-ENGINE-DOC] [S-HF-RENDERING]

## Option 1: Full pre-render

```text
HyperFrames project -> render -> PNG sequence / alpha media -> Fusion source
```

Required components: project runner, output manifest, progress/cancel, artifact
cache, Media Pool/Loader import, invalidation, cleanup. It is easiest to
prototype and provides smooth playback, deterministic delivery, and possible
audio in the imported artifact. It does not feel fully live and pays upfront
render/storage cost.

## Option 2: Requested-frame service

```text
Fusion frame 137 -> persistent HyperFrames session -> PNG buffer -> RGBA -> OFX
```

Required components: current OpenFX/bridge, binding registry, HyperFrames
adapter, session manager, PNG decoder, cache, scheduler, deadlines. This is
technically possible because the engine exposes seekable capture sessions and
in-memory frame capture. [S-HF-FRAME-CAPTURE-SOURCE] Its product quality remains
conditional on H01-H03 measurements.

## Option 3: Native-node translation

This would parse HTML/JS/animation semantics and emit Text+, Transform, masks,
keyframes, and Merge nodes. It cannot preserve arbitrary DOM/CSS/Canvas/WebGL or
library behavior. It is viable only for an explicitly designed subset and
belongs to a separate compiler/framework effort.

## Option 4: Operational hybrid

```text
one binding
  -> memory/disk hit: immediate
  -> simple miss: live capture
  -> expensive/idle/final: background pre-render
```

All paths use HyperFrames as the visual authority. Unlike native/render hybrid,
there is no layer decomposition or compositing ambiguity. Auto changes where the
same intended pixels come from, not their meaning.

## Option 5: Native/render hybrid

This combines editable native primitives with rasterized complex layers. It
requires semantic scene extraction, stable layer boundaries, coordinate/color/
alpha agreement, effect ordering, and fallback composition. It may be valuable
research later, but it is not needed for “code in, visual result out.”

## Option 6: Portable metadata/IR

A small IR can represent composition descriptors, typed props, timing ranges,
assets, determinism, and engine capability requirements. It improves UI,
validation, migration, and testing without claiming to reproduce browser
rendering. See [`../../11-framework-and-portable-ir.md`](../../11-framework-and-portable-ir.md).

## Answers A-E

- **A — easiest prototype:** full PNG-sequence pre-render.
- **B — best user experience:** operational hybrid, presented as one normal
  source with Live/Auto/Pre-render.
- **C — most technically elegant:** engine-neutral requested-frame contract plus
  isolated adapters; a portable metadata IR can sit above it later.
- **D — most realistic product:** operational hybrid using the existing OpenFX
  bridge, persistent HyperFrames sessions, shared cache, and pre-render fallback.
- **E — best HyperFrames compatibility:** direct HyperFrames rendering, whether
  live or pre-rendered; native translation cannot match it universally.

These selections can change only from measured tests, not preference.

