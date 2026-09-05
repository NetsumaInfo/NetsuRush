# Risk register

| ID | Risk | Evidence or basis | Test | Containment |
|---|---|---|---|---|
| R01 | OGraf cannot host the required Remotion/React bundle reliably | OGraf provides CEF and exact-time callbacks, but does not document Remotion compatibility. [S-BMD-OGRAF-INTEGRATION] | T02 | Keep A1 as mandatory fallback |
| R02 | `goToTime()` returns before React/media/fonts reach the requested frame | Resolve requires deterministic exact-time output and disallows asynchronous work in the seek path. [S-BMD-OGRAF-INTEGRATION] | T02 | Preload assets; reject incompatible projects; render fallback |
| R03 | Windows OGraf playback is too slow | Blackmagic documents CPU readback on Windows and Metal acceleration on macOS. [S-BMD-OGRAF-INTEGRATION] | T02, T07 | Preview scaling; cached renderer; platform-specific mode ranking |
| R04 | Public `renderStill()` is too slow for cold scrubbing | Browser reuse is supported, but the implementation creates a new page per call. [S-REM-OPEN-BROWSER] [S-REM-STILL-SOURCE] | T03 | Persistent Player/page experiment; prefetch; render-on-update |
| R05 | A custom persistent-page renderer diverges from official Remotion readiness semantics | It would bypass part of the supported renderer lifecycle. [S-REM-STILL-SOURCE] | T03 | Keep public renderer as correctness oracle and final mode |
| R06 | Fusion requests frames concurrently or out of order | OGraf documentation explicitly requires backward and random exact-time seeking; OpenFX hosts may render concurrently. [S-BMD-OGRAF-INTEGRATION] [S-OFX-THREADING] | T02, T03, T04 | Immutable cache keys; bounded concurrency; request deduplication |
| R07 | Frame mapping is off by one or drifts at mismatched FPS | Remotion uses explicit frame numbers; OGraf receives timeline timestamps and Resolve determines seek granularity from timeline rate. [S-REM-STILL] [S-BMD-OGRAF-INTEGRATION] | T01, T02 | Require matching FPS in MVP; store explicit mapping policy |
| R08 | Alpha or color differs after Fusion import | OGraf documents RCM behavior; browser render and Loader paths still need comparison. [S-BMD-OGRAF-INTEGRATION] [S-REM-ALPHA] | T01, T02, T04 | Reference composites; straight/premult tests; documented color contract |
| R09 | Audio expectations cannot be met by an image source | The evaluated Fusion paths are image-generation paths. | T01, T04 | Explicit image-only node; optional separate audio render/import |
| R10 | Fuse blocks or destabilizes Fusion while waiting for external rendering | Fuse has a per-frame `Process(req)` image path, but the SDK does not establish external async transport behavior. [S-BMD-FUSE] | T04 | File-backed cache only until proven; escalate to OpenFX if necessary |
| R11 | OpenFX increases crash and maintenance risk | OpenFX runs native render code under host scheduling and threading contracts. [S-OFX-IMAGE] [S-OFX-THREADING] | T04, T07 | Prototype last; isolate IPC; defensive timeouts; signed builds |
| R12 | Automatic native conversion silently changes visuals | ASTs expose syntax, not DOM/CSS painting semantics. [S-BABEL-PARSER] [S-TS-COMPILER] | T05 | Explicit subset, hard diagnostics, pixel regression gate |
| R13 | Automatic hybrid partitioning breaks layout/compositing | Parent/child CSS and compositing semantics can cross guessed boundaries. | T06 | Author-declared boundaries only |
| R14 | Arbitrary Remotion projects execute untrusted code | Remotion projects are JavaScript/TypeScript applications with dependencies. [S-REM-STILL] | T07 | Trusted local projects first; no automatic dependency installation |
| R15 | Browser/runtime packaging is incomplete in the installer | NetsuRush requires every runtime dependency to be staged, repaired, scanned, and packaging-tested. [S-NR-DIST] | T07 | Clean offline install and repair tests |
| R16 | Product licensing is incompatible or economically unsuitable | Remotion publishes specific licensing terms for organizations and automated products. [S-REM-LICENSING] | T07 | Written license confirmation before public/paid release |
| R17 | Resolve-version dependency fragments support | OGraf is present in the installed Resolve 21 SDK, while older versions cannot be assumed to provide it. [S-BMD-OGRAF-OVERVIEW] | T07 | Version capability detection and renderer fallback |
| R18 | Issue #10235 is mistaken for maintainer commitment | The open issue is user-authored and currently has no maintainer commitment. [S-REM-ISSUE-10235] | Documentation review | Treat as ecosystem signal only |
| R19 | The importer marks a composition native-safe despite hidden dynamic behavior | ASTs expose syntax but cannot prove arbitrary runtime React/CSS semantics. [S-BABEL-PARSER] [S-TS-COMPILER] | T08 | Fail closed; unknown behavior selects OGraf or Render |
| R20 | Framework analysis becomes coupled to specific Remotion internals | Public renderer/player contracts and source behavior may change across versions. [S-REM-STILL] [S-REM-PLAYER] [S-REM-STILL-SOURCE] | T08, T07 | Pin versions; capability manifests; regression corpus; supported renderer fallback |
| R21 | Users interpret backend selection as complete source translation | A faithful rendered result may contain no editable native nodes. | T08 | Show selected mode, reasons, unsupported constructs, and editability before conversion |

## Stop conditions

Stop or redesign an experimental path when any of the following occurs:

- it crashes Resolve or corrupts a project;
- it cannot reproduce the same frame deterministically;
- it cannot be cancelled without restarting Resolve or NetsuRush;
- it requires undocumented host behavior that cannot be isolated behind the render fallback;
- it cannot be packaged and repaired from a clean NetsuRush installer;
- its licensing cannot be made compatible with the intended product.

Failed experiments remain documented. Their artifacts should be retained so the same unsupported path is not reopened without new evidence.
