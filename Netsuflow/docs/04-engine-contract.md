# Renderer engine contract

## Purpose

This contract prevents HyperFrames-first implementation from becoming a
HyperFrames-only architecture. It is internal to the Node renderer service; the
OpenFX protocol remains binding-based.

## Core types

```ts
type EngineId = 'fake' | 'hyperframes' | 'remotion';

type ControlDescriptor = {
  id: string;
  valueType: 'double' | 'integer' | 'boolean' | 'color' | 'choice' | 'point2d' | 'string';
  label: string;
  defaultValue: unknown;
  animatable: boolean;
  constraints: Readonly<Record<string, unknown>>;
};

type EngineCapabilities = {
  engine: EngineId;
  adapterVersion: string;
  engineVersion: string;
  supportsRandomFrames: boolean;
  supportsAlpha: boolean;
  supportsPreRender: boolean;
  supportsAudioPreRender: boolean;
  captureFormats: readonly string[];
};

type BindingSnapshot = {
  id: string;
  engine: EngineId;
  projectRoot: string;
  entryPoint: string;
  compositionId: string;
  normalizedProps: unknown;
  propsRevision: string;
  controlSchemaRevision: string;
  controlSchema: readonly ControlDescriptor[];
  sourceRevision: string;
  engineConfig: Readonly<Record<string, unknown>>;
};

type CompositionDescriptor = {
  id: string;
  width: number;
  height: number;
  fpsNumerator: number;
  fpsDenominator: number;
  durationFrames: number;
  defaultProps?: unknown;
};

type NormalizedFrameRequest = {
  frame: number;
  width: number;
  height: number;
  renderScalePpm: number;
  quality: 'preview' | 'final';
  controlValues: Readonly<Record<string, unknown>>;
  controlValuesHash: string;
  deadlineMs: number;
  signal: AbortSignal;
};

type EngineFrame = {
  width: number;
  height: number;
  stride: number;
  pixelFormat: 'RGBA8';
  alphaMode: 'straight';
  pixels: Uint8Array;
  timings: Record<string, number>;
  diagnostics: readonly string[];
};
```

Use runtime validation at every external boundary. These definitions describe
the intended semantics, not permission to trust TypeScript types at runtime.

## Adapter interface

```ts
interface RendererEngine {
  probe(): Promise<EngineCapabilities>;
  open(binding: BindingSnapshot): Promise<EngineSession>;
}

interface EngineSession {
  describe(): Promise<CompositionDescriptor>;
  renderFrame(request: NormalizedFrameRequest): Promise<EngineFrame>;
  invalidate(next: BindingSnapshot): Promise<void>;
  close(): Promise<void>;
}
```

A production implementation may split encoded capture from pixel normalization:

```text
EngineSession.capture(request) -> EncodedFrame
PixelNormalizer.decode(encoded) -> EngineFrame
```

This keeps PNG decoding, alpha normalization, size validation, and memory
accounting common when both engines return PNG.

## Mandatory behavior

Every adapter must:

- reject unsupported engine/project versions before rendering;
- initialize once per session and support arbitrary request order;
- make repeated requests for the same binding revision/frame idempotent;
- honor abort/deadline signals or return a bounded timeout;
- return exact descriptor metadata;
- avoid hidden global process state where possible;
- close browser/page/server/media resources deterministically;
- surface structured error codes without leaking secrets;
- expose exact engine, adapter, Node, and browser fingerprints.

HyperFrames' documented frame-adapter lifecycle also requires initialization,
arbitrary seek, idempotent seek, and destruction. [S-HF-FRAME-ADAPTERS]

## Binding and revision rules

A binding snapshot is immutable. Any change to project source, dependencies,
assets, fonts, composition, normalized props, engine configuration, adapter,
engine package, or browser build creates a revision that cannot share stale
frames.

Fusion instance controls are evaluated per requested frame and do not create a
new binding revision for every keyframe. Their immutable schema revision and
canonical effective-values hash travel with the normalized request and enter
every cache key. See [`12-fusion-parameter-binding.md`](12-fusion-parameter-binding.md).

The plugin does not need the full snapshot. It sends a binding plus its known
revision. The service resolves the latest immutable snapshot and returns the
resolved revision. A mismatch invalidates the plugin last-frame entry.

## Session identity

Sessions may be reused only when all setup-affecting fields match:

```text
engine + adapter + engine package + browser build
+ project revision + entry point + composition
+ props revision + viewport/capture mode
```

Frame number and quality usually belong to the request, not session identity,
unless an engine proves otherwise.

## Error taxonomy

| Code family | Meaning |
|---|---|
| `BINDING_*` | Missing, stale, or invalid binding |
| `ENGINE_*` | Adapter unavailable or unsupported version |
| `PROJECT_*` | Untrusted, dependency, source, or asset failure |
| `COMPOSITION_*` | Missing/invalid descriptor |
| `SESSION_*` | Initialization, crash, exhaustion, or close failure |
| `FRAME_*` | Seek, capture, timeout, cancellation, or decode failure |
| `PIXEL_*` | Dimensions, format, alpha, stride, or size invalid |
| `CACHE_*` | Corrupt entry or storage failure |
| `PROTOCOL_*` | Authentication, version, framing, or payload violation |

The OFX layer only needs stable code, retryability, safe message, and diagnostic
frame policy. Engine-specific stack traces remain in NetsuRush logs.

## Conformance suite

The fake engine, HyperFrames, and future Remotion adapters must all pass:

- probe and descriptor validation;
- first, repeated, sequential, reverse, and random frame requests;
- identical-frame idempotence;
- props/source revision invalidation;
- cancellation and deadline;
- session crash and restart;
- exact close with no leaked sessions;
- RGBA/alpha/dimension validation;
- bounded parallel requests;
- error normalization.

No engine becomes selectable in production until this suite and its
engine-specific visual tests pass.
