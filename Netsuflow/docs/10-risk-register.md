# Risk register

| ID | Risk | Impact | Likelihood | Evidence/test | Mitigation or stop condition |
|---|---|---:|---:|---|---|
| R1 | Uncached HyperFrames frames are too slow for scrubbing | **Downgraded to Medium** | Low at 1080p, Medium at 4K | [S-NF-H03] | Measured on a software renderer: 1080p warm miss p95 133.7 ms against a 250 ms target, memory hit p95 26.8 ms under load against 33 ms. 4K miss p95 326.8 ms. What is genuinely slow is not the miss but the **cold session: 5.5 s at 1080p, 6.7 s at 4K**, which no cache helps and which decides the mode default |
| R2 | Resolve render callbacks deadlock or overload the service | Critical | Medium | T03, T07 | Bounded IPC/scheduler; common client path measured, remaining host stress required |
| R3 | HyperFrames pre-1.0 APIs drift | High | High | H01, [S-HF-RELEASE-CHANNELS] | Exact pin, one adapter wrapper, conformance suite, upgrade gate |
| R4 | PNG capture/decode dominates misses | Medium | **Confirmed, and it is capture rather than decode** | [S-NF-H03], [S-NF-PIXEL-BENCH] | Capture is 80% of a 1080p miss and 67% of a 4K one. The register's own rule for that case says improve session/prefetch or prefer pre-render rather than optimise pixels, which is what the mode default does. A raw-pixel path would attack the smaller half |
| R5 | Alpha/color differs from standalone output | High | Medium | H02, T06 | Canonical RGBA contract and golden fixtures |
| R6 | Random seeking is non-deterministic | **Downgraded to Medium** | Low for the fixtures tested | [S-NF-H03], [S-NF-CONFORMANCE] | 1,900 verified frames across sequential, reverse, seeded-random and loop traces: 0 wrong frames, and reverse/random cost exactly what sequential costs. Still fixtures rather than real compositions, and still on one engine build |
| R7 | Browser/session memory grows during scrubbing | **Downgraded to Low** | Low | [S-NF-H03] | 10,000 consecutive captures: browser working set +6 MiB, handles **-21**, browser count flat, cache pinned at its bound. Node RSS oscillates 113-146 MiB without trending. Worker restart verified by killing every browser process |
| R8 | Packaging Node/browser/FFmpeg is fragile or large | High | High | T08 | Runtime manifest, offline provisioning, checksum and repair tests |
| R9 | User projects compromise data | Critical | Medium | Security review | Explicit trust, process isolation, path/network/resource policy |
| R10 | Malformed payload crashes Resolve | Critical | Low/Medium | T03 | Preserve strict parser and hostile/fuzz regression suite |
| R11 | Props changes return stale plugin/service cache | Critical | High today | common conformance, T05 | Add canonical props revision to request/binding and every cache key before real engine |
| R12 | Engine logic leaks into OpenFX and forces later rebuild | High | Medium | architecture review, `test/adapterBoundary.test.mjs` | Binding-based dispatch only; stable plugin identifier. Enforced by test: no engine name may appear in `openfx/src/`, and only the adapter boundary may import the engine package. The leak had already happened once, in the plugin's user-visible name |
| R13 | Automatic Remotion migration fails visually | High | High for arbitrary projects | X01/X02, [S-HF-REMOTION-MIGRATION] | Separate explicit conversion tool; direct Remotion adapter fallback |
| R14 | Closed experimental Remotion adapter is mistaken for supported code | Medium | Medium | [S-HF-REMOTION-ADAPTER-PR] | Treat as research evidence only |
| R15 | Remotion licensing/version rules complicate second engine | High | Medium | RM01 | Isolate adapter/distribution policy; re-review before implementation |
| R16 | Framework work delays renderer proof | Medium | Medium | roadmap review | Metadata-only until two engines validate the contract |
| R17 | Host behavior differs across Resolve versions | High | Medium | T01/T02/T07 | Supported matrix and runtime capability checks |
| R18 | macOS signing/browser constraints block release | High | Medium | T09 | Windows-first; no macOS claim before hardware validation |
| R19 | Third-party OFX excludes Resolve Free users | Medium | High | [S-RESOLVE-STUDIO-OFX], T01 | Studio positioning; retain pre-render/import path |
| R20 | Composition schemas need arbitrary controls that OpenFX cannot add dynamically | High | High | [S-OFX-PARAMETERS], T10 | Fixed typed bank, stable slot mapping, hidden unused slots, explicit overflow editor in NetsuRush |
| R21 | Keyframed values do not update a warm HyperFrames page | High | Medium/High | R05, T10 | Measure official injection, opt-in frame-control shim, correct reinitialize/pre-render fallback |
| R22 | Parameter changes reuse a stale plugin/service frame | Critical | High until implemented | T10 | Schema revision and canonical effective-values hash in every cache key |
| R23 | A remapped slot applies old keyframes to another variable | Critical | Medium | T10 | Immutable stable assignments; never auto-reuse an occupied slot after schema changes |
| R24 | Windows capture uses Puppeteer screenshot mode, never the deterministic BeginFrame path | **Downgraded from Critical to Medium** | Certain that it applies | [S-HF-CAPTURE-MODE], [S-NF-H02-FIXTURE] | Measured: BeginFrame's compositor does not preserve alpha, so an alpha workflow forces screenshot capture on **every** platform. Windows is not disadvantaged; no platform gets the deterministic compositor path. Repeated and out-of-order captures were byte-identical over five runs on a hard-edged fixture. Keep measuring on real compositions |
| R28 | A composition without a GSAP timeline stalls 45 s on every session init | **Mitigated** | High for real user projects | [S-NF-H02-FIXTURE], [S-NF-TIMELINE-MODES] | Solved by an injected timeline shim with three modes. Measured 45,181 ms to 3,136 ms (`auto`) or 136 ms (`none`), with GSAP compositions untouched at ~100 ms. The user's file is never edited |
| R30 | `auto` mode captures a composition whose timeline registers after the grace | High | Medium | [S-NF-TIMELINE-MODES], T05 | Reproduced deliberately: under a 500 ms grace the late fixture is captured while its animation does not exist, and nothing errors. Default grace is 3 s, the shim reports every host it marked so the adapter can warn, and `gsap` mode removes the deadline. A slow project must be able to choose its mode |
| R29 | Antialiased content sharing a layer with animated content is not byte-stable | High | Medium | [S-NF-H02-FIXTURE], H02 | Observed once at 0.004% of pixels on diagonal SVG edges, not reproduced after restructuring and never isolated to a cause. Fixture keeps a tolerated antialias probe; H02 targets this pattern specifically, since most real compositions have it |
| R25 | A capture API built for sequential streaming is used for random access | **Downgraded to Low** | Low | [S-NF-H03], [S-NF-CONFORMANCE] | Tested rather than assumed: reverse and seeded-random traces are within 0.2 ms of sequential at p50, and every one of 1,900 frames matched the frame requested. `captureFrameToBuffer` is written for the engine's sequential pipeline and promises nothing about backward seeks; it simply does not degrade here |
| R26 | Engine-provided infrastructure is adopted without re-checking its trust boundary | Critical | Medium | [S-NF-H01-EVAL] | Measured once: `createFileServer` binds every interface and can be escaped on Windows, so it is not adopted. Re-probe bind, traversal, and internal callers on every engine upgrade, because an upgrade could start using it internally |
| R31 | A Node-side protocol client reassembles frames quadratically | **Found and fixed** | Was certain, on every Node client | [S-NF-READER-QUADRATIC] | The shared `MessageReader` concatenated every arriving chunk onto an accumulator. Invisible on small test messages, ruinous on a 33 MiB 4K frame: 1,564 ms to reassemble, against 0.3 ms for the same cached frame through the C++ client. It now copies each message exactly once. Caught only because two independent clients measured the same operation and disagreed |
| R27 | The PNG guard is bypassed and `decodePng` decodes hostile input directly | Critical | Low while the guard holds | [S-NF-H01-EVAL], T05 | `decodePng` inflates with no `maxOutputLength` and allocates from unchecked IHDR dimensions. Cap the encoded buffer and range-check IHDR before every call; keep a hostile-payload regression suite that fails if the guard is removed |

## Prototype targets

These are experimental thresholds, not promises:

- existing fake cache-hit bridge: retain p95 below 20 ms at 1080p;
- real decoded memory hit: p95 below 33 ms at 1080p;
- simple warm HyperFrames miss: measure first; provisional usability target below
  250 ms;
- interactive deadline at or below 2 s in early prototypes;
- 10,000 randomized requests after bounded caches fill: stable process/browser
  memory trend, no handle leak, no unbounded session count;
- requested random frames match standalone references within the color/alpha
  tolerances.

If decoding/transport dominates, optimize pixels. If capture dominates, improve
session/prefetch or prefer pre-render. If the host becomes unstable with the
already bounded bridge, stop before expanding engine features.
