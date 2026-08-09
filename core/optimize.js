// @ts-check
// core/optimize.js
// Module « Optimisation » : aide à la perf DaVinci Resolve. Portée VOLONTAIREMENT restreinte à
//   (1) DIAGNOSTIC en lecture seule (état Resolve, file de rendu, réglages cache/proxy, tailles de
//       cache disque + espace libre) ;
//   (2) ARRÊT de tâches via l'API Resolve native (StopRendering / DeleteRenderJob /
//       DeleteAllRenderJobs) — ça arrête, ça ne lance RIEN ;
//   (3) NETTOYAGE de cache disque (suppression fs whitelist-guardée des dossiers de cache Resolve
//       connus) — jamais de génération de cache/proxy/optimized media.
// Aucune écriture de réglage (SetSetting), aucun StartRendering, aucune génération : par conception
// rien ici ne crée de fichiers de cache ni ne déclenche de rendu.

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { getResolve } = require("./resolve-proxy");
const { yieldLoop, NR_HOME } = require("./config");
const sidecars = require("./sidecars"); // daemons python torch-CUDA (recherche/upscale) → VRAM
const proxy = require("./proxy"); // encodes NVENC des proxies → VRAM + sessions encodeur
const gate = require("./export/gate"); // seule vérité du nombre d'encodes en vol
const { HOST_IMAGES, protectedHostBases } = require("./hostImages");
const { createClassifier } = require("./optimize/noise");
const procScan = require("./optimize/procScan");
const { createWatchdog } = require("./optimize/watchdog");
const { isImageRunning } = require("./processList");
const { t } = require("./i18n");
const { captureResolveProjectLocation, openResolveProjectLocation } = require("./resolveProjectLocation");

const fsp = fs.promises;
const pExecFile = promisify(execFile);

// --- Helpers Resolve --------------------------------------------------------

// Projet courant via le pont. Renvoie { resolve, pm, proj } ou null si hors-ligne / pas de projet.
async function currentProject() {
  const resolve = await getResolve();
  if (!resolve) return null;
  const pm = await resolve.GetProjectManager();
  const proj = pm ? await pm.GetCurrentProject() : null;
  if (!proj) return null;
  return { resolve, pm, proj };
}

// Clés de réglage pertinentes pour la perf (cache / proxy / optimized media / lecture).
const PERF_KEY_RE = /cache|proxy|optimi[sz]|perf|superscale|timelineplayback|playbackgpu|render/i;

// Lit tous les réglages projet (GetSetting() sans argument = dict complet) et n'en garde que les
// clés pertinentes pour la perf. Best-effort : le pont peut renvoyer un dict ou rien.
async function readPerfSettings(proj) {
  try {
    const all = await proj.GetSetting();
    if (!all || typeof all !== "object") return {};
    /** @type {Record<string,string>} */
    const out = {};
    for (const k of Object.keys(all)) {
      if (PERF_KEY_RE.test(k)) out[k] = String(all[k]);
    }
    return out;
  } catch {
    return {};
  }
}

// --- Helpers disque ---------------------------------------------------------

// Espace libre/total du volume contenant `p`. Renvoie null si statfs indisponible (vieux Node).
async function diskInfo(p) {
  try {
    if (!fsp.statfs) return null;
    const st = await fsp.statfs(p);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { total, free, used: total - free };
  } catch {
    return null;
  }
}

// Base de données ACTIVE : grossit avec le nombre de projets → cause fréquente de lenteur au
// chargement. Lecture seule (on ne supprime JAMAIS rien là-dedans = ce sont les projets).
//
// Le chemin ne se devine pas : une base disque vit où l'utilisateur l'a mise (souvent hors APPDATA,
// sur le disque des rushs), et le dossier par défaut a changé de nom selon les versions
// (« Resolve Disk Database » → « Resolve Project Library »). On lit donc les deux fichiers de conf
// que Resolve tient à jour, au lieu de parier sur un chemin en dur :
//   activedb.conf → `<type>*:<nom>`               (ex. `disk*:AMV`)
//   dblist.conf   → `<nom>:<chemin>:...:<type>`   (une ligne par base)
// Piège du format : `:` sert de séparateur de champs, donc le deux-points du lecteur est ABSENT du
// chemin (`S\rush\Davinci\AMV` = `S:\rush\Davinci\AMV`) — il faut le remettre.
function resolvePrefsDir() {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  return path.join(appdata, "Blackmagic Design", "DaVinci Resolve", "Preferences");
}

function restoreDriveColon(p) {
  return /^[A-Za-z][\\/]/.test(p) ? `${p[0]}:${p.slice(1)}` : p;
}

async function activeDbPath() {
  const dir = resolvePrefsDir();
  if (!dir) return null;
  let active = null;
  try {
    const raw = (await fsp.readFile(path.join(dir, "activedb.conf"), "utf8")).trim();
    active = raw.split(/[*:]/).filter(Boolean).pop() || null; // `disk*:AMV` → `AMV`
  } catch {
    return null;
  }
  if (!active) return null;
  try {
    const list = await fsp.readFile(path.join(dir, "dblist.conf"), "utf8");
    for (const line of list.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cols = line.split(":");
      if (cols[0] !== active) continue;
      const type = (cols[cols.length - 1] || "").trim().toUpperCase();
      // Une base PostgreSQL n'a pas de dossier à peser : on ne prétend pas la mesurer.
      if (type && type !== "DISK") return { name: active, type, path: null };
      const p = restoreDriveColon((cols[1] || "").trim());
      return p ? { name: active, type: "DISK", path: p } : null;
    }
  } catch {
    return null;
  }
  return null;
}

