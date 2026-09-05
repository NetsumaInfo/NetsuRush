# System architecture

## Chosen boundary

Resolve contains only a small engine-neutral OpenFX Generator. User JavaScript,
HyperFrames, future Remotion packages, browsers, source watching, sessions, and
large caches remain in external processes owned by NetsuRush.

```text
DaVinci Resolve / Fusion
+----------------------------------------------+
| NetsuFlow OpenFX Generator                   |
| binding + time mapping + bounded IPC + copy  |
+----------------------+-----------------------+
                       | versioned loopback protocol
NetsuRush              |
+----------------------v-----------------------+
| Rust/Tauri lifecycle owner                   |
| Node core                                    |
|   BindingRegistry                            |
|   EngineRegistry                             |
|     hyperframes -> HyperFramesEngine          |
|     remotion    -> RemotionEngine (later)     |
|   SessionManager + Scheduler                 |
|   PixelNormalizer + memory/disk cache        |
|   Bridge server + diagnostics                |
+----------------------------------------------+
```

This follows NetsuRush's existing thin Tauri shell and persistent Node core
model. [S-NR-ARCH] [S-NR-RUST-CORE]

## Stable common components

### OpenFX plugin

- Sends an opaque binding and frame request.
- Maps host time, dimensions, scale, quality, format, and deadline.
- Validates response metadata and payload before copying pixels.
- Knows neither HyperFrames nor Remotion.
- Retains a diagnostic/last-good path when the service is unavailable.
- Keeps `com.netsurush.netsuflow.generator` stable. [S-NF-OPENFX]

### Binding registry

A binding is immutable by revision:

```ts
type RendererBinding = {
  id: string;
  engine: 'hyperframes' | 'remotion';
  projectRoot: string;
  entryPoint: string;
  compositionId: string;
  normalizedProps: unknown;
  propsRevision: string;
  sourceRevision: string;
  engineConfig: Record<string, unknown>;
};
```

Only the service reads `engine`. The plugin sends `binding`, so adding an
engine does not require changing Resolve compositions.

### Engine registry and adapters

The registry maps a binding engine ID to one adapter implementing the common
contract in [`04-engine-contract.md`](04-engine-contract.md). Engine adapters
own only discovery, session setup, engine-specific seeking, and raw capture.
They do not own the wire protocol, host behavior, global cache, or UI RPC.

### Common session manager

- Deduplicates equivalent sessions.
- Tracks leases from interactive and final requests.
- Enforces bounded concurrency and memory.
- Invalidates sessions on source, props, engine, browser, or configuration
  revision changes.
- Shuts down browser/page resources deterministically.

### Pixel normalizer

Every engine produces the same internal result:

```text
RGBA8 | tightly packed | straight alpha | declared browser source space
```

HyperFrames initially reaches it through PNG decode. Remotion may do the same.
A raw path is an optimization behind the same interface.

## Process isolation

The earliest adapter prototype may run in its own Node process beside the fake
renderer. Product integration should supervise renderer workers separately from
the main core RPC so a browser crash does not terminate the rest of NetsuRush.

## Discovery and failure boundary

The current atomic session descriptor and authenticated loopback connection stay
unchanged. [S-NF-BRIDGE] [S-NF-PROTOCOL] No renderer failure may crash Resolve
or block indefinitely. Deadlines, response limits, cancellation, reconnection,
and diagnostic output are common infrastructure, not engine responsibilities.

## Compatibility rule

Never branch on an engine inside the OpenFX plugin. If a new engine requires a
new host field, first ask whether it can be stored in the binding or negotiated
as a service capability. Wire changes require a versioned protocol addition and
must remain backwards-detectable.

