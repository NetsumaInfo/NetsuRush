# Security, licensing, and packaging

## Threat model

HyperFrames and Remotion projects execute JavaScript and may include build tools,
browser code, assets, network access, native npm dependencies, or expensive
workloads. The OFX plugin parses service output inside Resolve. Both project
execution and renderer responses are untrusted boundaries.

## Default policy

- Require explicit trust before dependency installation or first render.
- Canonicalize and restrict source/asset roots.
- Bind only to loopback and authenticate each service session.
- Cap dimensions, payloads, logs, time, memory, disk, and concurrency.
- Make network access disabled or explicitly declared.
- Run renderer work outside Resolve and preferably outside the main core process.
- Never log tokens, secrets, props contents, or source unnecessarily.
- Do not claim full OS sandboxing without a dedicated implementation and audit.

## Plugin hardening

Continue strict integer-overflow, stride, length, format, revision, protocol,
allocation, ABI exception, and timeout checks. The fake renderer's hostile
matrix remains mandatory for every protocol change. [S-NF-T03]

## HyperFrames

The repository is Apache-2.0. [S-HF-LICENSE] This is favorable for a distributed
product, but does not automatically cover every transitive dependency, bundled
browser, codec, font, fixture, or user project. Generate and ship notices from
the exact lockfile.

Because the engine is pre-1.0 and changing rapidly, pin the exact package,
lockfile, Node, browser/Puppeteer build, and adapter version. [S-HF-PACKAGE]
[S-HF-RELEASE-CHANNELS] Do not depend directly on experimental FrameAdapter
details outside one wrapper. [S-HF-FRAME-ADAPTERS]

## Remotion

Keep the existing Remotion research and a separate adapter policy. Current
documentation requires exact package-version alignment, and its license terms
need a fresh review before product distribution. [S-REM-VERSION-MATCH]
[S-REM-LICENSING] [S-REM-LICENSE-TERMS] Do not let HyperFrames' Apache license
be misread as permission to redistribute Remotion.

## Windows runtime

Ship or provision:

- architecture-correct `.ofx.bundle`;
- Node service and exact HyperFrames production dependencies;
- verified browser binary;
- FFmpeg only if the selected capture/pre-render path needs it;
- runtime manifest, hashes, and notices;
- install/repair/remove metadata;
- bounded cache root and independent cache removal.

NetsuRush packaging tests must be extended for each dependency.
[S-NR-DIST] [S-NR-BUILD] [S-NR-PACKAGING-TEST]

The measured per-user `OFX_PLUGIN_PATH` installation avoids elevation on the
tested Resolve Studio 21 machine. [S-NF-T01] Product support still needs repair,
update, removal, and multi-version testing.

## macOS

No claim before real hardware verifies bundle discovery, arm64/x86_64 strategy,
signing, notarization, hardened-runtime behavior, browser architecture, renderer
shutdown, and Resolve/Fusion output.

## Update safety

- Never replace a loaded OpenFX binary while Resolve is open.
- Stage and checksum runtime updates before activation.
- Preserve protocol compatibility or show a precise mismatch.
- Roll back engine/runtime updates independently from the plugin when possible.
- Remove only recorded NetsuFlow files; cache deletion is a separate visible
  operation.

