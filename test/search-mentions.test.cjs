// Analyse des mentions « @perso » de la barre de recherche. C'est elle qui décide si une requête
// FILTRE sur un personnage ou part telle quelle dans SigLIP : un nom tapé de mémoire qui ne
// s'apparie pas empoisonnait silencieusement la recherche (le jeton devenait un mot ordinaire).
// Le module est du TypeScript côté renderer → transpilé à la volée (esbuild est déjà une dépendance
// de Vite), le repo n'ayant pas de runner de tests TS.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { transformSync } = require("esbuild");

const SOURCE = path.join(__dirname, "..", "src", "components", "search", "mentions.ts");
const compiled = transformSync(fs.readFileSync(SOURCE, "utf8"), {
  loader: "ts", format: "cjs", target: "es2022",
}).code;
const mod = new Module(SOURCE);
mod._compile(compiled, SOURCE);
const { parseMentions, removeMention, detectMentionQuery } = mod.exports;

const ROSTER = [
  { id: 1, name: "Violet Evergarden" },
  { id: 2, name: "Renée Dubois" },
  { id: 3, name: "Ai Hoshino" },
  { id: 4, name: "Aï Kayano" },
];

test("un nom complet cite le personnage et sort du texte", () => {
  const r = parseMentions("@Violet Evergarden court sous la pluie", ROSTER);
  assert.deepStrictEqual(r.ids, [1]);
  assert.strictEqual(r.cleanText, "court sous la pluie");
  assert.deepStrictEqual(r.unknown, []);
});

test("un préfixe non ambigu suffit", () => {
  const r = parseMentions("@Violet dans une forêt", ROSTER);
  assert.deepStrictEqual(r.ids, [1]);
  assert.strictEqual(r.cleanText, "dans une forêt");
});

test("casse et accents ne bloquent pas l'appariement", () => {
  assert.deepStrictEqual(parseMentions("@renee dubois de nuit", ROSTER).ids, [2]);
  assert.deepStrictEqual(parseMentions("@RENÉE de nuit", ROSTER).ids, [2]);
});

test("un préfixe ambigu ne devine pas à la place de l'utilisateur", () => {
  const r = parseMentions("@Ai marche", ROSTER);   // « Ai Hoshino » et « Aï Kayano » commencent pareil
  assert.deepStrictEqual(r.ids, []);
  assert.deepStrictEqual(r.unknown, ["Ai"]);
  assert.strictEqual(r.cleanText, "marche");       // le jeton ne part PAS dans la requête SigLIP
});

test("la ponctuation ferme le nom", () => {
  const r = parseMentions("@Violet, elle sourit", ROSTER);
  assert.deepStrictEqual(r.ids, [1]);
  assert.strictEqual(r.cleanText, ", elle sourit");
});

test("plusieurs personnages sont cités dans l'ordre, sans doublon", () => {
  const r = parseMentions("@Violet et @Ai Hoshino et @Violet Evergarden", ROSTER);
  assert.deepStrictEqual(r.ids, [1, 3]);
  assert.strictEqual(r.cleanText, "et et");
});

test("un @ hors frontière reste du texte (adresse e-mail)", () => {
  const r = parseMentions("contact a@violet.com", ROSTER);
  assert.deepStrictEqual(r.ids, []);
  assert.strictEqual(r.cleanText, "contact a@violet.com");
});

test("un jeton inconnu est signalé et retiré", () => {
  const r = parseMentions("@Vilot court", ROSTER);
  assert.deepStrictEqual(r.unknown, ["Vilot"]);
  assert.strictEqual(r.cleanText, "court");
});

test("retirer une mention marche même quand seul un préfixe a été tapé", () => {
  // La pastille passe l'id : chercher le NOM COMPLET dans le texte ne trouvait rien.
  assert.strictEqual(removeMention("@Violet court", 1, ROSTER), "court");
  assert.strictEqual(removeMention("@Violet Evergarden court", 1, ROSTER), "court");
  assert.strictEqual(removeMention("court", 1, ROSTER), "court");
});

test("le sélecteur s'ouvre sur le @ en cours de frappe", () => {
  assert.deepStrictEqual(detectMentionQuery("plan de @Vio", 12), { start: 8, query: "Vio" });
  assert.strictEqual(detectMentionQuery("plan de nuit", 12), null);
});
