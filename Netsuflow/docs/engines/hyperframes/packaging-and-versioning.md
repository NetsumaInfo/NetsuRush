# HyperFrames packaging and versioning

## Baseline pin

The prototype is pinned to `@hyperframes/engine` 0.8.27 (upgraded from 0.8.16
on 2026-09-03: +2 root exports, 0 removals, pixel-identical references).
The research snapshot found `@hyperframes/engine` 0.8.16 and Node `>=22` in
the npm registry on 2026-08-27. Never use `latest` in a product build. Pin:

- exact HyperFrames package version;
- package lockfile;
- Node build;
- Puppeteer/browser build;
- FFmpeg build if used;
- adapter and protocol versions.

The official manifest and release-channel documentation are the authority for
each upgrade. [S-HF-PACKAGE] [S-HF-RELEASE-CHANNELS]

## Upgrade gate

For every version change:

1. review engine exports/types/source changes;
2. regenerate notices;
3. run adapter unit/conformance tests;
4. render the complete golden fixture set;
5. compare random-frame performance and memory;
6. test worker crash/restart;
7. stage/package/repair/uninstall;
8. record the exact revisions in a dated report.

## Browser reproducibility

Exact pixels can change with Chrome, fonts, codecs, GPU, and OS. Keep one
verified browser build per supported application release and record installed
fonts/media dependencies. [S-HF-ENGINE-DOC]

## Runtime delivery

Prefer an application-owned verified runtime rather than the user's global Node
or browser. Render must work offline after installation/repair. If first-run
provisioning downloads a browser, verify size/hash/signature and expose progress;
never download during an OFX render callback.

## Licensing

HyperFrames' repository license is Apache-2.0. [S-HF-LICENSE] Preserve its notice
and audit the resolved production dependency graph. The npm package's missing
license metadata in the 2026-08-27 query is a packaging-audit warning, not
evidence that the repository lacks a license.

