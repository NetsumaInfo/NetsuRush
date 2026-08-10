# NetsuBoard Web Provenance and Project Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the original URL on every web-imported image and video so existing website/embed actions always appear, and add a right-click action that reveals recent `.netsu` files in Explorer.

**Architecture:** Keep `BoardItem.sourceUrl` as the only provenance field and fix the ingestion boundaries that currently drop it. Add a renderer-only `revealPath` bridge method backed by the installed Tauri opener plugin, then expose it from the reusable recent-project card context menu.

**Tech Stack:** React 19, TypeScript, Base UI context menus, Tauri v2 opener plugin, Node test runner.

---

### Task 1: Preserve provenance for every remote-media route

**Files:**
- Modify: `test/reference-online-media-ui.test.cjs`
- Modify: `src/components/reference/useBoardIngest.ts`

- [ ] **Step 1: Write the failing provenance contracts**

Add assertions requiring direct image/video placement, downloaded assets, and Giphy CDN resolution to retain the user-entered URL:

```js
test('every remote image and video keeps the user-entered source URL', () => {
  assert.match(source, /place\("image",\s*url,\s*url,\s*nat,\s*undefined,\s*at,\s*\{\s*sourceUrl\s*\}\)/);
  assert.match(source, /place\("video",\s*url,\s*url,\s*nat,\s*undefined,\s*at,\s*\{\s*sourceUrl\s*\}\)/);
  assert.match(source, /place\(res\.kind,\s*res\.path,\s*src,\s*nat,\s*undefined,\s*at,\s*\{\s*sourceUrl\s*\}\)/);
  assert.match(source, /addRemoteMedia\(gif,\s*"image",\s*at,\s*text\)/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/reference-online-media-ui.test.cjs`

Expected: FAIL because the current helpers drop `sourceUrl`.

- [ ] **Step 3: Thread the original URL through the ingestion helpers**

Give `addImageUrl`, `addVideoFileUrl`, and `addRemoteMedia` an optional `sourceUrl = url`. Pass `{ sourceUrl }` to every `place` call, propagate it through hotlink fallbacks, and call `addRemoteMedia(gif, "image", at, text)` for Giphy so the page URL drives the toolbar.

```ts
const addVideoFileUrl = useCallback(
  async (url: string, at?: Point, sourceUrl = url) => {
    const nat = await probeVideo(url);
    place("video", url, url, nat, undefined, at, { sourceUrl });
  },
  [place],
);
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/reference-online-media-ui.test.cjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- test/reference-online-media-ui.test.cjs src/components/reference/useBoardIngest.ts
git commit -m "fix: preserve web media provenance"
```

### Task 2: Add a renderer bridge for selecting files in Explorer

**Files:**
- Create: `test/reveal-path.test.cjs`
- Modify: `src/lib/coreClient.ts`
- Modify: `src/lib/bridge.ts`

- [ ] **Step 1: Write the failing bridge contract**

```js
test('renderer bridge reveals an exact local file in its directory', () => {
  assert.match(client, /revealItemInDir/);
  assert.match(client, /revealPath:\s*\(p\)\s*=>\s*revealPath\(p\)/);
  assert.match(bridge, /revealPath\(path:\s*string\):\s*Promise<boolean>/);
  assert.match(bridge, /revealPath:\s*async\s*\(\)\s*=>\s*false/);
});
```

- [ ] **Step 2: Run the contract and verify RED**

Run: `node --test test/reveal-path.test.cjs`

Expected: FAIL because `revealPath` does not exist.

- [ ] **Step 3: Implement the narrow bridge method**

```ts
async function revealPath(path: string): Promise<boolean> {
  if (!path || !isTauri) return false;
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
    return true;
  } catch {
    return false;
  }
}
```

Expose it from the client, add it to `NrApi`, and return `false` in the browser mock.

- [ ] **Step 4: Run the contract and verify GREEN**

Run: `node --test test/reveal-path.test.cjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- test/reveal-path.test.cjs src/lib/coreClient.ts src/lib/bridge.ts
git commit -m "feat: reveal local files from NetsuRush"
```

### Task 3: Add the project-card context menu

**Files:**
- Modify: `test/reference-home.test.cjs`
- Modify: `src/components/reference/ReferenceHome.tsx`
- Modify: `src/locales/de/reference.json`
- Modify: `src/locales/en/reference.json`
- Modify: `src/locales/es/reference.json`
- Modify: `src/locales/fr/reference.json`
- Modify: `src/locales/ja/reference.json`
- Modify: `src/locales/zh/reference.json`

- [ ] **Step 1: Write the failing project-card contract**

```js
test('recent project cards reveal their netsu file from a context menu', () => {
  assert.match(source, /ContextMenuTrigger/);
  assert.match(source, /nr\.revealPath\(entry\.path\)/);
  assert.match(source, /nr\.openPath\(folder\)/);
  assert.match(source, /t\("home\.openProjectLocation"\)/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/reference-home.test.cjs test/reveal-path.test.cjs`

Expected: FAIL because `ProjectCard` has no context menu.

- [ ] **Step 3: Implement the reusable context menu**

Wrap `ProjectCard` in the project Base UI context-menu primitives. Add **Open project**, **Open file location**, and **Remove from list**. Reveal the exact `.netsu`; if that fails, open the recorded parent folder:

```ts
const reveal = async () => {
  if (await nr.revealPath(entry.path)) return;
  if (folder) await nr.openPath(folder);
};
```

Add French source strings and translations to all six locales:

```json
"openProjectFile": "Ouvrir le projet",
"openProjectLocation": "Ouvrir l’emplacement"
```

- [ ] **Step 4: Run focused UI and locale checks**

Run: `node --test test/reference-home.test.cjs test/reveal-path.test.cjs`

Run: `npm run check:i18n`

Expected: both commands pass.

- [ ] **Step 5: Commit**

```powershell
git add -- test/reference-home.test.cjs src/components/reference/ReferenceHome.tsx src/locales/*/reference.json
git commit -m "feat: reveal recent NetsuBoard projects"
```

### Task 4: Verify the complete change

**Files:**
- Verify only; no planned production edits.

- [ ] **Step 1: Run focused contracts**

Run: `node --test test/reference-online-media-ui.test.cjs test/reference-home.test.cjs test/reveal-path.test.cjs`

Expected: PASS.

- [ ] **Step 2: Run repository checks separately**

```powershell
npm run check:core
npm run check:i18n
npm run build
node --test test/*.test.cjs
```

Expected: each command exits with code 0.

- [ ] **Step 3: Run React Doctor and repository audits**

```powershell
npx react-doctor@latest --verbose --scope changed
git diff --check
git status --short
```

Expected: no React errors, no whitespace errors, and only intentional changes before final commit state.

- [ ] **Step 4: Record the runtime boundary**

Report static test and production-build evidence. Do not claim Explorer selection or live toolbar behavior was interactively verified without restarting and exercising the Tauri application.
