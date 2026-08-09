// @ts-check
// core/adobePrefs.js
// Catalogue des RÉGLAGES de performance Premiere Pro / After Effects exposés par NetsuBoost.
//
// Différence de fond avec core/resolvePrefs.js : Resolve n'expose AUCUNE API pour ses préférences, il
// a donc fallu patcher ses fichiers, fenêtre fermée, avec sauvegarde. Adobe, lui, expose des API
// DOCUMENTÉES et vivantes (`app.project.gpuAccelType`, `app.setMemoryUsageLimits`,
// `app.setEnableProxies`, `app.setScratchDiskPath`) : on passe donc par le panneau CEP — pas de
// fermeture d'application, pas de risque que l'app réécrive nos octets en quittant.
//
// Ce module est PUR : ni fs, ni appel panneau. Il définit ce qui est réglable, valide ce qui arrive du
// renderer, et met en forme ce que le panneau a lu. L'aller-retour vit dans core/adobeBoost.js.
//
// Le contrat de ligne est celui de resolvePrefs.readPrefs (`{id,key,kind,value,recommended,options,
// min,max,advisory,warn}`) pour que le rendu des Paramètres soit le même des deux côtés.

/**
 * @typedef {object} AdobePrefDef
 * @property {string} id
 * @property {string} key            nom de l'API/propriété visé côté hôte
 * @property {'bool'|'percent'|'enum'|'path'} kind
 * @property {string} from           chemin de lecture dans la réponse du panneau ('a.b' toléré)
 * @property {(string|number|boolean)=} recommended
 * @property {string[]=} options
 * @property {number=} min
 * @property {number=} max
 * @property {boolean=} advisory     arbitrage machine — jamais d'alerte, même hors recommandation
 * @property {boolean=} volatile     retombe à la fin du script (l'UI doit le dire)
 * @property {boolean=} writeOnly    l'hôte n'a pas d'accesseur en lecture : la ligne s'affiche vide
 * @property {string=} scratchType   pour kind 'path' : nom d'énum attendu par setScratchDiskPath
 */

/** @type {AdobePrefDef[]} */
const AEFT_DEFS = [
  // Accélération GPU du rendu d'effets. SOFTWARE alors qu'une autre option existe = perte sèche.
  { id: "gpuAccelType", key: "app.project.gpuAccelType", kind: "enum", from: "gpuAccelType", options: ["CUDA", "METAL", "OPENCL", "SOFTWARE"] },
  // 32 bpc multiplie le coût de chaque frame ; souvent activé sans raison sur un projet 8 bits.
  { id: "bitsPerChannel", key: "app.project.bitsPerChannel", kind: "enum", from: "bitsPerChannel", options: ["8", "16", "32"], advisory: true },
  // setMemoryUsageLimits(imageCachePercentage, maximumMemoryPercentage). After Effects n'expose
  // AUCUN accesseur en lecture pour ces deux valeurs : la ligne est donc écriture seule, valeur
  // inconnue. Mieux vaut l'afficher vide que la lire par une clé de préférences non documentée qui
  // changerait de nom d'une version à l'autre.
  { id: "imageCachePct", key: "app.setMemoryUsageLimits", kind: "percent", from: "imageCachePct", min: 10, max: 100, advisory: true, writeOnly: true },
  { id: "maxMemPct", key: "app.setMemoryUsageLimits", kind: "percent", from: "maxMemPct", min: 20, max: 100, advisory: true, writeOnly: true },
  // Multi-Frame Rendering : le réglage posé par un script est REMIS À ZÉRO à la fin de ce script
  // (documenté par Adobe). On l'expose quand même — il vaut pour un rendu piloté depuis NetsuRush —
  // mais marqué volatile pour ne pas laisser croire à un réglage durable.
  { id: "mfrEnabled", key: "app.setMultiFrameRenderingConfig", kind: "bool", from: "mfrEnabled", advisory: true, volatile: true, writeOnly: true },
  { id: "mfrMaxCpuPct", key: "app.setMultiFrameRenderingConfig", kind: "percent", from: "mfrMaxCpuPct", min: 10, max: 100, advisory: true, volatile: true, writeOnly: true },
];

/** @type {AdobePrefDef[]} */
const PPRO_DEFS = [
  { id: "enableProxies", key: "app.setEnableProxies", kind: "bool", from: "enableProxies", advisory: true },
  // Emplacements des fichiers de travail. Les déplacer sur un SSD rapide est le réglage disque qui
  // paie le plus, et c'est l'une des rares écritures officiellement scriptables côté Premiere.
  { id: "scratchVideoPreviews", key: "FirstVideoPreviewFolder", kind: "path", from: "scratch.videoPreviews", scratchType: "FirstVideoPreviewFolder", advisory: true },
  { id: "scratchAudioPreviews", key: "FirstAudioPreviewFolder", kind: "path", from: "scratch.audioPreviews", scratchType: "FirstAudioPreviewFolder", advisory: true },
  { id: "scratchAutoSave", key: "FirstAutoSaveFolder", kind: "path", from: "scratch.autoSave", scratchType: "FirstAutoSaveFolder", advisory: true },
];
// Premiere expose bien `app.properties.setProperty`, mais AUCUNE liste de clés de performance
// inscriptibles n'est documentée par Adobe. Inventer des noms produirait des lignes mortes dans l'UI :
// on n'expose donc que des API vérifiées. La mécanique générique existe côté jsx pour le jour où une
// clé sera confirmée.

