const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.join(__dirname, "..", "src", "components");

function tsxFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [full] : [];
  });
}

function tagName(node) {
  return node.tagName?.getText() ?? "";
}

function hasAttr(node, name, valuePattern) {
  const attr = node.attributes?.properties.find((p) => ts.isJsxAttribute(p) && p.name.text === name);
  if (!attr) return false;
  if (!valuePattern) return true;
  return !!attr.initializer && valuePattern.test(attr.initializer.getText());
}

function hasTooltipAncestor(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isJsxElement(cur) && tagName(cur.openingElement) === "Tooltip") return true;
  }
  return false;
}

test("les éléments interactifs n'utilisent pas le tooltip natif title", () => {
  const offenders = [];
  for (const file of tsxFiles(root)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /^[a-z]/.test(tagName(node)) && tagName(node) !== "iframe" && hasAttr(node, "title")) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        offenders.push(`${path.relative(root, file)}:${line}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(offenders, []);
});

test("les boutons icône de la page Console utilisent le Tooltip Base UI", () => {
  const consoleRoot = path.join(root, "settings", "console");
  const offenders = [];
  for (const file of tsxFiles(consoleRoot)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && tagName(node) === "Button" && hasAttr(node, "size", /icon/) && hasAttr(node, "aria-label") && !hasTooltipAncestor(node)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        offenders.push(`${path.relative(root, file)}:${line}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(offenders, []);
});

test("les sélecteurs de fichiers natifs restent masqués", () => {
  const offenders = [];
  for (const file of tsxFiles(root)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && tagName(node) === "input" && hasAttr(node, "type", /file/) && !hasAttr(node, "hidden") && !hasAttr(node, "className", /(?:hidden|sr-only)/)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        offenders.push(`${path.relative(root, file)}:${line}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(offenders, []);
});
