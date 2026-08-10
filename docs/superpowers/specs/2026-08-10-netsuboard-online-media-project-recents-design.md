# NetsuBoard Online Media and Project Recents Design

## Scope

This change fixes three connected NetsuBoard workflows:

1. YouTube relay playback works in development but fails in the installed application because the provisioned Python environment can be considered ready without `yt_dlp`.
2. Saving a board as a `.netsu` document creates a separate **Projects** row while the old internal scene can remain in **Recent**, so one saved board appears to be two different projects.
3. Generic pages containing an HTML5 video, including AMVNews embed pages, cannot be added in both linked and downloaded form.

The change does not add AMVNews as a named provider or expose it in the provider settings. It remains a generic video page. Popular providers such as YouTube, X, TikTok, Vimeo, and Instagram keep their existing named treatment.

## Product Behaviour

### Online-media preference

NetsuBoard keeps one global online-media preference:

- **Linked playback**: keep the original page as `sourceUrl` and play the resolved remote media without creating a local copy.
- **Automatic download**: resolve the same media, save it in NetsuBoard's asset store, and keep the original page as `sourceUrl` so the item can return to its linked reader.

The existing `autoDownloadOnline` preference remains the source of truth. Generic pages follow the global choice without being added to the per-provider list. The provider list remains reserved for recognizable, popular services.

### YouTube in production

The direct `/ytstream` relay remains the primary YouTube player because it avoids YouTube chrome during loops and supports NetsuBoard trim and ping-pong behaviour.

`yt_dlp` and `gallery_dl` become mandatory NetsuBoard runtime tools instead of dependencies installed only when an optional `reference` module happens to be selected. The first-run and repair setup always install `python/requirements-reference.txt`, and setup readiness probes both imports. Existing installations missing them become not-ready and enter the normal repair flow after updating.

The embedded YouTube player remains a graceful fallback for private, restricted, or temporarily unsupported videos. It is not considered the production fix for a missing packaged dependency. Relay failures log the actual resolver error instead of exposing only a generic HTTP 502 to the renderer.

### Generic HTML5 video pages

The core's existing generic page resolver is extended to recognize standard HTML video markup after its current direct-media and OpenGraph checks:

- `<video src="...">`
- `<video><source src="..." type="video/...">`

Relative media and poster URLs are resolved against the final page URL after redirects. Only HTTP(S) sources are accepted, existing redirect and size limits remain in force, and a page's framing protections are respected rather than bypassed.

For linked playback, the resolver returns the remote media URL and NetsuBoard creates a normal remote `video` item. For automatic download, the core downloads that media through the existing bounded asset path and creates a local `video` item. Both forms retain the original page URL in `sourceUrl`.

AMVNews therefore works through the same generic path as any other page exposing an HTML5 video. No `amvnews` provider id, settings chip, localized provider label, or site-specific UI is added.

## Project Identity and Recent Items

The NetsuBoard home shows one **Recent** section. The separate **Projects** heading and row are removed.

The Recent grid combines:

- the resumable current session;
- file-backed `.netsu` documents from the existing recents registry;
- internal library scenes that have not become file-backed documents.

File entries open with `openProject`, so the `.netsu` file remains the working document. They are never routed through archive import, which would create a new internal scene.

After **Save As** succeeds:

1. the new `.netsu` file is registered as the current document and as a recent file, with the source internal scene id when one exists;
2. the board state receives the saved file path;
3. if the board came from an internal scene, that source scene is deleted only after the file write succeeds;
4. the Recent grid filters any internal scene claimed by a file recent, so even a delayed cleanup cannot recreate the visual duplicate;
5. the UI returns to one file-backed recent entry instead of showing both the old scene and a project card.

Cancellation or save failure leaves the internal scene untouched. Saving an already file-backed document refreshes that file's recent timestamp without creating an internal scene.

## Interfaces and Data Flow

The existing IPC contract is extended rather than adding an unrelated channel:

- `reference:resolveMedia` accepts a linked/download mode and returns either a remote media locator or a saved asset path.
- `NrApi`, the renderer implementation, and the browser mock receive the same signature change.
- `useBoardIngest` passes the current `autoDownloadOnline` value and places the returned item while preserving `sourceUrl`.

The project save operation carries the source internal scene id when one exists. The core records that id in the file-recents entry and removes the source scene only after the `.netsu` save reports success. This keeps the file write and library cleanup in one ordered operation and makes the behaviour testable without relying on React timing. The recents mapping is also a durable de-duplication guard if cleanup has to be retried.

## Error Handling

- A missing YouTube runtime dependency makes setup status actionable and repairable; it does not silently leave `/ytstream` permanently broken.
- A YouTube extraction failure includes a sanitized diagnostic in the core log and falls back to the official embedded player for that item.
- A generic page with no direct media, OpenGraph media, or HTML5 source continues through the existing extraction and generic-card fallbacks.
- A linked remote media URL that later expires can be re-resolved from its retained `sourceUrl`.
- A failed `.netsu` save never deletes the internal source scene.
- A library cleanup failure is reported separately from the successful file save and remains retryable; the saved document is never rolled back, and the source-scene mapping prevents the duplicate from reappearing in Recent.

## Testing and Verification

Implementation follows red-green TDD with focused regression coverage:

1. Packaging/setup tests prove the reference requirements are always installed and their imports are part of readiness checks.
2. YouTube relay tests prove resolver failures expose diagnostics while successful resolution still streams through the stable local endpoint.
3. Generic resolver tests use a local HTTP fixture containing relative `<video>` and `<source>` URLs and verify both linked and downloaded results.
4. Ingestion tests verify the global preference selects linked versus local media without introducing an AMVNews provider setting.
5. Project tests cover create internal scene, Save As, durable source-scene mapping, successful source cleanup, one recent file entry, reopen as working document, and no cleanup on save failure.
6. Home tests verify there is one Recent section and no Projects section.

Required checks are the targeted regression suites, all Node tests, `npm run check:core`, `npm run check:i18n`, and `npm run build`. Because the core and setup change, the currently running Tauri window still executes old code until it is restarted. Installed-runtime verification additionally requires the updated setup repair to run and a real YouTube and generic HTML5-video page to be tested in the packaged application.

## Out of Scope

- Adding AMVNews branding, a provider chip, or site-specific settings.
- Bypassing `X-Frame-Options` or `frame-ancestors` restrictions.
- Changing `.netsu` sharing/export embedding levels.
- Replacing the YouTube relay with the official iframe player.
- Packaging or publishing a release as part of this implementation.
