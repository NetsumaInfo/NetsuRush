# NetsuFlow Studio Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hidden, engine-neutral NetsuFlow Studio foundation to NetsuRush using a deterministic fake editor adapter, without starting HyperFrames UI, Resolve publishing, or the AI redesign.

**Architecture:** The existing Node core owns editor sessions and an adapter registry. Three new RPC calls expose status, composition listing, and session lifecycle to a lazy-loaded React module. A deterministic fake adapter proves that the generic contracts and UI capability handling do not depend on HyperFrames DOM concepts.

**Tech Stack:** Node.js 22 CommonJS core, React 19, TypeScript, Zustand 5, Vite 7, existing NetsuRush HTTP RPC/SSE bridge, Node test runner, six i18next locales.

---

## Preconditions

- Gate 0 in `studio/plans/00-evidence-roadmap.md` is complete.
- T01 has a dated report, even though this foundation uses only the fake adapter.
- Work runs in an isolated worktree and does not launch, close, or rebuild Tauri.
- Existing dirty user changes are preserved.

## File map

Create focused runtime modules:

```text
core/webMotion/editor/contracts.js       validation and canonical public shapes
core/webMotion/editor/adapterRegistry.js adapter registration/lookup
core/webMotion/editor/sessionManager.js  session ownership and cleanup
core/webMotion/editor/fakeAdapter.js     deterministic contract fixture
core/webMotion/editor/index.js           public editor service
test/web-motion-editor.test.cjs          core contract and lifecycle tests

src/store/webMotion.ts                   renderer state/actions
src/components/web-motion/WebMotionStudio.tsx
src/components/web-motion/StudioEmptyState.tsx

src/locales/{fr,en,de,es,ja,zh}/webMotion.json
```

Modify integration points:

```text
core/rpc.js
src/lib/bridge.ts
src/lib/coreClient.ts
src/store/types.ts
src/store/index.ts
src/lib/modules.ts
src/components/nav.ts
src/components/panels.ts
src/locales/i18n.ts
test/i18n.test.cjs or the current locale parity fixture if applicable
```

No HyperFrames npm package is added by this plan.

### Task 1: Define and test common editor contracts

**Files:**
- Create: `core/webMotion/editor/contracts.js`
- Create: `test/web-motion-editor.test.cjs`

- [ ] **Step 1: Write failing contract tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCapabilities, validateProjectRef } = require('../core/webMotion/editor/contracts');

test('capabilities default to false and preserve explicit support', () => {
  assert.deepEqual(normalizeCapabilities({ preview: true, code: true }), {
    preview: true,
    code: true,
    variables: false,
    elementSelection: false,
    canvasTransform: false,
    clipTimeline: false,
    keyframes: false,
    liveBinding: false,
    renderedPublish: false,
  });
});

test('project roots must be absolute and engines must be registered identifiers', () => {
  assert.throws(() => validateProjectRef({ id: 'p1', engine: 'hyperframes', rootPath: 'relative' }), /absolute/i);
  assert.equal(validateProjectRef({ id: 'p1', engine: 'fake', rootPath: 'C:\\fixtures\\studio' }).id, 'p1');
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test test/web-motion-editor.test.cjs`

Expected: FAIL because `core/webMotion/editor/contracts.js` does not exist.

- [ ] **Step 3: Implement minimal contracts**

```js
// @ts-check
const path = require('path');

const CAPABILITY_KEYS = Object.freeze([
  'preview', 'code', 'variables', 'elementSelection', 'canvasTransform',
  'clipTimeline', 'keyframes', 'liveBinding', 'renderedPublish',
]);

function normalizeCapabilities(input = {}) {
  return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, input[key] === true]));
}

function validateProjectRef(value) {
  if (!value || typeof value !== 'object') throw new TypeError('project is required');
  if (typeof value.id !== 'string' || !value.id) throw new TypeError('project id is required');
  if (typeof value.engine !== 'string' || !value.engine) throw new TypeError('engine is required');
  if (typeof value.rootPath !== 'string' || !path.isAbsolute(value.rootPath)) throw new TypeError('project root must be absolute');
  return Object.freeze({ id: value.id, engine: value.engine, rootPath: path.resolve(value.rootPath) });
}

