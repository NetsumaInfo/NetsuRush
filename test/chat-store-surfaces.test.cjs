// Two windows now save conversations: NetsuPilot and NetsuFlow. They share one
// store, so the thing that can go wrong is silent mixing — a composition thread
// showing up in the Resolve copilot's list, or worse, one overwriting the other
// because both picked the same file name.
//
// NetsuPilot keeps the root directory on purpose: its conversations are already
// there, and moving them for symmetry's sake would lose somebody's history.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createChatStore } = require("../core/agent/store");

const freshStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-chat-store-"));
  return { store: createChatStore(dir), dir };
};

test("a surface's conversations are invisible to the other", () => {
  const { store } = freshStore();
  store.saveConversation({ title: "resolve", messages: [{ role: "user", content: "a" }] });
  store.saveConversation({ title: "compo", messages: [{ role: "user", content: "b" }], surface: "flow" });

  const pilot = store.listConversations();
  const flow = store.listConversations("flow");
  assert.deepEqual(pilot.map((c) => c.title), ["resolve"]);
  assert.deepEqual(flow.map((c) => c.title), ["compo"]);
});

test("NetsuPilot keeps the root directory, so existing history stays found", () => {
  // The migration that never happened is the one that cannot lose anything.
  const { store, dir } = freshStore();
  const saved = store.saveConversation({ title: "ancienne", messages: [] });
  assert.ok(saved.ok);
  assert.ok(
    fs.existsSync(path.join(dir, "chat", `${saved.id}.json`)),
    "a pilot conversation moved out of the root",
  );
});

test("a flow conversation lands in its own subdirectory", () => {
  const { store, dir } = freshStore();
  const saved = store.saveConversation({ title: "compo", messages: [], surface: "flow" });
  assert.ok(fs.existsSync(path.join(dir, "chat", "flow", `${saved.id}.json`)));
});

test("the pilot listing ignores the subdirectory rather than choking on it", () => {
  // It reads the root with readdir; a directory entry that is not a `.json`
  // file has to fall out of the filter, or every pilot listing would throw.
  const { store } = freshStore();
  store.saveConversation({ title: "compo", messages: [], surface: "flow" });
  assert.deepEqual(store.listConversations(), []);
});

test("the same id in two surfaces is two different conversations", () => {
  // Without the per-surface directory these would be one file, and saving in
  // one window would silently overwrite the other's thread.
  const { store } = freshStore();
  store.saveConversation({ id: "shared", title: "pilot side", messages: [{ role: "user", content: "p" }] });
  store.saveConversation({ id: "shared", title: "flow side", messages: [{ role: "user", content: "f" }], surface: "flow" });

  assert.equal(store.loadConversation("shared").title, "pilot side");
  assert.equal(store.loadConversation("shared", "flow").title, "flow side");
});

test("deleting in one surface leaves the other alone", () => {
  const { store } = freshStore();
  store.saveConversation({ id: "shared", title: "pilot side", messages: [] });
  store.saveConversation({ id: "shared", title: "flow side", messages: [], surface: "flow" });

  store.deleteConversation("shared", "flow");
  assert.ok(store.loadConversation("shared"), "deleting the flow copy took the pilot one with it");
  assert.equal(store.loadConversation("shared", "flow"), null);
});

test("a surface name cannot escape the chat directory", () => {
  // The surface reaches the core over IPC. It is ours today, but a path
  // segment built from a caller's string is exactly how a store starts writing
  // outside its own folder.
  const { store, dir } = freshStore();
  const saved = store.saveConversation({ title: "x", messages: [], surface: "../../escape" });
  assert.ok(saved.ok);
  const inside = path.resolve(dir, "chat");
  const written = fs.readdirSync(inside, { recursive: true, encoding: "utf8" })
    .filter((entry) => String(entry).endsWith(".json"));
  assert.ok(written.length > 0, "nothing was written at all");
  assert.ok(
    !fs.existsSync(path.resolve(dir, "escape")) && !fs.existsSync(path.resolve(inside, "..", "..", "escape")),
    "a surface name walked out of the chat directory",
  );
});
