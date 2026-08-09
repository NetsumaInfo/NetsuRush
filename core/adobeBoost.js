// @ts-check
// core/adobeBoost.js
// NetsuBoost côté Premiere Pro / After Effects : diagnostiquer, nettoyer, purger, régler.
//
// Trois voies d'action, et chacune a ses conditions — c'est ce qui structure ce module :
//   • JOB PANNEAU (adobe:cmd → NR_boost → adobe:jobResult) : exige l'app OUVERTE avec le panneau CEP
//     connecté. Sert aux purges scriptées, aux réglages et aux proxies.
//   • DISQUE (core/adobeCache.js) : exige l'app FERMÉE — vider le media cache pendant qu'Adobe écrit
//     dedans corrompt sa base. D'où l'enchaînement fermer → purger → rouvrir via core/hostPower.js.
//   • PROCESSUS : ne dépend de rien. Les applications Adobe laissent des processus vivants après leur
//     fermeture (fait connu et documenté par les utilisateurs) ; ils tiennent la RAM pour rien.
//
// La mise à mort d'un processus réutilise le canal `optimize:killProcess` existant : un seul chemin
// destructif dans l'application, avec ses garde-fous déjà écrits.

const { execFile } = require("child_process");
const { promisify } = require("util");
const { t } = require("./i18n");
const logbus = require("./logbus");
const adobeCache = require("./adobeCache");
const adobePrefs = require("./adobePrefs");
const { diskInfo } = require("./optimize");

const pExecFile = promisify(execFile);

const APPS = ["ppro", "aeft"];
/** Le diagnostic ne doit jamais rester bloqué sur un panneau muet : les données disque, elles,
 *  arrivent toujours. D'où un timeout court, bien inférieur aux 120 s d'un job normal. */
const STATS_TIMEOUT_MS = 10_000;
/** Attacher 300 proxies en un seul job dépasserait le timeout du pont : on découpe. */
const ATTACH_CHUNK = 25;
const CLOSE_POLL_MS = 500;
const CLOSE_TIMEOUT_MS = 60_000;

/** Processus Adobe qui survivent à la fermeture ou tournent en fond en permanence.
 *  `host` = l'application elle-même (jamais proposée à la mort tant qu'elle tourne pour de bon). */