// Taille récursive d'un dossier (octets). Borne la profondeur et rend la main périodiquement pour ne
// pas affamer l'event loop sur un gros cache. Erreurs d'accès ignorées (fichiers verrouillés).
async function dirSize(root, depth = 6) {
  let total = 0;
  let n = 0;
  async function walk(dir, d) {
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (d > 0) await walk(full, d - 1);
      } else {
        try {
          total += (await fsp.stat(full)).size;
        } catch {}
      }
      if (++n % 200 === 0) await yieldLoop();
    }
  }
  await walk(root, depth);
  return total;
}

// --- Whitelist de nettoyage cache ------------------------------------------

// Noms de dossiers de cache Resolve connus → catégorie. La suppression NE touche QUE des dossiers
// dont le basename figure ici (et on vide leur CONTENU, on ne retire pas le dossier lui-même).
const CACHE_DIRS = [
  { name: "CacheClip", kind: "render", labelKey: "cacheRender" },
  { name: "ProxyMedia", kind: "proxy", labelKey: "cacheProxy" },
  { name: "Proxy", kind: "proxy", labelKey: "cacheProxy" },
  { name: ".gallery", kind: "gallery", labelKey: "cacheGallery" },
  { name: "Gallery", kind: "gallery", labelKey: "cacheGallery" },
];
const CACHE_NAMES = new Set(CACHE_DIRS.map((d) => d.name.toLowerCase()));
function cacheMeta(name) {
  return CACHE_DIRS.find((d) => d.name.toLowerCase() === name.toLowerCase()) || null;
}

// Racines de cache CANDIDATES. Source #1 = la LISTE DES VOLUMES Media Storage de Resolve
// (`GetMediaStorage().GetMountedVolumeList()`) : le 1er volume est l'emplacement de cache PAR DÉFAUT
// de Resolve (le cache n'est PAS dans AppData — il vit dans `<volume>/CacheClip`). Source #2 = les
// valeurs de réglages projet qui ressemblent à un chemin (emplacement de cache personnalisé).
// Dé-dupliquées, filtrées sur l'existence réelle. Best-effort.
async function detectCacheRoots(resolve, perfSettings) {
  const cands = new Set();
  try {
    if (resolve) {
      const ms = await resolve.GetMediaStorage();
      const vols = ms ? await ms.GetMountedVolumeList() : null;
      if (Array.isArray(vols)) for (const v of vols) if (v) cands.add(String(v));
    }
  } catch {}
  for (const v of Object.values(perfSettings || {})) {
    const s = String(v || "");
    if (/[\\/]/.test(s) && s.length > 3 && !/^https?:/i.test(s)) cands.add(s);
  }
  /** @type {string[]} */
  const roots = [];
  for (const c of cands) {
    try {
      if ((await fsp.stat(c)).isDirectory()) roots.push(c);
    } catch {}
  }
  return roots;
}

// Repère les dossiers de cache Resolve connus (+ taille) sous une racine. On regarde : la racine
// elle-même (si on pointe directement un CacheClip), ses enfants directs, et UN niveau de plus
// (emplacement de cache personnalisé `<racine>/MonCache/CacheClip`). Profondeur bornée à 1 pour ne
// PAS scanner un disque entier ; `dirSize` n'est calculé que sur les dossiers reconnus.
async function scanCache(root) {
  if (!root) return { ok: false, error: t("noFolder"), entries: [], disk: null };
  let exists = false;
  try {
    exists = (await fsp.stat(root)).isDirectory();
  } catch {}
  if (!exists) return { ok: false, error: t("folderMissing"), entries: [], disk: null };

  /** @type {{path:string,name:string,kind:string,label:string,size:number}[]} */
  const entries = [];
  const seen = new Set();
  async function add(full, name) {
    if (seen.has(full)) return;
    const meta = cacheMeta(name);
    if (!meta) return;
    seen.add(full);
    entries.push({ path: full, name, kind: meta.kind, label: t(meta.labelKey), size: await dirSize(full) });
  }
  await add(root, path.basename(root));
  async function look(dir, depth) {
    /** @type {fs.Dirent[]} */
    let list;
    try {
      list = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (CACHE_NAMES.has(e.name.toLowerCase())) await add(full, e.name);
      else if (depth > 0) await look(full, depth - 1);
    }
  }
  await look(root, 1);
  const disk = await diskInfo(root);
  return { ok: true, root, entries, disk };
}

// Supprime le CONTENU des dossiers de cache passés. Re-valide la whitelist côté serveur : chaque
// chemin doit avoir un basename de cache connu (sinon ignoré). Renvoie les octets libérés.
async function cleanPaths(paths) {
  const targets = Array.isArray(paths) ? paths : [];
  let freed = 0;
  const removed = [];
  const skipped = [];
  for (const p of targets) {
    const base = path.basename(String(p || ""));
    if (!CACHE_NAMES.has(base.toLowerCase())) {
      skipped.push(p);
      continue;
    }
    let size = 0;
    try {
      size = await dirSize(p);
    } catch {}
    try {
      // Vide le contenu, conserve le dossier (Resolve le réutilise).
      const entries = await fsp.readdir(p, { withFileTypes: true });
      for (const e of entries) {
        await fsp.rm(path.join(p, e.name), { recursive: true, force: true });
        await yieldLoop();
      }
      freed += size;
      removed.push(p);
    } catch (e) {
      skipped.push(p);
    }
  }
  return { ok: true, freed, removed, skipped };
}

// --- Diagnostic + contrôle de file de rendu --------------------------------

