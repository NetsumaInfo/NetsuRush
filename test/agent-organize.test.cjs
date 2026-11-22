// Sorting through MCP: an agent files rushes, collections, shots and Resolve clips into folders it
// names by path, and never loses an item into a folder that does not exist. The library and the
// collections run on their real stores; the Resolve Media Pool runs on a fake that mirrors the
// scripting API (AddSubFolder accepts duplicate names, MoveClips/MoveFolders take object lists).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildDomainTool } = require("../core/agent/tools/app/domain.js");
const { createJobs } = require("../core/agent/jobs.js");
const { createLibraryStore } = require("../core/library.js");
const { createCollectionStore } = require("../core/collections.js");
const { createMediaPoolOps, mediaPoolRisk } = require("../core/agent/tools/mediaPool.js");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `nr-org-${p}-`));

function libraryTool() {
  const store = createLibraryStore(tmp("lib"), {});
  const table = {
    "library:list": () => store.listItems(),
    "library:listFolders": () => store.listFolders(),
    "library:saveFolder": ([f]) => store.saveFolder(f),
    "library:move": ([id, folderId]) => store.moveItem(id, folderId),
    "library:deleteFolder": ([id, withItems]) => store.deleteFolder(id, withItems),
    "library:addPaths": ([paths, folderId]) => store.addPaths(paths, folderId),
  };
  const invoke = async (ch, args = []) => table[ch](args);
  return { store, tool: buildDomainTool(require("../core/agent/tools/app/library.js"), { invoke, jobs: createJobs() }) };
}

async function importTwo(store, tool) {
  const dir = tmp("media");
  const a = path.join(dir, "a.mp4");
  const b = path.join(dir, "b.mp4");
  fs.writeFileSync(a, "x");
  fs.writeFileSync(b, "x");
  await tool.handler({ action: "add_paths", paths: [a, b] }, {});
  return store.listItems().map((i) => i.id);
}

test("library: a move to a path creates the nested folders once and files every item", async () => {
  const { store, tool } = libraryTool();
  const ids = await importTwo(store, tool);
  const r = await tool.handler({ action: "move", ids, folder: "Anime/OP" }, {});
  assert.equal(r.ok, true);
  assert.equal(r.moved, 2);
  const again = await tool.handler({ action: "move", ids: [ids[0]], folder: "anime/op" }, {});
  assert.equal(again.folderId, r.folderId, "an existing path is reused, case aside");
  const folders = (await tool.handler({ action: "folders" }, {})).folders;
  assert.deepEqual(folders.map((f) => f.path).sort(), ["Anime", "Anime/OP"]);
  assert.ok(store.listItems().every((i) => i.folderId === r.folderId));
  const listed = await tool.handler({ action: "list", folder: "Anime/OP" }, {});
  assert.equal(listed.total, 2);
});

test("library: an unknown folderId is refused instead of hiding the item", async () => {
  const { store, tool } = libraryTool();
  const ids = await importTwo(store, tool);
  await assert.rejects(tool.handler({ action: "move", ids, folderId: "nope" }, {}), /unknown folderId/);
  assert.ok(store.listItems().every((i) => i.folderId === null));
  await tool.handler({ action: "create_folder", folder: "Rushes/Ep1" }, {});
  const byPath = await tool.handler({ action: "move", ids, folderId: "Rushes/Ep1" }, {});
  assert.equal(byPath.ok, true, "a path passed where an id is expected still lands in the right folder");
});

test("library: folders rename, move without cycles, and delete by path", async () => {
  const { tool } = libraryTool();
  await tool.handler({ action: "create_folder", folder: "A/B/C" }, {});
  const cycle = await tool.handler({ action: "move_folder", folder: "A", to: "A/B" }, {});
  assert.equal(cycle.ok, false);
  assert.equal((await tool.handler({ action: "move_folder", folder: "A/B/C", to: "" }, {})).ok, true);
  assert.equal((await tool.handler({ action: "rename_folder", folder: "C", name: "Final" }, {})).ok, true);
  const removed = await tool.handler({ action: "delete_folder", folder: "A/B" }, {});
  assert.equal(removed.ok, true);
  const paths = (await tool.handler({ action: "folders" }, {})).folders.map((f) => f.path).sort();
  assert.deepEqual(paths, ["A", "Final"]);
});