module.exports = { CAPABILITY_KEYS, normalizeCapabilities, validateProjectRef };
```

- [ ] **Step 4: Run focused tests**

Run: `node --test test/web-motion-editor.test.cjs`

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/webMotion/editor/contracts.js test/web-motion-editor.test.cjs
git commit -m "feat: define web motion editor contracts"
```

### Task 2: Add adapter registry and deterministic fake adapter

**Files:**
- Create: `core/webMotion/editor/adapterRegistry.js`
- Create: `core/webMotion/editor/fakeAdapter.js`
- Modify: `test/web-motion-editor.test.cjs`

- [ ] **Step 1: Add failing registry tests**

```js
const { createAdapterRegistry } = require('../core/webMotion/editor/adapterRegistry');
const { createFakeAdapter } = require('../core/webMotion/editor/fakeAdapter');

test('registry rejects duplicates and resolves the fake adapter', () => {
  const registry = createAdapterRegistry();
  const fake = createFakeAdapter();
  registry.register(fake);
  assert.equal(registry.require('fake'), fake);
  assert.throws(() => registry.register(fake), /already registered/i);
  assert.throws(() => registry.require('missing'), /not available/i);
});

test('fake adapter exposes deterministic capability-limited composition', async () => {
  const adapter = createFakeAdapter();
  const items = await adapter.listCompositions({ id: 'p1', engine: 'fake', rootPath: 'C:\\fixtures\\studio' });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'fake-main');
  assert.equal(items[0].capabilities.preview, true);
  assert.equal(items[0].capabilities.canvasTransform, false);
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test test/web-motion-editor.test.cjs`

Expected: FAIL because registry and fake adapter modules do not exist.

- [ ] **Step 3: Implement the registry**

```js
// @ts-check
function createAdapterRegistry() {
  const adapters = new Map();
  return {
    register(adapter) {
      if (!adapter || typeof adapter.id !== 'string' || !adapter.id) throw new TypeError('adapter id is required');
      if (adapters.has(adapter.id)) throw new Error(`adapter already registered: ${adapter.id}`);
      adapters.set(adapter.id, adapter);
    },
    require(id) {
      const adapter = adapters.get(id);
      if (!adapter) throw new Error(`editor engine not available: ${id}`);
      return adapter;
    },
    list() {
      return [...adapters.values()].map(({ id, label }) => ({ id, label }));
    },
  };
}

module.exports = { createAdapterRegistry };
```

- [ ] **Step 4: Implement the fake adapter**

```js
// @ts-check
const { normalizeCapabilities } = require('./contracts');

function createFakeAdapter() {
  return {
    id: 'fake',
    label: 'Contract fixture',
    async listCompositions() {
      return [{
        id: 'fake-main',
        name: 'Fake Main',
        sourcePath: 'fake://main',
        width: 1920,
        height: 1080,
        fps: 30,
        durationFrames: 150,
        capabilities: normalizeCapabilities({ preview: true, code: true }),
      }];
    },
    async openSession({ project, compositionId }) {
      return { id: `${project.id}:${compositionId}:session`, projectId: project.id, compositionId, revision: 'fake-r1' };
    },
    async closeSession() {},
  };
}

module.exports = { createFakeAdapter };
```

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test test/web-motion-editor.test.cjs`

Expected: all tests pass.

```bash
git add core/webMotion/editor/adapterRegistry.js core/webMotion/editor/fakeAdapter.js test/web-motion-editor.test.cjs
git commit -m "feat: add editor adapter registry fixture"
```

### Task 3: Add session manager cleanup and conflict tests

**Files:**
- Create: `core/webMotion/editor/sessionManager.js`
- Modify: `test/web-motion-editor.test.cjs`

- [ ] **Step 1: Write failing lifecycle tests**

```js
const { createSessionManager } = require('../core/webMotion/editor/sessionManager');

