// @ts-check
// core/resolvePrefs.js
// Lecture et écriture des PRÉFÉRENCES de DaVinci Resolve (≠ réglages projet).
//
// Pourquoi ce module existe : l'API de scripting sait écrire les réglages PROJET (`project.SetSetting`)
// mais n'expose RIEN pour les préférences de l'application — ni `resolve.SetSetting`, ni pont fiable
// (`Fusion().GetPrefs` est déprécié et renvoie des valeurs fausses depuis Resolve 19). Or les réglages
// qui coûtent le plus cher en perf vivent précisément là : « Charger toutes les timelines à l'ouverture »
// (OFF par défaut justement pour la perf des projets à timelines multiples) et les limites mémoire.
// Ces prefs sont sur disque en TEXTE LISIBLE, donc on les lit, et on les patche fenêtre fermée.
//
// NON SUPPORTÉ PAR BLACKMAGIC — d'où les garde-fous, tous obligatoires :
//   • whitelist stricte : une clé hors catalogue n'est jamais écrite ;
//   • backup horodaté des DEUX fichiers AVANT d'y toucher, restaurable ;
//   • patch par SUBSTITUTION ciblée, jamais de re-sérialisation : les octets qu'on ne vise pas ne
//     bougent pas (une clé inconnue de nous survit intacte) ;
//   • Resolve doit être RÉELLEMENT sorti : il réécrit ses prefs en quittant, et taskkill rend la main
//     avant que le process ait fini de vider ses buffers → patcher trop tôt = patch écrasé en silence.
//
// Deux fichiers, deux formats (constatés sur Resolve 21, Windows) :
//   Preferences/.config.data     → onglet « Système »     → lignes `Clé = Valeur`
//   Preferences/config.user.xml  → onglet « Utilisateur » → nœuds `<Clé>valeur</Clé>`

const path = require("node:path");
const fs = require("node:fs");
const { t } = require("./i18n");
const { isImageRunning } = require("./processList");

const fsp = fs.promises;

const RESOLVE_IMAGE = "Resolve.exe";
// Resolve met « plusieurs secondes, parfois une minute » à sortir pour de bon.
const EXIT_TIMEOUT_MS = 60_000;
const EXIT_POLL_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isResolveRunning = () => isImageRunning(RESOLVE_IMAGE);

// Attend la disparition RÉELLE du process. Sans ça, le patch part pendant que Resolve vide encore ses
// buffers de prefs → il réécrit par-dessus et le réglage revient tout seul, sans le moindre message.
async function waitForExit() {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isResolveRunning())) return true;
    await sleep(EXIT_POLL_MS);
  }
  return false;
}

// --- Emplacements -----------------------------------------------------------

function prefsDir() {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  return path.join(appdata, "Blackmagic Design", "DaVinci Resolve", "Preferences");
}

/** @param {"system"|"user"} which */
function prefsFile(which) {
  const dir = prefsDir();
  if (!dir) return null;
  return path.join(dir, which === "system" ? ".config.data" : "config.user.xml");
}

// --- Catalogue (WHITELIST) --------------------------------------------------

// Seules ces clés sont lisibles/écrivables. `recommended` = la valeur qui sert la perf ; quand la
// valeur courante s'en écarte, l'UI le signale — elle ne « corrige » jamais toute seule.
// `advisory` = on signale mais sans trancher : le bon réglage dépend de la machine et de ce qui
// tourne à côté (les sidecars torch/ffmpeg de NetsuRush mangent la RAM que Resolve ne prend pas).
/**
 * @typedef {object} PrefDef
 * @property {string} id
 * @property {"system"|"user"} file
 * @property {string} key
 * @property {"bool"|"percent"|"enum"} kind
 * @property {(string|number|boolean)=} recommended
 * @property {string[]=} options
 * @property {number=} min
 * @property {number=} max
 * @property {boolean=} advisory
 */
