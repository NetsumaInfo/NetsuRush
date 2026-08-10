const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.join(__dirname, "..");

function loadTypeScriptModule(relativePath) {
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  Function("module", "exports", output)(module, module.exports);
  return module.exports;
}

test("la pause noire se présente en secondes sans changer le contrat en millisecondes", () => {
  const {
    millisecondsToSeconds,
    secondsToMilliseconds,
  } = loadTypeScriptModule("src/components/export/blackPause.ts");

  assert.equal(millisecondsToSeconds(1500), 1.5);
  assert.equal(secondsToMilliseconds(1.5), 1500);
  assert.equal(secondsToMilliseconds(0.30000000000000004), 300);
});

test("le réglage de pause noire utilise le tooltip custom et l'unité seconde", () => {
  const source = fs.readFileSync(path.join(root, "src/components/export/ProfileEditor.tsx"), "utf8");

  assert.match(source, /from "\.\/blackPause"/);
  assert.match(source, /<Tooltip>/);
  assert.match(source, /<TooltipTrigger/);
  assert.match(source, /millisecondsToSeconds\(profile\.mergeGap \?\? MERGE_GAP_DEFAULT_MS\)/);
  assert.match(source, /secondsToMilliseconds\(v\)/);
  assert.match(source, /t\("editor\.seconds"\)/);
  assert.match(source, /<TooltipContent[^>]*>\{t\("editor\.mergeGapHint"\)\}<\/TooltipContent>/);
});

test("le champ numérique partagé évite la validation native et accepte les pas décimaux", () => {
  const { clampSteppedNumber } = loadTypeScriptModule("src/components/ui/numberSpinValue.ts");
  const source = fs.readFileSync(path.join(root, "src/components/ui/number-spin.tsx"), "utf8");

  assert.equal(clampSteppedNumber(1.54, 0, 10, 0.1), 1.5);
  assert.equal(clampSteppedNumber(10.2, 0, 10, 0.1), 10);
  assert.equal(clampSteppedNumber(-1, 0, 10, 0.1), 0);
  assert.match(source, /type="text"/);
  assert.match(source, /role="spinbutton"/);
  assert.match(source, /parseFloat\(draft\)/);
  assert.match(source, /clampSteppedNumber\(v, min, max, step\)/);
});

test("les six langues nomment la pause noire, son aide et les secondes", () => {
  const locales = ["fr", "en", "es", "de", "ja", "zh"];
  for (const locale of locales) {
    const messages = JSON.parse(fs.readFileSync(path.join(root, `src/locales/${locale}/export.json`), "utf8"));
    assert.ok(messages.editor.mergeGap, `${locale}: editor.mergeGap manquant`);
    assert.ok(messages.editor.mergeGapHint, `${locale}: editor.mergeGapHint manquant`);
    assert.ok(messages.editor.seconds, `${locale}: editor.seconds manquant`);
    assert.equal(messages.editor.milliseconds, undefined, `${locale}: ancienne unité milliseconds encore présente`);
  }

  const fr = JSON.parse(fs.readFileSync(path.join(root, "src/locales/fr/export.json"), "utf8"));
  assert.equal(fr.editor.mergeGap, "Pause noire");
  assert.equal(fr.editor.mergeGapHint, "Durée du noir ajouté entre chaque plan fusionné");
  assert.equal(fr.editor.seconds, "s");
});

test("la pause noire vaut une seconde par défaut sans remplacer un zéro explicite", () => {
  const profiles = fs.readFileSync(path.join(root, "src/features/export/profiles.ts"), "utf8");
  const editor = fs.readFileSync(path.join(root, "src/components/export/ProfileEditor.tsx"), "utf8");

  assert.match(profiles, /MERGE_GAP_DEFAULT_MS = 1000/);
  assert.match(profiles, /ms == null \? MERGE_GAP_DEFAULT_MS/);
  assert.match(editor, /profile\.mergeGap \?\? MERGE_GAP_DEFAULT_MS/);
});
