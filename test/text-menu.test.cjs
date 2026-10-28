// Right-click menu rules: which menu opens for a target, which entries show and which are greyed,
// and the notebook editor's block helpers. Pure modules, transpiled on the fly.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function load(file) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  new Function("exports", "require", code)(exports, () => ({}));
  return exports;
}
const { resolveMenu, textMenuPlan } = load("src/components/common/textMenuPolicy.ts");
const { clipboardUrl, isConvertible, stripBlockIds } = load("src/components/notebook/noteMenuModel.ts");

const base = { field: "input", readOnly: false, secret: false, empty: false, hasSelection: true, canPaste: true, selectable: false };
const plan = (over) => textMenuPlan({ ...base, ...over });
const byAction = (over) => Object.fromEntries(plan(over).map((p) => [p.action, p.disabled]));
const ctx = { editable: false, inOwnMenu: false, extension: false, selectionHere: false };

test("an editable field gets the text menu, even inside a surface with its own menu", () => {
  assert.equal(resolveMenu({ ...ctx, editable: true }), "text");
  assert.equal(resolveMenu({ ...ctx, editable: true, inOwnMenu: true }), "text");
});

test("a surface with its own menu keeps it; a bare one offers Copy over a selection only", () => {
  assert.equal(resolveMenu({ ...ctx, inOwnMenu: true }), "own");
  assert.equal(resolveMenu({ ...ctx, inOwnMenu: true, selectionHere: true }), "own");
  assert.equal(resolveMenu({ ...ctx, selectionHere: true }), "selection");
  assert.equal(resolveMenu(ctx), "none");
  assert.equal(resolveMenu({ ...ctx, extension: true }), "selection");
});

test("input and rich field entries, with their disabled states", () => {
  assert.deepEqual(plan({}).map((p) => p.action), ["cut", "copy", "paste", "selectAll"]);
  assert.deepEqual(plan({ field: "editable" }).map((p) => p.action), ["cut", "copy", "paste", "pastePlain", "selectAll"]);
  const none = byAction({ hasSelection: false });
  assert.equal(none.cut, true);
  assert.equal(none.copy, true);
  assert.equal(none.paste, false);
  const ro = byAction({ field: "editable", readOnly: true });
  assert.deepEqual([ro.cut, ro.paste, ro.pastePlain, ro.copy], [true, true, true, false]);
  assert.equal(byAction({ canPaste: false }).paste, true);
  assert.equal(byAction({ empty: true }).selectAll, true);
});

test("a password field never offers Cut or Copy", () => {
  assert.deepEqual(plan({ secret: true }).map((p) => p.action), ["paste", "selectAll"]);
});

test("a read-only surface gets Copy and Select all only", () => {
  assert.deepEqual(plan({ field: "none", readOnly: true, hasSelection: false, selectable: true }), [
    { action: "copy", disabled: true }, { action: "selectAll", disabled: false },
  ]);
  assert.deepEqual(plan({ field: "none", selectable: false }).map((x) => x.action), ["copy"]);
});

test("notebook menu helpers", () => {
  assert.equal(isConvertible("paragraph"), true);
  assert.equal(isConvertible("codeBlock"), true);
  assert.equal(isConvertible("image"), false);
  assert.equal(isConvertible("gallery"), false);
  const copy = stripBlockIds({ id: "a", type: "paragraph", props: { x: 1 }, children: [{ id: "b", type: "paragraph", children: [{ id: "c", type: "paragraph", children: [] }] }] });
  assert.doesNotMatch(JSON.stringify(copy), /"id"/);
  assert.equal(copy.props.x, 1);
  assert.equal("children" in stripBlockIds({ id: "a", type: "image" }), false);
  assert.equal(clipboardUrl(" https://example.com/a?b=1 "), "https://example.com/a?b=1");
  assert.equal(clipboardUrl("two words https://example.com"), null);
  assert.equal(clipboardUrl("ftp://example.com"), null);
});
