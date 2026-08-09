// @ts-check
// core/hostPower.js
// Fermer / rouvrir le LOGICIEL DE MONTAGE (DaVinci Resolve, Premiere, After Effects) depuis NetsuRush.
// Motivation : une tâche lourde (découpe en masse, indexation de recherche, upscale) sature RAM/GPU ;
// or NetsuRush a déjà en cache la SOURCE des médias → on peut fermer l'hôte le temps de finir la tâche,
// puis le rouvrir DIRECTEMENT sur le même projet pour reprendre le travail. Les envois différés pendant
// la fermeture sont gérés par le « cache projet » (core/outbox.js), rejoués au retour en ligne.
//
// Fermeture PROPRE :
//   • Resolve — pas d'API Quit fiable → on SAUVEGARDE le projet via le pont (SaveProject), on note son
//     nom, on arrête le helper Python, puis taskkill /f (sûr : déjà sauvegardé, aucun dialogue bloquant).
//   • Adobe — taskkill sans /f (WM_CLOSE) → l'app affiche son propre « Enregistrer ? » (zéro perte).
// Réouverture : on relance l'exécutable, on attend que le pont/panneau réponde, puis (Resolve) on
// recharge le projet par son nom (LoadProject) et on revient sur la page quittée.
// `restart()` enchaîne les deux d'un geste : c'est le seul correctif documenté de la dérive de session
// (cf. core/optimize.js), là où la fermeture seule sert à libérer la machine pendant une tâche lourde.
//
// L'état « dernier hôte fermé + projet » est persisté (NR_HOME) → l'offre « Rouvrir » survit à un
// redémarrage du core (fréquent en dev : toute modif core/ respawn le process).

const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');
const { t } = require('./i18n');
const { captureResolveProjectLocation, openResolveProjectLocation } = require('./resolveProjectLocation');
const { isImageRunning, invalidate: invalidateProcessList } = require('./processList');
const { HOST_IMAGES } = require('./hostImages');

