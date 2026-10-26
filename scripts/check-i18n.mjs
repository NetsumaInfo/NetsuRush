import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const I18N_INDEX = path.join(ROOT, "src", "i18n", "index.ts");
const LOCALES_DIR = path.join(ROOT, "src", "locales");
const SOURCE_DIR = path.join(ROOT, "src");
// Appels à clé LITTÉRALE et préfixée : t("common:action.import"). Les clés construites (gabarit,
// tableau de clés avec defaultValue) ne sont pas vérifiables statiquement et sont ignorées.
const NAMESPACED_KEY = /\bt\(\s*"([a-z]+):([\w.$-]+)"/g;
const EXPECTED_LANGUAGE_COUNT = 6;
const EXPECTED_NAMESPACE_COUNT = 24;

function relative(file) {
  return path.relative(ROOT, file).replaceAll("\\", "/");
}

function extractBlock(source, name) {
  const match = new RegExp(`export\\s+const\\s+${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]\\s*(?:as\\s+const)?\\s*;`).exec(source);
  if (!match) throw new Error(`Impossible de lire ${name} dans ${relative(I18N_INDEX)}`);
  return match[1];
}

function extractContract(source) {
  const languageBlock = extractBlock(source, "LANGUAGES");
  const namespaceBlock = extractBlock(source, "NAMESPACES");
  const languages = [...languageBlock.matchAll(/\bcode\s*:\s*["']([^"']+)["']/g)].map((match) => match[1]);
  const namespaces = [...namespaceBlock.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);

  if (languages.length !== EXPECTED_LANGUAGE_COUNT) {
    throw new Error(`LANGUAGES doit déclarer ${EXPECTED_LANGUAGE_COUNT} langues, ${languages.length} trouvée(s)`);
  }
  if (namespaces.length !== EXPECTED_NAMESPACE_COUNT) {
    throw new Error(`NAMESPACES doit déclarer ${EXPECTED_NAMESPACE_COUNT} namespaces, ${namespaces.length} trouvé(s)`);
  }
  if (new Set(languages).size !== languages.length) throw new Error("LANGUAGES contient un code en double");
  if (new Set(namespaces).size !== namespaces.length) throw new Error("NAMESPACES contient un nom en double");
  if (!languages.includes("fr")) throw new Error("LANGUAGES doit contenir la langue source fr");

  return { languages, namespaces };
}

function flatten(value, prefix = "", output = new Map()) {
  if (typeof value === "string") {
    output.set(prefix, value);
    return output;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) output.set(prefix, value);
    for (const [key, child] of entries) flatten(child, prefix ? `${prefix}.${key}` : key, output);
    return output;
  }

  output.set(prefix, value);
  return output;
}

function interpolationTokens(value) {
  if (typeof value !== "string") return [];
  return [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1].trim()).sort();
}

function sameMultiset(left, right) {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

async function readLocale(file, errors) {
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    errors.push(`${relative(file)} :: <fichier> — fichier manquant (${error.code ?? "lecture impossible"})`);
    return null;
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    errors.push(`${relative(file)} :: <json> — JSON invalide : ${error.message}`);
    return null;
  }
}

function validateValues(file, values, errors) {
  for (const [key, value] of values) {
    if (typeof value !== "string") {
      errors.push(`${relative(file)} :: ${key || "<racine>"} — la valeur doit être une chaîne non vide`);
    } else if (value.trim() === "") {
      errors.push(`${relative(file)} :: ${key || "<racine>"} — valeur vide`);
    }
  }
}

async function sourceFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Clés RÉELLEMENT utilisées par l'interface. La parité entre langues ne dit rien d'une clé qu'aucun
 * fichier de traduction ne définit : i18next affiche alors la clé brute à l'écran (« action.import »),
 * dans toutes les langues à la fois. On confronte donc le code au français, la langue source.
 */
async function validateUsedKeys(frenchByNamespace, errors) {
  for (const file of await sourceFiles(SOURCE_DIR)) {
    const source = await readFile(file, "utf8");
    for (const [, namespace, key] of source.matchAll(NAMESPACED_KEY)) {
      if (key.includes("${")) continue;
      const known = frenchByNamespace.get(namespace);
      if (!known) {
        errors.push(`${relative(file)} :: ${namespace}:${key} — namespace inconnu`);
        continue;
      }
      // Une clé peut être un parent (t("a.b") avec returnObjects) ou une forme plurielle.
      const exists = known.has(key)
        || known.has(`${key}_other`)
        || [...known].some((candidate) => candidate.startsWith(`${key}.`));
      if (!exists) errors.push(`${relative(file)} :: ${namespace}:${key} — clé absente des traductions`);
    }
  }
}

async function main() {
  const errors = [];
  /** @type {Map<string, Set<string>>} namespace → clés françaises (langue source) */
  const frenchByNamespace = new Map();
  let contract;
  try {
    contract = extractContract(await readFile(I18N_INDEX, "utf8"));
  } catch (error) {
    console.error(`Échec du contrôle i18n : ${error.message}`);
    process.exitCode = 1;
    return;
  }

  for (const namespace of contract.namespaces) {
    const frenchFile = path.join(LOCALES_DIR, "fr", `${namespace}.json`);
    const frenchJson = await readLocale(frenchFile, errors);
    if (frenchJson === null) continue;

    const frenchValues = flatten(frenchJson);
    validateValues(frenchFile, frenchValues, errors);
    frenchByNamespace.set(namespace, new Set(frenchValues.keys()));

    for (const language of contract.languages) {
      if (language === "fr") continue;
      const localeFile = path.join(LOCALES_DIR, language, `${namespace}.json`);
      const localeJson = await readLocale(localeFile, errors);
      if (localeJson === null) continue;

      const localeValues = flatten(localeJson);
      validateValues(localeFile, localeValues, errors);

      for (const [key, frenchValue] of frenchValues) {
        if (!localeValues.has(key)) {
          errors.push(`${relative(localeFile)} :: ${key || "<racine>"} — clé manquante (présente dans ${relative(frenchFile)})`);
          continue;
        }
        const translatedValue = localeValues.get(key);
        const expectedTokens = interpolationTokens(frenchValue);
        const actualTokens = interpolationTokens(translatedValue);
        if (!sameMultiset(expectedTokens, actualTokens)) {
          errors.push(
            `${relative(localeFile)} :: ${key || "<racine>"} — interpolations différentes ` +
              `(attendu : ${JSON.stringify(expectedTokens)}, reçu : ${JSON.stringify(actualTokens)})`,
          );
        }
      }

      for (const key of localeValues.keys()) {
        if (!frenchValues.has(key)) {
          errors.push(`${relative(localeFile)} :: ${key || "<racine>"} — clé en trop (absente de ${relative(frenchFile)})`);
        }
      }
    }
  }

  await validateUsedKeys(frenchByNamespace, errors);

  if (errors.length > 0) {
    console.error(`Contrôle i18n échoué — ${errors.length} erreur(s) :`);
    for (const error of errors.sort()) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Contrôle i18n réussi : ${contract.languages.length} langues × ${contract.namespaces.length} namespaces, `
    + `clés et interpolations conformes, clés utilisées par l'interface toutes traduites.`,
  );
}

await main();
