// @ts-check
// core/projectScan.js
// Recensement des projets EXISTANTS pour la portée de recherche. Le registre (core/projectRegistry)
// n'apprend un projet qu'en le lisant : les projets indexés AVANT l'arrivée de cette fonctionnalité
// n'y figurent donc pas, et l'API de scripting n'expose le Media Pool que du projet COURANT — aucun
// moyen de lire les rushs d'un projet sans l'ouvrir.
//
// Ce scan fait donc l'aller-retour explicitement : sauvegarde, ouvre chaque projet à tour de rôle,
// relève ses rushs, puis rouvre le projet d'origine. C'est une action DEMANDÉE par l'utilisateur,
// jamais automatique : elle change ce qui est ouvert dans Resolve pendant quelques secondes par
// projet.
//
// Le balayage couvre TOUTE la bibliothèque, pas le seul dossier courant : les projets d'un monteur
// vivent dans des sous-dossiers (« 2024 », « Clients/… ») et parfois dans plusieurs bases de données
// — ne lire que le dossier ouvert laissait justement les anciens projets invisibles.

const { t } = require('./i18n');
const { captureResolveProjectLocation, openResolveProjectLocation } = require('./resolveProjectLocation');

// Pages qui TIENNENT le projet : il faut passer par « edit » avant d'en changer, sinon le
// changement échoue en silence (même piège que core/optimize.js#reloadProject).
const HOLDING_PAGES = /^(fusion|color|fairlight)$/i;

// Garde-fou d'arborescence : au-delà, on est dans une boucle ou une organisation pathologique.
const MAX_FOLDER_DEPTH = 5;

/**
 * @typedef {object} ProjectRef
 * @property {string} name
 * @property {string[]} folder   chemin de dossiers depuis la racine de la base
 * @property {any} database      base de données du Project Manager (null = base courante)
 */

/**
 * @param {object} deps
 * @param {() => Promise<any>} deps.getResolve
 * @param {(opts?: any) => Promise<{connected:boolean, project?:string|null, clips:any[]}>} deps.listMediaPool
 * @param {{record: (project:string|null|undefined, clips:any[]) => boolean, list: () => any}} deps.registry
 * @param {(channel:string, payload:any)=>void} [deps.broadcast]
 */