function collectionsTool() {
  const store = createCollectionStore(tmp("coll"));
  const table = {
    "collections:list": () => store.listCollections(),
    "collections:load": ([id]) => store.loadCollection(id),
    "collections:save": ([c]) => store.saveCollection(c),
    "collections:addShots": ([id, shots]) => store.addShots(id, shots),
    "collections:removeShot": ([id, shotId]) => store.removeShot(id, shotId),
    "collections:listFolders": () => store.listFolders(),
    "collections:saveFolder": ([f]) => store.saveFolder(f),
    "collections:deleteFolder": ([id]) => store.deleteFolder(id),
    "collections:move": ([id, folderId]) => store.moveCollection(id, folderId),
  };
  const invoke = async (ch, args = []) => table[ch](args);
  return { store, tool: buildDomainTool(require("../core/agent/tools/app/collections.js"), { invoke, jobs: createJobs() }) };
}

test("collections: shots move between collections with their metadata, once", async () => {
  const { store, tool } = collectionsTool();
  const from = store.saveCollection({ name: "from" }).id;
  const to = store.saveCollection({ name: "to" }).id;
  store.addShots(from, [
    { path: "a.mp4", in: 0, out: 1, inFrame: 0, outFrame: 23, tags: ["fight"], rating: 4, note: "keep" },
    { path: "b.mp4", in: 0, out: 1, inFrame: 0, outFrame: 23 },
  ]);
  const [a, b] = store.loadCollection(from).shots;
  const copied = await tool.handler({ action: "move_shots", id: from, toId: to, shotIds: [a.id], copy: true }, {});
  assert.equal(copied.added, 1);
  assert.equal(store.loadCollection(from).shots.length, 2, "copy keeps the source");
  const moved = await tool.handler({ action: "move_shots", id: from, toId: to, shotIds: [a.id, b.id, "ghost"] }, {});
  assert.equal(moved.added, 1);
  assert.equal(moved.alreadyThere, 1, "the shot copied earlier is not duplicated");
  assert.deepEqual(moved.notFound, ["ghost"]);
  assert.equal(store.loadCollection(from).shots.length, 0);
  const landed = store.loadCollection(to).shots.find((s) => s.path === "a.mp4");
  assert.deepEqual([landed.tags, landed.rating, landed.note], [["fight"], 4, "keep"]);
});

test("collections: filed by path, several at once", async () => {
  const { store, tool } = collectionsTool();
  const one = (await tool.handler({ action: "save", collection: { name: "one" }, folder: "Projects/AMV" }, {})).id;
  const two = store.saveCollection({ name: "two" }).id;
  const r = await tool.handler({ action: "move", ids: [two], folder: "Projects/AMV" }, {});
  assert.equal(r.ok, true);
  assert.equal(store.loadCollection(one).folderId, r.folderId);
  assert.equal(store.loadCollection(two).folderId, r.folderId);
  assert.equal((await tool.handler({ action: "rename_folder", folder: "Projects", name: "a/b" }, {})).ok, false);
});

// --- Resolve Media Pool --------------------------------------------------------------------------

let seq = 0;
function fakeFolder(name, parent = null) {
  const f = {
    name, parent, subs: [], clips: [], uid: `f${(seq += 1)}`,
    GetName: async () => f.name,
    GetSubFolderList: async () => [...f.subs],
    GetClipList: async () => [...f.clips],
    GetUniqueId: async () => f.uid,
  };
  return f;
}
function fakeClip(file, folder) {
  const c = {
    file, folder, name: path.basename(file), color: "", uid: `c${(seq += 1)}`,
    GetName: async () => c.name,
    SetName: async (n) => { c.name = n; return true; },
    GetClipProperty: async () => c.file,
    GetUniqueId: async () => c.uid,
    GetClipColor: async () => c.color,
    SetClipColor: async (col) => { c.color = col; return true; },
    ClearClipColor: async () => { c.color = ""; return true; },
  };
  folder.clips.push(c);
  return c;
}
function fakePool() {
  const root = fakeFolder("Master");
  let current = root;
  const mp = {
    AddSubFolder: async (parent, name) => { const f = fakeFolder(name, parent); parent.subs.push(f); return f; },
    MoveClips: async (clips, dest) => {
      for (const c of clips) { c.folder.clips.splice(c.folder.clips.indexOf(c), 1); c.folder = dest; dest.clips.push(c); }
      return true;
    },
    MoveFolders: async (folders, dest) => {
      for (const f of folders) { f.parent.subs.splice(f.parent.subs.indexOf(f), 1); f.parent = dest; dest.subs.push(f); }
      return true;
    },
    DeleteFolders: async (folders) => { for (const f of folders) f.parent.subs.splice(f.parent.subs.indexOf(f), 1); return true; },
    GetCurrentFolder: async () => current,
    SetCurrentFolder: async (f) => { current = f; return true; },
    ImportMedia: async (paths) => paths.map((p) => fakeClip(p, current)),
  };
  return { root, mp, ops: createMediaPoolOps(mp, root), current: () => current };
}

