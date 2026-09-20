// The permission gate decides whether the agent may touch the project, so what
// each mode allows is worth pinning rather than re-reading.
//
// It also had a fourth mode, `safe`, which allowed everything but duplicated
// the timeline first. That was a checkbox wearing a mode's clothes: duplicating
// is orthogonal to how much the agent should ask, and coupling it to the most
// permissive level made the safety net unreachable to anyone who also wanted to
// be consulted. A saved `safe` still has to land somewhere sensible.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createPermissions } = require("../core/agent/permissions");

const gate = () => createPermissions({ broadcast: () => {} });

test("the default asks only about destructive work, and duplicates nothing", () => {
  const permissions = gate();
  assert.equal(permissions.getMode(), "ask");
  // Off by default: duplicating unasked leaves orphan timelines in the project.
  assert.equal(permissions.getDuplicateFirst(), false);
  assert.equal(permissions.decide("read"), "allow");
  // Editing a timeline does not touch the source files, so it is not the kind
  // of thing worth interrupting for.
  assert.equal(permissions.decide("write"), "allow");
  assert.equal(permissions.decide("destructive"), "prompt");
});

test("read-only refuses writes outright rather than asking about them", () => {
  const permissions = gate();
  permissions.setMode("read-only");
  assert.equal(permissions.decide("read"), "allow");
  // A guarantee, not a prompt: a mode that asked would not be read-only.
  assert.equal(permissions.decide("write"), "deny");
  assert.equal(permissions.decide("destructive"), "deny");
});

test("full access never prompts", () => {
  const permissions = gate();
  permissions.setMode("auto");
  for (const risk of ["read", "write", "destructive"]) {
    assert.equal(permissions.decide(risk), "allow", risk);
  }
});

test("duplication combines with every mode, including the guarded ones", () => {
  const permissions = gate();
  permissions.setMode("read-only");
  permissions.setDuplicateFirst(true);
  // The combination the old four-mode model could not express.
  assert.equal(permissions.getMode(), "read-only");
  assert.equal(permissions.getDuplicateFirst(), true);
  assert.equal(permissions.decide("write"), "deny");
});

test("a saved `safe` migrates rather than falling back to the default", () => {
  const permissions = gate();
  permissions.setMode("safe");
  // It meant "allow everything, but keep a copy" — both halves survive.
  assert.equal(permissions.getMode(), "auto");
  assert.equal(permissions.getDuplicateFirst(), true);
});

test("an unknown mode is ignored, not applied", () => {
  const permissions = gate();
  permissions.setMode("auto");
  permissions.setMode("whatever");
  assert.equal(permissions.getMode(), "auto");
});
