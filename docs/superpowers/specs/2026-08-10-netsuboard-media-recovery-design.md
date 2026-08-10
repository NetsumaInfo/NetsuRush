# NetsuBoard durable media recovery

## Problem

A working `.netsu` project stores generated and downloaded media in its sibling companion folder,
`<project>.medias/`. When a companion reference cannot be resolved, the current read path returns an
empty renderer reference. Autosave can then persist that empty value over the durable token, and the
next orphan sweep can delete media that still belongs to the project.

The inspected `test.netsu` demonstrates this failure mode: several web-backed items still retain
their `sourceUrl`, while their `ref` values and sequence frame references are empty and the companion
folder is absent.

## Storage contract

The working project and the sharing archive remain distinct:

- A working `.netsu` always stores durable media identity and provenance: original URL, durable local
  locator, expected filename, size, kind, and content identity when available.
- Working media bytes remain in the sibling companion folder. Routine saves do not embed or re-encode
  them inside the database.
- Share/export keeps the existing embedding levels and may place the selected media bytes inside the
  exported `.netsu`. This is the portable, self-contained path.
- Converting, upscaling, sequencing, or switching to an embed must not discard the original web URL.
  The project must retain enough provenance to download the displayed media again.

## Durable missing references

Opening a project must never replace a durable token with an irreversible empty value.

- A missing `sidecar:` or `ref:` locator is retained in structured missing-media metadata.
- Missing sequence frames retain their locators by index.
- Saving an unresolved item reuses the retained locator instead of writing an empty token.
- Any unresolved project-owned media suspends companion-folder orphan deletion for that save.
- A sudden drop from populated project media to empty media is treated as unresolved state, not as
  intentional deletion. Explicit item deletion remains supported once the remaining document is
  fully resolved.

## Automatic relocation

Resolution starts from the current `.netsu` path, which is the project root of truth:

1. Resolve the normal sibling folder `<project>.medias/`.
2. If it is absent or the expected relative file is missing, inspect sibling `*.medias` folders for
   the same relative locator or content identity. Use a candidate only when the match is unambiguous.
3. For referenced user files, search the `.netsu` parent tree for a candidate matching filename,
   size, and stored content identity. Bound the search and skip inaccessible paths.
4. On the next successful save, adopt recovered project-owned media into the canonical current
   companion folder so future opens no longer need fallback discovery.

Relocation is read-safe: ambiguous candidates remain missing and are never silently substituted.

## Automatic web recovery

After a project opens, NetsuBoard identifies missing image, video, and sequence items that still have
an original HTTP(S) source.

- Recovery runs sequentially to avoid launching several `yt-dlp`, `gallery-dl`, or remote downloads
  at once.
- Each successful download replaces the missing local locator while preserving `sourceUrl`.
- Recovered files are adopted into the companion folder by the normal project save path.
- A sequence whose extracted frames are gone may recover from its original web media and can be
  rebuilt or restored as the downloaded source without losing board geometry.
- Failed items remain visible as missing placeholders with their provenance intact.
- Recovery never deletes the `.netsu`, its companion directory, or unrelated user files.

Automatic recovery starts only for missing media; healthy embeds and healthy local files are not
downloaded again.

## Recovery notice

The existing toolbar notice area gains a compact action when recoverable web media are missing:

- Label: `Redownload all (N)` in English and equivalent copy in all six locales.
- Automatic recovery reports current and total progress in the existing notice area.
- The action remains available after partial failure and retries only items that are still missing.
- Completion reports recovered and failed counts without opening a dialog.

## Failure handling

- No source URL: keep the placeholder and offer the existing manual file picker.
- Network or extractor failure: retain the URL and locator, report the failure, and keep the retry
  action visible.
- Ambiguous relocation: do not guess; continue to web recovery when a source URL exists.
- Save during recovery: preserve old durable locators until a replacement download has completed.
- Application reload during recovery: loading placeholders remain transient, while stored provenance
  allows the next open to retry safely.

## Interfaces

Core responsibilities:

- Resolve durable media locators relative to the active `.netsu`.
- Preserve unresolved tokens and expose structured recovery metadata.
- Guard companion cleanup whenever project media resolution is incomplete.

Renderer responsibilities:

- Count web-recoverable missing items.
- Run sequential bulk recovery through the existing media extraction and resolution APIs.
- Display progress and the compact retry action.
- Save successful replacements through the normal project path.

No new external runtime dependency is required.

## Testing

Core tests cover:

- unresolved companion tokens surviving open and autosave;
- missing sequence frame locators surviving by index;
- orphan sweep suspension while any project media are unresolved;
- automatic relocation from the current `.netsu` root and an unambiguous sibling companion folder;
- ambiguous candidates remaining unresolved;
- explicit removal still cleaning true orphans after a fully resolved save.

Renderer tests cover:

- recoverable-item counting;
- sequential bulk recovery for images, videos, and sequences;
- preservation of `sourceUrl` after recovery;
- retry action visibility and progress copy;
- successful recovery triggering a project save.

The current user project is evidence for the regression but is never modified by automated tests.
