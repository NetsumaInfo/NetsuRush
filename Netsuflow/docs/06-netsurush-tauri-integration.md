# NetsuRush and Tauri integration

## Fit

NetsuRush remains a standalone Tauri application that drives Resolve externally.
NetsuFlow extends its Rust-owned lifecycle and persistent Node core rather than
turning the whole application into a host plugin. [S-NR-ARCH]

## Ownership

### Rust shell

- Start and stop the existing core and supervised renderer workers.
- Supply packaged runtime paths.
- Install, repair, report, and remove the OpenFX bundle.
- Own session-descriptor lifecycle.
- Never implement engine-specific rendering.

### Node core

- Own the binding and engine registries.
- Discover compositions and validate props through the selected adapter.
- Watch projects, calculate revisions, supervise sessions, schedule frames, and
  own caches.
- Expose application RPC and the separate hardened OFX bridge.

### Renderer workers

- Run trusted HyperFrames or future Remotion project code.
- Own browsers/pages and engine-specific lifecycle.
- Return encoded frames plus diagnostics to the common service.
- Be restartable without terminating core RPC.

## Proposed generic application RPC

Every new channel must be added to `core/rpc.js`, `src/lib/coreClient.ts`,
and `src/lib/bridge.ts`.

```text
webMotion.status
webMotion.listEngines
webMotion.probeEngine
webMotion.registerProject
webMotion.unregisterProject
webMotion.listProjects
webMotion.listCompositions
webMotion.createBinding
webMotion.updateBinding
webMotion.validateProps
webMotion.invalidate
webMotion.clearCache
webMotion.getDiagnostics

openfx.status
openfx.install
openfx.repair
openfx.remove
```

Engine-specific details belong inside request payloads or adapter diagnostics,
not in RPC names such as `hyperframes.renderFrame`.

## Runtime layout

Proposed product resources:

```text
resources/netsuflow/
  service/
  engines/
    hyperframes/
      runtime manifest
      pinned production dependencies
    remotion/
      adapter host only (later)
  browser/
    exact verified build or provision manifest
  openfx/
    NetsuFlow.ofx.bundle/
  licenses/
```

HyperFrames currently requires Node 22+ and browser-management dependencies.
[S-HF-PACKAGE] Rendering must never trigger an unexpected network download.
Packaging or first-run repair provisions an exact browser build and verifies its
checksum.

The future Remotion adapter follows its own rule: load matching Remotion
packages from the registered project unless a later licensing review approves a
different distribution. [S-REM-VERSION-MATCH] [S-REM-LICENSE-TERMS]

## Binding persistence

NetsuRush stores project path, engine, entry point, composition, normalized
props, revisions, and engine configuration. The OFX instance stores only the
binding ID and host-specific overrides. Switching engines updates or replaces
the binding; the Resolve node remains the same.

## Version manifest

Every supported runtime records:

- NetsuFlow service and adapter version;
- exact HyperFrames or supported Remotion range;
- Node and browser build;
- lockfile/checksum;
- protocol range;
- platform/architecture;
- third-party notice inventory.

## Restart semantics

Core, worker, or packaging changes require a Tauri restart before runtime
validation. OpenFX binary changes require Resolve to close before replacement
and restart before discovery. UI status must distinguish installed, staged,
running, and actually host-loaded versions.