/** @type {PrefDef[]} */
const PREF_DEFS = [
  // LE réglage qui plombe l'ouverture : OFF par défaut chez Blackmagic, précisément « pour améliorer
  // les performances des projets longs à timelines multiples ». ON = toutes les timelines chargées en
  // RAM à l'ouverture du projet.
  { id: "loadAllTimelines", file: "user", key: "IsLoadAllTimelinesEnabled", kind: "bool", recommended: false },
  // Plafond RAM de Resolve. Défaut 75 %. Le baisser ne l'accélère PAS, ça réserve juste de la RAM aux
  // autres applis — arbitrage réel ici, puisque NetsuRush fait justement tourner des sidecars gourmands.
  { id: "resolveMemory", file: "system", key: "ResolveMemoryUsageInPercentage", kind: "percent", min: 20, max: 90, recommended: 75, advisory: true },
  // Cache mémoire Fusion, en % de l'allocation Resolve (plafond 80 %).
  { id: "fusionMemory", file: "system", key: "FusionMemoryUsageInPercentage", kind: "percent", min: 20, max: 80, advisory: true },
  { id: "gpuMode", file: "system", key: "GPUProcessingMode", kind: "enum", options: ["Auto", "CUDA", "OpenCL", "Metal"] },
  { id: "hwDecode", file: "system", key: "UseHwAccForDecodeEnable", kind: "bool", recommended: true },
  { id: "liveSave", file: "user", key: "IsProjectLiveSaveEnabled", kind: "bool", advisory: true },
  { id: "timelineBackups", file: "user", key: "IsTimelineBackupsEnabled", kind: "bool", advisory: true },
];

const DEF_BY_ID = new Map(PREF_DEFS.map((d) => [d.id, d]));

// --- Lecture ----------------------------------------------------------------

