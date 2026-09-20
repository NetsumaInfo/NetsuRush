const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function editorHarness({ create, update }) {
  let stateIndex = 0;
  const store = {
    createCollection: create, updateCollection: update,
    collectionFolders: [], collectionTags: [], exportProfiles: [],
  };
  const sharingType = () => {};
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: { createElement: jsx, useState: (initial) => [stateIndex++ === 3 ? "My collection" : initial, () => {}], useRef: (current) => ({ current }), useEffect: () => {}, useMemo: (fn) => fn() },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "zustand/react/shallow": { useShallow: (fn) => fn },
    "@/store": { useApp: (selector) => selector(store) },
    // Sharing turns archiving on: without a folder of its own the collection takes the one the app
    // proposes, so the editor asks the core for it before it saves.
    "@/lib/bridge": { nr: { collections: { defaultArchiveDir: async () => ({ dir: "D:/archives/My collection" }) } } },
    "@/features/export/profiles": { EXPORT_AUDIO_OPTIONS: [], EXPORT_CONTAINER_OPTIONS: [] },
    "@/features/export/encodingFields": { useExportEncodingFields: () => ({}) },
    "./CollectionSharingControls": { CollectionSharingControls: sharingType },
    "@/lib/utils": { cn: () => "" },
  };
  const source = fs.readFileSync(path.join(__dirname, "../src/components/collections/FolderEditor.tsx"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  new Function("exports", "require", code)(exports, (id) => modules[id] ?? {});
  const tree = exports.FolderEditor({ open: true, onOpenChange: () => {} });
  function find(node) {
    if (!node || typeof node !== "object") return null;
    if (node.type === sharingType) return node.props;
    for (const child of [node.props?.children].flat(Infinity)) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  }
  return find(tree);
}

test("new collection sharing retries retain the durable id instead of creating duplicates", async () => {
  let creates = 0;
  const created = [];
  const updates = [];
  const controls = editorHarness({
    create: async (patch) => { creates++; created.push(patch); return "collection-1"; },
    update: async (patch) => updates.push(patch),
  });
  assert.ok(controls);
  assert.equal(await controls.saveLocal(), "collection-1");
  // Publication can fail after saving: the next sharing attempt updates the same local document.
  assert.equal(await controls.saveLocal(), "collection-1");
  assert.equal(creates, 1);
  assert.equal(updates[0].id, "collection-1");
  // Sharing is archiving: the saved collection carries the archive it is about to publish.
  assert.equal(created[0].archive.dir, "D:/archives/My collection");
  assert.equal(updates[0].archive.dir, "D:/archives/My collection");
});

test("overlapping sharing saves coalesce and failed local creation is not treated as success", async () => {
  let finish;
  let creates = 0;
  const controls = editorHarness({ create: () => { creates++; return new Promise((resolve) => { finish = resolve; }); }, update: async () => {} });
  // Saving now starts by asking the core where to archive, so the write lands a tick later.
  const settle = async () => { while (!finish) await new Promise(setImmediate); };
  const first = controls.saveLocal();
  const second = controls.saveLocal();
  await settle();
  assert.equal(creates, 1);
  const failCreation = finish;
  finish = undefined;
  failCreation(null);
  await assert.rejects(first, /share.failed/);
  await assert.rejects(second, /share.failed/);
  const retry = controls.saveLocal();
  await settle();
  assert.equal(creates, 2);
  finish("collection-2");
  assert.equal(await retry, "collection-2");
});

