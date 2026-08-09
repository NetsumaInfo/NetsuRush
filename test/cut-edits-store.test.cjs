// Les édits de découpe sont écrits par LOTS (le Découpage renvoie l'état complet à chaque clic).
// Ces tests figent le contrat : la mémoire est la vérité immédiate, le disque rattrape, et rien
// n'est perdu à l'arrêt du core.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCutEditsStore } = require("../core/cutEdits.js");

const FLUSH_MS = 300;
const span = (a, b) => ({ in: a, out: b, inFrame: a * 24, outFrame: b * 24 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-cut-edits-"));
  return { dir, store: createCutEditsStore(dir), file: path.join(dir, "cut-edits.json") };
}

function readStore(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("un édit est lisible immédiatement, avant toute écriture disque", () => {
  const { dir, store, file } = fixture();
  try {
    store.saveEdits("S:/rush.mp4", "transnetv2", { merges: [span(1, 2)], removed: [] });
    assert.deepEqual(store.getEdits("S:/rush.mp4", "transnetv2").merges, [span(1, 2)]);
    assert.equal(fs.existsSync(file), false, "l'écriture est différée, pas immédiate");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("une rafale d'édits ne produit qu'une écriture, avec l'état final", async () => {
  const { dir, store, file } = fixture();
  try {
    for (let i = 1; i <= 20; i++) {
      store.saveEdits("S:/rush.mp4", "transnetv2", { merges: [span(0, i)], removed: [] });
    }
    await wait(FLUSH_MS * 2);
    assert.deepEqual(readStore(file)["S:/rush.mp4"].transnetv2.merges, [span(0, 20)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("flush() écrit tout de suite (arrêt du core)", () => {
  const { dir, store, file } = fixture();
  try {
    store.saveEdits("S:/rush.mp4", "omnishotcut", { merges: [], removed: [span(3, 4)] });
    store.flush();
    assert.deepEqual(readStore(file)["S:/rush.mp4"].omnishotcut.removed, [span(3, 4)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("un magasin écrit est relu par un nouveau store (survit au redémarrage)", () => {
  const { dir, store } = fixture();
  try {
    store.saveEdits("S:/rush.mp4", "transnetv2", { merges: [span(5, 9)], removed: [] });
    store.flush();
    const reopened = createCutEditsStore(dir);
    assert.deepEqual(reopened.getEdits("S:/rush.mp4", "transnetv2").merges, [span(5, 9)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("chaque modèle garde ses propres édits", () => {
  const { dir, store } = fixture();
  try {
    store.saveEdits("S:/rush.mp4", "transnetv2", { merges: [span(1, 2)], removed: [] });
    store.saveEdits("S:/rush.mp4", "omnishotcut", { merges: [span(7, 8)], removed: [] });
    store.flush();
    assert.deepEqual(store.getEdits("S:/rush.mp4", "transnetv2").merges, [span(1, 2)]);
    assert.deepEqual(store.getEdits("S:/rush.mp4", "omnishotcut").merges, [span(7, 8)]);
    store.clearEdits("S:/rush.mp4", "transnetv2");
    assert.deepEqual(store.getEdits("S:/rush.mp4", "transnetv2").merges, []);
    assert.deepEqual(store.getEdits("S:/rush.mp4", "omnishotcut").merges, [span(7, 8)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clearEdits est persisté, pas seulement en mémoire", async () => {
  const { dir, store, file } = fixture();
  try {
    store.saveEdits("S:/rush.mp4", "transnetv2", { merges: [span(1, 2)], removed: [] });
    store.flush();
    store.clearEdits("S:/rush.mp4", "transnetv2");
    await wait(FLUSH_MS * 2);
    assert.deepEqual(readStore(file), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("le magasin hérité (fusions sans modèle) est repris sur transnetv2 et écrit aussitôt", () => {
  const { dir, file } = fixture();
  try {
    fs.writeFileSync(
      path.join(dir, "cut-merges.json"),
      JSON.stringify({ "S:/vieux.mp4": [{ in: 2, out: 6, inFrame: 48, outFrame: 144 }] }),
    );
    const store = createCutEditsStore(dir);
    assert.deepEqual(store.getEdits("S:/vieux.mp4", "transnetv2").merges, [span(2, 6)]);
    assert.ok(fs.existsSync(file), "la migration écrit tout de suite, pas en différé");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("un chemin vide est refusé sans toucher au magasin", () => {
  const { dir, store } = fixture();
  try {
    assert.equal(store.saveEdits("", "transnetv2", { merges: [span(1, 2)], removed: [] }).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
