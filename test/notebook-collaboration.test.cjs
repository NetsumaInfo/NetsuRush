const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
function load(file, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const result = {};
  new Function('exports', 'require', 'localStorage', code)(result, (id) => dependencies[id] ?? {}, { getItem: () => null, setItem() {} });
  return result;
}
const model = load('src/components/notebook/notebookCollabModel.ts');
function snapshot(text = 'Hello 🌍') {
  return { notebook: { id: 'nb', title: 'Notes', icon: null, scriptId: null, kind: 'notes', language: 'en', updatedAt: 1 },
    pages: [{ id: 'page', notebookId: 'nb', parentId: null, title: 'Page', icon: null, cover: null, orderIdx: 1, updatedAt: 1,
      blocks: [{ id: 'block', type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: { bold: true } }], children: [] }] }], databases: {} };
}
test('notebook rich text round-trips Unicode, marks, links, inline mentions and nested blocks', () => {
  const original = snapshot();
  original.pages[0].blocks[0].content.push({ type: 'link', href: 'https://example.com', content: [{ type: 'text', text: 'link', styles: {} }] }, { type: 'pageMention', props: { pageId: 'other', label: 'Other' } });
  original.pages[0].blocks[0].children.push({ id: 'child', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Child', styles: {} }], children: [] });
  const decoded = model.decodeNotebook(model.encodeNotebook(original), 'nb');
  assert.deepEqual(decoded.pages[0].blocks, original.pages[0].blocks);
});
test('a keystroke produces a scalar-indexed text edit without a full page replacement', () => {
  const before = model.encodeNotebook(snapshot());
  const after = model.encodeNotebook(snapshot('Hello 🌍!'));
  assert.deepEqual(model.diffNotebook(before, after), [{ type: 'surfaceTextInsert', entryId: 'block', field: 'content', index: 7, text: '!' }]);
  assert.deepEqual(model.diffNotebook(before, before), []);
});
test('restoring a deleted block is explicit while unchanged metadata does not revive it', () => {
  const before = model.encodeNotebook(snapshot());
  const removed = before.filter((entry) => entry.entryId !== 'block');
  assert.deepEqual(model.diffNotebook(before, removed), [{ type: 'surfaceDeleteEntry', entryId: 'block' }]);
  assert.equal(model.diffNotebook(removed, before)[0].type, 'surfaceRestoreEntry');
});
test('database ownership follows its containing page', () => {
  const value = snapshot();
  value.pages[0].blocks.push({ id: 'db-block', type: 'database', props: { dbId: 'db' } });
  value.databases.db = { id: 'db', name: 'Tasks', fields: [], rows: [], views: [] };
  assert.equal(model.encodeNotebook(value).find((entry) => entry.entryId === 'db_db').fields.pageId, 'page');
});

test('sharing notebook metadata excludes the local NetsuDraft binding', () => {
  const value = snapshot();
  value.notebook.scriptId = 'private-local-draft';
  const entries = model.encodeNotebook(value);
  assert.equal(Object.hasOwn(entries[0].fields, 'scriptId'), false);
  assert.equal(JSON.stringify(entries).includes('private-local-draft'), false);
});
function storeFixture(savePage) {
  let state;
  const store = load('src/store/notebook.ts', {
    '@/lib/bridge': { nr: { notebook: { savePage } } },
    '@/components/notebook/notebookPrefs': { readPrefs: () => ({}) },
    '@/components/notebook/notebookCollabState': { notebookCanEdit: () => true, notebookCollabState: {} },
    '@/i18n': { default: { t: (key) => key, language: 'en' } },
    '@/lib/errorText': { errorText: (e) => (e instanceof Error ? e.message : String(e)) },
  });
  state = store.createNotebookSlice((patch) => { Object.assign(state, typeof patch === 'function' ? patch(state) : patch); }, () => state);
  Object.assign(state, { nbActiveId: 'nb', nbActivePageId: 'page', nbPage: snapshot().pages[0], nbDirty: true });
  return state;
}
test('failed notebook save stays dirty and can be retried without another keystroke', async () => {
  let reject = true;
  const state = storeFixture(async () => reject ? { ok: false, error: 'Disk full' } : { ok: true });
  await assert.rejects(state.nbFlushPage(), /Disk full/);
  assert.equal(state.nbDirty, true);
  assert.equal(state.nbSaveError, 'Disk full');
  reject = false;
  await state.nbFlushPage();
  assert.equal(state.nbDirty, false);
  assert.equal(state.nbSaveError, null);
});
test('edits while saving are serialized and the latest snapshot is acknowledged', async () => {
  let release;
  const captured = [];
  const state = storeFixture(async (page) => { captured.push(page); if (captured.length === 1) await new Promise((resolve) => { release = resolve; }); return { ok: true }; });
  const first = state.nbFlushPage();
  state.nbSetPageBlocks(snapshot('Later').pages[0].blocks);
  const second = state.nbFlushPage();
  release();
  await Promise.all([first, second]);
  assert.equal(captured.length, 2);
  assert.equal(captured[1].blocks[0].content[0].text, 'Later');
  assert.equal(state.nbDirty, false);
});
