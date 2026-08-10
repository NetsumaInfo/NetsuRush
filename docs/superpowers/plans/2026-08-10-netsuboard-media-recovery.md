# NetsuBoard Durable Media Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent project autosave from destroying unresolved media locators or companion files, automatically relocate local media from the `.netsu` root, and recover missing web media from stored source URLs.

**Architecture:** The core keeps unresolved locators as structured metadata and blocks orphan cleanup whenever resolution is incomplete. A focused relocation module searches only the current project tree and validates candidates by stored identity. The renderer derives recoverable web items from board state, downloads them sequentially through existing APIs, autosaves successful replacements, and exposes a compact retry action in the toolbar.

**Tech Stack:** Node.js CommonJS core, `node:sqlite`, React 19, TypeScript, Zustand, Tauri IPC, Base UI/shadcn, Node test runner, i18next.

---

## File map

- Create `core/netsu/relocate.js`: bounded, identity-checked project-root relocation.
- Modify `core/netsu/board.js`: retain unresolved locators and use relocation before producing placeholders.
- Modify `core/netsu/project.js`: reuse retained locators and suspend unsafe orphan cleanup.
- Modify `core/netsu/embed.js`: expose the existing head fingerprint helper to relocation.
- Modify `src/components/reference/referenceShared.ts`: type durable missing locators.
- Modify `src/components/reference/boardMediaActions.ts`: count and sequentially recover missing web media.
- Modify `src/components/reference/useScenePersistence.ts`: start recovery after opening a project and save successful replacements.
- Modify `src/components/reference/Toolbar.tsx`: render the compact retry action beside notices.
- Modify all six `src/locales/*/reference.json`: recovery labels and result copy.
- Modify `test/netsu-project.test.cjs`: core regression and relocation coverage.
- Modify `test/reference-online-media-ui.test.cjs`: renderer recovery and toolbar contracts.

### Task 1: Preserve unresolved project locators and stop unsafe cleanup

**Files:**
- Modify: `core/netsu/board.js`
- Modify: `core/netsu/project.js`
- Modify: `src/components/reference/referenceShared.ts`
- Test: `test/netsu-project.test.cjs`

- [ ] **Step 1: Write the failing scalar-media regression test**

Create a project with one adopted image, delete or temporarily rename the expected file, reopen it,
save the returned scene, and assert that the stored `sidecar:` token and companion bytes survive:

```js
test('an unresolved companion token survives open and autosave without sweeping project media', async () => {
  // Save two adopted items, hide one file, read the scene, then save that unresolved scene.
  // Assert read.scene.items[0].missing.locator is the original sidecar token.
  // Assert the stored board_items JSON still contains that token after save.
  // Assert the second companion file was not swept while any locator was unresolved.
});
```

- [ ] **Step 2: Run the test and confirm the destructive behavior**

Run: `node --test test/netsu-project.test.cjs`

Expected: FAIL because `readBoardProject()` returns `ref: ""`, the next save stores an empty token,
and `sidecar.sweep()` removes unlisted companion files.

- [ ] **Step 3: Retain durable locators in missing metadata**

Extend the renderer type without changing visible placeholder behavior:

```ts
missing?: {
  name: string;
  size: number;
  kind: string;
  locator?: string;
  frameLocators?: string[];
};
```

In `core/netsu/board.js`, make unresolved `sidecar:` and `ref:` results carry `locator: value`. For a
sequence, retain a locator per frame index in `missing.frameLocators`. Continue returning empty display
paths so the current missing placeholder remains in control.

- [ ] **Step 4: Reuse retained locators during project save**

In `tokenizeProjectItem()` select the durable input before calling `tokenizeProjectRef()`:

```js
const durableRef = item.ref || (item.missing && item.missing.locator) || '';
const frameLocators = (item.missing && item.missing.frameLocators) || [];
const durableFrame = frames[i] || frameLocators[i] || '';
```

Keep `item.missing` when resolution is still incomplete. Return an `unresolved` flag from item
tokenization so `saveBoardProject()` can distinguish an intentionally removed item from a present but
temporarily unavailable one.

- [ ] **Step 5: Suspend orphan cleanup on incomplete resolution**

Replace the empty-document-only cleanup guard with:

```js
const unsafeSweep = unresolved > 0 || (prepared.length === 0 && removed > 0);
const swept = unsafeSweep ? { removed: 0, bytes: 0 } : sweepUnused(session, docId, ctx.keep, keepMediaIds);
```

Expose `unresolved` in the save counts for diagnostics. Do not change explicit cleanup when every
remaining item is resolved.