function createProjectScan({ getResolve, listMediaPool, registry, broadcast }) {
  let running = false;

  const emit = (payload) => { try { broadcast && broadcast('projects:scan', payload); } catch (_) {} };

  /** Nom du projet courant, ou null. @param {any} pm */
  async function currentName(pm) {
    try {
      const proj = await pm.GetCurrentProject();
      return proj ? String(await proj.GetName()) : null;
    } catch (_) { return null; }
  }

  /** Bases de données du Project Manager (liste vide = API absente → base courante seule). */
  async function databases(pm) {
    if (!pm.GetDatabaseList) return [];
    try { return (await pm.GetDatabaseList()) || []; } catch (_) { return []; }
  }

  /**
   * Projets du dossier courant + de ses sous-dossiers. Le curseur du Project Manager revient au
   * dossier de départ à chaque remontée, donc l'appelant retrouve son point d'entrée intact.
   * @param {any} pm @param {string[]} folder @param {ProjectRef[]} out @param {any} database
   */
  async function collectFolder(pm, folder, out, database, depth = 0) {
    let names = [];
    try { names = (await pm.GetProjectListInCurrentFolder()) || []; } catch (_) { names = []; }
    for (const name of names) {
      const clean = String(name || '').trim();
      if (clean) out.push({ name: clean, folder: [...folder], database });
    }
    if (depth >= MAX_FOLDER_DEPTH || !pm.GetFolderListInCurrentFolder || !pm.OpenFolder) return;
    let subs = [];
    try { subs = (await pm.GetFolderListInCurrentFolder()) || []; } catch (_) { subs = []; }
    for (const sub of subs) {
      const child = String(sub || '').trim();
      if (!child) continue;
      let opened = false;
      try { opened = !!(await pm.OpenFolder(child)); } catch (_) { opened = false; }
      if (!opened) continue;
      await collectFolder(pm, [...folder, child], out, database, depth + 1);
      try { await pm.GotoParentFolder(); } catch (_) { /* remontée impossible : on s'arrête là */ }
    }
  }

  /** Toute la bibliothèque : chaque base, chaque dossier. @param {any} pm */
  async function collectAll(pm) {
    /** @type {ProjectRef[]} */
    const out = [];
    const dbs = await databases(pm);
    if (!dbs.length) {
      try { await pm.GotoRootFolder(); } catch (_) {}
      await collectFolder(pm, [], out, null);
      return out;
    }
    for (const db of dbs) {
      if (pm.SetCurrentDatabase) {
        let ok = false;
        try { ok = !!(await pm.SetCurrentDatabase(db)); } catch (_) { ok = false; }
        if (!ok) continue;   // base injoignable (serveur PostgreSQL éteint) → on passe
      }
      try { await pm.GotoRootFolder(); } catch (_) {}
      await collectFolder(pm, [], out, db);
    }
    return out;
  }

  /** Place le Project Manager sur la base + le dossier d'un projet. @param {any} pm @param {ProjectRef} ref */
  async function goTo(pm, ref) {
    if (ref.database && pm.SetCurrentDatabase) {
      try { if (!(await pm.SetCurrentDatabase(ref.database))) return false; } catch (_) { return false; }
    }
    try { if (pm.GotoRootFolder && !(await pm.GotoRootFolder())) return false; } catch (_) { return false; }
    for (const name of ref.folder) {
      try { if (!(await pm.OpenFolder(name))) return false; } catch (_) { return false; }
    }
    return true;
  }

  /** Ouvre un projet et relève ses rushs dans le registre. @param {any} pm @param {ProjectRef} ref */
  async function harvest(pm, ref) {
    if (!(await goTo(pm, ref))) return false;
    let opened = false;
    try { opened = !!(await pm.LoadProject(ref.name)); } catch (_) { opened = false; }
    // LoadProject renvoie un objet truthy même quand le projet demandé n'a pas pris la main :
    // on vérifie par le nom (mêmes précautions que la fermeture de projet).
    if (!opened || (await currentName(pm)) !== ref.name) return false;
    const media = await listMediaPool({ includeAudio: false });
    if (!media || !media.connected) return false;
    return registry.record(ref.name, media.clips || []);
  }

  /**
   * Scanne toute la bibliothèque de projets. Le projet d'origine est rouvert dans tous les cas —
   * succès comme échec.
   */
  async function scan() {
    if (running) return { ok: false, error: t('scanRunning') };
    const resolve = await getResolve();
    if (!resolve) return { ok: false, error: t('resolveOffline') };
    const pm = await resolve.GetProjectManager();
    if (!pm) return { ok: false, error: t('resolveOffline') };

    const origin = await currentName(pm);
    if (!origin) return { ok: false, error: t('noProject') };

    let page = null;
    try { page = await resolve.GetCurrentPage(); } catch (_) {}
    const restorePage = async () => {
      if (!page) return;
      try { await resolve.OpenPage(String(page)); } catch (_) {}
    };

    running = true;
    const location = await captureResolveProjectLocation(pm);
    let scanned = 0;
    /** @type {string[]} */
    const failed = [];
    let refs = [];
    try {
      if (!(await pm.SaveProject())) return { ok: false, error: t('projectSaveFailed') };
      if (HOLDING_PAGES.test(String(page || ''))) {
        try { await resolve.OpenPage('edit'); } catch (_) {}
      }
      emit({ done: 0, total: 0, project: null });
      refs = await collectAll(pm);
      if (!refs.length) return { ok: false, error: t('noProject') };

      for (let i = 0; i < refs.length; i++) {
        emit({ done: i, total: refs.length, project: refs[i].name });
        if (await harvest(pm, refs[i])) scanned++;
        else failed.push(refs[i].name);
        try { await pm.SaveProject(); } catch (_) {}
      }
      return { ok: true, scanned, failed, total: refs.length };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), scanned, failed };
    } finally {
      running = false;
      if (location.ok) await openResolveProjectLocation(pm, location.folder, location.database);
      // Retour au projet de départ : c'est la seule chose que l'utilisateur ne pardonnerait pas.
      try { await pm.LoadProject(origin); } catch (_) {}
      await restorePage();
      emit({ done: refs.length, total: refs.length, project: null, finished: true });
    }
  }

  return { scan, isRunning: () => running };
}

module.exports = { createProjectScan };
