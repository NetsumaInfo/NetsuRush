const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function load(file, dependencies, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  new Function("exports", "require", ...Object.keys(globals), code)(exports, (id) => dependencies[id] ?? {}, ...Object.values(globals));
  return exports;
}
function preferences(stored = null) {
  let value = stored;
  let storage;
  const api = load("src/lib/collab/preferences.ts", {}, {
    localStorage: { getItem: () => value, setItem: (_, next) => { value = next; } },
    window: { addEventListener: (_, fn) => { storage = fn; } },
  });
  return { api, stored: () => value, external: (next) => { value = next; storage({ key: "netsurush.collab.preferences.v1" }); } };
}
test("cadence validates persisted values and excludes unknown surfaces", () => {
  const { api } = preferences('{"profile":"bad","overrides":{"notebook":"economy","board":"live","draft":"live","collection":50}}');
  assert.deepEqual(api.getCollabPreferences(), { profile: "balanced", overrides: { notebook: "economy" } });
  assert.deepEqual(api.getCollabCadence("notebook"), { batchMs: 900, mediaConcurrency: 1, autoDownload: false });
  assert.equal(api.getCollabCadence("collection").batchMs, 200);
  assert.equal(preferences("invalid json").api.getCollabPreferences().profile, "balanced");
});

test("new devices default to live writing and allow an explicit global economy profile", () => {
  const { api } = preferences();
  assert.equal(api.getCollabCadence("notebook").batchMs, 60);
  assert.equal(api.getCollabCadence("notebook-page").batchMs, 60);
  assert.equal(api.getCollabCadence("collection").batchMs, 200);
  api.setCollabPreferences({ profile: "economy", overrides: {} });
  assert.equal(api.getCollabCadence("notebook").batchMs, 900);
});
test("preferences persist across reload and notify both local and external subscribers", () => {
  const state = preferences();
  let updates = 0;
  const stop = state.api.subscribeCollabPreferences(() => updates++);
  state.api.setCollabPreferences({ profile: "live", overrides: { "notebook-page": "economy" } });
  assert.equal(preferences(state.stored()).api.getCollabCadence("collection").batchMs, 60);
  assert.equal(updates, 1);
  state.external('{"profile":"economy"}');
  assert.equal(state.api.getCollabCadence("collection").autoDownload, false);
  assert.equal(updates, 2);
  stop();
  state.api.setCollabPreferences({ profile: "balanced", overrides: {} });
  assert.equal(updates, 2);
});
test("failed persistence does not publish an unsaved profile", () => {
  const api = load("src/lib/collab/preferences.ts", {}, {
    localStorage: { getItem: () => null, setItem: () => { throw new Error("disk full"); } },
    window: { addEventListener: () => {} },
  });
  let updates = 0;
  api.subscribeCollabPreferences(() => updates++);
  assert.throws(() => api.setCollabPreferences({ profile: "economy", overrides: {} }), /disk full/);
  assert.equal(api.getCollabPreferences().profile, "balanced");
  assert.equal(updates, 0);
});