- [ ] **Step 6: Add and pass sequence-locator coverage**

Add a failing test that removes one sequence frame, opens and saves the project, then verifies the
missing frame's original token remains at the same index and no sibling frames are swept. Run:

`node --test test/netsu-project.test.cjs`

Expected: PASS for scalar and sequence regressions plus the existing explicit-orphan test.

- [ ] **Step 7: Commit the locator protection**

```powershell
git add -- core/netsu/board.js core/netsu/project.js src/components/reference/referenceShared.ts test/netsu-project.test.cjs
git commit -m "fix: preserve unresolved NetsuBoard media"
```

### Task 2: Relocate media from the active `.netsu` root

**Files:**
- Create: `core/netsu/relocate.js`
- Modify: `core/netsu/board.js`
- Modify: `core/netsu/embed.js`
- Test: `test/netsu-project.test.cjs`

- [ ] **Step 1: Write failing relocation tests**

Cover these cases independently:

```js
test('a renamed netsu finds its media in one unambiguous sibling companion folder', () => {});
test('two matching sibling companion candidates remain unresolved', () => {});
test('a referenced user file moved under the netsu root is matched by size and head fingerprint', () => {});
```

Run: `node --test test/netsu-project.test.cjs`

Expected: FAIL because resolution currently checks only the exact stored path.

- [ ] **Step 2: Implement bounded project-root search**

Create `core/netsu/relocate.js` with synchronous read-only helpers:

```js
const MAX_ENTRIES = 10000;

function findCompanionFile(netsuPath, token) {
  // Check the canonical companion first, then sibling *.medias directories.
  // Return a path only when exactly one existing relative candidate matches.
}

function findReferencedFile(netsuPath, mediaRow) {
  // Walk from path.dirname(netsuPath), stop after MAX_ENTRIES, filter by name and size,
  // then compare headSha(candidate) with mediaRow.head_sha. Return one unique match only.
}
```

Export the existing `headSha` from `core/netsu/embed.js`; do not duplicate the 4 MiB identity
algorithm.

- [ ] **Step 3: Use relocation before returning missing placeholders**

In `core/netsu/board.js`:

```js
const relocated = relocate.findCompanionFile(ctx.handle.path, value);
if (relocated) return { path: relocated, missing: null };

const moved = relocate.findReferencedFile(ctx.handle.path, row);
if (moved) return { path: moved, missing: null };
```

Keep traversal protection from `sidecar.resolveSidecar()`. Never choose between multiple candidates.

- [ ] **Step 4: Run core tests and commit**

Run: `node --test test/netsu-project.test.cjs`

Expected: PASS, including traversal rejection and relocation ambiguity.

```powershell
git add -- core/netsu/relocate.js core/netsu/board.js core/netsu/embed.js test/netsu-project.test.cjs
git commit -m "feat: relocate NetsuBoard project media"
```

### Task 3: Recover missing web media sequentially

**Files:**
- Modify: `src/components/reference/boardMediaActions.ts`
- Modify: `src/components/reference/useScenePersistence.ts`
- Test: `test/reference-online-media-ui.test.cjs`

- [ ] **Step 1: Write failing pure-selection and sequential-recovery tests**

Export and test a pure selector:

```ts
export function recoverableOnlineItems(items: BoardItem[]): BoardItem[] {
  return items.filter((item) => {
    const source = item.sourceUrl || item.prevMedia?.sourceUrl;
    if (!source || !/^https?:/i.test(source)) return false;
    if (item.kind === "sequence") return !!item.missing || !(item.frames || []).some(Boolean);
    return (item.kind === "image" || item.kind === "video") && (!!item.missing || !item.ref);
  });
}
```

Add a behavioral test around an injected recovery worker to prove only one item runs at a time and
success/failure counts are returned. Run:

`node --test test/reference-online-media-ui.test.cjs`

Expected: FAIL because no bulk recovery API exists.

- [ ] **Step 2: Generalize recovery for images, videos, and sequences**

Implement a single-item helper that derives the original URL, tries `resolveMedia`, falls back to
`extractMedia`, probes the first recovered media, and patches the existing item while preserving its
geometry and `sourceUrl`. Clear stale sequence-only fields when a lost sequence is restored as its
source media:

```ts
st.patchItem(id, {
  kind,
  ref: path,
  src,
  sourceUrl: url,
  missing: undefined,
  frames: undefined,
  frame: undefined,
  seqIn: undefined,
  seqOut: undefined,
});
```