const RESOLVE_IMAGE = HOST_IMAGES.resolve;
// Attente max de réouverture de Resolve (boot + chargement de l'API de scripting) avant d'abandonner.
const REOPEN_TIMEOUT_MS = 150_000;
const CLOSE_TIMEOUT_MS = 30_000;
const POLL_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function taskkill(image, force) {
  return new Promise((resolve) => {
    const args = force ? ['/f', '/im', image] : ['/im', image];
    try {
      execFile('taskkill', args, (err) => {
        invalidateProcessList(); // l'instantané de processus vient de devenir faux
        resolve({ ok: !err, error: err ? String(err) : undefined });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

/**
 * @param {object} deps
 * @param {any} deps.CONFIG
 * @param {any} deps.resolveMod   core/resolve.js (resolveStatus + getResolve)
 * @param {any} deps.bridge       resolve-proxy bridge (connect / stop)
 * @param {any} deps.adobeBridge  core/adobe.js (launch / close / snapshot)
 * @param {(channel:string, payload:any)=>void} deps.broadcast
 * @param {string} deps.dataDir
 * @param {any} deps.projectSnapshot  core/projectSnapshot.js (capture avant fermeture / clear à la réouverture)
 * @param {any} deps.captureReaders  lectures Resolve (rOp-wrappées) passées à projectSnapshot.capture()
 * @param {(image:string)=>Promise<boolean>} [deps.isImageRunningFn] injection de test
 * @param {(image:string, force:boolean)=>Promise<{ok:boolean,error?:string}>} [deps.taskkillFn] injection de test
 * @param {(ms:number)=>Promise<void>} [deps.sleepFn] injection de test
 * @param {typeof spawn} [deps.spawnFn] injection de test
 */
function createHostPower({
  CONFIG, resolveMod, bridge, adobeBridge, broadcast, dataDir, projectSnapshot, captureReaders,
  isImageRunningFn = isImageRunning, taskkillFn = taskkill, sleepFn = sleep, spawnFn = spawn,
}) {
  const stateFile = path.join(dataDir, 'host-power.json');
  /** @type {{ host:"resolve"|"ppro"|"aeft", project:string|null, projectPath?:string|null, page?:string|null, folder?:string[], database?:any, at:number } | null} */
  let closed = null;
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (raw && raw.host) closed = raw;
  } catch (_) { /* premier lancement */ }

  let busy = false; // une seule op power à la fois (close/reopen)
  /** @type {'close'|'reopen'|null} */
  let busyKind = null;

  function persist() {
    try {
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(closed));
      fs.renameSync(tmp, stateFile);
    } catch (_) { /* best-effort */ }
  }
  function emit() {
    try { broadcast && broadcast('power:changed', snapshot()); } catch (_) {}
  }
  function progress(msg, pct) {
    try { broadcast && broadcast('power:progress', { msg, pct: pct ?? null }); } catch (_) {}
  }
  function snapshot() { return { closed, busy }; }

  async function waitForHostStopped(host) {
    const deadline = Date.now() + CLOSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let running = false;
      if (host === 'resolve') {
        running = await isImageRunningFn(RESOLVE_IMAGE);
      } else {
        try {
          const st = await adobeBridge.status();
          running = !!(st && st[host] && st[host].running);
        } catch (_) { running = true; }
      }
      if (!running) return true;
      await sleepFn(250);
    }
    return false;
  }

  /** Chemin de Resolve.exe : config explicite, sinon dossier de fusionscript.dll, sinon défaut Windows. */
  function resolveExe() {
    const c = CONFIG.resolveExe;
    if (c && fs.existsSync(c)) return c;
    const lib = CONFIG.resolveScriptLib;
    if (lib) {
      const guess = path.join(path.dirname(lib), RESOLVE_IMAGE);
      if (fs.existsSync(guess)) return guess;
    }
    const def = 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Resolve.exe';
    return fs.existsSync(def) ? def : null;
  }

  // --- Resolve -------------------------------------------------------------

  async function closeResolve() {
    // Nom du projet + page courante (pour rouvrir là où on en était) + sauvegarde AVANT de tuer le process.
    let project = null;
    let page = null;
    let folder = [];
    let database = null;
    const running = await isImageRunningFn(RESOLVE_IMAGE);
    if (!running) {
      closed = { host: 'resolve', project, page, folder, database, at: Date.now() };
      persist(); emit();
      return { ok: true, already: true, project, page };
    }
    try {
      const st = await resolveMod.resolveStatus();
      if (!st || !st.connected) return { ok: false, error: t('resolveSaveUnavailable') };
      project = st.project || null;
      const resolve = await resolveMod.getResolve();
      const pm = resolve ? await resolve.GetProjectManager() : null;
      const proj = pm ? await pm.GetCurrentProject() : null;
      if (resolve) { try { page = await resolve.GetCurrentPage(); } catch (_) {} }
      if (project && (!pm || !proj)) return { ok: false, error: t('resolveSaveUnavailable') };
      if (proj) {
        const location = await captureResolveProjectLocation(pm);
        if (!location.ok) return location;
        folder = location.folder;
        database = location.database;
        progress('Sauvegarde du projet Resolve…', 5);
        const saved = await pm.SaveProject();
        if (!saved) return { ok: false, error: t('projectSaveFailed') };
        // Photo des lectures (Media Pool + timelines) TANT QUE Resolve répond → servie offline pendant
        // la fermeture (l'UI garde ses rushes/timelines). La fermeture est refusée si le cache ne peut
        // pas être vérifié : Resolve n'est jamais tué sur une sauvegarde ou un snapshot incertain.
        if (!projectSnapshot || !captureReaders) return { ok: false, error: t('projectCacheUnavailable') };
        progress('Vérification du cache projet…', 10);
        const cap = await projectSnapshot.capture(
          captureReaders,
          (msg, pct) => progress(msg, pct),
          { skipExistingCuts: true, waitIfBusy: true, requireComplete: true },
        );
        if (!cap || !cap.ok) {
          console.log(`[snapshot] fermeture annulée : ${cap && cap.error ? cap.error : 'capture incomplète'}`);
          return { ok: false, error: (cap && cap.error) || t('projectCacheIncomplete') };
        }
        console.log(`[snapshot] capture vérifiée avant fermeture : ${cap.clips} rush(s), ${cap.timelines} timeline(s) (${cap.fresh} neuves)`);
      }
    } catch (e) {
      return { ok: false, error: `${t('projectSaveFailed')} : ${String(e && /** @type {Error} */ (e).message || e)}` };
    }
    // Arrête le helper Python (il tient un handle vers un Resolve qu'on s'apprête à tuer) → respawn propre.
    try { bridge.stop(); } catch (_) {}
    const r = await taskkillFn(RESOLVE_IMAGE, true);
    if (!r.ok) return { ok: false, error: r.error || 'échec de la fermeture de Resolve' };
    progress('Confirmation de la fermeture de Resolve…', 99);
    if (!(await waitForHostStopped('resolve'))) {
      return { ok: false, error: t('applicationCloseTimeout') };
    }
    closed = { host: 'resolve', project, page, folder, database, at: Date.now() };
    persist(); emit();
    return { ok: true, project, page, folder, database };
  }

  async function reopenResolve(target) {
    const { project, page, folder = [], database = null } = target;
    const exe = resolveExe();
    if (!exe) return { ok: false, error: t('resolveExeMissing') };
    progress('Lancement de DaVinci Resolve…', 5);
    if (!(await isImageRunningFn(RESOLVE_IMAGE))) {
      try { spawnFn(exe, [], { detached: true, stdio: 'ignore' }).unref(); }
      catch (e) { return { ok: false, error: String(e) }; }
      invalidateProcessList(); // l'instantané de processus vient de devenir faux
    }
    // Attend que le pont de scripting réponde (Resolve met du temps à booter + charger l'API).
    const deadline = Date.now() + REOPEN_TIMEOUT_MS;
    let connected = false;
    while (Date.now() < deadline) {
      await sleepFn(POLL_MS);
      try {
        // `force` : on ATTEND activement le boot de Resolve → jamais le cooldown du coupe-circuit
        // (il servirait un « hors ligne » périmé et ferait échouer la réouverture).
        const c = await bridge.connect({ force: true });
        if (c && c.connected) { connected = true; break; }
      } catch (_) {}
      const left = Math.max(0, deadline - Date.now());
      progress('Attente de Resolve…', 5 + Math.round(90 * (1 - left / REOPEN_TIMEOUT_MS)));
    }
    if (!connected) return { ok: false, error: t('resolveTimeout') };
    // Recharge le projet s'il n'est pas déjà ouvert (Resolve rouvre souvent le dernier projet seul).
    if (project) {
      progress(`Ouverture du projet « ${project} »…`, 96);
      try {
        const resolve = await resolveMod.getResolve();
        const pm = resolve ? await resolve.GetProjectManager() : null;
        if (!resolve || !pm) return { ok: false, error: t('resolveProjectOpenFailed') };
        let current = await pm.GetCurrentProject();
        let currentName = current ? await current.GetName() : null;
        if (currentName !== project) {
          const located = await openResolveProjectLocation(pm, folder, database);
          if (!located.ok) return located;
          const loaded = await pm.LoadProject(project);
          if (!loaded) return { ok: false, error: `${t('resolveProjectOpenFailed')} : ${project}` };
          current = await pm.GetCurrentProject();
          currentName = current ? await current.GetName() : null;
          if (currentName !== project) return { ok: false, error: `${t('resolveProjectOpenFailed')} : ${project}` };
        }
        // Retour sur la page d'où on est parti (Montage par défaut : la fermeture a pu se faire hors ligne).
        if (resolve) { try { await resolve.OpenPage(String(page || 'edit')); } catch (_) {} }
      } catch (e) {
        return { ok: false, error: `${t('resolveProjectOpenFailed')} : ${String(e && e.message || e)}` };
      }
    }
    progress('Resolve prêt.', 100);
    return { ok: true, project, page };
  }

  // --- Adobe ---------------------------------------------------------------

  async function closeAdobe(app) {
    let project = null;
    let projectPath = null;
    try {
      const snap = adobeBridge.snapshot(app);
      project = (snap && snap.project) || null;
      projectPath = (snap && snap.projectPath) || null;
    } catch (_) {}
    const r = await adobeBridge.close(app);
    if (!r.ok) return { ok: false, error: r.error || "échec de la fermeture" };
    if (!r.already && !(await waitForHostStopped(app))) {
      return { ok: false, error: t('applicationCloseTimeout') };
    }
    closed = { host: app, project, projectPath, at: Date.now() };
    persist(); emit();
    return { ok: true, already: !!r.already, project, projectPath };
  }

  async function reopenAdobe(app, projectPath) {
    progress('Relancement de l’application…', 20);
    const r = await adobeBridge.launch(app, projectPath || null);
    if (!r.ok) return { ok: false, error: r.error || 'échec du lancement' };
    const deadline = Date.now() + REOPEN_TIMEOUT_MS;
    let running = false;
    while (Date.now() < deadline) {
      try {
        const st = await adobeBridge.status();
        if (st && st[app] && st[app].running) { running = true; break; }
      } catch (_) {}
      await sleepFn(POLL_MS);
    }
    if (!running) return { ok: false, error: t('applicationStartTimeout') };
    progress('Application relancée.', 100);
    return { ok: true };
  }

  // --- Réconciliation : l'état « fermé » ne doit pas survivre à une réouverture EXTERNE ------------
  // (l'utilisateur relance Resolve/Adobe lui-même, ou notre reopen a partiellement échoué). Sinon
  // l'UI affiche « Rouvrir » / la bannière alors que le logiciel est bel et bien ouvert et détecté.

  async function isHostOnline(host) {
    if (host === 'resolve') {
      // Le pop-up décrit si L'APPLICATION est ouverte, pas si l'API de scripting répond. Resolve peut
      // être parfaitement visible avec `scriptapp("Resolve") === null` (API froide/désactivée) : dans
      // ce cas la pastille de connexion reste rouge, mais l'application ne doit jamais être dite fermée.
      return isImageRunningFn(RESOLVE_IMAGE);
    }
    try { const st = await adobeBridge.status(); return !!(st && st[host] && st[host].running); } catch (_) { return false; }
  }

  // Efface l'état « fermé » si le logiciel est en réalité en ligne. Appelé au boot, à la reconnexion
  // détectée par le poll de statut, et à la demande du renderer quand son statut passe « en ligne ».
  async function reconcile() {
    // Pendant une fermeture on ne réconcilie pas sur le processus encore en train de s'arrêter. Pendant
    // une RÉOUVERTURE, au contraire, il faut pouvoir corriger immédiatement l'état même si l'attente de
    // l'API Resolve continue en arrière-plan.
    if (!closed || busyKind === 'close') return snapshot();
    if (await isHostOnline(closed.host)) { closed = null; persist(); emit(); }
    return snapshot();
  }

  // Efface l'état « fermé » d'un hôte réputé de retour en ligne (transition offline→online du watch).
  // On NE jette PLUS le snapshot au retour en ligne : c'est un cache PERSISTANT (construit en fond via
  // Paramètres, rafraîchi passivement pendant l'usage). Le vider ici détruisait le cache pré-construit →
  // le build repartait de zéro à chaque reconnexion au lieu de simplement vérifier. Reset seulement au
  // changement de projet (projectSnapshot.ensure) ou vidage manuel (snapshot:clear).
  function markOnline(host) {
    if (closed && closed.host === host && busyKind !== 'close') { closed = null; persist(); emit(); }
    return { ok: true };
  }

  // Auto-réparation continue : même si la transition de reconnexion a été manquée (fenêtre en arrière-
  // plan, pont encore froid, ouverture manuelle après une erreur), l'état « fermé » est resondé jusqu'à
  // ce que le processus soit réellement détecté. Le pop-up se corrige alors via `power:changed`.
  let reconcilePending = false;
  const autoReconcile = async () => {
    if (reconcilePending || !closed || busyKind === 'close') return;
    reconcilePending = true;
    try { await reconcile(); } finally { reconcilePending = false; }
  };
  const bootTimer = setTimeout(() => { void reconcile(); }, 4000);
  if (bootTimer.unref) bootTimer.unref();
  const reconcileTimer = setInterval(() => { void autoReconcile(); }, 4000);
  if (reconcileTimer.unref) reconcileTimer.unref();

  // --- API publique --------------------------------------------------------

  function state() { return snapshot(); }

  async function close(host) {
  if (busy) return { ok: false, error: t('busyOperation') };
    busy = true; emit();
    busyKind = 'close';
    try {
      if (host === 'resolve') return await closeResolve();
      if (host === 'ppro' || host === 'aeft') return await closeAdobe(host);
    return { ok: false, error: t('unknownHost') };
    } finally {
      busy = false; emit();
      busyKind = null;
    }
  }

  async function reopen() {
  if (busy) return { ok: false, error: t('busyOperation') };
  if (!closed) return { ok: false, error: t('noClosedHost') };
    const target = closed;
    busy = true; emit();
    busyKind = 'reopen';
    try {
      const r = target.host === 'resolve'
        ? await reopenResolve(target)
        : await reopenAdobe(target.host, target.projectPath);
      // Snapshot CONSERVÉ à la réouverture (cache persistant) : le warm passif le rafraîchit à l'usage,
      // et un futur build n'a plus qu'à VÉRIFIER (rien à re-cacher). Ne plus effacer ici.
      if (r.ok) { closed = null; persist(); }
      return { ...r, host: target.host };
    } finally {
      busy = false; emit();
      busyKind = null;
    }
  }

  // Fermer PUIS rouvrir d'un seul geste, sur le même projet et la même page. C'est le seul correctif
  // documenté de la dérive de session (VRAM high-water mark + cache Fusion + pile d'undo, qu'aucune
  // API ne purge) — le rechargement de projet ne rend que la RAM des timelines.
  // Appelle les fonctions INTERNES : passer par close()/reopen() publics reprendrait le verrou `busy`
  // qu'on tient déjà, et l'opération se bloquerait elle-même.
  async function restart(host) {
  if (busy) return { ok: false, error: t('busyOperation') };
  if (host !== 'resolve' && host !== 'ppro' && host !== 'aeft') return { ok: false, error: t('unknownHost') };
    busy = true; emit();
    busyKind = 'close';
    try {
      const c = host === 'resolve' ? await closeResolve() : await closeAdobe(host);
      if (!c.ok) return { ...c, host };
      busyKind = 'reopen';
      const r = host === 'resolve'
        ? await reopenResolve({ host, project: c.project, page: /** @type {any} */ (c).page, folder: /** @type {any} */ (c).folder, database: /** @type {any} */ (c).database })
        : await reopenAdobe(host, /** @type {any} */ (c).projectPath);
      // Réouverture ratée → l'état « fermé » RESTE : la bannière « Rouvrir » prend le relais plutôt
      // que de laisser l'utilisateur avec un Resolve tué et aucune trace de ce qu'il faut rouvrir.
      if (r.ok) { closed = null; persist(); }
      return { ...r, host, project: c.project };
    } finally {
      busy = false; emit();
      busyKind = null;
    }
  }

  return { state, close, reopen, restart, reconcile, markOnline, resolveExe };
}

module.exports = { createHostPower };
