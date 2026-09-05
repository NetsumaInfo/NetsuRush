# HyperFrames project and session lifecycle

## Registration

Record:

- canonical root and entry point;
- exact HyperFrames package and lockfile fingerprint;
- selected composition ID;
- normalized props and revision;
- source/assets/fonts revision;
- Node and browser build;
- capture/viewport/media policy;
- trust and network policy.

HyperFrames compositions provide finite dimensions, fps, and duration metadata
that NetsuFlow normalizes into `CompositionDescriptor`.
[S-HF-COMPOSITIONS]

## Lifecycle

```text
register/trust
 -> verify dependencies and version
 -> start controlled project server
 -> create capture session
 -> initialize composition
 -> describe
 -> serve arbitrary frames
 -> invalidate or idle-evict
 -> close page/browser lease/server
```

The source implementation holds browser/page state in a capture session and
provides explicit close behavior. [S-HF-FRAME-CAPTURE-SOURCE]

Two mechanical constraints follow from the real signatures
[S-HF-ENGINE-EXPORTS] [S-HF-CAPTURE-BUFFER-PURPOSE]:

- a browser lease is acquired separately from the session, and both must be
  released. `acquireBrowser()` returns the lease, `closeCaptureSession()` closes
  the session, and the lease's own release is a distinct call;
- `createCaptureSession()` requires an `outputDir` even when every frame is
  captured to a buffer. NetsuFlow allocates a per-session scratch directory,
  never writes frames into it on the live path, and removes it on close. Any
  file that appears there is a diagnostic finding, not normal operation.

## Serving the project

The engine takes a server URL and **appends `/index.html`** to it to navigate.
A URL ending in a slash therefore produces `//index.html`, which is a leading
slash once the server strips its own prefix, which resolves as an absolute path,
which lands outside the served root. The symptom is a silent 404 followed by the
full 45 s `window.__hf` readiness timeout, so the cost of getting this wrong is
paid in an error message that names neither the URL nor the file.
[S-NF-H02-FIXTURE]

NetsuFlow serves the project itself rather than using the engine's
`createFileServer`, which was measured and rejected. The server is loopback-only,
scopes every URL under a per-run random token, checks containment against the
canonical root both after `resolve()` and again after `realpath()` so a symlink
inside the root cannot lead out of it, bounds URL, header, and file sizes,
answers only `GET` and `HEAD`, and returns an identical 404 for every refusal so
it cannot be used to probe the filesystem. [S-NF-PROJECT-SERVER]

Head and body script injection into the entry point is supported, and is the
candidate mechanism for the frame-control shim that
[`12-fusion-parameter-binding.md`](../../12-fusion-parameter-binding.md)
describes. Only the entry point is ever rewritten, and byte ranges are disabled
while it is.

## Seeking

Requests may arrive sequentially, backwards, repeated, or random. The session
must seek by frame, wait for all adapter/media async work, then capture.
HyperFrames' adapter contract requires arbitrary and idempotent seeks.
[S-HF-FRAME-ADAPTERS]

Do not advance time from the previous request. Derive requested time from the
normalized frame and composition fps so random access stays correct.
[S-HF-DETERMINISM]

## Invalidation

Create a new source revision for changes to:

- project code or build configuration;
- dependency lockfile;
- local assets or registered fonts;
- composition metadata;
- normalized props;
- HyperFrames adapter/package;
- browser build;
- viewport, scale, media, network, or capture mode.

Watchers reduce latency but are not correctness. The revision/hash is the cache
authority.

## Session policy to measure

1. One capture session for one binding revision.
2. Idle timeout with deterministic close.
3. Sequential/reverse/random request patterns.
4. One versus bounded multiple sessions.
5. Browser pool only after its lease/recovery behavior is proven.
6. Worker kill and supervisor recreation.

## Diagnostics

Record separately: project server startup, browser lease/start, navigation,
initialization, composition discovery, seek, media wait, screenshot, decode,
cache, transport, and copy. Without stage timings, optimization decisions are
guesswork.

