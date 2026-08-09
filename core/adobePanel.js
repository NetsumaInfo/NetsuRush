// @ts-check
// core/adobePanel.js
// Installation, mise à jour et préférences de l'extension CEP `adobe-cep/` (panneau Premiere/AE).
//
// L'extension est un DOSSIER copié dans %APPDATA%\Adobe\CEP\extensions (pas d'admin requis) : une
// mise à jour de NetsuRush ne touche donc PAS la copie déjà installée. Ce module compare l'empreinte
// de CONTENU de la source (ressources bundlées ou dépôt) à celle de la copie installée et réinstalle
// quand elles divergent — c'est ce qui rend le panneau solidaire des versions de l'app.
//
// L'empreinte est calculée sur le CONTENU (pas les mtimes) : fs.copyFileSync ne conserve pas les
// dates, une comparaison par mtime déclencherait une réinstallation à chaque démarrage.
// La préférence (auto-update on/off) vit dans NR_HOME (pattern hostPower.js / discord-rpc.json) :
// une seule source de vérité, indépendante du renderer et de nr.config.json (figé au packaging).

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { t } = require('./i18n');
const { NR_HOME } = require('./config');

const EXT_ID = 'com.netsurush.panel';
const STATE_FILE = path.join(NR_HOME, 'adobe-panel.json');
// PlayerDebugMode=1 → Adobe charge une extension non signée. CSXS 9 = apps 2020, 15 = marge future.
const CSXS_VERSIONS = ['9', '10', '11', '12', '13', '14', '15'];

/** @typedef {{ autoUpdate: boolean, installedAt: number|null, removedAt: number|null, sourceHash: string|null, version: string|null, updatedAt: number|null }} PanelState */

/** @type {PanelState} */
const DEFAULT_STATE = { autoUpdate: true, installedAt: null, removedAt: null, sourceHash: null, version: null, updatedAt: null };

/** Dossier extensions CEP de l'utilisateur (pas d'admin requis). */
function cepExtensionsDir() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming');
  return path.join(appData, 'Adobe', 'CEP', 'extensions');
}

/** Destination de l'extension. */
function panelInstallDir() {
  return path.join(cepExtensionsDir(), EXT_ID);
}

/** Source de l'extension : ressources bundlées en packagé, dépôt en dev. */
function panelSourceDir() {
  const res = process.env.NR_RESOURCE_DIR;
  if (res && fs.existsSync(path.join(res, 'adobe-cep', 'CSXS', 'manifest.xml'))) {
    return path.join(res, 'adobe-cep');
  }
  return path.join(__dirname, '..', 'adobe-cep');
}

function manifestPath(dir) {
  return path.join(dir, 'CSXS', 'manifest.xml');
}

/** Un dossier contient-il une extension exploitable (manifest présent) ? */
function hasPanel(dir) {
  try { return fs.existsSync(manifestPath(dir)); } catch (_) { return false; }
}

