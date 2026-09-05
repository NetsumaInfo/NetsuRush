# NetsuFlow - Remotion inside Fusion research

NetsuFlow is the research workspace for integrating Remotion with DaVinci Resolve and Fusion from the NetsuRush desktop application.

This directory is deliberately documentation-first. It does not select a production architecture and does not yet contain a shipping implementation. The research program must establish what Resolve, Fusion, Remotion, and the packaged NetsuRush runtime can actually support before product code is added.

## Research question

Can NetsuRush expose a Remotion composition as a practical Fusion source while preserving as much of the following as possible?

- Remotion visual fidelity and project compatibility;
- responsive timeline seeking and reliable final export;
- alpha, frame-rate, duration, color, and asset correctness;
- a simple Resolve/Fusion user experience;
- Windows and macOS packaging inside the Tauri application;
- optional native Fusion editability where it is technically honest.

## Current candidate order

The order below is a test order, not a final product decision.

1. Establish an official Remotion PNG/alpha render as the fidelity baseline.
2. Test Resolve 21 OGraf as the shortest path to a live HTML/React source.
3. Benchmark a persistent Remotion renderer with individual-frame caching.
4. Test Fusion host adapters: scripting, Loader, Fuse, and OpenFX.
5. Test a deliberately small native Remotion-to-Fusion compiler.
6. Test a Remotion import framework that classifies existing code and selects a safe backend.
7. Test hybrid composition only at explicit native/rendered boundaries.
8. Validate clean-install packaging, security, licensing, and cross-platform behavior.

The reliable product fallback is expected to use the official Remotion renderer. OGraf is the leading live-mode hypothesis, not a confirmed replacement for Remotion rendering. [S-REM-STILL] [S-BMD-OGRAF-INTEGRATION]

## Documentation map

- [Research scope and evidence policy](research/00-scope-and-evidence.md)
- [Architecture candidates](research/01-architecture-candidates.md)
- [Remotion issue #10235 and adjacent ecosystem signals](research/02-ecosystem-signals.md)
- [NetsuRush and Tauri integration](research/03-netsurush-integration.md)
- [Risk register](research/04-risk-register.md)
- [Remotion import and translation framework](research/05-remotion-import-framework.md)
- [Test program and shared fixtures](tests/README.md)
- [T01 - Official renderer baseline](tests/T01-official-renderer-baseline.md)
- [T02 - OGraf live runtime](tests/T02-ograf-live-runtime.md)
- [T03 - Persistent frame service](tests/T03-persistent-frame-service.md)
- [T04 - Fusion host adapters](tests/T04-fusion-host-adapters.md)
- [T05 - Native IR compiler](tests/T05-native-ir-compiler.md)
- [T06 - Explicit hybrid composition](tests/T06-explicit-hybrid-composition.md)
- [T07 - Packaged product validation](tests/T07-packaged-product-validation.md)
- [T08 - Remotion import framework](tests/T08-remotion-import-framework.md)
- [Decision framework](decision/decision-framework.md)
- [Source registry](SOURCES.md)

## Status language

Every conclusion must use one of these labels:

- **Verified**: reproduced locally and backed by a stored test artifact.
- **Documented**: stated by a primary source but not yet reproduced locally.
- **Observed**: measured locally without sufficient repetitions for a stable conclusion.
- **Hypothesis**: plausible design direction requiring a named test.
- **Rejected**: failed a defined gate, with retained evidence.

No runtime path is considered supported merely because it builds or because an API exists.

## Immediate decision gates

No architecture is selected until T01, T02, T03, and T04 have evidence.

- If OGraf passes fidelity, deterministic seeking, export, and packaging gates, it becomes the preferred live path.
- If OGraf fails but cached individual-frame rendering is usable, the persistent renderer becomes the live/update path.
- If neither is usable, NetsuFlow remains an automated render-and-import workflow.
- Native compilation and hybrid composition remain optional product layers; they are not allowed to block the faithful renderer path.
- The import framework may coordinate Native, OGraf, and Render modes, but it may never report an unsafe translation as native-compatible.

All source identifiers used in this directory resolve through [SOURCES.md](SOURCES.md).
