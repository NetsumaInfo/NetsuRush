# H01 result (dependency surface) — 2026-08-27

Status: PASS for the slice it covers

This is the first slice of [H01](../../engines/hyperframes/H01-session-baseline.md):
can the adapter be written against public API on a pinned version, and what
exactly does that version pull in. Sessions, captures, seek order, and the
100-cycle lifecycle are **not** covered here; they need a provisioned browser
and arrive with Tasks 2-4 of the
[HyperFrames adapter plan](../../../plans/2026-08-27-hyperframes-renderer-adapter-implementation.md).

## Environment

| | |
|---|---|
| OS | Windows 11 Pro 10.0.26200, x64 |
| Node | v22.16.0 |
| npm | 11.14.1 |
| Working tree | `Netsuflow/prototypes/hyperframes-renderer/` |
| Resolve | not involved |

## Versions and revisions

| Package | Version |
|---|---|
| `@hyperframes/engine` | 0.8.16 (exact pin, no caret or tilde) |
| `@hyperframes/core` | 0.8.16 |
| `@hyperframes/parsers` | 0.8.16 |
| `puppeteer` | 25.9.0 |
| `puppeteer-core` | 25.9.0 |

Lockfile version 3, 105 entries, SHA-256
`1864abe8b65c9bcf9b2c486612ad83134e6dd95700d01ddd9979918f67f86713`.
Full fingerprint in [`runtime-manifest.json`](runtime-manifest.json).

## Commands

```text
node --test test/packageExports.test.mjs        # before install: FAIL, as intended
npm install --ignore-scripts --no-audit --no-fund
npm test
node runtimeManifest.mjs
```

## Results

### The adapter can be written against public API

All six functions the documented session lifecycle needs are package-root
exports on 0.8.16: `acquireBrowser`, `releaseBrowser`, `createCaptureSession`,
`initializeSession`, `captureFrameToBuffer`, `closeCaptureSession`. So are the
nine helpers that would otherwise be reimplemented, including
`getCompositionDuration`, `getCapturePerfSummary`, `buildChromeArgs`, and the
failure classifiers. **No internal path import is required for the baseline.**

The root surface is 191 exports, recorded in
[`exports-baseline.json`](exports-baseline.json). The drift test was verified to
actually fail: removing one symbol from the baseline and adding a fictitious one
produced `not ok 3 - the root export surface has not drifted since it was
pinned`, then the baseline was restored.

### The package is a clean ESM import

`"type": "module"`, `main` and the `.` export both resolve to compiled
`dist/index.js` with `.d.ts` beside it. 2.3 MB installed. No build step, no
transpile, no source-only publish.

### Windows will never get the deterministic capture path

`expectedCaptureMode()` reports `screenshot` with
`deterministicPathAvailable: false` on this machine. This mirrors the upstream
rule read from source: BeginFrame requires `process.platform === "linux"` plus a
headless-shell binary plus `--enable-begin-frame-control`. [S-HF-CAPTURE-MODE]

This is now asserted by a test rather than remembered, so an engine upgrade that
changes it surfaces here instead of inside a determinism measurement. The
consequence for the project is unchanged and stated in
[R24](../../../docs/10-risk-register.md): byte-stability of repeated identical
requests on Windows is something H02 must measure directly.

### Installing pulls no browser

`--ignore-scripts` suppressed Puppeteer's postinstall. 79 packages, 8 seconds,
68 MB, and no Chrome or chrome-headless-shell binary anywhere in the tree — the
only `.exe` present is esbuild's own. Browser provisioning stays a separate,
verified, checksum-checked step, which is what
[packaging-and-versioning](../../../docs/engines/hyperframes/packaging-and-versioning.md)
already requires.

### Licensing: resolved, and better than the npm metadata suggested

The resolved tree is 79 packages: 44 MIT, 13 BSD-2-Clause, 8 ISC, 5 Apache-2.0,
3 BSD-3-Clause, 1 0BSD, and 5 with no `license` field. **No GPL, LGPL, AGPL, or
other copyleft.**

All five without metadata are HyperFrames' own packages (`core`, `engine`,
`lint`, `parsers`, `studio-server`), and every one of them **ships a full
Apache-2.0 LICENSE file inside its tarball**. The gap is npm metadata only, not
the licence itself. That closes the warning
[SOURCES.md](../../../SOURCES.md) raised from the registry query: the
repository licence is not merely inferred, it is present in each installed
package and can be redistributed with our notices.

Raw output in [`dependency-licenses.txt`](dependency-licenses.txt).

## Findings from the export surface, and what was decided

The 191-symbol surface contains code that overlaps work later tasks planned to
write. Each overlap was evaluated against the installed 0.8.16, not against the
main branch, and each is now a decision rather than an open question.

### `createFileServer` — do not adopt

