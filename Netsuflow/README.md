# NetsuFlow: web motion engines inside Fusion

NetsuFlow is an R&D project for using a web-motion composition as a normal image
source inside DaVinci Resolve/Fusion. HyperFrames is the first renderer engine.
Remotion is preserved as a second engine behind the same bridge contract.

```text
HyperFrames project                         Remotion project (later)
         |                                           |
         +--------------- binding -------------------+
                             |
                             v
                 NetsuRush renderer service
          engine registry + sessions + cache + pixels
                             |
                             v
                 NetsuFlow OpenFX Generator
                             |
                             v
                    Fusion image output
```

The OpenFX plugin never interprets HyperFrames or Remotion code. It requests a
frame for an opaque binding and validates/copies the returned RGBA pixels. The
Node service resolves the binding to an engine adapter. This boundary lets a
future Remotion adapter reuse the current plugin, protocol, scheduler, cache,
diagnostics, and NetsuRush lifecycle.

## Current status

The OpenFX Generator builds, loads in Resolve Studio 21, and renders frames from
the real pinned HyperFrames engine through the authenticated loopback bridge.
The renderer, random/reverse frame access, alpha path, cache/scrubbing soak,
editor handoff, declared-variable controls, and several export paths have dated
evidence. Remaining product gates include Inspector lifecycle restoration,
Fusion element interaction, packaging, recovery, and supported-platform claims.
See [`STATUS.md`](STATUS.md) and [`tests/results/`](tests/results/).

## Documentation map

- [`SOURCES.md`](SOURCES.md): canonical source and local-evidence registry.
- [`docs/00-product-scope.md`](docs/00-product-scope.md): product promise and non-goals.
- [`docs/01-feasibility.md`](docs/01-feasibility.md): confirmed capabilities and unknowns.
- [`docs/02-system-architecture.md`](docs/02-system-architecture.md): engine-neutral process architecture.
- [`docs/03-openfx-generator.md`](docs/03-openfx-generator.md): host-side plugin contract.
- [`docs/04-engine-contract.md`](docs/04-engine-contract.md): renderer adapter and binding contract.
- [`docs/05-bridge-protocol-and-cache.md`](docs/05-bridge-protocol-and-cache.md): wire protocol, scheduling, and cache.
- [`docs/06-netsurush-tauri-integration.md`](docs/06-netsurush-tauri-integration.md): application lifecycle and packaging.
- [`docs/07-user-experience.md`](docs/07-user-experience.md): engine selection and node workflow.
- [`docs/08-color-time-and-alpha.md`](docs/08-color-time-and-alpha.md): cross-engine pixel contract.
- [`docs/09-security-licensing-and-packaging.md`](docs/09-security-licensing-and-packaging.md): product constraints.
- [`docs/10-risk-register.md`](docs/10-risk-register.md): risks and stop conditions.
- [`docs/11-framework-and-portable-ir.md`](docs/11-framework-and-portable-ir.md): staged framework/IR option.
- [`docs/12-fusion-parameter-binding.md`](docs/12-fusion-parameter-binding.md): native Fusion controls, keyframes, and HyperFrames variable mapping.
- [`docs/13-fusion-element-selection-and-contextual-controls.md`](docs/13-fusion-element-selection-and-contextual-controls.md): viewer selection, exhaustive control surface, contextual properties, stable native promotion, and Fusion evidence tests.
- [`docs/engines/`](docs/engines/README.md): HyperFrames and Remotion-specific designs.
- [`studio/`](studio/README.md): future custom NetsuFlow Studio editor, Resolve Media Pool/timeline workflows, redesigned AI agent research, tests, and implementation gates.
- [`docs/engines/hyperframes/architecture-options.md`](docs/engines/hyperframes/architecture-options.md): six implementation architectures and A-E conclusions.
- [`docs/engines/interoperability/engine-switching.md`](docs/engines/interoperability/engine-switching.md): how one node supports both engines.
- [`docs/engines/interoperability/remotion-to-hyperframes.md`](docs/engines/interoperability/remotion-to-hyperframes.md): optional migration path and its limits.
- [`research/`](research/README.md): unresolved questions and closure tests.
- [`tests/`](tests/README.md): ordered common, engine-specific, and cross-engine experiments.
- [`roadmap.md`](roadmap.md): evidence-gated delivery sequence.
- [`plans/2026-08-27-hyperframes-renderer-adapter-implementation.md`](plans/2026-08-27-hyperframes-renderer-adapter-implementation.md): executable HyperFrames prototype plan.
- [`plans/2026-08-27-engine-neutral-netsurush-integration.md`](plans/2026-08-27-engine-neutral-netsurush-integration.md): later application integration plan.
- [`plans/2026-08-27-fusion-parameter-binding-implementation.md`](plans/2026-08-27-fusion-parameter-binding-implementation.md): fixed OpenFX control bank and frame-value bridge plan.
- [`tests/T11-fusion-element-overlay.md`](tests/T11-fusion-element-overlay.md): Resolve host gate for viewer selection, contextual edits, and stable native promotion.

## Existing implementation

- [`openfx/`](openfx/README.md): OpenFX Generator, bridge client, protocol, and native tests.
- [`prototypes/fake-renderer/`](prototypes/fake-renderer/): deterministic contract server and fault injection.
- [`tests/results/`](tests/results/): dated runtime evidence that must remain historical.

The plugin identifier `com.netsurush.netsuflow.generator` is engine-neutral and
must remain stable: Resolve projects store the identifier, not the visible name,
so renaming the label is safe and renaming the identifier would orphan every
node already placed in a timeline.

The visible label was `NetsuFlow Remotion (Experimental)` and is now
`NetsuFlow (Experimental)`. It named an engine the node does not know about: the
node resolves an opaque binding and copies back validated pixels, and which
engine produced them is decided service-side. A test in the prototype suite now
fails if any engine name reappears in `openfx/src/`.

## Explicit non-goals for the first product

- Universal HyperFrames/Remotion-to-Fusion-node translation.
- JavaScript-to-Python or JavaScript-to-Lua transpilation.
- Reimplementing browser layout inside Fusion.
- Making Remotion-to-HyperFrames conversion a correctness dependency.
- Shipping a public motion framework before the frame bridge is validated.

The earlier broad Remotion/native-translation investigation remains preserved in
[`archive/2026-08-26-pre-openfx-direction/`](archive/2026-08-26-pre-openfx-direction/).