- [ ] **Step 3: Implement sequential bulk recovery**

```ts
export async function recoverAllOnlineMedia() {
  const ids = recoverableOnlineItems(useBoard.getState().items).map((item) => item.id);
  let recovered = 0;
  for (let index = 0; index < ids.length; index += 1) {
    useBoard.getState().setNotice({
      kind: "ok",
      sticky: true,
      text: tr("notice.recoveringOnline", { current: index + 1, total: ids.length }),
    });
    if (await recoverMedia(ids[index])) recovered += 1;
  }
  return { total: ids.length, recovered, failed: ids.length - recovered };
}
```

Retry selection reads fresh store state, so successful items are not downloaded twice.

- [ ] **Step 4: Start automatic recovery after project open**

After `loadScene()` and file-path binding in `openProject()`, schedule bulk recovery. If at least one
item succeeds, call `saveProject()` so normal adoption moves the downloaded global asset into the
project companion folder. Keep failures missing and retryable.

- [ ] **Step 5: Run renderer contract tests and commit**

Run: `node --test test/reference-online-media-ui.test.cjs`

Expected: PASS for selection, sequential execution, provenance retention, and autosave integration.

```powershell
git add -- src/components/reference/boardMediaActions.ts src/components/reference/useScenePersistence.ts test/reference-online-media-ui.test.cjs
git commit -m "feat: recover missing NetsuBoard web media"
```

### Task 4: Add the toolbar retry action and translations

**Files:**
- Modify: `src/components/reference/Toolbar.tsx`
- Modify: `src/locales/fr/reference.json`
- Modify: `src/locales/en/reference.json`
- Modify: `src/locales/es/reference.json`
- Modify: `src/locales/de/reference.json`
- Modify: `src/locales/ja/reference.json`
- Modify: `src/locales/zh/reference.json`
- Test: `test/reference-online-media-ui.test.cjs`

- [ ] **Step 1: Write the failing toolbar contract test**

Assert that `Toolbar.tsx` derives the count from `recoverableOnlineItems(items)`, renders a compact
Base UI button beside the notice only when the count is non-zero, calls `recoverAllOnlineMedia()`, and
then calls `onSave` after a successful recovery.

Run: `node --test test/reference-online-media-ui.test.cjs`

Expected: FAIL because the retry action is absent.

- [ ] **Step 2: Add localized copy in all six locales**

Add equivalent keys under `notice`:

```json
{
  "redownloadAll": "Retélécharger tout ({{count}})",
  "recoveryResult": "{{recovered}} récupéré(s), {{failed}} échec(s)"
}
```

Use natural translations rather than copying French to other locales.

- [ ] **Step 3: Render the compact retry action**

Import `RotateCw`, `recoverableOnlineItems`, and `recoverAllOnlineMedia`. Select `items` from the store,
derive the count, and render a small `Button` beside the current notice:

```tsx
{recoverableCount > 0 && (
  <Button variant="ghost" size="xs" onClick={() => void retryMissing()}>
    <RotateCw />
    {t("notice.redownloadAll", { count: recoverableCount })}
  </Button>
)}
```

The handler reports recovered/failed counts and invokes `onSave?.()` only when recovery changed at
least one item.

- [ ] **Step 4: Run focused and repository verification**

Run separately:

```powershell
node --test test/netsu-project.test.cjs test/reference-online-media-ui.test.cjs
npm run check:core
npm run check:i18n
npm run build
node --test test/*.test.cjs
npx react-doctor@latest --verbose --scope changed
git diff --check
```

Expected: zero test failures, successful core and renderer builds, locale parity across all six
languages, no React Doctor score regression, and no whitespace errors.

- [ ] **Step 5: Commit the UI and translations**

```powershell
git add -- src/components/reference/Toolbar.tsx src/locales/*/reference.json test/reference-online-media-ui.test.cjs
git commit -m "feat: retry missing NetsuBoard media"
```

### Task 5: Runtime handoff

**Files:**
- No source changes.

- [ ] **Step 1: Verify the working tree and commit list**

Run:

```powershell
git status --short
git log -5 --oneline
```

Expected: clean working tree and focused commits for locator protection, relocation, web recovery,
and the toolbar action.

- [ ] **Step 2: Report the runtime boundary**

Core changes require a Tauri window restart before the running application can exercise relocation or
cleanup protection. Do not claim interactive runtime verification unless the user restarts and tests
the real app. Do not modify the existing user `test.netsu` or attempt to reconstruct unrecoverable
bytes automatically during tests.