Task 3 planned to write a project server, and the engine exports one. Measured
against our trust boundary, it fails both halves of it:

| Property | Required | Measured on 0.8.16 |
|---|---|---|
| Bind address | loopback only | `0.0.0.0`; reachable from another machine on the LAN |
| Escape from the served root | impossible | one encoded-separator form returned a file outside the root on Windows |
| Access control | per-run token | none |
| Read size | bounded | whole file via `readFileSync` |
| Byte ranges | supported | not implemented |

`FileServerOptions` has no hostname field, so the bind cannot be narrowed by
configuration. Hono normalises the ordinary `..` forms, and six of seven
traversal attempts returned 404; the failing one survives normalisation and is
then treated as a separator by `path.join` on Windows. Probe output is in
[`fileserver-probe.txt`](fileserver-probe.txt).

**NetsuFlow does not inherit this.** `createFileServer` is exported but never
called inside the engine, and `createCaptureSession(serverUrl, ...)` takes the
URL from its caller, so the server is ours to provide. Task 3 proceeds exactly
as originally written, and the measured failures become named regression tests.

The issue is worth reporting to the HyperFrames maintainers. It is their code,
it is a default-insecure local server, and the fix on their side is small.

### `decodePng` — adopt, but only behind our own bounds check

It is a hand-written PNG decoder built on `zlib` alone, with no third-party
dependency, and it targets exactly our input: colour type 2 or 6, 8-bit,
non-interlaced, which is what Chrome's screenshot capture emits. It correctly
rejects other colour types, interlaced images, unknown filter types, and the
wrong bit depth.

What it does not do is defend against a hostile buffer:

- `inflateSync()` is called with no `maxOutputLength`, so a compression bomb in
  IDAT inflates unbounded;
- `Buffer.allocUnsafe(height * stride)` uses IHDR dimensions that were never
  range-checked;
- chunk CRCs are not verified;
- a truncated IDAT silently yields zero-filled pixels instead of an error,
  because missing bytes fall back to `0`.

None of that is a defect in its intended use, where the input came from our own
browser. It does mean the decoder cannot also be the validator. NetsuFlow
therefore keeps its guard in front: cap the encoded buffer, parse and
range-check IHDR before decoding, and verify the decoded length against the
dimensions the request asked for. That is the same shape as the bounds already
proven in the bridge protocol.

The oracle problem is real but narrow: validating capture output with the
codebase that produced it is circular. It only matters for the golden-reference
comparison, so a second, independent decoder is needed there and nowhere else.

### Alpha capture changes the baseline path

`captureFrameToBuffer()` is not the only capture entry point, and probably not
the right one. The engine also exports:

- `initTransparentBackground(page)`, called once per session;
- `captureAlphaPng(page, width, height)`, called per frame;
- `captureScreenshotWithAlpha(page, width, height)`, which sets and restores the
  background override on every call.

The engine's own guidance is explicit: for a session that captures many frames,
call `initTransparentBackground()` once at init and `captureAlphaPng()` per
frame, because `captureScreenshotWithAlpha()` costs two CDP round-trips each
time. That is precisely our access pattern, and alpha is the entire point of a
Fusion generator rather than a nice-to-have.

H02 therefore compares two candidate paths rather than assuming one:
`captureFrameToBuffer()` against `initTransparentBackground()` +
`captureAlphaPng()`. Both need a `Page`, which the capture session holds.

### `@hyperframes/lint` and `@hyperframes/studio-server` — no action needed

Both are runtime dependencies of `@hyperframes/core`, which `@hyperframes/engine`
imports, and `core/dist/index.js` imports them directly. They cannot be pruned
without breaking core.

Measured, they are not a problem: 1.4 MB and 934 KB against 11 MB for the whole
HyperFrames set, both Apache-2.0, and importing `@hyperframes/engine` opens **no
listening socket**, so the studio API is linked but inert. T08 records the size
and moves on.

## Decision

Task 1 passes. The dependency surface is frozen, fingerprinted, and guarded by a
test that fails on drift. Every overlap between the engine's exports and our own
planned code has been resolved into a decision. Proceed to Task 2, the HTML
fixture.

The rest of H01 stays open, and no claim about session lifetime, seek order, or
resource cleanup is made by this report.

## Follow-up

- Task 2: author the `index.html` fixture.
- Task 3: write the project server, with the measured `createFileServer`
  failures as named regression tests.
- Task 5: use `decodePng` behind a NetsuFlow bounds check; add a second,
  independent decoder for golden references only.
- H02: compare `captureFrameToBuffer()` against `initTransparentBackground()` +
  `captureAlphaPng()`, and measure Windows screenshot-mode byte-stability.
- Upstream, two reports worth sending: the default-insecure `createFileServer`
  bind and traversal, and the missing `license` field in all five published
  packages.
