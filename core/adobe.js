// @ts-check
// Pont Adobe (Premiere Pro / After Effects) via l'extension CEP `adobe-cep/`.
// Le panneau (dans Adobe) lit le projet en ExtendScript puis POUSSE un snapshot
// normalisé ici (`adobe:ingest`) ; le renderer le consomme (`adobe:snapshot`).
// Sens inverse : `adobe:cmd` diffuse une commande en SSE, le panneau l'exécute.
// Temps du contrat TOUJOURS en secondes (les ticks Premiere sont convertis dans host-ppro.jsx).

const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { t } = require('./i18n');
const { NR_HOME } = require('./config');
const adobePanel = require('./adobePanel'); // installation / mise à jour de l'extension CEP
const { isImageRunning, invalidate: invalidateProcessList } = require('./processList');
const { HOST_IMAGES } = require('./hostImages');

/**
 * @typedef {Object} AdobeClip
 * @property {string} name
 * @property {string|null} path
 * @property {number|null} tlStart  position timeline (s)
 * @property {number|null} tlEnd
 * @property {number|null} srcIn    trim source (s)
 * @property {number|null} srcOut
 * @property {number|null} [srcFps]       fps de la SOURCE (≠ séquence/comp)
 * @property {boolean} [direct]           false quand une séquence imbriquée impose un report en secondes
 * @property {number|null} [srcInFrame]   frames source INCLUSIVES (calculées par l'hôte)
 * @property {number|null} [srcOutFrame]
 * @property {number|null} [srcFrames]    longueur de la source ; null = inconnue (Premiere)
 * @property {number|null} [tlStartFrame] position timeline en frames
 * @property {number|null} [tlEndFrame]   fin timeline en frames (occupation exacte du plan)
 * @property {string} [nodeId] identité native du TrackItem
 * @property {{start?:string,end?:string,in?:string,out?:string}} [ticks]
 * @property {import('./transfer/types').TransferVideoProperties} [video]
 * @property {import('./transfer/types').TransferAudioProperties} [audio]
 * @property {import('./transfer/types').TransferTiming} [timing]
 * @property {boolean} [reverse]
 * @property {boolean} [freeze]
 * @property {number} [speed]
 * @property {string[]} [deferred]
 */
/**
 * @typedef {Object} AdobeSnapshot
 * @property {boolean} ok
 * @property {"ppro"|"aeft"} app
 * @property {string} appVersion
 * @property {string} project
 * @property {string|null} projectPath
 * @property {number} at
 * @property {{path:string,name:string,fps:number|null,dur:number|null,w:number|null,h:number|null}[]} rushes
 * @property {{name:string,fps:number|null,w:number|null,h:number|null,tracks:{kind:"video"|"audio",index:number,clips:AdobeClip[]}[]}[]} sequences
 * @property {string|null} [activeSequence] séquence Premiere / composition AE ouverte au scan
 */

const APPS = ["ppro", "aeft"];
const EXE_IMAGE = { ppro: HOST_IMAGES.ppro, aeft: HOST_IMAGES.aeft };
const PANEL_TTL_MS = 12000; // heartbeat panneau toutes les 5 s
// Recopier une timeline entière ou dérouler un script d'export peut demander plusieurs minutes
// (centaines de plans, imports de sources) : les 2 min du job standard y suffisent rarement.
const PLACE_TIMEOUT_MS = 600000;
/** Cherche l'exécutable d'une app Adobe (même logique que findAfterFx d'aeExport.js). */
function findAdobeExe(app, CONFIG) {
  const cfgKey = app === "ppro" ? "premierePro" : "afterFx";
  if (CONFIG && CONFIG[cfgKey] && fs.existsSync(CONFIG[cfgKey])) return CONFIG[cfgKey];
  const roots = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Adobe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Adobe'),
  ];
  const dirRe = app === "ppro" ? /Premiere Pro/i : /After Effects/i;
  const rel = app === "ppro"
    ? ["Adobe Premiere Pro.exe"]
    : [path.join("Support Files", "AfterFX.exe")];
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (_) { continue; }
    for (const e of entries) {
      if (!dirRe.test(e)) continue;
      for (const r of rel) {
        const exe = path.join(root, e, r);
        if (fs.existsSync(exe)) found.push(exe);
      }
    }
  }
  found.sort().reverse(); // version la plus récente d'abord
  return found[0] || null;
}