function readSystemValue(text, key) {
  // `Clé = Valeur` (espaces libres autour du `=`).
  const m = text.match(new RegExp(`^\\s*${escapeRe(key)}\\s*=\\s*(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

function readUserValue(text, key) {
  const m = text.match(new RegExp(`<${escapeRe(key)}>([^<]*)</${escapeRe(key)}>`));
  return m ? m[1].trim() : null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Texte disque → valeur JS selon le type. Les booléens ne s'écrivent pas pareil dans les deux fichiers :
// `1`/`0` côté Système, `true`/`false` côté Utilisateur.
function parseValue(def, raw) {
  if (raw == null) return null;
  if (def.kind === "bool") return /^(1|true)$/i.test(raw);
  if (def.kind === "percent") {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  return raw;
}

function formatValue(def, val) {
  if (def.kind === "bool") return def.file === "system" ? (val ? "1" : "0") : val ? "true" : "false";
  if (def.kind === "percent") return String(Math.round(Number(val)));
  return String(val);
}

async function readFileSafe(p) {
  try {
    return await fsp.readFile(p, "utf8");
  } catch {
    return null;
  }
}

// Lit toutes les prefs du catalogue présentes sur disque. Une clé absente du fichier est simplement
// omise (Resolve n'écrit pas toujours tout) plutôt que rapportée à null — on n'invente pas d'état.
async function readPrefs() {
  const sysPath = prefsFile("system");
  const usrPath = prefsFile("user");
  if (!sysPath || !usrPath) return { ok: false, error: t("prefsFolderMissing"), prefs: [] };
  const [sys, usr] = await Promise.all([readFileSafe(sysPath), readFileSafe(usrPath)]);
  if (sys == null && usr == null) {
    return { ok: false, error: `${t("unreadableFile")}: ${prefsDir()}`, prefs: [] };
  }
  const prefs = [];
  for (const def of PREF_DEFS) {
    const text = def.file === "system" ? sys : usr;
    if (text == null) continue;
    const raw = def.file === "system" ? readSystemValue(text, def.key) : readUserValue(text, def.key);
    if (raw == null) continue;
    const value = parseValue(def, raw);
    const off = def.recommended !== undefined && value !== def.recommended;
    prefs.push({
      id: def.id,
      key: def.key,
      file: def.file,
      kind: def.kind,
      value,
      recommended: def.recommended ?? null,
      options: def.options ?? null,
      min: def.min ?? null,
      max: def.max ?? null,
      advisory: !!def.advisory,
      // `warn` = s'écarte d'une recommandation FERME. Les réglages d'arbitrage (advisory) ne
      // déclenchent jamais d'alerte : leur bonne valeur dépend de la machine.
      warn: off && !def.advisory,
    });
  }
  return { ok: true, dir: prefsDir(), prefs };
}

// --- Sauvegarde / restauration ---------------------------------------------

function backupsDir(dataDir) {
  return path.join(dataDir, "resolve-prefs-backups");
}

// Copie les DEUX fichiers dans un dossier horodaté. Fait AVANT toute écriture, sans exception : c'est
// le filet si un patch tourne mal ou si Resolve n'aime pas une valeur.
async function backupPrefs(dataDir) {
  const dir = backupsDir(dataDir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = path.join(dir, ts);
  await fsp.mkdir(dest, { recursive: true });
  const copied = [];
  for (const which of /** @type {("system"|"user")[]} */ (["system", "user"])) {
    const src = prefsFile(which);
    if (!src) continue;
    try {
      await fsp.copyFile(src, path.join(dest, path.basename(src)));
      copied.push(path.basename(src));
    } catch {
      /* fichier absent : rien à sauvegarder pour celui-là */
    }
  }
  if (!copied.length) return { ok: false, error: t("noPrefsBackupFiles") };
  return { ok: true, path: dest, at: Date.now(), files: copied };
}

async function listBackups(dataDir) {
  const dir = backupsDir(dataDir);
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      try {
        const st = await fsp.stat(full);
        const files = await fsp.readdir(full);
        out.push({ name: e.name, path: full, at: st.mtimeMs, files });
      } catch {}
    }
    out.sort((a, b) => b.at - a.at);
    return { ok: true, dir, backups: out };
  } catch {
    return { ok: true, dir, backups: [] };
  }
}

// Remet en place une sauvegarde. Même contrainte que le patch : Resolve doit être sorti, sinon il
// réécrit par-dessus en quittant.
async function restoreBackup(dataDir, name) {
  if (!name || /[\\/]/.test(String(name))) return { ok: false, error: t("invalidBackup") };
  const src = path.join(backupsDir(dataDir), String(name));
  if (await isResolveRunning()) return { ok: false, error: t("closeResolveFirst") };
  let files;
  try {
    files = await fsp.readdir(src);
  } catch {
    return { ok: false, error: t("backupMissing") };
  }
  const restored = [];
  for (const f of files) {
    const which = f === ".config.data" ? "system" : f === "config.user.xml" ? "user" : null;
    if (!which) continue;
    const dest = prefsFile(which);
    if (!dest) continue;
    try {
      await fsp.copyFile(path.join(src, f), dest);
      restored.push(f);
    } catch (e) {
      return { ok: false, error: `${t("restoreFailed")}: ${f}: ${String(e)}` };
    }
  }
  return restored.length ? { ok: true, restored } : { ok: false, error: t("nothingToRestore") };
}

// --- Écriture ---------------------------------------------------------------

// Substitution ciblée + écriture atomique. On ne reconstruit JAMAIS le fichier : une clé qu'on ne
// connaît pas doit ressortir octet pour octet.
async function patchFile(which, entries) {
  if (!entries.length) return { ok: true, changed: 0 };
  const p = prefsFile(which);
  if (!p) return { ok: false, error: t("prefsFolderMissing") };
  let text = await readFileSafe(p);
  if (text == null) return { ok: false, error: `${t("unreadableFile")}: ${path.basename(p)}` };
  let changed = 0;
  for (const { def, value } of entries) {
    const out = formatValue(def, value);
    if (which === "system") {
      const re = new RegExp(`^(\\s*${escapeRe(def.key)}\\s*=\\s*).*$`, "m");
      if (!re.test(text)) return { ok: false, error: `${t("notFound")}: ${def.key} (${path.basename(p)})` };
      text = text.replace(re, `$1${out}`);
    } else {
      const re = new RegExp(`(<${escapeRe(def.key)}>)[^<]*(</${escapeRe(def.key)}>)`);
      if (!re.test(text)) return { ok: false, error: `${t("notFound")}: ${def.key} (${path.basename(p)})` };
      text = text.replace(re, `$1${out}$2`);
    }
    changed++;
  }
  const tmp = p + ".nrtmp";
  await fsp.writeFile(tmp, text, "utf8");
  await fsp.rename(tmp, p);
  return { ok: true, changed };
}

// Valide des changements contre la whitelist. Une clé inconnue ou une valeur hors bornes fait échouer
// TOUT le lot : on n'applique pas « la moitié » d'une demande.
function validate(changes) {
  const entries = [];
  for (const [id, value] of Object.entries(changes || {})) {
    const def = DEF_BY_ID.get(id);
    if (!def) return { error: `${t("unknownSetting")}: ${id}` };
    if (def.kind === "bool" && typeof value !== "boolean") return { error: `${t("invalidValue")}: ${id}` };
    if (def.kind === "percent") {
      const n = Number(value);
      if (!Number.isFinite(n)) return { error: `${t("invalidValue")}: ${id}` };
      if ((def.min != null && n < def.min) || (def.max != null && n > def.max)) {
        return { error: `${t("invalidValue")}: ${id} (${def.min}-${def.max}; ${n})` };
      }
    }
    if (def.kind === "enum" && def.options && !new Set(def.options).has(String(value))) {
      return { error: `${t("invalidValue")}: ${id} (${def.options.join(", ")})` };
    }
    entries.push({ def, value });
  }
  return { entries };
}

/**
 * Applique un LOT de changements de préférences. Les prefs ne sont relues par Resolve qu'au démarrage
 * et réécrites à la sortie → la seule séquence sûre est : sauvegarder le projet, fermer, attendre la
 * sortie réelle, patcher, rouvrir. D'où un seul redémarrage pour tout le lot.
 * @param {object} deps
 * @param {any} deps.hostPower
 * @param {string} deps.dataDir
 * @param {(msg:string, pct:number|null)=>void=} deps.progress
 * @param {Record<string, any>} changes
 */
async function applyPrefs({ hostPower, dataDir, progress }, changes) {
  const say = progress || (() => {});
  const { entries, error } = validate(changes);
  if (error) return { ok: false, error };
  if (!entries || !entries.length) return { ok: false, error: t("noChanges") };

  // Le filet AVANT tout le reste : si la suite tourne mal, la config d'origine est déjà à l'abri.
  say("Sauvegarde de la configuration…", 5);
  const backup = await backupPrefs(dataDir);
  if (!backup.ok) return { ok: false, error: backup.error };

  const wasRunning = await isResolveRunning();
  const byFile = {
    system: entries.filter((e) => e.def.file === "system"),
    user: entries.filter((e) => e.def.file === "user"),
  };

  // Resolve fermé : rien à sauvegarder ni à redémarrer, on patche directement.
  if (!wasRunning) {
    say("Écriture des préférences…", 50);
    for (const which of /** @type {("system"|"user")[]} */ (["system", "user"])) {
      const r = await patchFile(which, byFile[which]);
      if (!r.ok) return { ok: false, error: r.error, backup: backup.path };
    }
    say("Préférences écrites.", 100);
    return { ok: true, applied: entries.length, backup: backup.path, restarted: false };
  }

  // close() sauvegarde le projet avant de tuer le process (cf. core/hostPower.js) → zéro perte.
  say("Sauvegarde du projet et fermeture de Resolve…", 15);
  const c = await hostPower.close("resolve");
  if (!c.ok) return { ok: false, error: c.error || "Fermeture de Resolve impossible.", backup: backup.path };

  say("Attente de la sortie complète de Resolve…", 35);
  if (!(await waitForExit())) {
    return { ok: false, error: t("resolveCloseTimeout"), backup: backup.path };
  }

  say("Écriture des préférences…", 50);
  for (const which of /** @type {("system"|"user")[]} */ (["system", "user"])) {
    const r = await patchFile(which, byFile[which]);
    // Échec à mi-parcours : Resolve est fermé et l'état « fermé » persiste → la bannière « Rouvrir »
    // prend le relais, et la sauvegarde permet de revenir en arrière.
    if (!r.ok) return { ok: false, error: r.error, backup: backup.path };
  }

  say("Relance de Resolve…", 60);
  const re = await hostPower.reopen();
  if (!re.ok) {
    return { ok: true, applied: entries.length, backup: backup.path, restarted: false, reopenError: re.error };
  }
  return { ok: true, applied: entries.length, backup: backup.path, restarted: true, project: re.project };
}

module.exports = {
  PREF_DEFS,
  readPrefs,
  applyPrefs,
  backupPrefs,
  listBackups,
  restoreBackup,
  prefsDir,
};