/** Version déclarée par le manifest (ExtensionBundleVersion), ou null si illisible. */
function panelVersion(dir) {
  try {
    const xml = fs.readFileSync(manifestPath(dir), 'utf8');
    const m = xml.match(/ExtensionBundleVersion\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

/** Fichiers du dossier, triés par chemin relatif (ordre stable = empreinte stable). */
function listFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else out.push({ rel: path.relative(base, full).split(path.sep).join('/'), full });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// Le contenu ne bouge pas d'un poll à l'autre : on mémorise l'empreinte par (taille, mtime) pour ne
// pas relire tous les fichiers à chaque appel de statut (l'onglet Adobe interroge toutes les 8 s).
const hashCache = new Map();

/** Empreinte sha1 du CONTENU d'un dossier d'extension (chemins relatifs + octets). */
function panelContentHash(dir) {
  let files;
  try { files = listFiles(dir); } catch (_) { return null; }
  if (!files.length) return null;
  const key = files.map((f) => {
    const st = fs.statSync(f.full);
    return `${f.rel}:${st.size}:${st.mtimeMs}`;
  }).join('|');
  const cached = hashCache.get(dir);
  if (cached && cached.key === key) return cached.hash;
  const sum = crypto.createHash('sha1');
  for (const f of files) {
    sum.update(f.rel);
    sum.update('\0');
    sum.update(fs.readFileSync(f.full));
  }
  const hash = sum.digest('hex');
  hashCache.set(dir, { key, hash });
  return hash;
}

/** @returns {PanelState} */
function readPanelState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { ...DEFAULT_STATE, ...raw, autoUpdate: raw.autoUpdate !== false };
  } catch (_) {
    return { ...DEFAULT_STATE }; // absent au premier lancement, ou illisible → réglages par défaut
  }
}

function writePanelState(patch) {
  const next = { ...readPanelState(), ...patch };
  const tmp = `${STATE_FILE}.tmp`;
  try {
    fs.mkdirSync(NR_HOME, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    // Préférence best-effort : l'installation reste valide même si l'état n'a pas pu être écrit
    // (la comparaison d'empreintes source/installée sert alors de repli).
    console.warn('[adobe] état du panneau non écrit :', e && e.message);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  return next;
}

function setPanelAutoUpdate(on) {
  return writePanelState({ autoUpdate: !!on });
}

/** Le panneau que NetsuRush avait posé n'est plus sur le disque : il a été retiré à la main.
 * Sans cette trace, l'installation automatique le reposerait à chaque démarrage — c'est-à-dire
 * qu'elle refuserait la désinstallation. */
function markPanelRemoved() {
  return writePanelState({ removedAt: Date.now() });
}

/** Le panneau est de retour (réinstallation manuelle, ou `scripts/install-cep.ps1`) : l'automatisme
 * redevient légitime pour les mises à jour suivantes. */
function clearPanelRemoved() {
  return writePanelState({ removedAt: null });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** PlayerDebugMode=1 sur CSXS 9→15 : Adobe charge les extensions non signées (dev/bêta).
 * SYNCHRONE + vérifié (une écriture async fire-and-forget masquait les échecs) : les apps 2020 =
 * CSXS 9 ; 2024-2026 = CSXS 11/12+ selon la version. Retourne le détail par version. */
function enablePlayerDebugMode() {
  const set = [], failed = [];
  for (const v of CSXS_VERSIONS) {
    try {
      execFileSync('reg', ['add', `HKCU\\Software\\Adobe\\CSXS.${v}`, '/v', 'PlayerDebugMode', '/t', 'REG_SZ', '/d', '1', '/f'], { stdio: 'ignore' });
      set.push(v);
    } catch (_) { failed.push(v); }
  }
  return { set, failed };
}

/** Lecture du flag PlayerDebugMode réellement présent dans le registre (diagnostic). */
function playerDebugState() {
  const out = {};
  for (const v of CSXS_VERSIONS) {
    try {
      const r = execFileSync('reg', ['query', `HKCU\\Software\\Adobe\\CSXS.${v}`, '/v', 'PlayerDebugMode'], { encoding: 'utf8' });
      out['CSXS.' + v] = /PlayerDebugMode\s+REG_SZ\s+1/i.test(r) ? '1' : 'défini≠1';
    } catch (_) { out['CSXS.' + v] = 'absent'; }
  }
  return out;
}

/**
 * L'extension installée est-elle en retard sur celle livrée avec cette version de l'app ?
 * Comparaison d'empreintes de contenu — l'état sur disque n'est qu'un raccourci : une extension
 * posée par `scripts/install-cep.ps1` (ou par une version antérieure sans état) reste détectée.
 * @returns {{ installed: boolean, outdated: boolean, sourceHash: string|null, installedHash: string|null }}
 */
function panelUpdateStatus() {
  const dst = panelInstallDir();
  if (!hasPanel(dst)) return { installed: false, outdated: false, sourceHash: null, installedHash: null };
  const sourceHash = panelContentHash(panelSourceDir());
  const installedHash = panelContentHash(dst);
  return {
    installed: true,
    outdated: !!sourceHash && !!installedHash && sourceHash !== installedHash,
    sourceHash,
    installedHash,
  };
}

/**
 * Que doit faire la resynchronisation du démarrage ? PURE (aucun I/O) : c'est la seule partie de la
 * gestion automatique qui porte une POLITIQUE, et elle doit se vérifier sans Adobe ni registre.
 * `autoUpdate` gouverne la gestion automatique ENTIÈRE (pose comprise) : c'est l'unique interrupteur
 * exposé, et un utilisateur qui l'a coupé ne s'attend à aucune écriture dans son dossier Adobe.
 * Un panneau absent alors qu'on en a déjà posé un = retrait à la main : le reposer reviendrait à
 * refuser la désinstallation.
 * @param {PanelState} state
 * @param {{ installed: boolean, outdated: boolean }} update
 * @param {boolean} hostDetected une app Adobe est-elle installée sur ce poste ?
 * @returns {{ action: 'install'|'update'|'none', reason?: 'upToDate'|'autoUpdate'|'removed'|'noHost' }}
 */
function panelSyncAction(state, update, hostDetected) {
  if (update.installed) {
    if (!update.outdated) return { action: 'none', reason: 'upToDate' };
    if (!state.autoUpdate) return { action: 'none', reason: 'autoUpdate' };
    return { action: 'update' };
  }
  if (!state.autoUpdate) return { action: 'none', reason: 'autoUpdate' };
  if (state.installedAt) return { action: 'none', reason: 'removed' };
  if (!hostDetected) return { action: 'none', reason: 'noHost' };
  return { action: 'install' };
}

/** Copie l'extension + PlayerDebugMode + mémorise l'empreinte installée.
 * Tout est vérifié : source présente, ancienne install purgée, copie confirmée, flag debug posé.
 * @param {{ update?: boolean }} [opts] update = réinstallation automatique (horodatée à part).
 * @returns {{ ok: boolean, dir?: string, debugSet?: string[], version?: string|null, error?: string }}
 */
function installPanel(opts = {}) {
  try {
    const src = panelSourceDir();
    if (!hasPanel(src)) return { ok: false, error: `${t('panelSourceMissing')} (${src})` };
    const dst = panelInstallDir();
    // Purge une install précédente (évite des fichiers orphelins d'un ancien manifest).
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch (_) {}
    copyDir(src, dst);
    if (!hasPanel(dst)) return { ok: false, error: t('panelCopyFailed') };
    const debug = enablePlayerDebugMode();
    if (!debug.set.length) return { ok: false, dir: dst, error: t('adobeDebugModeFailed') };
    const version = panelVersion(dst);
    const now = Date.now();
    writePanelState({
      sourceHash: panelContentHash(src),
      version,
      installedAt: now,
      removedAt: null, // le panneau est là : un retrait antérieur n'a plus de sens
      updatedAt: opts.update ? now : null,
      ...(opts.update ? {} : { autoUpdate: true }), // installer à la main vaut « garde-le à jour »
    });
    return { ok: true, dir: dst, debugSet: debug.set, version };
  } catch (e) {
    return { ok: false, error: String((e && /** @type {Error} */ (e).message) || e) };
  }
}

module.exports = {
  EXT_ID,
  cepExtensionsDir,
  panelInstallDir,
  panelSourceDir,
  hasPanel,
  panelVersion,
  panelContentHash,
  panelUpdateStatus,
  panelSyncAction,
  readPanelState,
  setPanelAutoUpdate,
  markPanelRemoved,
  clearPanelRemoved,
  enablePlayerDebugMode,
  playerDebugState,
  installPanel,
};