// Cache disque des snapshots. Sans lui, un redémarrage du core (ou Adobe fermé pour libérer la RAM)
// vide Timeline Live et l'onglet Derush jusqu'au prochain scan du panneau — alors que la donnée n'a
// pas changé. Écriture atomique (.tmp + rename) : un core tué en plein vol ne laisse pas de JSON
// tronqué que la session suivante refuserait de lire.
const SNAPSHOT_DIR = path.join(NR_HOME, 'adobe-snapshots');

function snapshotPath(app) {
  return path.join(SNAPSHOT_DIR, `${app}.json`);
}

function readSnapshotFile(app) {
  try {
    const raw = fs.readFileSync(snapshotPath(app), 'utf8');
    const snap = JSON.parse(raw);
    return snap && snap.app === app ? snap : null;
  } catch (_) {
    return null; // absent au premier lancement, ou illisible → on repart d'un scan
  }
}

function writeSnapshotFile(app, snap) {
  const target = snapshotPath(app);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, target);
  } catch (e) {
    // Cache best-effort : l'échec d'écriture ne doit pas faire échouer l'ingestion du snapshot.
    console.warn(`[adobe] cache snapshot ${app} non écrit :`, e && e.message);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function createAdobeBridge({ CONFIG, broadcast }) {
  /** @type {Record<string, AdobeSnapshot|null>} */
  const snapshots = { ppro: readSnapshotFile('ppro'), aeft: readSnapshotFile('aeft') };
  /** @type {Record<string, number>} dernier heartbeat du panneau par app */
  const panelSeen = { ppro: 0, aeft: 0 };
  /** Apps ouvertes au moment d'une (ré)installation du panneau → à redémarrer pour la recharger. */
  let panelRestartApps = [];
  // Aller-retour de jobs à travers le panneau (le core ne parle pas à Adobe directement) :
  // adobe:cmd{jobId} → panneau evalScript → POST adobe:jobResult{jobId} → résolution ici.
  let jobSeq = 1;
  /** @type {Map<number, {resolve:(v:any)=>void, timer:NodeJS.Timeout}>} */
  const jobs = new Map();

  /** Le panneau renvoie le résultat d'un job → résout la promesse en attente. */
  function jobResult(res) {
    const j = res && jobs.get(res.jobId);
    if (!j) return { ok: false, error: t('unknownJob') };
    clearTimeout(j.timer);
    jobs.delete(res.jobId);
    j.resolve(res.result || { ok: false, error: t('emptyResult') });
    return { ok: true };
  }

  /** Envoie une commande-job au panneau et attend son résultat (timeout → échec). */
  function runHostJob(ev, app, cmd, payload, timeoutMs = 120000) {
    if (!APPS.includes(app)) return Promise.resolve({ ok: false, error: t('unknownApp') });
    if (Date.now() - panelSeen[app] > PANEL_TTL_MS) {
      return Promise.resolve({ ok: false, error: `${t('panelDisconnected')} (${app})` });
    }
    const jobId = jobSeq++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        jobs.delete(jobId);
        resolve({ ok: false, error: t('panelTimeout') });
      }, timeoutMs);
      jobs.set(jobId, { resolve, timer });
      ev.sender.send('adobe:cmd', { app, cmd, jobId, payload });
    });
  }

  /** Construit une séquence/comp dans l'app cible (via le panneau). opts.app = ppro|aeft. */
  function buildTimeline(ev, opts) {
    const app = opts && APPS.includes(opts.app) ? opts.app : null;
    if (!app) return Promise.resolve({ ok: false, error: t('targetAppMissing') });
    return runHostJob(ev, app, 'buildTimeline', opts);
  }

  /** Recopie une timeline ENTIÈRE dans l'app cible (positions absolues, pistes conservées). */
  function placeTimeline(ev, app, payload) {
    if (!APPS.includes(app)) return Promise.resolve({ ok: false, error: t('unknownApp') });
    return runHostJob(ev, app, 'placeTimeline', payload || {}, PLACE_TIMEOUT_MS);
  }

  /**
   * Fait IMPORTER par l'hôte un fichier d'échange comme séquence. Voie native : l'importeur pose ce
   * qu'aucune écriture par script n'atteint — un titre, que Premiere ne sait pas créer autrement.
   */
  function importTimeline(ev, app, payload) {
    if (!APPS.includes(app)) return Promise.resolve({ ok: false, error: t('unknownApp') });
    return runHostJob(ev, app, 'importTimeline', payload || {}, PLACE_TIMEOUT_MS);
  }

  /** Fait exporter par l'hôte sa séquence en FCP7 XML : la seule sortie qui porte les images clés. */
  function exportXml(ev, app, filePath, timelineName) {
    if (!APPS.includes(app)) return Promise.resolve({ ok: false, error: t('unknownApp') });
    return runHostJob(ev, app, 'exportXml', { path: filePath, timelineName: timelineName || undefined });
  }

  /** Exécute dans l'hôte OUVERT un script écrit par NetsuRush (export AE riche). */
  function runScript(ev, app, scriptPath) {
    if (!APPS.includes(app)) return Promise.resolve({ ok: false, error: t('unknownApp') });
    return runHostJob(ev, app, 'runScript', { path: scriptPath }, PLACE_TIMEOUT_MS);
  }

  /** NetsuBoost : purge de cache, hygiène projet, réglages, proxies (via le panneau).
   * `timeoutMs` court pour les lectures d'état — un panneau muet ne doit pas figer un diagnostic. */
  function boost(ev2, app, payload, timeoutMs) {
    if (!APPS.includes(app)) return Promise.resolve({ ok: false, error: t('unknownApp') });
    return runHostJob(ev2, app, 'boost', payload || {}, timeoutMs);
  }

  /** Importe des fichiers dans le projet de l'app cible (via le panneau). opts = { app, paths }. */
  function importMedia(ev, opts) {
    const app = opts && APPS.includes(opts.app) ? opts.app : null;
    if (!app) return Promise.resolve({ ok: false, error: t('targetAppMissing') });
    return runHostJob(ev, app, 'import', { paths: (opts && opts.paths) || [] });
  }

  /** Le panneau (dans Adobe) signale sa présence — vaut « connecté » pendant PANEL_TTL_MS. */
  function panelHello(info) {
    const app = info && APPS.includes(info.app) ? info.app : null;
    if (!app) return { ok: false, error: t('unknownApp') };
    panelSeen[app] = Date.now();
    return { ok: true };
  }

  /**
   * Ligne de journal venue du panneau. Le journal CEP vit dans Premiere/After Effects : sans ce
   * relais, l'échec de chargement d'un script hôte — la seule chose qui explique un
   * « … is not a function » — n'atteignait jamais la console de NetsuRush ni un rapport de bug.
   */
  function panelLog(entry) {
    const app = entry && APPS.includes(entry.app) ? entry.app : null;
    if (!app) return { ok: false, error: t('unknownApp') };
    const line = `[panneau ${app}] ${String((entry && entry.message) || '')}`;
    if (entry.level === 'error') console.warn(line);
    else console.log(line);
    return { ok: true };
  }

  /** Le panneau pousse un snapshot projet ; diffusé au renderer en SSE `adobe:update`. */
  function ingest(ev, snap) {
    if (!snap || !APPS.includes(snap.app)) return { ok: false, error: t('invalidSnapshot') };
    snapshots[snap.app] = snap;
    writeSnapshotFile(snap.app, snap);
    panelSeen[snap.app] = Date.now();
    ev.sender.send('adobe:update', { app: snap.app, at: snap.at });
    return { ok: true };
  }

  /** Snapshot stocké (une app, ou les deux si app absent). */
  function snapshot(app) {
    if (app) return APPS.includes(app) ? snapshots[app] : null;
    return { ppro: snapshots.ppro, aeft: snapshots.aeft };
  }

  async function status() {
    const now = Date.now();
    const out = {};
    for (const app of APPS) {
      const exe = findAdobeExe(app, CONFIG);
      out[app] = {
        installed: !!exe,
        exe,
        running: exe ? await isImageRunning(EXE_IMAGE[app]) : false,
        panelConnected: now - panelSeen[app] < PANEL_TTL_MS,
        lastSnapshotAt: snapshots[app] ? snapshots[app].at : null,
      };
    }
    const update = adobePanel.panelUpdateStatus();
    const state = adobePanel.readPanelState();
    // L'invite « redémarre l'app » n'a de sens que tant que l'hôte concerné tourne encore avec
    // l'ancienne copie du panneau : dès qu'il est fermé, la prochaine ouverture chargera la neuve.
    panelRestartApps = panelRestartApps.filter((app) => out[app] && out[app].running);
    return {
      ok: true,
      ppro: out.ppro,
      aeft: out.aeft,
      panelInstalled: update.installed,
      panelDir: adobePanel.panelInstallDir(),
      panelVersion: adobePanel.panelVersion(adobePanel.panelSourceDir()),
      panelInstalledVersion: update.installed ? adobePanel.panelVersion(adobePanel.panelInstallDir()) : null,
      panelAutoUpdate: state.autoUpdate,
      // La resynchronisation compare des EMPREINTES de contenu, pas des versions : une version
      // oubliée n'empêche rien mais rend un rapport de bug inexploitable. On expose donc l'empreinte
      // courte, seule chose qui identifie à coup sûr le build installé.
      panelBuild: update.sourceHash ? update.sourceHash.slice(0, 7) : null,
      panelOutdated: update.outdated,
      panelUpdatedAt: state.updatedAt,
      panelRestartApps: [...panelRestartApps],
    };
  }

  /** Lance l'app Adobe avec le fichier projet en argument pour reprendre directement la session. */
  async function launch(app, projectPath = null) {
    if (!APPS.includes(app)) return { ok: false, error: t('unknownApp') };
    const exe = findAdobeExe(app, CONFIG);
    if (!exe) return { ok: false, error: t('applicationMissing') };
    if (await isImageRunning(EXE_IMAGE[app])) return { ok: true, already: true };
    try {
      const args = projectPath && fs.existsSync(projectPath) ? [projectPath] : [];
      const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
      child.unref();
      invalidateProcessList(); // l'instantané de processus vient de devenir faux
      return { ok: true, already: false };
    } catch (e) {
      return { ok: false, error: String(e && /** @type {Error} */ (e).message || e) };
    }
  }

  /** Ferme PROPREMENT l'app Adobe (taskkill sans /f = WM_CLOSE) → Adobe affiche son propre dialogue
   * « Enregistrer ? » si le projet est modifié (zéro perte). Sert à libérer la RAM/GPU pendant une
   * tâche lourde de NetsuRush ; on relance ensuite via launch(). */
  async function close(app) {
    if (!APPS.includes(app)) return { ok: false, error: t('unknownApp') };
    const image = EXE_IMAGE[app];
    if (!(await isImageRunning(image))) return { ok: true, already: true };
    return new Promise((resolve) => {
      try {
        execFile('taskkill', ['/im', image], (err) => {
          invalidateProcessList();
          resolve({ ok: !err, error: err ? String(err) : undefined });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  /** Diffuse une commande au panneau (SSE `adobe:cmd`). P0 : { cmd:"scan" }. */
  function cmd(ev, app, payload) {
    ev.sender.send('adobe:cmd', { app: APPS.includes(app) ? app : null, ...(payload || {}) });
    return { ok: true };
  }

  /** Apps Adobe ouvertes : CEP ne charge l'extension qu'au démarrage de l'hôte → à redémarrer. */
  async function runningApps() {
    const running = [];
    for (const app of APPS) {
      try { if (await isImageRunning(EXE_IMAGE[app])) running.push(app); } catch (_) {}
    }
    return running;
  }

  /** Copie adobe-cep/ dans le dossier extensions CEP + PlayerDebugMode (non signé).
   * Retourne le diagnostic d'installation + les apps ouvertes à redémarrer. */
  async function installPanel(opts = {}) {
    const result = adobePanel.installPanel({ update: !!opts.update });
    const restart = result.ok ? await runningApps() : [];
    if (result.ok) panelRestartApps = restart;
    return { ...result, restart };
  }

  /** Active/désactive la mise à jour automatique du panneau et renvoie le nouvel état. */
  function setPanelAutoUpdate(on) {
    const state = adobePanel.setPanelAutoUpdate(on);
    return { ok: true, autoUpdate: state.autoUpdate };
  }

  /** Réinstalle le panneau quand la copie posée dans Adobe est en retard sur celle livrée avec
   * cette version de NetsuRush (mise à jour de l'app, ou modification du panneau en dev).
   * Appelé au démarrage du core ; silencieux si le panneau n'est pas installé ou si l'utilisateur
   * a coupé la mise à jour automatique. */
  async function syncPanel() {
    const state = adobePanel.readPanelState();
    const update = adobePanel.panelUpdateStatus();
    const hosts = APPS.filter((app) => !!findAdobeExe(app, CONFIG));
    const decision = adobePanel.panelSyncAction(state, update, hosts.length > 0);

    // Retrait à la main mémorisé une seule fois : la décision suivante se relit sur l'état, mais la
    // trace sert aussi à ne pas confondre « jamais posé » et « posé puis enlevé » dans un rapport.
    if (decision.reason === 'removed' && !state.removedAt) adobePanel.markPanelRemoved();
    // Panneau de retour après un retrait (réinstallation manuelle, ou install-cep.ps1, qui n'écrit
    // aucun état) : l'automatisme redevient légitime.
    if (update.installed && state.removedAt) adobePanel.clearPanelRemoved();
    if (decision.action === 'none') return { ok: true, updated: false, installed: update.installed, skipped: decision.reason };

    const updating = decision.action === 'update';
    const result = await installPanel(updating ? { update: true } : {});
    if (!result.ok) {
      console.warn(`[adobe] ${updating ? 'mise à jour' : 'installation automatique'} du panneau impossible :`, result.error);
      return { ok: false, updated: false, installed: update.installed, error: result.error };
    }
    const payload = { version: result.version || null, restart: result.restart || [], installed: true };
    if (broadcast) broadcast('adobe:panelUpdated', payload);
    console.log(updating
      ? `[adobe] panneau CEP mis à jour (${payload.version || 'version inconnue'})`
      : `[adobe] panneau CEP installé automatiquement pour ${hosts.join(', ')} (${payload.version || 'version inconnue'})`);
    return { ok: true, updated: updating, ...payload };
  }

  /** Diagnostic d'installation du panneau : dossier, manifest sur disque, PlayerDebugMode réel,
   * et lignes du log CEP mentionnant NetsuRush (= pourquoi Adobe accepte/rejette l'extension). */
  function diagnose() {
    const os = require('os');
    const out = { ok: true, panelDir: null, manifestExists: false, files: [], manifestHead: null, playerDebug: {}, cepLogs: [] };
    try {
      const dir = adobePanel.panelInstallDir();
      out.panelDir = dir;
      const man = path.join(dir, 'CSXS', 'manifest.xml');
      out.manifestExists = fs.existsSync(man);
      if (out.manifestExists) { try { out.manifestHead = fs.readFileSync(man, 'utf8').slice(0, 500); } catch (_) {} }
      try { out.files = fs.readdirSync(dir); } catch (_) {}
    } catch (_) {}
    out.playerDebug = adobePanel.playerDebugState();
    try {
      const tmp = process.env.TEMP || os.tmpdir();
      const logs = fs.readdirSync(tmp).filter((f) => /^(cep|csxs).*\.log$/i.test(f));
      for (const f of logs.slice(0, 8)) {
        try {
          const c = fs.readFileSync(path.join(tmp, f), 'utf8');
          const lines = c.split(/\r?\n/).filter((l) => /netsurush/i.test(l));
          if (lines.length) out.cepLogs.push({ file: f, lines: lines.slice(-20) });
        } catch (_) {}
      }
    } catch (_) {}
    return out;
  }

  return { panelHello, panelLog, ingest, snapshot, status, launch, close, cmd, installPanel, setPanelAutoUpdate, syncPanel, buildTimeline, placeTimeline, importTimeline, runScript, exportXml, importMedia, boost, jobResult, diagnose };
}

module.exports = { createAdobeBridge, findAdobeExe };
