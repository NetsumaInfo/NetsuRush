# NetsuBoard Recent Project Cards and Drop Design

**Date:** 2026-08-10

## Goal

Show one coherent recent card per NetsuBoard project, give file-backed projects the same board thumbnail and modification label as internal projects, and open `.netsu` documents dropped on the home screen.

## Legacy Duplicate Recovery

New Save As operations already carry `sourceSceneId`, but projects saved by an older running core can have a recent `.netsu` entry without that link while the original internal scene remains. Matching only by title would hide unrelated projects with the same name.

For each unlinked, existing board recent, NetsuRush reads the project item identifiers and compares them with same-title internal scenes. A scene is treated as the legacy source only when the project has items and at least 80 percent of those identifiers occur in the scene, with a minimum overlap of three identifiers when the project contains at least three items. The strongest match wins. The inferred `sourceSceneId` is persisted into the recent entry without changing its recency timestamp. The internal scene remains stored for safety but is hidden from Recent exactly like a normally converted scene.

Empty projects are not inferred from their title alone. Future Save As operations continue using their explicit `sourceSceneId`.

## Unified Cards

A file-backed recent card reads a preview scene directly from its `.netsu` file through a read-only core method. It uses the same thumbnail renderer as an internal scene, including image, video, YouTube, frame, text, and fallback tiles. Previewing must not open a document session or move the project to the front of Recent.

Under the project name, the card shows `Modified …` using the `.netsu` file modification time. The folder path is removed from the visible card but remains available in the existing full-path tooltip and in the right-click **Open file location** action.

Internal scene cards gain a right-click menu. It exposes **Open project** plus their existing favorite, hide, and delete operations. They do not expose a file-location action because no `.netsu` path exists.

## Dropping a `.netsu`

The home drop handler checks for `.netsu` before media files. When one is present, it resolves the native Windows path and opens the first dropped `.netsu` through the existing project-open flow. It does not import the file as a copied internal scene and does not create a blank board. Ordinary image and video drops keep their current behavior.

## Integration

The existing `netsu:recents` result gains `modifiedAt`. A new read-only `netsu:previewProject` channel is added to the core handler table, `RefApi`/client implementation, and browser mock. `SceneThumb.tsx` owns a shared board-thumbnail renderer used by both `SceneThumb` and `ProjectThumb`.

No new dependency or setting is introduced. No visible locale key is needed because the existing translated project-open, favorite, hide, delete, modification, and file-location labels are reused.

## Testing

Regression coverage must prove:

- legacy same-project content is linked and hidden even when it gained one internal item after Save As;
- unrelated same-title projects with different item identifiers remain separate;
- inferred identity is persisted without changing `openedAt`;
- project recents expose `modifiedAt` and previews do not mutate recency;
- project cards render `ProjectThumb`, show the modification label, and omit the visible folder path;
- internal scene cards expose the right-click open action;
- `.netsu` is handled before image/video home drops and routed to project opening;
- all four IPC surfaces for project preview stay aligned.
