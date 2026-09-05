# NetsuFlow Studio

NetsuFlow Studio is the planned custom authoring workspace for web-motion
projects inside NetsuRush. It will use HyperFrames first, reuse the existing
NetsuFlow OpenFX bridge, and later add Remotion behind the same application
contracts.

This directory is intentionally separate from the current OpenFX proof. The
OpenFX renderer integration remains the immediate delivery target. Studio work
starts only after the HyperFrames frame bridge, cache, parameters, and packaging
gates are proven.

## Product boundary

Studio is not an embedded copy of HyperFrames Studio. NetsuRush owns the shell,
layout, interaction model, Resolve integration, project lifecycle, and AI
experience. HyperFrames supplies editing, preview, timeline, and rendering
building blocks where they survive explicit compatibility tests.

```text
NetsuRush custom UI
  -> common editor domain
     -> HyperFrames editor adapter (first)
     -> Remotion editor adapter (later)
  -> Resolve Media Pool bridge
  -> Resolve publish coordinator
  -> redesigned AI change-set agent
  -> existing NetsuFlow binding / OpenFX renderer
```

## Documentation map

- [`SOURCES.md`](SOURCES.md): evidence registry for this feature.
- [`docs/00-product-scope.md`](docs/00-product-scope.md): promise, users, and non-goals.
- [`docs/01-feasibility.md`](docs/01-feasibility.md): confirmed capabilities and unknowns.
- [`docs/02-editor-user-experience.md`](docs/02-editor-user-experience.md): custom interface and workflows.
- [`docs/03-system-architecture.md`](docs/03-system-architecture.md): process and domain architecture.
- [`docs/04-hyperframes-editor-adapter.md`](docs/04-hyperframes-editor-adapter.md): SDK, Player, Studio component, and server boundaries.
- [`docs/05-resolve-media-pool-bridge.md`](docs/05-resolve-media-pool-bridge.md): media discovery and asset references.
- [`docs/06-resolve-timeline-publishing.md`](docs/06-resolve-timeline-publishing.md): live OpenFX and flattened render delivery.
- [`docs/07-ai-agent-redesign.md`](docs/07-ai-agent-redesign.md): replacement agent concept and safety model.
- [`docs/08-cross-engine-remotion.md`](docs/08-cross-engine-remotion.md): shared editor contracts and later Remotion support.
- [`docs/09-security-licensing-packaging.md`](docs/09-security-licensing-packaging.md): trust, distribution, and dependency rules.
- [`docs/10-risk-register.md`](docs/10-risk-register.md): risks, mitigations, and stop conditions.
- [`docs/11-architecture-options.md`](docs/11-architecture-options.md): complete Studio, selective components, SDK-only, and IR-first comparison.
- [`docs/12-selection-inspector-and-ai-editing.md`](docs/12-selection-inspector-and-ai-editing.md): shared element selection, manual Inspector, AI context attachments, and Fusion handoff.
- [`research/`](research/README.md): questions that require code or host evidence.
- [`tests/`](tests/README.md): ordered decision experiments.
- [`plans/00-evidence-roadmap.md`](plans/00-evidence-roadmap.md): phase gates from the current extension to Studio.
- [`plans/2026-08-27-studio-foundation-implementation.md`](plans/2026-08-27-studio-foundation-implementation.md): executable plan for the first Studio foundation after the gates pass.

## Decision summary

1. Finish the HyperFrames OpenFX extension first.
2. Build a NetsuRush-native Studio shell, not an iframe containing `StudioApp`.
3. Treat `@hyperframes/sdk` and `@hyperframes/player` as the preferred base.
4. Adopt `@hyperframes/studio` components individually behind wrappers after
   T01 proves compatibility, theming, and interaction behavior.
5. Keep project source engine-specific. Share assets, preview controls, publish
   targets, parameters, history, and agent operations through common contracts.
6. Replace the current general-purpose agent experience for this module with a
   staged, previewable change-set workflow. Existing agent code is reference
   material, not an accepted product foundation.
7. Use one stable selection/property/change-set model across Studio, the
   lightweight editor, and Fusion; keep simple edits fully manual and local.