// Liste de la file de rendu + rendu en cours. Tolérant : renvoie connected:false si pont KO.
async function renderJobs() {
  const ctx = await currentProject();
  if (!ctx) return { connected: false, jobs: [], inProgress: false };
  try {
    const list = (await ctx.proj.GetRenderJobList()) || [];
    const inProgress = !!(await ctx.proj.IsRenderingInProgress());
    const jobs = (Array.isArray(list) ? list : []).map((j) => ({
      id: j.JobId || j.JobID || "",
      name: j.RenderJobName || j.OutputFilename || j.JobId || "Job",
      target: j.TargetDir || "",
    }));
    return { connected: true, jobs, inProgress };
  } catch (e) {
    return { connected: false, jobs: [], inProgress: false, error: String(e) };
  }
}

// Snapshot complet pour l'onglet : état Resolve + réglages perf + file de rendu + racines de cache
// candidates (auto-détection). 100% lecture seule.
async function diagnose() {
  const [vram, ctx] = await Promise.all([
    gpuVram(), // lisible même Resolve hors-ligne (c'est le GPU de la machine)
    currentProject(),
  ]);
  if (!ctx) {
    return {
      connected: false,
      project: null,
      timeline: null,
      version: null,
      settings: {},
      render: { jobs: [], inProgress: false },
      cacheRoots: [],
      vram,
    };
  }
  const { resolve, proj } = ctx;
  let version = null;
  let project = null;
  let timeline = null;
  try {
    version = await resolve.GetVersionString();
  } catch {}
  try {
    project = await proj.GetName();
  } catch {}
  try {
    const tl = await proj.GetCurrentTimeline();
    timeline = tl ? await tl.GetName() : null;
  } catch {}
  const settings = await readPerfSettings(proj);
  let render = { jobs: [], inProgress: false };
  try {
    const list = (await proj.GetRenderJobList()) || [];
    render.inProgress = !!(await proj.IsRenderingInProgress());
    render.jobs = (Array.isArray(list) ? list : []).map((j) => ({
      id: j.JobId || j.JobID || "",
      name: j.RenderJobName || j.OutputFilename || j.JobId || "Job",
      target: j.TargetDir || "",
    }));
  } catch {}
  const cacheRoots = await detectCacheRoots(resolve, settings);
  let page = null;
  try {
    page = await resolve.GetCurrentPage();
  } catch {}
  // Taille de la base ACTIVE (read-only) → repère le bloat « trop de projets ».
  let db = null;
  const active = await activeDbPath();
  if (active && active.path) {
    try {
      if ((await fsp.stat(active.path)).isDirectory()) {
        db = { path: active.path, name: active.name, size: await dirSize(active.path) };
      }
    } catch {}
  } else if (active) {
    db = { path: null, name: active.name, type: active.type, size: null }; // PostgreSQL : pas de dossier à peser
  }
  return { connected: true, project, timeline, version, settings, render, cacheRoots, page, db, vram };
}

