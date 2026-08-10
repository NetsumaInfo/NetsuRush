# NetsuBoard Web Provenance and Project Reveal Design

**Date:** 2026-08-10

## Goal

Make every image or video imported from the web retain its original page URL, so the existing item toolbar and context menu consistently expose the source website and the return-to-embed action. Also let users reveal a saved `.netsu` project from any recent-project card.

## Current Problem

NetsuBoard already renders a known platform icon, or a globe for an unknown domain, when an item has a web origin. It also offers a separate action that converts a downloaded image or video back to its embed representation.

The newer generic-media ingestion paths do not all persist `sourceUrl`. Direct image URLs, direct video URLs, and assets downloaded by the generic fetch path can therefore look like local-only media after import. The toolbar consequently hides both the website icon and the embed action even though the media came from the web.

Recent `.netsu` project cards display the saved file path but have no direct action for locating that file in Explorer.

## Web Provenance

`BoardItem.sourceUrl` remains the single source of truth for the original web page. No second provenance model is introduced.

Every HTTP(S) ingestion path that produces an image or video must pass the original user URL into the placed item:

- direct remote image;
- direct remote video;
- remotely fetched asset saved locally;
- generic HTML5 page resolution in linked mode;
- generic HTML5 page resolution in download mode;
- extractor results, including multiple images from one post;
- automatic recovery that replaces an expired or unreadable remote media locator.

Local files, clipboard blobs without an originating URL, Resolve media, and generated assets must not receive a fabricated `sourceUrl`.

Transformations that replace the media representation must preserve the existing origin. This includes download, restore-download, recovery, sequence conversion, and return from a sequence.

## Item Actions

The current toolbar and context-menu behavior is retained and made consistent by the provenance fix:

- A recognized domain uses its registered platform icon. Clicking it opens the original page in the system browser.
- An unknown domain uses the globe icon. Clicking it opens the original page in the system browser.
- A downloaded or linked image/video with `sourceUrl` shows the separate embed action.
- The embed action converts the item to the existing embedded representation while retaining any local copy according to the existing board preference.
- Returning to the downloaded media restores the retained local copy when available; otherwise NetsuBoard downloads it again.

Automatic import behavior is unchanged: NetsuBoard uses supported embeds where configured and otherwise follows the existing automatic-download preference and fallback behavior. The feature does not add a provider or setting for generic sites.

## Reveal Saved Project

Every `ProjectCard` for a recent `.netsu` document gets a right-click context menu containing:

- **Open project** — the existing document-open action;
- **Open file location** — calls Tauri's `revealItemInDir(entry.path)` so Explorer opens the containing folder and selects the exact `.netsu` file;
- **Remove from list** — the existing non-destructive recent-list action.

The context menu belongs to the reusable project-card component, so the action is available wherever that card is rendered. Internal unsaved scenes do not expose a file-location action because they have no `.netsu` path.

If revealing the exact file fails, NetsuBoard attempts to open its parent directory. A missing project remains marked as missing; revealing its recorded directory does not restore or reimport it.

## Integration

The renderer bridge gains a narrowly scoped `revealPath(path)` method backed by `@tauri-apps/plugin-opener`'s existing `revealItemInDir`. The browser mock returns `false`. No core RPC channel or new runtime dependency is needed.

All new visible copy is added to the six `reference.json` locale files, with French as the wording source.

## Testing

Tests must first fail against the current implementation and then cover:

- direct linked video imports retain the original URL;
- direct linked image imports retain the original URL;
- generic downloaded assets retain the user-entered page URL rather than only the resolved CDN URL;
- the toolbar derives a known platform icon or globe from that origin and exposes the embed action;
- project cards expose the reveal action and pass the exact `.netsu` path;
- the bridge uses `revealItemInDir` and has a safe browser mock;
- locale parity remains valid.

Final verification includes the focused Node contracts, the full Node suite, `npm run check:core`, `npm run check:i18n`, and `npm run build`. Interactive Explorer selection and item-toolbar behavior remain runtime checks because the running Tauri window must not be restarted during implementation.