test('session manager closes the adapter exactly once', async () => {
  let closes = 0;
  const adapter = { id: 'fake', openSession: async () => ({ id: 's1', revision: 'r1' }), closeSession: async () => { closes++; } };
  const manager = createSessionManager({ require: () => adapter });
  const session = await manager.open({ project: { id: 'p1', engine: 'fake', rootPath: 'C:\\fixtures\\studio' }, compositionId: 'fake-main' });
  await manager.close(session.id);
  await manager.close(session.id);
  assert.equal(closes, 1);
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test test/web-motion-editor.test.cjs`

Expected: FAIL because session manager does not exist.

- [ ] **Step 3: Implement session ownership**

```js
// @ts-check
const { validateProjectRef } = require('./contracts');

function createSessionManager(registry) {
  const sessions = new Map();
  return {
    async open(input) {
      const project = validateProjectRef(input.project);
      const adapter = registry.require(project.engine);
      const session = await adapter.openSession({ project, compositionId: String(input.compositionId) });
      if (!session || typeof session.id !== 'string' || sessions.has(session.id)) throw new Error('invalid or duplicate editor session');
      sessions.set(session.id, { adapter, session });
      return session;
    },
    list() { return [...sessions.values()].map((entry) => entry.session); },
    async close(id) {
      const entry = sessions.get(id);
      if (!entry) return false;
      sessions.delete(id);
      await entry.adapter.closeSession(id);
      return true;
    },
    async closeAll() {
      for (const id of [...sessions.keys()]) await this.close(id);
    },
  };
}

module.exports = { createSessionManager };
```

- [ ] **Step 4: Run tests and commit**

Run: `node --test test/web-motion-editor.test.cjs`

Expected: all tests pass.

```bash
git add core/webMotion/editor/sessionManager.js test/web-motion-editor.test.cjs
git commit -m "feat: manage editor sessions"
```

### Task 4: Expose the editor service and RPC channels

**Files:**
- Create: `core/webMotion/editor/index.js`
- Modify: `core/rpc.js`
- Modify: `test/web-motion-editor.test.cjs`

- [ ] **Step 1: Add failing service test**

```js
const { createEditorService } = require('../core/webMotion/editor');

test('editor service lists engines and compositions through one boundary', async () => {
  const editor = createEditorService();
  assert.deepEqual(editor.status().engines.map((item) => item.id), ['fake']);
  const compositions = await editor.listCompositions({ id: 'p1', engine: 'fake', rootPath: 'C:\\fixtures\\studio' });
  assert.equal(compositions[0].id, 'fake-main');
  await editor.close();
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test test/web-motion-editor.test.cjs`

Expected: FAIL because the service entrypoint does not exist.

- [ ] **Step 3: Implement service entrypoint**

```js
// @ts-check
const { createAdapterRegistry } = require('./adapterRegistry');
const { createFakeAdapter } = require('./fakeAdapter');
const { createSessionManager } = require('./sessionManager');
const { validateProjectRef } = require('./contracts');

function createEditorService() {
  const registry = createAdapterRegistry();
  registry.register(createFakeAdapter());
  const sessions = createSessionManager(registry);
  return {
    status: () => ({ engines: registry.list(), sessions: sessions.list() }),
    listCompositions: (project) => registry.require(validateProjectRef(project).engine).listCompositions(validateProjectRef(project)),
    openSession: (input) => sessions.open(input),
    closeSession: (id) => sessions.close(String(id)),
    close: () => sessions.closeAll(),
  };
}

module.exports = { createEditorService };
```

- [ ] **Step 4: Register RPC handlers using the current `createRpc` lifecycle**

Create the service once beside other long-lived module services, close it from
the existing core shutdown path, and add handlers:

```js
"webMotion:editor:status": () => editor.status(),
"webMotion:editor:listCompositions": ([project]) => editor.listCompositions(project),
"webMotion:editor:openSession": ([input]) => editor.openSession(input),
"webMotion:editor:closeSession": ([id]) => editor.closeSession(id),
```

- [ ] **Step 5: Run core typecheck and focused tests**

Run: `node --test test/web-motion-editor.test.cjs`

Expected: all tests pass.

Run: `npm run check:core`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/webMotion/editor/index.js core/rpc.js test/web-motion-editor.test.cjs
git commit -m "feat: expose web motion editor service"
```

### Task 5: Add typed renderer bridge and mock

**Files:**
- Modify: `src/lib/bridge.ts`
- Modify: `src/lib/coreClient.ts`

- [ ] **Step 1: Add public types and API to `bridge.ts`**

```ts
export interface WebMotionCapabilities {
  preview: boolean;
  code: boolean;
  variables: boolean;
  elementSelection: boolean;
  canvasTransform: boolean;
  clipTimeline: boolean;
  keyframes: boolean;
  liveBinding: boolean;
  renderedPublish: boolean;
}

export interface WebMotionProjectRef {
  id: string;
  engine: string;
  rootPath: string;
}

export interface WebMotionCompositionSummary {
  id: string;
  name: string;
  sourcePath: string;
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  capabilities: WebMotionCapabilities;
}

export interface WebMotionEditorApi {
  status(): Promise<{ engines: Array<{ id: string; label: string }>; sessions: unknown[] }>;
  listCompositions(project: WebMotionProjectRef): Promise<WebMotionCompositionSummary[]>;
  openSession(input: { project: WebMotionProjectRef; compositionId: string }): Promise<{ id: string; revision: string }>;
  closeSession(id: string): Promise<boolean>;
}
```

Add `webMotionEditor: WebMotionEditorApi` to `NrApi` and a mock that returns the
fake engine with no sessions/compositions.

- [ ] **Step 2: Implement `coreClient.ts` calls**

```ts
const webMotionEditor: WebMotionEditorApi = {
  status: () => call("webMotion:editor:status"),
  listCompositions: (project) => call("webMotion:editor:listCompositions", [project]),
  openSession: (input) => call("webMotion:editor:openSession", [input]),
  closeSession: (id) => call("webMotion:editor:closeSession", [id]),
};
```

Return it from `makeCoreClient()`.

- [ ] **Step 3: Run renderer build**

Run: `npm run build`

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/bridge.ts src/lib/coreClient.ts
git commit -m "feat: add web motion editor client"
```

### Task 6: Add renderer store

**Files:**
- Create: `src/store/webMotion.ts`
- Modify: `src/store/index.ts`

- [ ] **Step 1: Implement a focused Zustand slice/store following current store composition**

The store state must contain only serializable UI/session state:

```ts
export interface WebMotionState {
  project: WebMotionProjectRef | null;
  compositions: WebMotionCompositionSummary[];
  compositionId: string | null;
  sessionId: string | null;
  loading: boolean;
  error: string | null;
  loadCompositions(project: WebMotionProjectRef): Promise<void>;
  openComposition(id: string): Promise<void>;
  closeSession(): Promise<void>;
}
```

Use `nr.webMotionEditor`, guard async results with the current project/session
identity, and always close the prior session before replacing it.

- [ ] **Step 2: Export/compose the state from `src/store/index.ts` using the existing project pattern**

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/store/webMotion.ts src/store/index.ts
git commit -m "feat: add web motion editor state"
```

### Task 7: Add localized hidden module shell

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/lib/modules.ts`
- Modify: `src/components/nav.ts`
- Modify: `src/components/panels.ts`
- Create: `src/components/web-motion/WebMotionStudio.tsx`
- Create: `src/components/web-motion/StudioEmptyState.tsx`
- Create: `src/locales/fr/webMotion.json`
- Create: `src/locales/en/webMotion.json`
- Create: `src/locales/de/webMotion.json`
- Create: `src/locales/es/webMotion.json`
- Create: `src/locales/ja/webMotion.json`
- Create: `src/locales/zh/webMotion.json`
- Modify: locale namespace registration file discovered from current `src/locales/` implementation

- [ ] **Step 1: Add `webMotion` to the shared `TabId`, `MODULE_IDS`, navigation, and lazy panel map**

Use a Lucide icon already present in the lockfile. The visible French source
wording is:

```json
{
  "title": "NetsuFlow",
  "noProject": "Ouvrez un projet de motion design pour commencer.",
  "openProject": "Ouvrir un projet",
  "engine": "Moteur",
  "composition": "Composition",
  "previewUnavailable": "Aucun aperçu disponible"
}
```

Translate the same keys into the other five locale files; do not hard-code UI
copy in components.

- [ ] **Step 2: Implement the developer-gated shell**

`WebMotionStudio.tsx` renders the existing NetsuRush layout primitives and
`StudioEmptyState` when no project is registered. Until the product gate is
approved, the module is hidden by default through the existing module
preference/migration mechanism rather than a hard-coded production exposure.

- [ ] **Step 3: Verify locale parity**

Run: `npm run check:i18n`

Expected: exit 0 and all six locales have equal keys.

- [ ] **Step 4: Verify renderer build**

Run: `npm run build`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/store/types.ts src/lib/modules.ts src/components/nav.ts src/components/panels.ts src/components/web-motion src/locales
git commit -m "feat: add NetsuFlow Studio shell"
```

### Task 8: Add composition list and capability-driven empty preview

**Files:**
- Create: `src/components/web-motion/ProjectPanel.tsx`
- Create: `src/components/web-motion/PreviewPanel.tsx`
- Create: `src/components/web-motion/InspectorPanel.tsx`
- Modify: `src/components/web-motion/WebMotionStudio.tsx`
- Modify: all six `src/locales/*/webMotion.json`

- [ ] **Step 1: Render composition selection from store data**

The project panel lists composition name, resolution, fps, duration, and engine.
Selection opens exactly one session and closes the previous one.

- [ ] **Step 2: Render capability-driven panels**

`PreviewPanel` renders a deterministic fake preview label only when
`capabilities.preview` is true. `InspectorPanel` lists supported capabilities
and disables unsupported actions with the project Tooltip component, never a
native `title` attribute.

- [ ] **Step 3: Add loading, empty, disconnected, and error states to all six locales**

- [ ] **Step 4: Run checks**

Run: `npm run check:i18n`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/web-motion src/locales
git commit -m "feat: show editor compositions and capabilities"
```

### Task 9: Run the complete foundation verification

**Files:**
- Modify: `studio/tests/results/` only to add the dated implementation report

- [ ] **Step 1: Run focused and repository checks separately**

```bash
node --test test/web-motion-editor.test.cjs
npm run check:core
npm run check:i18n
npm run build
```

Expected: every command exits 0. Do not combine commands in a way that hides the
first failure.

- [ ] **Step 2: Run all Node suites if the focused checks pass**

Run: `node --test test/*.test.cjs`

Expected: exit 0. If unrelated pre-existing failures occur, record exact names
and reproduce them against the unchanged base before classifying them.

- [ ] **Step 3: Inspect the task-specific diff**

Run: `git diff -- core/webMotion/editor test/web-motion-editor.test.cjs src/lib/bridge.ts src/lib/coreClient.ts src/store src/components/nav.ts src/components/panels.ts src/components/web-motion src/locales studio/tests/results`

Expected: only the foundation scope described by this plan.

- [ ] **Step 4: Record evidence**

Create `studio/tests/results/foundation-YYYY-MM-DD/report.md` with exact commands,
exit codes, versions, environment, unverified runtime behavior, and known gaps.
Do not claim Tauri runtime behavior because this plan does not launch the app.

- [ ] **Step 5: Commit the report**

```bash
git add studio/tests/results/foundation-YYYY-MM-DD/report.md
git commit -m "docs: record Studio foundation verification"
```

## Completion boundary

This plan completes only an engine-neutral hidden foundation. It does not claim:

- HyperFrames SDK/Player/Studio integration;
- a real preview;
- Media Pool assets;
- Resolve publishing;
- AI agent behavior;
- Remotion runtime support;
- runtime validation in a running Tauri window.

Those claims require the later evidence gates and separate implementation plans.

