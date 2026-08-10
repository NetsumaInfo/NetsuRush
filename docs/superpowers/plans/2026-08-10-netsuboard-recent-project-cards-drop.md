# NetsuBoard Recent Project Cards and Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove legacy duplicate recent cards safely, render file-backed projects like internal boards, and open dropped `.netsu` files as projects.

**Architecture:** Infer only strong legacy scene/project matches from stable item identifiers and persist the recovered identity without touching recency. Add a read-only preview channel, share one thumbnail renderer between internal and file-backed boards, and route `.netsu` drops through the existing project-open flow before media ingestion.

**Tech Stack:** Node.js CommonJS core, SQLite `.netsu`, React 19, TypeScript, Base UI context menus, Node test runner.

---

### Task 1: Recover legacy project identity and expose read-only previews

**Files:**
- Modify: `test/netsu-project-recents.test.cjs`
- Modify: `core/netsu/recents.js`
- Modify: `core/netsu.js`

- [ ] **Step 1: Write failing core tests**

Create a legacy project without `sourceSceneId`, keep a same-title internal scene with one extra item, and assert that the strong item-ID overlap is linked while an unrelated same-title scene is ignored. Record `openedAt` before inference and assert it is unchanged. Also assert `modifiedAt` and a read-only preview scene are returned.

```js
const legacy = refStore.saveScene({
  name: 'Legacy',
  items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'newer' }],
  view: null,
});
refStore.saveScene({ name: 'Legacy', items: [{ id: 'x' }, { id: 'y' }, { id: 'z' }], view: null });
await netsu.saveProjectAs(refStore, {
  scene: { name: 'Legacy', items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], view: null },
  destPath,
});
const before = recents.list('board').find((entry) => entry.path === path.resolve(destPath));
const entry = netsu.recentProjects(refStore, 'board').find((item) => item.path === path.resolve(destPath));
assert.equal(entry.sourceSceneId, legacy.id);
assert.equal(entry.openedAt, before.openedAt);
assert.ok(entry.modifiedAt > 0);
assert.equal(netsu.previewProject(refStore, destPath).scene.items.length, 3);
```

- [ ] **Step 2: Run RED**

Run: `node --test test/netsu-project-recents.test.cjs`

Expected: FAIL because inference, `modifiedAt`, and `previewProject` do not exist.

- [ ] **Step 3: Implement the core behavior**

Add `modifiedAt` to `recents.list()` from `fs.statSync(path).mtimeMs`. Add `linkSource(filePath, sourceSceneId)` that rewrites only the matching raw entry and preserves `openedAt`.

Add `previewProject(refStore, srcPath)` as a read-only wrapper around `importBoard`. Add `recentProjects(refStore, type)` that loads unlinked board previews, compares same-title scene item IDs, requires at least 80 percent project coverage and `Math.min(3, projectItemCount)` common IDs, persists the strongest match, and returns the enriched entries.

- [ ] **Step 4: Run GREEN**

Run: `node --test test/netsu-project-recents.test.cjs test/netsu-project.test.cjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- test/netsu-project-recents.test.cjs core/netsu/recents.js core/netsu.js
git commit -m "fix: recover legacy NetsuBoard project identity"
```

### Task 2: Add the preview IPC contract and shared project thumbnails

**Files:**
- Create: `test/netsu-project-preview.test.cjs`
- Modify: `core/rpc.js`
- Modify: `src/lib/coreClient.ts`
- Modify: `src/lib/bridge.ts`
- Modify: `src/components/reference/SceneThumb.tsx`

- [ ] **Step 1: Write the failing IPC and thumbnail contract**

```js
test('project preview is wired through every IPC surface', () => {
  assert.match(rpc, /"netsu:previewProject"/);
  assert.match(client, /previewProject:\s*\(srcPath\)\s*=>\s*call\("netsu:previewProject"/);
  assert.match(bridge, /previewProject\(srcPath:\s*string\):\s*Promise<NetsuImportResult>/);
  assert.match(bridge, /previewProject:\s*async\s*\(\)\s*=>/);
});

test('file projects reuse the board thumbnail renderer', () => {
  assert.match(thumb, /export const ProjectThumb/);
  assert.match(thumb, /previewProject\(path\)/);
  assert.match(thumb, /<BoardThumb items=/);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test test/netsu-project-preview.test.cjs`

