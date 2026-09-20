# Collaboration implementation plan

**Goal:** Integrate shared collections and NetsuBook with device-specific scheduling, fifteen
participants, prepared collection media and explicit removal rules.

**Architecture:** Retain native Loro authority, iroh media and Convex recovery. Each surface
owns its typed projection and lifecycle adapter. Local preferences and hiding never enter
the shared document. Operations are checked at native boundaries.

**Tech stack:** TypeScript/React, CommonJS Node core, Rust/Loro/iroh, Convex.

## Handoff, 2026-09-07

The source paths below are implemented. Collections now shares the existing archive, following the
concurrent UI revision, and registers its prepared files in the native allowlist. NetsuBook exposes
both scopes in a persistent action row, the notebook menu, document actions and the page context
menu. Unavailable collaboration displays an explanation instead of hiding those entry points.

Source verification: final renderer build, core type-check, six-locale parity and 1,066 Node tests
passed after the UI pass. Convex type-check and 138 Python tests also passed. Rust
`cargo check --locked --tests` passed; Rust tests were compiled, not executed. No native app launch,
package build or restart was performed.

Acceptance remains open: deploy/verify the matching Convex functions, restart Tauri, then test two
accounts for invitations, simultaneous writing, reconnect, IME/selection/undo, permissions and
media availability. Long-document latency and weak-PC performance have not been measured. Portable
export of downloaded notebook media also remains unverified. NetsuDraft remains out of scope.

The checklist below records the original implementation and acceptance scope; unchecked items must
not be interpreted as a promise that live acceptance has passed.

- [ ] Add `src/lib/collab/preferences.ts`, a General Settings section and six translations.
  Wire reference bridge batching to the persisted, validated per-surface preference. Test
  invalid stored input, independent overrides and pending edits during profile changes.
- [ ] Extend typed native surface operations in `src-tauri/src/collab/ops.rs` and `doc.rs`.
  Integrate NetsuBook page/notebook registry bindings, sharing dialogs and incremental editor
  changes. Fix revision-aware autosave failure handling in `src/store/notebook.ts` and test
  edits during saves, page switches and rejected saves.
- [ ] Add prepared collection media and durable collaboration bindings to `core/collections.js`
  and the collection bridge. Use the existing archive/export pipeline with re-encode/remux
  selection; reject incomplete output, missing sources and source-path publication.
- [ ] Add collection sharing controls to `FolderEditor.tsx`, and projection/subscription handling
  to `CollectionDetail.tsx`. Register the collection surface at boot and add local hiding.
  Test creation, reopen, preparation failure and retry without duplicate project creation.
- [ ] Enforce fifteen reserved seats in `convex/projects.ts` and native invitation validation.
  Review remote semantic authorization before exposing contributor/delegated deletion.
- [ ] Luna adapts cadence and seat-limit changes to NetsuBoard independently, preserving its
  board-specific semantics and existing user files.
- [ ] Run `npm run build`, `npm run check:core`, `npm run check:i18n`, focused Node behavior
  tests and `cargo check --locked` in `src-tauri`. Review integration for original-path leaks,
  hidden-item deletion propagation, save races and privilege bypasses.
- [ ] Update `docs/collab.md` with actual behavior and distinguish source validation from
  pending restarted two-machine acceptance. Do not launch or rebuild the running Tauri app.