test("media pool: clips are filed into nested bins, created once", async () => {
  const { root, ops } = fakePool();
  fakeClip("D:/r/a.mp4", root);
  fakeClip("D:/r/b.mp4", root);
  const r = await ops.run({ action: "move_clips", paths: ["d:/r/A.mp4", "D:/r/b.mp4", "D:/r/missing.mp4"], folder: "Rushes/Ep1" });
  assert.equal(r.moved, 2);
  assert.deepEqual(r.notFound, ["d:/r/missing.mp4"]);
  await ops.run({ action: "create_folder", folder: "rushes/Ep1/Fights" });
  const tree = (await ops.run({ action: "list_folders" })).folders.map((f) => `${f.path}:${f.clips}`);
  assert.deepEqual(tree, [":0", "Rushes:0", "Rushes/Ep1:2", "Rushes/Ep1/Fights:0"], "existing bins are reused, never duplicated");
  const listed = (await ops.run({ action: "list_clips", folder: "Rushes/Ep1", recursive: false })).clips;
  assert.deepEqual(listed.map((c) => c.bin), ["Rushes/Ep1", "Rushes/Ep1"]);
});

test("media pool: bins move, never into themselves, and imports land in the asked bin", async () => {
  const { ops, current, root } = fakePool();
  await ops.run({ action: "create_folder", folder: "A/B" });
  await assert.rejects(ops.run({ action: "move_folder", folder: "A", to: "A/B/C" }), /./);
  await ops.run({ action: "move_folder", folder: "A/B", to: "" });
  assert.deepEqual((await ops.run({ action: "list_folders" })).folders.map((f) => f.path), ["", "A", "B"]);
  const imported = await ops.run({ action: "import", paths: ["D:/x.mov"], folder: "Imports/Day1" });
  assert.equal(imported.count, 1);
  assert.equal(current(), root, "the current bin is put back after an import");
  const clip = (await ops.run({ action: "list_clips" })).clips.find((c) => c.path === "D:/x.mov");
  assert.equal(clip.bin, "Imports/Day1");
  await ops.run({ action: "set_clip_color", ids: [clip.id], color: "Orange" });
  await ops.run({ action: "rename_clip", id: clip.id, name: "Intro" });
  const after = (await ops.run({ action: "list_clips", folder: "Imports/Day1" })).clips[0];
  assert.deepEqual([after.name, after.color], ["Intro", "Orange"]);
  await assert.rejects(ops.run({ action: "delete_folders", folders: [""] }), /./);
});

test("media pool risk: sorting is a write, deleting asks, unknown is destructive", () => {
  assert.equal(mediaPoolRisk({ action: "list_folders" }), "read");
  assert.equal(mediaPoolRisk({ action: "move_clips" }), "write");
  assert.equal(mediaPoolRisk({ action: "move_folder" }), "write");
  assert.equal(mediaPoolRisk({ action: "delete_folders" }), "destructive");
  assert.equal(mediaPoolRisk({ action: "wipe_everything" }), "destructive");
});

// --- In-app chat -----------------------------------------------------------------------------

function inAppSession(duplicateFirst) {
  const { createSession } = require("../core/agent/session");
  const sent = [];
  const executed = [];
  const tools = { netsu_library: { risk: "write", riskFor: (a) => (a.action === "list" ? "read" : "write") } };
  const session = createSession({
    registry: {
      toAnthropicTools: () => [], toOpenAITools: () => [],
      get: (n) => tools[n] || { risk: "write" },
      execute: async (name, input) => { executed.push([name, input.action]); return { ok: true }; },
    },
    permissions: {
      setMode: () => {}, setDuplicateFirst: () => {}, getMode: () => "ask", getDuplicateFirst: () => duplicateFirst,
      respond: () => {}, check: async () => ({ approved: true }),
    },
    broadcast: (ch, p) => sent.push([ch, p]),
  });
  return { run: session.runToolFor("r1"), sent, executed };
}

test("in-app chat: a sort made by the agent tells the screen to refresh", async () => {
  const { run, sent } = inAppSession(false);
  await run("netsu_library", { action: "list" });
  await run("netsu_library", { action: "move", ids: ["a"], folder: "X" });
  const changes = sent.filter(([ch]) => ch === "agent:dataChanged").map(([, p]) => p);
  assert.deepEqual(changes, [{ tool: "netsu_library", action: "move" }], "reads stay silent, the move is announced");
});

test("in-app chat: sorting the library never duplicates the Resolve timeline", async () => {
  const { run, executed } = inAppSession(true);
  await run("netsu_library", { action: "move", ids: ["a"], folder: "X" });
  assert.deepEqual(executed, [["netsu_library", "move"]]);
  await run("resolve_timeline", { action: "add_marker" });
  assert.deepEqual(executed.map(([n]) => n), ["netsu_library", "resolve_timeline", "resolve_timeline"], "a timeline write still gets its copy first");
});