Expected: FAIL because the channel and `ProjectThumb` are absent.

- [ ] **Step 3: Implement the channel and thumbnail reuse**

Add `netsu:previewProject` to `core/rpc.js`, `previewProject` to `RefApi` and the core client, and an unavailable browser mock. Add `modifiedAt?: number` to `NetsuRecent`.

Refactor `SceneThumb.tsx` so `BoardThumb` receives already loaded items and owns local-video thumbnails. Keep `SceneThumb` as the internal-scene loader and add `ProjectThumb` that calls `nr.reference.previewProject(path)` without opening a project session.

- [ ] **Step 4: Run GREEN and type-check**

Run: `node --test test/netsu-project-preview.test.cjs`

Run: `npm run build`

Expected: both pass.

- [ ] **Step 5: Commit**

```powershell
git add -- test/netsu-project-preview.test.cjs core/rpc.js src/lib/coreClient.ts src/lib/bridge.ts src/components/reference/SceneThumb.tsx
git commit -m "feat: preview recent NetsuBoard projects"
```

### Task 3: Unify recent-card presentation and route `.netsu` drops

**Files:**
- Modify: `test/reference-home.test.cjs`
- Modify: `src/components/reference/ReferenceHome.tsx`

- [ ] **Step 1: Write failing home-screen contracts**

Require `ProjectThumb`, the modification label, absence of a visible folder paragraph, `.netsu` handling before media filtering, native path resolution, project opening, and a `SceneCard` context-menu open action.

```js
assert.match(source, /<ProjectThumb path=\{entry\.path\}/);
assert.match(source, /relDate\(entry\.modifiedAt\s*\?\?\s*entry\.openedAt\)/);
assert.doesNotMatch(projectCard, /<p[^>]*>\{entry\.missing\s*\?[^:]+:\s*folder\}<\/p>/);
assert.match(source, /\.name\.toLowerCase\(\)\.endsWith\("\.netsu"\)/);
assert.match(source, /nr\.pathsForFiles\(\[projectFile\]\)/);
assert.match(source, /onOpenRecent\(projectPath\)/);
assert.match(sceneCard, /ContextMenuItem[^]*home\.openProjectFile/);
```

- [ ] **Step 2: Run RED**

Run: `node --test test/reference-home.test.cjs`

Expected: FAIL because project cards still show a file icon/path, SceneCard has no context menu, and drops ignore `.netsu`.

- [ ] **Step 3: Implement the unified cards and drop routing**

Render `ProjectThumb` inside the file-backed card and show `home.modified` with `modifiedAt ?? openedAt`; keep the full path only in the tooltip. Wrap `SceneCard` in a Base UI context menu with open, favorite, hide, and delete actions.

Make the home `onDrop` handler asynchronous. Before filtering media, select the first `.netsu`, call `nr.pathsForFiles([projectFile])`, and pass the resolved path to `onOpenRecent`. Return immediately so no blank board or copied scene is created.

- [ ] **Step 4: Run GREEN**

Run: `node --test test/reference-home.test.cjs test/netsu-project-preview.test.cjs`

Run: `npm run build`

Expected: both pass.

- [ ] **Step 5: Commit**

```powershell
git add -- test/reference-home.test.cjs src/components/reference/ReferenceHome.tsx
git commit -m "feat: unify NetsuBoard recent project cards"
```

### Task 4: Verify the complete change

**Files:**
- Verify only.

- [ ] **Step 1: Run focused tests**

Run: `node --test test/netsu-project-recents.test.cjs test/netsu-project-preview.test.cjs test/reference-home.test.cjs`

Expected: PASS.

- [ ] **Step 2: Run repository checks**

```powershell
npm run check:core
npm run check:i18n
npm run build
node --test test/*.test.cjs
```

Expected: every command exits 0.

- [ ] **Step 3: Run React Doctor and Git audits**

```powershell
npx react-doctor@latest --verbose --scope changed
git diff --check
git status --short
```

Expected: no React errors, no whitespace errors, clean worktree.

- [ ] **Step 4: Record the runtime boundary**

Report that core changes require a Tauri restart before the currently running application can demonstrate legacy inference and project previews.
