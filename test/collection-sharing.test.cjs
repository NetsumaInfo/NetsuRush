// Sharing a collection sends its ARCHIVE: the same files, produced once, with the settings the user
// chose in the archive card. These tests pin that contract — that nothing is encoded a second time,
// that a source rush is never sent whole, and that a shot the archive did not produce is a loud
// failure rather than a nameless hole in everyone's collection.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCollectionSharing } = require("../core/collectionSharing.js");
const { shotIdentity } = require("../core/archivePlan.js");

const PROFILE = { id: "__archive__", workflow: "video_encode", container: "mp4" };

function fixture(t, archiveImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-collection-sharing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, "archive");
  fs.mkdirSync(store, { recursive: true });
  const source = path.join(dir, "original.mp4");
  fs.writeFileSync(source, "original video bytes");
  let collection = {
    id: "local", name: "Collection", archive: { dir: store },
    shots: [{ id: "shot1", name: "First", path: source, in: 2, out: 4 }],
  };
  const calls = [];
  /** Writes what a real archive would have written, and records which file holds which shot. */
  const produce = (bytes = "archived") => {
    const entries = { ...(collection.archive.entries || {}) };
    collection.shots.forEach((shot, index) => {
      if (String(shot.id).startsWith("ci_")) return;
      const file = path.join(store, `Collection_${String(index + 1).padStart(3, "0")}.mp4`);
      fs.writeFileSync(file, bytes);
      entries[shotIdentity(shot)] = { file, key: `key-${shot.id}` };
    });
    collection = { ...collection, archive: { ...collection.archive, entries, lastAt: Date.now() } };
    return { ok: true };
  };
  const sharing = createCollectionSharing({
    collectionStore: { loadCollection: () => collection, saveCollection: (patch) => { collection = { ...collection, ...patch }; return { ok: true }; } },
    collectionArchive: { archive: async (event, id, opts) => {
      calls.push(opts);
      return archiveImpl ? archiveImpl(opts, { produce, get: () => collection, set: (next) => { collection = next; } }) : produce();
    } },
  });
  return { dir, store, source, calls, sharing, produce,
    get: () => collection, set: (next) => { collection = next; } };
}

test("sharing publishes the archived files and never the source rush", async (t) => {
  const f = fixture(t);
  f.set({ ...f.get(), shots: [...f.get().shots, { id: "shot2", name: "Second", path: f.source, in: 5, out: 7 }] });
  const result = await f.sharing.prepare(null, "local", { dir: f.store, profile: PROFILE, autoSync: true, process: { enabled: false } });
  assert.equal(result.ok, true);
  assert.equal(result.prepared.length, 2);
  // The archive is run with the collection's own settings: one pipeline, one set of files.
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { dir: f.store, profile: PROFILE, autoSync: true, process: { enabled: false } });
  for (const item of result.prepared) {
    assert.equal(path.dirname(item.path), f.store);
    assert.equal(fs.readFileSync(item.path, "utf8"), "archived");
  }
  assert.deepEqual(result.prepared.map((item) => item.duration), [2, 2]);
  assert.equal(fs.readFileSync(f.source, "utf8"), "original video bytes");
  assert.deepEqual(f.get().collaboration.preparedPaths, result.prepared.map((item) => item.path));
  assert.equal(f.get().collaboration.preparedPaths.includes(f.source), false);
});

test("a failed archive publishes nothing", async (t) => {
  const f = fixture(t, () => ({ ok: false, error: "disk full" }));
  const result = await f.sharing.prepare(null, "local", { dir: f.store, profile: PROFILE });
  assert.equal(result.ok, false);
  assert.match(result.error, /disk full/);
});

test("a shot the archive did not record fails instead of publishing a hole", async (t) => {
  const f = fixture(t, (_, tools) => {
    tools.produce();
    const archive = { ...tools.get().archive };
    archive.entries = {};
    tools.set({ ...tools.get(), archive });
    return { ok: true };
  });
  const result = await f.sharing.prepare(null, "local", { dir: f.store, profile: PROFILE });
  assert.equal(result.ok, false);
  assert.match(result.error, /Not archived: First/);
});

test("an archived file that vanished or is empty fails", async (t) => {
  const missing = fixture(t, (_, tools) => {
    tools.produce();
    fs.rmSync(Object.values(tools.get().archive.entries)[0].file);
    return { ok: true };
  });
  assert.match((await missing.sharing.prepare(null, "local", { dir: missing.store, profile: PROFILE })).error, /missing/);

  const empty = fixture(t, (_, tools) => tools.produce(""));
  assert.match((await empty.sharing.prepare(null, "local", { dir: empty.store, profile: PROFILE })).error, /missing/);
});

test("an archive entry that resolves to the source rush is refused", async (t) => {
  const f = fixture(t, (_, tools) => {
    const collection = tools.get();
    tools.set({ ...collection, archive: { ...collection.archive, entries: {
      [shotIdentity(collection.shots[0])]: { file: f.source, key: null },
    } } });
    return { ok: true };
  });
  const result = await f.sharing.prepare(null, "local", { dir: f.store, profile: PROFILE });
  assert.equal(result.ok, false);
  assert.match(result.error, /Source cannot be shared directly/);
  assert.equal(fs.readFileSync(f.source, "utf8"), "original video bytes");
});

test("shots received from other people are never re-published, and a collection of only those never archives", async (t) => {
  const f = fixture(t);
  const remote = { id: "ci_shot9", name: "Theirs", path: path.join(f.dir, "theirs.mp4"), in: 0, out: 3 };
  f.set({ ...f.get(), shots: [...f.get().shots, remote] });
  const mixed = await f.sharing.prepare(null, "local", { dir: f.store, profile: PROFILE });
  assert.deepEqual(mixed.prepared.map((item) => item.shotId), ["shot1"]);

  f.set({ ...f.get(), shots: [remote] });
  const onlyRemote = await f.sharing.prepare(null, "local", { dir: f.store, profile: PROFILE });
  assert.equal(onlyRemote.ok, true);
  assert.deepEqual(onlyRemote.prepared, []);
  assert.equal(f.calls.length, 1, "nothing of our own to archive");
});

test("sharing without an archive folder is refused rather than encoding somewhere hidden", async (t) => {
  const f = fixture(t);
  f.set({ ...f.get(), archive: null });
  const result = await f.sharing.prepare(null, "local", { profile: PROFILE });
  assert.equal(result.ok, false);
  assert.match(result.error, /archive folder/);
  assert.equal(f.calls.length, 0);
});

test("concurrent preparations share one archive run", async (t) => {
  let finish;
  const f = fixture(t, (_, tools) => new Promise((resolve) => {
    finish = () => { tools.produce(); resolve({ ok: true }); };
  }));
  const first = f.sharing.prepare(null, "local", { dir: f.store, profile: PROFILE });
  const second = f.sharing.prepare(null, "local", { dir: f.store, profile: PROFILE });
  while (!finish) await new Promise(setImmediate);
  finish();
  const results = await Promise.all([first, second]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(results[0], results[1]);
});