// Arrête le rendu en cours (n'enlève pas les jobs de la file). Ne lance rien.
async function stopRender() {
  const ctx = await currentProject();
  if (!ctx) return { ok: false, error: t("resolveOffline") };
  try {
    await ctx.proj.StopRendering();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Vide toute la file de rendu (jobs en attente). Arrête d'abord un éventuel rendu actif.
async function clearRenderQueue() {
  const ctx = await currentProject();
  if (!ctx) return { ok: false, error: t("resolveOffline") };
  try {
    try {
      await ctx.proj.StopRendering();
    } catch {}
    const ok = await ctx.proj.DeleteAllRenderJobs();
    return { ok: !!ok };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Pages qui tiennent le projet : depuis Fusion/Couleur/Fairlight, CloseProject renvoie false sans rien
// fermer. On bascule donc sur Montage avant, et on restaure la page à la fin.
const HOLDING_PAGES = /^(fusion|color|fairlight)$/i;

// Recharge le projet courant (save → close → reopen) → FLUSH la RAM des timelines empilées sans
// fermer Resolve. Seule méthode native pour récupérer la mémoire en cours de session. Sauvegarde
// d'ABORD (zéro perte). Si la réouverture échoue (projet dans un sous-dossier de base), on le signale
// clairement plutôt que de laisser l'utilisateur sans projet ouvert.
async function reloadProject() {
  const resolve = await getResolve();
  if (!resolve) return { ok: false, error: t("resolveOffline") };
  const pm = await resolve.GetProjectManager();
  const proj = pm ? await pm.GetCurrentProject() : null;
  if (!proj) return { ok: false, error: t("noProject") };
  let name = null;
  try {
    name = await proj.GetName();
  } catch {}
  if (!name) return { ok: false, error: t("projectNameMissing") };
  let page = null;
  try {
    page = await resolve.GetCurrentPage();
  } catch {}
  // La page d'origine est rendue dans TOUS les cas (succès comme échec) : on ne laisse pas
  // l'utilisateur ailleurs que là où il travaillait à cause d'une manœuvre interne.
  const restorePage = async () => {
    if (!page) return;
    try {
      await resolve.OpenPage(String(page));
    } catch {}
  };
  try {
    const location = await captureResolveProjectLocation(pm);
    if (!location.ok) return location;
    if (!(await pm.SaveProject())) return { ok: false, error: t("projectSaveFailed") };
    if (HOLDING_PAGES.test(String(page || ""))) {
      try {
        await resolve.OpenPage("edit");
      } catch {}
    }
    await pm.CloseProject(proj);
    // CloseProject échoue en silence : il renvoie false sans dire pourquoi, et LoadProject retrouve
    // alors le projet TOUJOURS ouvert — donc un retour truthy ne prouve RIEN. On vérifie par le nom
    // que le projet est bien parti, sinon on annonçait « mémoire libérée » sans avoir rien libéré.
    let stillOpen = null;
    try {
      const cur = await pm.GetCurrentProject();
      stillOpen = cur ? await cur.GetName() : null;
    } catch {}
    if (stillOpen === name) {
      await restorePage();
      return {
        ok: false,
        error: `${t("projectCloseRefused")} (${name})`,
      };
    }
    const located = await openResolveProjectLocation(pm, location.folder, location.database);
    if (!located.ok) return located;
    const re = await pm.LoadProject(name);
    if (!re) {
      return {
        ok: false,
        error: `${t("projectReopenFailed")} (${name})`,
      };
    }
    let reopenedName = null;
    try {
      const current = await pm.GetCurrentProject();
      reopenedName = current ? await current.GetName() : null;
    } catch {}
    if (reopenedName !== name) {
      return { ok: false, error: `${t("projectReopenFailed")} (${name})` };
    }
    await restorePage();
    return { ok: true, project: name, page };
  } catch (e) {
    await restorePage();
    return { ok: false, error: String(e) };
  }
}

// Bascule Resolve sur une page légère (défaut "media") → relâche le pipeline Couleur/Fusion qui
// tient le GPU/VRAM occupé. Gain VRAM non garanti par la doc officielle mais relâche le pipeline.
// Ne génère/supprime rien. Pages valides : media|cut|edit|fusion|color|fairlight|deliver.
async function openPage(page) {
  const resolve = await getResolve();
  if (!resolve) return { ok: false, error: t("resolveOffline") };
  try {
    const ok = await resolve.OpenPage(String(page || "media"));
    let now = null;
    try {
      now = await resolve.GetCurrentPage();
    } catch {}
    return { ok: !!ok, page: now };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Retire de la file SEULEMENT les jobs de rendu terminés (JobStatus "Complete"/"Failed"/"Cancelled").
// Les jobs en cours/en attente sont laissés intacts. Allège la file qui s'accumule au fil des exports.
async function clearFinishedJobs() {
  const ctx = await currentProject();
  if (!ctx) return { ok: false, error: t("resolveOffline") };
  try {
    const list = (await ctx.proj.GetRenderJobList()) || [];
    let removed = 0;
    for (const j of Array.isArray(list) ? list : []) {
      const id = j.JobId || j.JobID;
      if (!id) continue;
      let status = "";
      try {
        const s = await ctx.proj.GetRenderJobStatus(id);
        status = (s && (s.JobStatus || s.Status)) || "";
      } catch {}
      if (/complete|failed|cancel/i.test(status)) {
        try {
          if (await ctx.proj.DeleteRenderJob(id)) removed++;
        } catch {}
      }
    }
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Supprime un job de rendu précis de la file.
async function deleteRenderJob(id) {
  if (!id) return { ok: false, error: t("noJob") };
  const ctx = await currentProject();
  if (!ctx) return { ok: false, error: t("resolveOffline") };
  try {
    const ok = await ctx.proj.DeleteRenderJob(String(id));
    return { ok: !!ok };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Lecture VRAM via nvidia-smi (read-only, ~10-100 ms). nvidia-smi n'est PAS toujours dans le PATH →
// on tente le PATH puis l'emplacement par défaut du pilote. Chemin mémorisé une fois trouvé. null si
// pas de GPU NVIDIA / nvidia-smi introuvable.
let _nvPath = null;
async function gpuVram() {
  const cands = _nvPath
    ? [_nvPath]
    : ["nvidia-smi", "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"];
  for (const c of cands) {
    try {
      const { stdout } = await pExecFile(
        c,
        ["--query-gpu=memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
        { timeout: 4000 },
      );
      _nvPath = c;
      const line = String(stdout).trim().split(/\r?\n/)[0] || "";
      const [used, total, util] = line.split(",").map((s) => parseInt(s.trim(), 10));
      if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
        return { usedMB: used, totalMB: total, util: Number.isFinite(util) ? util : null };
      }
    } catch {}
  }
  return null;
}

// Charge CPU système (%), calculée par DELTA entre deux échantillons os.cpus() (os.loadavg() renvoie
// 0 sur Windows → inutilisable). null au tout premier échantillon (pas de delta).
let _prevCpu = null;
function cpuPercent() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  const prev = _prevCpu;
  _prevCpu = { total, idle };
  if (!prev) return null;
  const dt = total - prev.total;
  const di = idle - prev.idle;
  return dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : null;
}

// Arrête les tâches LOURDES de NetsuRush (les seules qu'on contrôle) : encodes proxy NVENC +
// daemons python torch-CUDA (recherche/upscale). Ces process chargent À LA FOIS le GPU (VRAM/NVENC)
// ET le CPU/RAM (process python) → les tuer relâche les deux. Respawn paresseux au besoin.
function stopHeavyWork() {
  let proxiesKilled = 0;
  try {
    const r = proxy.proxyCancelAll();
    proxiesKilled = r && typeof r.killed === "number" ? r.killed : 0;
  } catch {}
  try {
    sidecars.killSidecars();
  } catch {}
  return proxiesKilled;
}

// LIBÈRE LA VRAM QUE NETSURUSH OCCUPE pour la rendre au rendu Resolve. On ne peut PAS vider la VRAM
// que Resolve tient (pas d'API), mais on contrôle 100% la nôtre : on annule tous les encodes proxy
// NVENC (sessions encodeur + VRAM) et on tue les daemons python torch-CUDA (recherche SigLIP / upscale
// Real-ESRGAN / détection) qui réservent de gros blocs VRAM. Ils respawn paresseusement au prochain
// usage → aucun dommage permanent. Renvoie la VRAM relue après (preuve de l'effet).
// Libère les ressources : arrête la charge NetsuRush (encodes + daemons IA) ET nettoie les RÉSIDUS du
// PC = applis figées « Ne répond pas ». Base commune des 3 boutons (GPU/CPU/RAM) ; chacun relit ensuite
// sa propre jauge comme preuve (les process lourds étant dual-resource, libérer l'un libère les trois).
async function freeResources() {
  const proxiesKilled = stopHeavyWork();
  let deadKilled = 0;
  try {
    const r = await cleanDeadProcesses();
    deadKilled = r.killed || 0;
  } catch {}
  await new Promise((r) => setTimeout(r, 800)); // laisse l'OS/pilote récupérer la mémoire avant relecture
  return { proxiesKilled, deadKilled };
}

// Libère la RAM physique inutilisée (EmptyWorkingSet via psapi) → Windows la pagine sur disque, la
// mémoire redevient disponible tout de suite. Non destructif : la page revient à la demande.
//
// Ce trim vise TOUT SAUF les processus critiques. Il portait auparavant sur `Get-Process` en entier :
// il vidait donc aussi le working set de l'hôte de montage et le nôtre, forçant l'application qu'on
// veut RAPIDE à repaginer plusieurs gigaoctets — au pire moment, pendant un rendu.
async function trimWorkingSets() {
  if (process.platform !== "win32") return false;
  try {
    const procs = await procScan.scanProcesses(classifier);
    const pids = procs.filter((p) => !p.critical && p.pid !== process.pid).map((p) => p.pid);
    const r = await procScan.trimProcesses(pids);
    return r.ok;
  } catch {
    return false;
  }
}

async function freeGpu() {
  const before = await gpuVram();
  const { proxiesKilled, deadKilled } = await freeResources();
  const vram = await gpuVram();
  const vramFreedMB = before && vram ? Math.max(0, before.usedMB - vram.usedMB) : 0;
  return { ok: true, proxiesKilled, deadKilled, vramFreedMB, vram };
}

async function freeCpu() {
  const { proxiesKilled, deadKilled } = await freeResources();
  return { ok: true, proxiesKilled, deadKilled, cpu: cpuPercent() };
}

async function freeRam() {
  const before = os.freemem();
  stopHeavyWork();
  let deadKilled = 0;
  try {
    deadKilled = (await cleanDeadProcesses()).killed || 0;
  } catch {}
  await trimWorkingSets();
  await new Promise((r) => setTimeout(r, 500));
  const after = os.freemem();
  const ramFreed = Math.max(0, after - before);
  return { ok: true, deadKilled, ramFreed, ram: { free: after, total: os.totalmem() } };
}

// Classement des processus (noyau Windows / hôte de montage / les nôtres / bruit d'arrière-plan).
// La liste des hôtes protégés vient de `hostImages.js` — source unique partagée avec le pont Adobe et
// l'alimentation d'hôte. Elle était recopiée ici À LA MAIN et ne contenait que Resolve : sur un poste
// Premiere ou After Effects, le gestionnaire proposait d'arrêter l'application qui tient le montage.
const classifier = createClassifier({ hostBases: protectedHostBases() });

function procBase(name) {
  return String(name || "").toLowerCase().replace(/\.exe$/i, "");
}
function isCriticalProc(name) {
  return classifier.classify(name).critical;
}

// Map pid → { vramMB, name } des processus QUI UTILISENT LE GPU (nvidia-smi compute-apps). Répond
// directement à « qu'est-ce qui pollue ma VRAM » (Resolve, Chrome, NetsuRush, jeux…).
async function gpuProcs() {
  const map = new Map();
  const cands = _nvPath
    ? [_nvPath]
    : ["nvidia-smi", "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"];
  for (const c of cands) {
    try {
      const { stdout } = await pExecFile(
        c,
        ["--query-compute-apps=pid,used_gpu_memory,process_name", "--format=csv,noheader,nounits"],
        { timeout: 4000 },
      );
      _nvPath = c;
      for (const line of String(stdout).trim().split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parts = line.split(",").map((s) => s.trim());
        const pid = parseInt(parts[0], 10);
        const mem = parseInt(parts[1], 10);
        if (Number.isFinite(pid)) map.set(pid, { vramMB: Number.isFinite(mem) ? mem : 0, name: parts[2] || "" });
      }
      return map;
    } catch {}
  }
  return map;
}

const PROC_LIST_MAX = 30;

/** Forme attendue par le renderer (un scan enrichi porte plus de champs qu'il n'en affiche). */
function toProcRow(p) {
  return {
    pid: p.pid,
    name: p.name,
    ram: p.ram,
    vramMB: p.vramMB,
    cpu: p.cpu,
    windowed: p.windowed,
    kind: p.kind,
    family: p.family,
    risk: p.risk,
    critical: p.critical,
  };
}

// Liste les processus gourmands du PC, triés VRAM puis CPU puis RAM, chacun CLASSÉ (système / hôte de
// montage / nôtre / bruit d'arrière-plan). Le tri par working set seul manquait les tâches de fond qui
// mangent le processeur sans occuper de mémoire — invisibles alors qu'elles ralentissent le rendu.
// Read-only, à la demande (deux échantillons espacés pour la charge CPU ≈ 1,5 s).
async function listProcesses() {
  if (process.platform !== "win32") return { ok: false, error: t("windowsOnly"), procs: [] };
  try {
    const vram = await gpuProcs();
    const scanned = await procScan.scanProcessesWithLoad(classifier, vram);
    const byPid = new Map(scanned.map((p) => [p.pid, p]));
    // Un consommateur de VRAM peut être absent du scan (droits) : on le rajoute, c'est précisément
    // celui qu'on cherche quand la question est « qui remplit ma carte ».
    for (const [pid, info] of vram) {
      if (byPid.has(pid)) continue;
      const name = procBase(info.name);
      const v = classifier.classify(name);
      byPid.set(pid, {
        pid, name, ram: 0, cpuMs: 0, cpu: null, windowed: false, path: "", vramMB: info.vramMB,
        kind: v.kind, family: v.family, risk: v.risk, restart: v.restart, critical: v.critical,
      });
    }
    const procs = [...byPid.values()]
      .sort((a, b) => b.vramMB - a.vramMB || (b.cpu || 0) - (a.cpu || 0) || b.ram - a.ram)
      .slice(0, PROC_LIST_MAX)
      .map(toProcRow);
    return { ok: true, procs };
  } catch (e) {
    return { ok: false, error: String(e), procs: [] };
  }
}

// Bruit d'arrière-plan ARRÊTABLE : updaters, superpositions, clients de synchro… Ni critique, ni
// fenêtré (une application visible sert peut-être à l'utilisateur), trié par RAM décroissante.
async function noiseProcesses() {
  if (process.platform !== "win32") return { ok: false, error: t("windowsOnly"), procs: [] };
  try {
    const scanned = await procScan.scanProcesses(classifier);
    return { ok: true, procs: procScan.killableNoise(scanned).map(toProcRow) };
  } catch (e) {
    return { ok: false, error: String(e), procs: [] };
  }
}

// Arrête une LISTE de processus de bruit en un appel (le bouton « Arrêter ces N tâches »). La liste
// vient du renderer et peut avoir vieilli — Windows recycle les PID —, donc on RE-SCANNE et on ne
// garde que l'intersection avec le bruit réellement arrêtable au moment du clic.
async function killNoise(pids) {
  const asked = new Set((Array.isArray(pids) ? pids : []).map(Number).filter(Number.isFinite));
  if (!asked.size) return { ok: true, killed: 0, names: [], skipped: 0 };
  const allowed = procScan.killableNoise(await procScan.scanProcesses(classifier)).filter((p) => asked.has(p.pid));
  const names = [];
  for (const p of allowed) {
    const r = await killProcess(p.pid);
    if (r.ok) names.push(p.name);
  }
  return { ok: true, killed: names.length, names, skipped: asked.size - names.length };
}

// Tue un processus du PC par PID. Garde-fous : re-valide la criticité par le nom courant, refuse notre
// propre process et les critiques. Équivalent « Fin de tâche » du Gestionnaire (peut perdre le travail
// non sauvé de l'app visée → confirmation côté UI).
async function killProcess(pid) {
  const id = parseInt(pid, 10);
  if (!Number.isFinite(id)) return { ok: false, error: t("invalidPid") };
  if (id === process.pid) return { ok: false, error: t("ownProcess") };
  try {
    const { stdout } = await pExecFile("tasklist", ["/fi", `PID eq ${id}`, "/fo", "csv", "/nh"], { timeout: 4000 });
    const line = String(stdout).trim().split(/\r?\n/)[0] || "";
    const name = (line.split('","')[0] || "").replace(/^"/, "");
    if (name && isCriticalProc(name)) return { ok: false, error: `${t("criticalProcess")}: ${name}` };
  } catch {}
  try {
    process.kill(id);
    return { ok: true };
  } catch {
    try {
      await pExecFile("taskkill", ["/PID", String(id), "/F"], { timeout: 4000 });
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: String(e2) };
    }
  }
}

// Processus FIGÉS (« Ne répond pas ») = applis plantées/résidus qui retiennent RAM/VRAM pour rien.
// Détectés via le statut Windows (tasklist STATUS eq NOT RESPONDING). Exclut les critiques.
async function deadProcesses() {
  if (process.platform !== "win32") return { ok: false, error: t("windowsOnly"), procs: [] };
  try {
    const { stdout } = await pExecFile(
      "tasklist",
      ["/fi", "STATUS eq NOT RESPONDING", "/fo", "csv", "/nh"],
      { timeout: 6000 },
    );
    const out = [];
    const seen = new Set();
    for (const line of String(stdout).trim().split(/\r?\n/)) {
      if (!line.includes('","')) continue; // saute "INFO: No tasks..."
      const cols = line.split('","').map((s) => s.replace(/^"|"$/g, ""));
      const pid = parseInt(cols[1], 10);
      if (!Number.isFinite(pid) || seen.has(pid)) continue;
      seen.add(pid);
      out.push({ pid, name: procBase(cols[0]), critical: isCriticalProc(cols[0]) });
    }
    return { ok: true, procs: out };
  } catch (e) {
    return { ok: false, error: String(e), procs: [] };
  }
}

// Tue automatiquement tous les processus figés non critiques (résidus). Renvoie le compte + les noms.
async function cleanDeadProcesses() {
  const r = await deadProcesses();
  if (!r.ok) return { ok: false, error: r.error, killed: 0, names: [] };
  let killed = 0;
  const names = [];
  for (const p of r.procs) {
    if (p.critical || p.pid === process.pid) continue;
    let done = false;
    try {
      process.kill(p.pid);
      done = true;
    } catch {
      try {
        await pExecFile("taskkill", ["/PID", String(p.pid), "/F"], { timeout: 4000 });
        done = true;
      } catch {}
    }
    if (done) {
      killed++;
      names.push(p.name);
    }
  }
  return { ok: true, killed, names };
}

// RAM (working set) du process Resolve.exe via tasklist (Windows). Léger (~10-50 ms), read-only.
async function resolveProcRam() {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await pExecFile(
      "tasklist",
      ["/fi", "imagename eq Resolve.exe", "/fo", "csv", "/nh"],
      { timeout: 4000 },
    );
    const line = String(stdout).trim().split(/\r?\n/).find((l) => /Resolve\.exe/i.test(l));
    if (!line) return null;
    const cols = line.split('","').map((s) => s.replace(/^"|"$/g, ""));
    const kb = parseInt(String(cols[cols.length - 1]).replace(/[^\d]/g, ""), 10); // "1 234 567 K"
    return Number.isFinite(kb) ? kb * 1024 : null; // octets
  } catch {
    return null;
  }
}

// Snapshot LIVE des ressources pour le moniteur pré-crash : VRAM (nvidia-smi), RAM système (os),
// RAM de Resolve.exe, et espace disque du dossier de cache (si fourni). Léger → pollable ~2,5 s.
async function resources(root) {
  const gpu = await gpuVram();
  const ram = { free: os.freemem(), total: os.totalmem() };
  const cpu = cpuPercent();
  let resolveRam = null;
  try {
    resolveRam = await resolveProcRam();
  } catch {}
  let disk = null;
  if (root) disk = await diskInfo(root);
  return { gpu, ram, cpu, resolveRam, disk };
}

// --- Dérive de session ------------------------------------------------------

// « Plus je l'utilise longtemps, plus c'est lent » : la VRAM de Resolve est un high-water mark (les
// frames décodées ne sont rendues qu'à la sortie du process), et le cache Fusion (75 % de la RAM
// allouée par défaut) comme la pile d'undo s'empilent sans jamais se vider. Aucune API ne les purge :
// recharger le projet ou redémarrer Resolve sont les seuls correctifs. On mesure donc la dérive pour
// dire QUAND ça vaut le coup, au lieu de laisser deviner. 100 % lecture seule : tasklist + nvidia-smi,
// ~50 ms par minute.

const SAMPLE_MS = 60_000;
const MAX_SAMPLES = 180; // 3 h d'historique
// Une session saine dérive de ~300-600 Mo sur 2 h. Au-delà de ces paliers, un rechargement se justifie.
const DRIFT_WATCH = 1.5 * 1024 ** 3;
const DRIFT_HIGH = 3 * 1024 ** 3;

/** @type {{ at:number, ram:number, vram:number|null, vramTotal:number|null }[]} */
let samples = [];
let sessionAt = 0; // 1re mesure de la session Resolve courante

async function sampleSession() {
  const ram = await resolveProcRam();
  if (ram == null) {
    // Resolve fermé → la session est finie ; la prochaine repart d'une baseline propre.
    samples = [];
    sessionAt = 0;
    return;
  }
  const prev = samples.length ? samples[samples.length - 1].ram : null;
  // Resolve relancé entre deux mesures (le sampler dort 60 s) : la RAM s'effondre → nouvelle session.
  if (prev != null && ram < prev * 0.5) {
    samples = [];
    sessionAt = 0;
  }
  const v = await gpuVram();
  if (!sessionAt) sessionAt = Date.now();
  samples.push({ at: Date.now(), ram, vram: v ? v.usedMB : null, vramTotal: v ? v.totalMB : null });
  if (samples.length > MAX_SAMPLES) samples.shift();
}

// Dérive depuis la 1re mesure de la session. Si le core a démarré alors que Resolve tournait déjà, la
// baseline est celle du moment où on a commencé à regarder — on SOUS-estime alors la dérive réelle,
// jamais l'inverse : on ne crie pas au loup.
function sessionHealth() {
  if (!samples.length) return { running: false, verdict: "ok", samples: [] };
  const first = samples[0];
  const last = samples[samples.length - 1];
  const driftRam = last.ram - first.ram;
  const driftVram = last.vram != null && first.vram != null ? last.vram - first.vram : null;
  const vramPct = last.vram != null && last.vramTotal ? (last.vram / last.vramTotal) * 100 : null;
  let verdict = "ok";
  if (driftRam >= DRIFT_WATCH) verdict = "watch";
  if (driftRam >= DRIFT_HIGH) verdict = "high";
  // VRAM au plafond = le pré-crash « GPU memory full » : prioritaire sur la dérive RAM.
  if (vramPct != null && vramPct >= 90) verdict = "high";
  return {
    running: true,
    since: sessionAt,
    measured: last.at - sessionAt,
    ram: last.ram,
    baselineRam: first.ram,
    driftRam,
    vram: last.vram,
    vramTotal: last.vramTotal,
    driftVram,
    verdict,
    samples,
  };
}

const sampleTimer = setInterval(() => {
  void sampleSession().catch(() => {});
}, SAMPLE_MS);
if (sampleTimer.unref) sampleTimer.unref();
void sampleSession().catch(() => {});

// --- Surveillance mémoire pendant les tâches lourdes -------------------------

const WATCHDOG_PREFS_FILE = path.join(NR_HOME, "optimize-watchdog.json");
// `renderJobs` traverse le pont Python : le sonder à chaque tick ajouterait un aller-retour toutes
// les 10 s pendant un rendu, exactement quand la machine est chargée. Un rendu dure des minutes,
// une minute de granularité suffit largement à l'armer.
const HOST_POLL_MS = 60_000;

let hostRendering = false;
let hostPolledAt = 0;
/** @type {ReturnType<typeof createWatchdog>|null} */
let watchdog = null;

function readWatchdogPrefs() {
  try {
    return JSON.parse(fs.readFileSync(WATCHDOG_PREFS_FILE, "utf8"));
  } catch {
    return null; // absent au premier lancement : le watchdog prendra ses défauts
  }
}

function writeWatchdogPrefs(prefs) {
  try {
    const tmp = `${WATCHDOG_PREFS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2));
    fs.renameSync(tmp, WATCHDOG_PREFS_FILE); // écriture atomique : jamais de fichier à moitié écrit
  } catch (e) {
    console.warn("[optimize] préférences de surveillance non enregistrées :", String(e));
  }
}

/** Un rendu tourne-t-il dans l'hôte ? Sondé au plus une fois par minute (cf. HOST_POLL_MS). */
async function pollHostRender() {
  if (!(await isImageRunning(HOST_IMAGES.resolve))) return false;
  const r = await renderJobs();
  return !!r.inProgress;
}

/**
 * « NetsuRush ou l'hôte travaille-t-il ? » Les deux premiers signaux sont GRATUITS (compteurs en
 * mémoire) et couvrent nos propres encodes ; seul le rendu de l'hôte coûte un aller-retour, d'où sa
 * cadence à part. Un rendu lancé depuis Adobe Media Encoder n'est pas détectable à ce prix : il reste
 * hors de portée de l'armement automatique, la surveillance manuelle le couvre.
 */
async function heavySignal() {
  if (gate.stats().active > 0) return { heavy: true, source: "export" };
  if (proxy.proxyActiveCount().encoding > 0) return { heavy: true, source: "proxy" };
  if (Date.now() - hostPolledAt >= HOST_POLL_MS) {
    hostPolledAt = Date.now();
    hostRendering = await pollHostRender().catch(() => false);
  }
  return hostRendering ? { heavy: true, source: "render" } : { heavy: false, source: null };
}

/** Démarre la surveillance. Appelé UNE fois par `rpc.js`, qui détient `broadcast`. */
function startWatchdog(broadcast) {
  if (watchdog) return watchdog;
  watchdog = createWatchdog({
    resources: () => resources(),
    heavySignal,
    scan: () => procScan.scanProcesses(classifier),
    trim: (pids) => procScan.trimProcesses(pids),
    killable: (procs) => procScan.killableNoise(procs),
    broadcast,
    readPrefs: readWatchdogPrefs,
    writePrefs: writeWatchdogPrefs,
  });
  return watchdog;
}

function stopWatchdog() {
  if (!watchdog) return;
  watchdog.stop();
  watchdog = null;
}

function watchdogState() {
  return watchdog ? watchdog.state() : { prefs: null, armed: false, journal: [], suggestion: null };
}

function setWatchdogPrefs(patch) {
  return watchdog ? watchdog.setPrefs(patch || {}) : watchdogState();
}

function dismissWatchdogSuggestion() {
  return watchdog ? watchdog.dismissSuggestion() : watchdogState();
}

// POINT DE RESTAURATION : exporte le projet courant en .drp (ExportProject, non destructif, sûr
// projet ouvert) dans NR_HOME/snapshots → un crash Resolve devient indolore (ré-import du .drp).
// Sauvegarde d'abord. Le .drp contient les instructions de montage (PAS les médias).
async function snapshotProject() {
  const resolve = await getResolve();
  if (!resolve) return { ok: false, error: t("resolveOffline") };
  const pm = await resolve.GetProjectManager();
  const proj = pm ? await pm.GetCurrentProject() : null;
  if (!proj) return { ok: false, error: t("noProject") };
  let name = null;
  try {
    name = await proj.GetName();
  } catch {}
  if (!name) return { ok: false, error: t("projectNameMissing") };
  const dir = path.join(NR_HOME, "snapshots");
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch {}
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safe = name.replace(/[^a-z0-9_-]+/gi, "_");
  const file = path.join(dir, `${safe}__${ts}.drp`);
  try {
    await pm.SaveProject();
    const ok = await pm.ExportProject(name, file);
    if (!ok) return { ok: false, error: t("snapshotExportFailed") };
    let size = 0;
    try {
      size = (await fsp.stat(file)).size;
    } catch {}
    return { ok: true, path: file, name, size };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Liste les points de restauration .drp existants (plus récents d'abord) + leur dossier.
async function listSnapshots() {
  const dir = path.join(NR_HOME, "snapshots");
  try {
    const files = await fsp.readdir(dir);
    const out = [];
    for (const f of files) {
      if (!/\.drp$/i.test(f)) continue;
      const full = path.join(dir, f);
      try {
        const st = await fsp.stat(full);
        out.push({ name: f, path: full, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return { ok: true, dir, snapshots: out };
  } catch {
    return { ok: true, dir, snapshots: [] };
  }
}

module.exports = {
  diagnose,
  gpuVram,
  freeGpu,
  freeCpu,
  freeRam,
  listProcesses,
  killProcess,
  noiseProcesses,
  killNoise,
  deadProcesses,
  cleanDeadProcesses,
  resources,
  startWatchdog,
  stopWatchdog,
  watchdogState,
  setWatchdogPrefs,
  dismissWatchdogSuggestion,
  sessionHealth,
  snapshotProject,
  listSnapshots,
  renderJobs,
  stopRender,
  clearRenderQueue,
  clearFinishedJobs,
  deleteRenderJob,
  reloadProject,
  openPage,
  scanCache,
  cleanPaths,
  // Réutilisés par cacheAdmin (Paramètres › Stockage) : mesurer un dossier de cache et l'espace
  // disque est le même problème ici et là — pas de seconde implémentation.
  dirSize,
  diskInfo,
};
