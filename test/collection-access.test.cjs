const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function fixture() {
  const tables = {
    projects: [{ _id: "project", surface: "collection" }, { _id: "other", surface: "collection" }],
    projectMembers: [
      { _id: "owner-member", projectId: "project", userId: "owner", role: "owner" },
      { _id: "editor-member", projectId: "project", userId: "editor", role: "editor" },
      { _id: "recipient-member", projectId: "project", userId: "recipient", role: "editor" },
      { _id: "viewer-member", projectId: "project", userId: "viewer", role: "viewer" },
    ], collectionEntries: [],
  };
  let userId = "owner", sequence = 0;
  const ctx = { db: {
    get: async (id) => Object.values(tables).flat().find((row) => row._id === id) ?? null,
    query: (table) => ({ withIndex: (_, match) => {
      const conditions = [];
      const q = { eq: (key, value) => { conditions.push([key, value]); return q; } };
      match(q);
      const rows = tables[table].filter((row) => conditions.every(([key, value]) => row[key] === value));
      return { unique: async () => rows[0] ?? null, take: async (n) => rows.slice(0, n) };
    } }),
    insert: async (table, row) => { const id = `row-${++sequence}`; tables[table].push({ ...row, _id: id }); return id; },
    patch: async (id, patch) => Object.assign(Object.values(tables).flat().find((row) => row._id === id), patch),
  } };
  const validators = new Proxy({}, { get: () => () => ({}) });
  const modules = {
    "./_generated/server": { mutation: (definition) => definition.handler, query: (definition) => definition.handler },
    "convex/values": { v: validators },
    "./auth": { authComponent: { safeGetAuthUser: async () => userId ? { _id: userId } : null } },
    "./audit": { recordProjectAudit: async () => {} },
  };
  const load = (file) => {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const exports = {};
    new Function("exports", "require", code)(exports, (id) => modules[id] ?? {});
    return exports;
  };
  // The role lives in `projects.ts` and the delegation in `collectionAccess.ts`: they are one
  // permission model, so both are exercised over the same rows.
  return { api: load("convex/collectionAccess.ts"), projects: load("convex/projects.ts"),
    ctx, tables, as: (user) => { userId = user; },
    member: (id) => tables.projectMembers.find((row) => row.userId === id) };
}

test("an editor removes only their own contributions; the owner governs the whole collection", async () => {
  const f = fixture();
  await f.api.register(f.ctx, { projectId: "project", entryIds: ["ci_owner"] });
  f.as("editor");
  await f.api.register(f.ctx, { projectId: "project", entryIds: ["ci_editor"] });
  f.as("recipient");
  await assert.rejects(f.api.remove(f.ctx, { projectId: "project", entryId: "ci_owner" }), /not permitted/);
  await assert.rejects(f.api.remove(f.ctx, { projectId: "project", entryId: "ci_editor" }), /not permitted/);
  f.as("editor");
  await assert.rejects(f.api.remove(f.ctx, { projectId: "project", entryId: "ci_owner" }), /not permitted/);
  // The owner needs no delegation on their own collection - they can delete the project outright.
  f.as("owner");
  await f.api.remove(f.ctx, { projectId: "project", entryId: "ci_editor" });
  await f.api.remove(f.ctx, { projectId: "project", entryId: "ci_owner" });
  assert.deepEqual(f.tables.collectionEntries.map((row) => row.removed), [true, true]);
});

test("only the owner delegates removal, revocation bites, and a viewer can neither hold it nor write", async () => {
  const f = fixture();
  await f.api.register(f.ctx, { projectId: "project", entryIds: ["ci_one", "ci_two"] });
  f.as("editor");
  await assert.rejects(f.api.setPermission(f.ctx, { projectId: "project", userId: "editor", allowed: true }), /Only the owner/);
  f.as("owner");
  await f.api.setPermission(f.ctx, { projectId: "project", userId: "editor", allowed: true });
  f.as("editor");
  await f.api.remove(f.ctx, { projectId: "project", entryId: "ci_one" });
  f.as("owner");
  await f.api.setPermission(f.ctx, { projectId: "project", userId: "editor", allowed: false });
  // A viewer writes nothing, so it cannot even be granted: a permission parked on a read-only
  // member would come back the day they are promoted, without the owner granting it again.
  await assert.rejects(f.api.setPermission(f.ctx, { projectId: "project", userId: "viewer", allowed: true }), /Only an editor/);
  f.as("editor");
  await assert.rejects(f.api.remove(f.ctx, { projectId: "project", entryId: "ci_two" }), /not permitted/);
  f.as("viewer");
  await assert.rejects(f.api.remove(f.ctx, { projectId: "project", entryId: "ci_two" }), /not permitted/);
  await assert.rejects(f.api.register(f.ctx, { projectId: "project", entryIds: ["ci_forged"] }), /Read-only/);
});

test("demoting an editor to viewer drops the removal they were granted", async () => {
  const f = fixture();
  await f.api.setPermission(f.ctx, { projectId: "project", userId: "editor", allowed: true });
  assert.equal(f.member("editor").canDeleteOthers, true);
  await f.projects.setMemberRole(f.ctx, { projectId: "project", userId: "editor", role: "viewer" });
  assert.equal(f.member("editor").canDeleteOthers, false);
  // Promoted again, they are back to governing only what they contributed.
  await f.projects.setMemberRole(f.ctx, { projectId: "project", userId: "editor", role: "editor" });
  assert.equal(f.member("editor").canDeleteOthers, false);
  f.as("editor");
  await f.api.register(f.ctx, { projectId: "project", entryIds: ["ci_mine"] });
  f.as("owner");
  await f.api.register(f.ctx, { projectId: "project", entryIds: ["ci_theirs"] });
  f.as("editor");
  await assert.rejects(f.api.remove(f.ctx, { projectId: "project", entryId: "ci_theirs" }), /not permitted/);
  await f.api.remove(f.ctx, { projectId: "project", entryId: "ci_mine" });
});

test("authenticated identity owns contributions; forged ids, reuse, cross-project access and resurrection fail", async () => {
  const f = fixture();
  await f.api.register(f.ctx, { projectId: "project", entryIds: ["ci_unique", "ci_unique"], contributorId: "recipient" });
  assert.equal(f.tables.collectionEntries.length, 1);
  assert.equal(f.tables.collectionEntries[0].contributorId, "owner");
  f.as("editor");
  await assert.rejects(f.api.register(f.ctx, { projectId: "project", entryIds: ["ci_unique"] }), /already reserved/);
  await assert.rejects(f.api.register(f.ctx, { projectId: "project", entryIds: ["../../source"] }), /Invalid entry identity/);
  await assert.rejects(f.api.register(f.ctx, { projectId: "other", entryIds: ["ci_other"] }), /unavailable/);
  f.as("owner");
  await f.api.remove(f.ctx, { projectId: "project", entryId: "ci_unique" });
  await assert.rejects(f.api.register(f.ctx, { projectId: "project", entryIds: ["ci_unique"] }), /already reserved/);
  f.as(null);
  await assert.rejects(f.api.list(f.ctx, { projectId: "project" }), /Sign in required/);
});