const PREF_DEFS = { ppro: PPRO_DEFS, aeft: AEFT_DEFS };

/** @param {string} app @returns {AdobePrefDef[]} */
function defsFor(app) {
  return PREF_DEFS[app] || [];
}

/** Lecture d'un chemin pointé ('scratch.videoPreviews') dans un objet. @param {any} obj @param {string} p */
function pick(obj, p) {
  let cur = obj;
  for (const part of String(p).split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    cur = cur[part];
  }
  return cur === undefined ? null : cur;
}

/** Valeur brute → valeur typée de la ligne. @param {AdobePrefDef} def @param {any} raw */
function normalize(def, raw) {
  if (raw == null) return null;
  if (def.kind === "bool") return raw === true || raw === 1 || raw === "1" || raw === "true";
  if (def.kind === "percent") {
    const n = Math.round(Number(raw));
    return Number.isFinite(n) ? n : null;
  }
  return String(raw);
}

/** Vrai quand la valeur mérite une alerte. Réservé aux cas où le mauvais réglage est certain :
 *  rendu logiciel alors que le GPU est disponible. Tout le reste est un arbitrage machine.
 *  @param {AdobePrefDef} def @param {any} value @param {any} raw */
function shouldWarn(def, value, raw) {
  if (def.id !== "gpuAccelType") return false;
  const available = pick(raw, "gpuAvailable");
  return value === "SOFTWARE" && Array.isArray(available) && available.length > 1;
}

/** Réponse `prefsRead` du panneau → lignes prêtes pour l'UI. Une valeur absente (clé inconnue de cette
 *  version d'AE) est OMISE, jamais rapportée à null : on n'invente pas d'état.
 *  @param {string} app @param {any} raw */
function mergeRead(app, raw) {
  const source = raw || {};
  const prefs = [];
  for (const def of defsFor(app)) {
    const value = normalize(def, pick(source, def.from));
    // Valeur absente = clé inconnue de cette version : la ligne disparaît plutôt que d'inventer un
    // état. Sauf pour les réglages écriture seule, qu'aucune version ne sait relire.
    if (value === null && !def.writeOnly) continue;
    const dynamic = def.id === "gpuAccelType" ? pick(source, "gpuAvailable") : null;
    prefs.push({
      id: def.id,
      key: def.key,
      kind: def.kind,
      value,
      recommended: def.recommended ?? null,
      options: Array.isArray(dynamic) && dynamic.length ? dynamic.map(String) : (def.options ?? null),
      min: def.min ?? null,
      max: def.max ?? null,
      advisory: !!def.advisory,
      volatile: !!def.volatile,
      writeOnly: !!def.writeOnly,
      warn: shouldWarn(def, value, source),
    });
  }
  return prefs;
}

/** Valide un lot de changements venu du renderer. Hors catalogue, hors bornes, hors options : rejeté
 *  en bloc — un lot à moitié appliqué laisserait l'utilisateur devant un état qu'il n'a pas demandé.
 *  @param {string} app @param {Record<string, any>} changes
 *  @returns {{entries?: {def:AdobePrefDef, value:any}[], error?: string}} */
function validate(app, changes) {
  const defs = defsFor(app);
  if (!defs.length) return { error: "unknownApp" };
  const byId = new Map(defs.map((d) => [d.id, d]));
  const entries = [];
  for (const [id, rawValue] of Object.entries(changes || {})) {
    const def = byId.get(id);
    if (!def) return { error: `unknownPref:${id}` };
    if (def.kind === "bool") {
      entries.push({ def, value: rawValue === true });
      continue;
    }
    if (def.kind === "percent") {
      const n = Math.round(Number(rawValue));
      const min = def.min ?? 0;
      const max = def.max ?? 100;
      if (!Number.isFinite(n) || n < min || n > max) return { error: `outOfRange:${id}` };
      entries.push({ def, value: n });
      continue;
    }
    if (def.kind === "enum") {
      const v = String(rawValue);
      // Les options de gpuAccelType dépendent de la machine : le panneau refusera une valeur absente
      // du matériel, la validation ici ne fait que barrer les chaînes fantaisistes.
      if (def.options && !def.options.includes(v)) return { error: `invalidValue:${id}` };
      entries.push({ def, value: v });
      continue;
    }
    const p = String(rawValue || "");
    if (!p) return { error: `invalidValue:${id}` };
    entries.push({ def, value: p });
  }
  if (!entries.length) return { error: "noChanges" };
  return { entries };
}

/** Lot validé → charge utile du job panneau. @param {{def:AdobePrefDef, value:any}[]} entries */
function toPayload(entries) {
  return entries.map((e) => ({
    id: e.def.id,
    key: e.def.key,
    kind: e.def.kind,
    scratchType: e.def.scratchType || null,
    value: e.value,
  }));
}

module.exports = { PREF_DEFS, defsFor, mergeRead, validate, toPayload };