const ADOBE_PROCS = [
  { name: "Adobe Premiere Pro", host: "ppro" },
  { name: "AfterFX", host: "aeft" },
  { name: "AfterFX.com", host: "aeft" },
  { name: "aerender", host: null },
  { name: "Adobe QT32 Server", host: null },
  { name: "dynamiclinkmanager", host: null },
  { name: "Adobe Media Encoder", host: null },
  { name: "CEPHtmlEngine", host: null },
  { name: "CCXProcess", host: null },
  { name: "CoreSync", host: null },
  { name: "AdobeIPCBroker", host: null },
  { name: "Adobe Desktop Service", host: null },
  { name: "AGSService", host: null },
  { name: "AdobeNotificationClient", host: null },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {any} e */
function msg(e) {
  return String((e && e.message) || e);
}

function createAdobeBoost({ adobeBridge, hostPower, broadcast, ev }) {
  /** @param {string} app */
  function knownApp(app) {
    return APPS.includes(app);
  }

  /** Un job panneau, avec l'enveloppe d'erreur uniforme. Ne jette jamais : l'appelant reçoit
   *  toujours `{ok:false, error}` plutôt qu'une exception qui traverserait le RPC. */
  async function job(app, payload, timeoutMs) {
    if (!knownApp(app)) return { ok: false, error: t("unknownApp") };
    try {
      const res = await adobeBridge.boost(ev, app, payload, timeoutMs);
      return res || { ok: false, error: t("emptyResult") };
    } catch (e) {
      logbus.emit("adobe-boost", "error", `job ${payload && payload.op} (${app}) : ${msg(e)}`);
      return { ok: false, error: msg(e) };
    }
  }

  /** Chemin du projet ouvert, tel que le panneau l'a poussé. Sert à trouver les fichiers de
   *  prévisualisation posés à côté du projet — il n'existe aucun autre moyen de les localiser. */
  function projectPathOf(app) {
    const snap = adobeBridge.snapshot(app);
    return (snap && snap.projectPath) || null;
  }

  /** @param {string} app */
  function roots(app) {
    return adobeCache.adobeCacheRoots(/** @type {'ppro'|'aeft'} */ (app), { projectPath: projectPathOf(app) });
  }

  // --- Processus --------------------------------------------------------------

  /** Processus Adobe présents, avec leur RAM. Requête ciblée par NOM : `optimize.listProcesses` ne
   *  remonte que le top 30 en mémoire, or les auxiliaires Adobe (CCXProcess, CoreSync…) sont
   *  justement nombreux et petits — invisibles dans ce top, et c'est leur somme qui coûte. */
  async function procs() {
    if (process.platform !== "win32") return { ok: false, error: t("windowsOnly"), procs: [] };
    const names = ADOBE_PROCS.map((p) => `'${p.name.replace(/'/g, "''")}'`).join(",");
    let list = [];
    try {
      // Filtré en aval : `Get-Process -Name <liste>` sort en code 1 dès qu'un nom n'a aucun processus
      // vivant, même avec `-ErrorAction SilentlyContinue` — execFile rejetait un scan réussi.
      const { stdout } = await pExecFile(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `$n=@(${names}); Get-Process | Where-Object { $n -contains $_.Name } | Select-Object Name,Id,@{N='ws';E={$_.WorkingSet64}} | ConvertTo-Json -Compress`,
        ],
        { timeout: 8000 },
      );
      const raw = String(stdout).trim();
      if (!raw) return { ok: true, procs: [], total: 0 };
      const parsed = JSON.parse(raw);
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      return { ok: false, error: msg(e), procs: [] };
    }
    const byName = new Map(ADOBE_PROCS.map((p) => [p.name.toLowerCase(), p]));
    const out = list.map((p) => {
      const def = byName.get(String(p.Name).toLowerCase());
      return {
        pid: p.Id,
        name: p.Name,
        ram: p.ws || 0,
        // Une app hôte VIVANTE n'est pas un résidu : la tuer perdrait le montage en cours. Elle reste
        // listée (l'utilisateur veut voir ce qui mange sa RAM) mais protégée.
        host: (def && def.host) || null,
        critical: !!(def && def.host),
      };
    });
    out.sort((a, b) => b.ram - a.ram);
    return { ok: true, procs: out, total: out.reduce((s, p) => s + p.ram, 0) };
  }

  // --- Diagnostic (P0, lecture seule) ----------------------------------------

  /** État complet d'une application : installée, lancée, panneau connecté, caches pesés, disque,
   *  processus, et statistiques vivantes si le panneau répond. */
  async function diagnose(app) {
    if (!knownApp(app)) return { ok: false, error: t("unknownApp") };
    const st = await adobeBridge.status();
    const appStatus = st[app] || { installed: false, running: false, panelConnected: false };
    const cacheRoots = await adobeCache.measure(await roots(app));
    const snap = adobeBridge.snapshot(app);
    const p = await procs();
    // Statistiques vivantes : facultatives par construction. Panneau absent = on affiche tout le reste.
    const live = appStatus.panelConnected ? await job(app, { op: "stats" }, STATS_TIMEOUT_MS) : null;
    return {
      ok: true,
      app,
      installed: !!appStatus.installed,
      running: !!appStatus.running,
      exe: appStatus.exe || null, // seule source de millésime quand l'extension est muette
      panelConnected: !!appStatus.panelConnected,
      panelInstalled: !!st.panelInstalled,
      project: (snap && snap.project) || null,
      projectPath: projectPathOf(app),
      cacheRoots,
      cacheTotal: cacheRoots.reduce((s, r) => s + (r.size || 0), 0),
      disk: cacheRoots.length ? await diskInfo(cacheRoots[0].dir) : null,
      procs: p.procs || [],
      procsRam: p.total || 0,
      live: live && live.ok ? live : null,
      liveError: live && !live.ok ? live.error || null : null,
    };
  }

  // --- Nettoyage disque (P1) --------------------------------------------------

  function say(msgText, pct) {
    try {
      broadcast("boost:progress", { msg: msgText, pct });
    } catch (e) {
      logbus.emit("adobe-boost", "warn", `progression non diffusée : ${msg(e)}`);
    }
  }

  async function scanCache(app, dir) {
    if (!knownApp(app)) return { ok: false, error: t("unknownApp") };
    const known = await roots(app);
    if (!adobeCache.insideAdobeRoots(dir, known)) return { ok: false, error: t("folderMissing") };
    return adobeCache.scan(dir);
  }

  /** Attend la sortie RÉELLE de l'application. `hostPower.close` rend la main dès que le process a
   *  disparu de la liste, mais on revérifie ici : purger le media cache une seconde trop tôt, c'est
   *  écrire dans le dos d'une application qui tient encore ses fichiers. */
  async function waitClosed(app) {
    const deadline = Date.now() + CLOSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const st = await adobeBridge.status();
      if (!st[app] || !st[app].running) return true;
      await sleep(CLOSE_POLL_MS);
    }
    return false;
  }

  /** Purge un lot de racines. Refuse net tant que l'application tourne : `restart:true` est le seul
   *  chemin, et il ferme proprement (dialogue « Enregistrer ? » d'Adobe) avant de rouvrir le projet. */
  async function cleanCache(app, targets, opts) {
    if (!knownApp(app)) return { ok: false, error: t("unknownApp") };
    const known = await roots(app);
    const st = await adobeBridge.status();
    const running = !!(st[app] && st[app].running);
    const restart = !!(opts && opts.restart);

    if (running && !restart) return { ok: false, code: "APP_RUNNING", error: t("adobeAppRunning") };
    if (!running) {
      const r = await adobeCache.clean(targets, known);
      return { ...r, restarted: false };
    }

    say(t("boostClosing"), 10);
    const closed = await hostPower.close(app);
    if (!closed.ok) return { ok: false, error: closed.error || t("adobeCloseFailed") };
    if (!(await waitClosed(app))) return { ok: false, error: t("adobeCloseFailed") };

    say(t("boostPurging"), 45);
    const cleaned = await adobeCache.clean(targets, known);

    say(t("boostReopening"), 80);
    const re = await hostPower.reopen();
    say(null, 100);
    if (!re.ok) {
      logbus.emit("adobe-boost", "warn", `réouverture ${app} échouée : ${re.error}`);
      return { ...cleaned, restarted: false, reopenError: re.error || t("adobeReopenFailed") };
    }
    return { ...cleaned, restarted: true };
  }

  // --- Purges scriptées (P2) --------------------------------------------------

  function purge(app, target) {
    return job(app, { op: "purge", target: target || "memory" });
  }

  function hygiene(app, op) {
    return job(app, { op: "hygiene", mode: op });
  }

  function deletePreviews(app) {
    return job(app, { op: "deletePreviews" });
  }

  // --- Réglages (P3) ----------------------------------------------------------

  async function prefs(app) {
    if (!knownApp(app)) return { ok: false, error: t("unknownApp"), prefs: [] };
    const res = await job(app, { op: "prefsRead" });
    if (!res.ok) return { ok: false, error: res.error, prefs: [] };
    return { ok: true, prefs: adobePrefs.mergeRead(app, res) };
  }

  async function applyPrefs(app, changes) {
    if (!knownApp(app)) return { ok: false, error: t("unknownApp") };
    const { entries, error } = adobePrefs.validate(app, changes || {});
    if (error || !entries) return { ok: false, error: error || t("noChanges") };
    return job(app, { op: "prefsApply", entries: adobePrefs.toPayload(entries) });
  }

  // --- Proxies (P3) -----------------------------------------------------------

  function proxyAudit(app) {
    return job(app, { op: "proxyAudit" });
  }

  function setEnableProxies(app, on) {
    return job(app, { op: "setEnableProxies", on: !!on });
  }

  /** Attache des proxies par lots. Un échec de lot n'arrête pas les suivants : l'utilisateur préfère
   *  180 proxies attachés sur 200 avec la liste des ratés qu'un « échec » global. */
  async function attachProxies(app, pairs) {
    if (!knownApp(app)) return { ok: false, error: t("unknownApp") };
    const list = Array.isArray(pairs) ? pairs.filter((p) => p && p.path && p.proxy) : [];
    if (!list.length) return { ok: false, error: t("noChanges") };
    let attached = 0;
    /** @type {string[]} */
    const failed = [];
    for (let i = 0; i < list.length; i += ATTACH_CHUNK) {
      const chunk = list.slice(i, i + ATTACH_CHUNK);
      const res = await job(app, { op: "attachProxy", pairs: chunk });
      if (!res.ok) {
        failed.push(...chunk.map((c) => c.path));
        logbus.emit("adobe-boost", "warn", `lot de proxies refusé (${chunk.length}) : ${res.error}`);
        continue;
      }
      attached += Number(res.attached) || 0;
      if (Array.isArray(res.failed)) failed.push(...res.failed);
    }
    return { ok: attached > 0, attached, failed, total: list.length };
  }

  return {
    diagnose,
    procs,
    scanCache,
    cleanCache,
    purge,
    hygiene,
    deletePreviews,
    prefs,
    applyPrefs,
    proxyAudit,
    attachProxies,
    setEnableProxies,
  };
}

module.exports = { createAdobeBoost, ADOBE_PROCS };
