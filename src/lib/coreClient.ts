// src/lib/coreClient.ts
// Implémente NrApi en parlant au service Node "core" (HTTP POST /rpc + SSE /events) pour l'app
// Tauri standalone. Même interface que le bridge Electron (window.nr) → composants inchangés.
// Dialogs / openExternal passent par les plugins Tauri (chargés à la demande, seulement sous Tauri).

import type { NrApi, RefApi, WallpaperApi, ScriptApi, CollectionsApi, LibraryApi, ChatApi, NotebookApi, OutboxApi, PowerApi, SnapshotApi, CacheApi } from "./bridge";
import i18n from "@/i18n";
import { logError } from "@/lib/appLog";
import { readPreviewSettings } from "@/lib/previewSettings";
import { beginHeavyCall, isHeavyChannel } from "@/lib/busyBus";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---- Adresse du core ----
// Le port n'est plus figé : la coquille Tauri en choisit un LIBRE au lancement (8730 pris par une
// autre instance, une session de dev ou un logiciel tiers ne doit pas laisser l'app sans backend).
// Elle seule connaît le sien → on le lui demande. Hors Tauri (panneau CEP, navigateur), on balaie
// la plage jusqu'à trouver un /healthz qui se déclare NetsuRush.
const CORE_PORT_FIRST = 8730;
const CORE_PORT_SPAN = 20;
const FIXED_BASE: string | null =
  (typeof window !== "undefined" && (window as unknown as { __NR_CORE__?: string }).__NR_CORE__) || null;
let BASE: string = FIXED_BASE || `http://127.0.0.1:${CORE_PORT_FIRST}`;

async function probePort(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    if (!response.ok) return false;
    return (await response.json())?.app === "netsurush";
  } catch {
    return false;
  }
}

async function discoverBase(): Promise<void> {
  if (isTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const port = await invoke<number>("nr_core_port");
      if (port) {
        BASE = `http://127.0.0.1:${port}`;
        return;
      }
    } catch {
      // Coquille antérieure à la commande : on retombe sur le balayage.
    }
  }
  for (let port = CORE_PORT_FIRST; port < CORE_PORT_FIRST + CORE_PORT_SPAN; port++) {
    if (await probePort(port)) {
      BASE = `http://127.0.0.1:${port}`;
      return;
    }
  }
}

let discovery: Promise<void> | null = null;
function ensureBase(): Promise<void> {
  if (FIXED_BASE) return Promise.resolve();
  discovery ??= discoverBase();
  return discovery;
}
// Le core a pu redémarrer sur un autre port (le watchdog en reprend un libre) : après une série
// d'échecs réseau, on refait la recherche au lieu de marteler une adresse morte.
function forgetBase() {
  discovery = null;
}

// Token partagé optionnel : si la coquille Tauri l'injecte (window.__NR_TOKEN__), on l'envoie au core
// (header /rpc + query `tk` sur /media et /stream) pour qu'il authentifie nos requêtes. Absent (dev,
// avant câblage) → chaîne vide, le core n'exige rien (cf. media-server.js NR_CORE_TOKEN).
const TOKEN: string =
  (typeof window !== "undefined" && (window as unknown as { __NR_TOKEN__?: string }).__NR_TOKEN__) || "";
const tkParam = TOKEN ? `&tk=${encodeURIComponent(TOKEN)}` : "";

// ---- Chemins disque des fichiers lâchés depuis l'Explorateur ----
// Chromium masque le chemin des objets `File` (pas de `File.path`). Activer `dragDropEnabled`
// donnerait les chemins via l'événement DnD natif de Tauri, mais le flag est EXCLUSIF : wry révoque
// alors les cibles OLE de WebView2 et TOUT le DnD HTML5 interne meurt (blocs BlockNote/ProseMirror,
// cartes du tiroir Footages). On passe donc par la voie WebView2 : `postMessageWithAdditionalObjects`
// remet les objets File au host Rust, qui lit `ICoreWebView2File::Path` et répond en événement
// `nr://file-paths`. Détail complet dans `nr_attach_file_paths` (src-tauri/src/lib.rs).

type WebView2 = { postMessageWithAdditionalObjects?: (msg: unknown, objects: unknown[]) => void };
const webview2 = (): WebView2 | null =>
  (typeof window !== "undefined" && (window as unknown as { chrome?: { webview?: WebView2 } }).chrome?.webview) || null;

const pathWaiters = new Map<number, (paths: string[]) => void>();
let pathSeq = 0;
let pathBridge: Promise<boolean> | null = null;

// Attache paresseuse (une fois par fenêtre) : les fenêtres board/carnet détachées naissent côté JS,
// bien après le `setup` Rust — c'est le renderer qui sait quand sa webview existe.
async function ensurePathBridge(): Promise<boolean> {
  if (!pathBridge) {
    pathBridge = (async () => {
      if (!isTauri || !webview2()?.postMessageWithAdditionalObjects) return false;
      const [{ listen }, { invoke }, { getCurrentWindow }] = await Promise.all([
        import("@tauri-apps/api/event"),
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/window"),
      ]);
      await listen<{ id: number; paths: string[] }>("nr://file-paths", (e) => {
        const done = pathWaiters.get(e.payload.id);
        if (done) { pathWaiters.delete(e.payload.id); done(e.payload.paths || []); }
      });
      return (await invoke<boolean>("nr_attach_file_paths", { label: getCurrentWindow().label })) === true;
    })().then((ok) => {
      if (!ok) pathBridge = null;
      return ok;
    }).catch(() => {
      pathBridge = null;
      return false;
    });
  }
  return pathBridge;
}

async function resolveFilePaths(files: File[]): Promise<string[]> {
  const blank = files.map(() => "");
  if (!files.length || !(await ensurePathBridge())) return blank;
  const wv = webview2();
  if (!wv?.postMessageWithAdditionalObjects) return blank;
  const id = ++pathSeq;
  return new Promise<string[]>((resolve) => {
    // Runtime WebView2 trop ancien (< 1.0.1587) ou objet refusé : on rend des chemins vides plutôt
    // que de laisser l'appelant suspendu — l'import par sélecteur natif reste la voie de repli.
    const timer = setTimeout(() => { pathWaiters.delete(id); resolve(blank); }, 4000);
    pathWaiters.set(id, (paths) => { clearTimeout(timer); resolve(paths.length === files.length ? paths : blank); });
    try {
      wv.postMessageWithAdditionalObjects!({ __nrFiles: id }, files);
    } catch {
      clearTimeout(timer);
      pathWaiters.delete(id);
      resolve(blank);
    }
  });
}

// ---- Invocation RPC : POST /rpc { channel, args } -> result | throw ----
/** Journalise l'échec puis rend l'erreur à lancer — l'appelant garde son `throw` explicite. */
function fail(channel: string, message: string): Error {
  logError("core:rpc", `${channel} — ${message}`);
  return new Error(message);
}

// Le core est spawné en parallèle de la WebView : les premiers appels partent forcément avant qu'il
// n'écoute. Tant qu'il n'a JAMAIS répondu, on lui laisse largement le temps de démarrer — un
// démarrage à froid (antivirus qui inspecte node.exe et 300 Mo de ressources, disque lent) dépasse
// facilement quelques secondes, et la page d'installation, elle, affiche son erreur DÉFINITIVEMENT.
// Une fois le contact établi, une panne est une vraie panne : fenêtre courte, échec rapide.
const BOOT_GRACE_MS = 45_000;
const RETRY_GRACE_MS = 6_000;
const RETRY_STEP_MS = 250;
// Toutes les 2 s d'échecs, on rouvre la question de l'adresse : le core a pu renaître ailleurs.
const REDISCOVER_EVERY = 8;
let coreReached = false;

// Retour `any` : chaque méthode NrApi impose son propre type de retour (le cast est local au client).
async function call(channel: string, args: unknown[] = []): Promise<any> {
  // Un travail lourd se déclare AVANT de partir : ce qui allège l'app (fond animé figé) doit l'être
  // pendant le démarrage du job — chargement de modèle, spawn ffmpeg — pas seulement une fois que la
  // première progression est revenue.
  const releaseBusy = isHeavyChannel(channel) ? beginHeavyCall() : null;
  try {
    return await callInner(channel, args);
  } finally {
    releaseBusy?.();
  }
}

async function callInner(channel: string, args: unknown[] = []): Promise<any> {
  await ensureBase();
  const deadline = Date.now() + (coreReached ? RETRY_GRACE_MS : BOOT_GRACE_MS);
  let r: Response | null = null;
  let networkError: unknown = null;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(TOKEN ? { "x-nr-token": TOKEN } : {}) },
        body: JSON.stringify({ channel, args }),
      });
      // Toute réponse HTTP prouve que le service écoute, même un 500 : la fenêtre longue de
      // démarrage n'a plus lieu d'être.
      coreReached = true;
      networkError = null;
      break;
    } catch (error) {
      networkError = error;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_STEP_MS));
      if (attempt % REDISCOVER_EVERY === REDISCOVER_EVERY - 1) {
        forgetBase();
        await ensureBase();
      }
    }
  }
  // Tout échec est JOURNALISÉ ici, au seul endroit que traversent les ~200 canaux : la plupart des
  // appelants attrapent et n'affichent qu'une notice, la console ne voyait donc jamais la cause.
  // Le service tourne hors de la webview : sa cause d'arrêt n'est QUE dans son journal (la coquille
  // Tauri release n'a pas de console). Sans ce pointeur, « Failed to fetch » n'était pas actionnable.
  if (!r) throw fail(channel, `core indisponible (${BASE}) : ${String(networkError || "Failed to fetch")}${isTauri ? " — journal : %LOCALAPPDATA%\\NetsuRush\\logs\\core.log" : ""}`);
  if (!r.ok) throw fail(channel, `core rpc HTTP ${r.status}: ${r.statusText || "request failed"}`);
  const j = await r.json();
  if (!j || !j.ok) throw fail(channel, (j && j.error) || `core rpc error: ${channel}`);
  return j.result;
}

// ---- Événements (progression) : SSE /events { channel, payload } ----
const listeners = new Map<string, Set<(p: unknown) => void>>();
let es: EventSource | null = null;
let sseOpening = false;
function ensureSse() {
  if (es || sseOpening || typeof EventSource === "undefined") return;
  // L'adresse n'est peut-être pas encore connue (recherche du port en cours) : ouvrir maintenant
  // brancherait le flux sur un port au hasard. Le garde `sseOpening` évite d'en ouvrir plusieurs
  // pendant l'attente, chaque abonnement passant par ici.
  sseOpening = true;
  void ensureBase().then(() => {
    sseOpening = false;
    if (es || !listeners.size) return;
    es = new EventSource(`${BASE}/events`);
    es.onmessage = (e) => {
      try {
        const { channel, payload } = JSON.parse(e.data);
        const set = listeners.get(channel);
        if (set) for (const cb of set) cb(payload);
      } catch {
        /* ignore */
      }
    };
  });
}
function on(channel: string, cb: (p: unknown) => void): () => void {
  ensureSse();
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (!set!.size) listeners.delete(channel);
    if (!listeners.size && es) {
      es.close();
      es = null;
    }
  };
}

// ---- Plugins Tauri (chargés paresseusement, no-op hors Tauri) ----
const VIDEO_EXT = ["mp4", "mov", "mkv", "avi", "m4v", "mxf", "webm", "wmv", "flv", "ts", "m2ts", "mpg", "mpeg"];
const AUDIO_EXT = ["wav", "mp3", "aac", "m4a", "flac", "ogg", "opus", "aif", "aiff", "wma"];
const MEDIA_EXT = [...VIDEO_EXT, ...AUDIO_EXT];
const IMAGE_EXT = ["jpg", "jpeg", "png", "tif", "tiff", "bmp", "webp", "gif", "dpx", "exr"];

async function dlgOpen(opts: Record<string, unknown>): Promise<string | string[] | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  return (await open(opts)) as string | string[] | null;
}
async function dlgSave(defaultPath?: string): Promise<string | null> {
  if (!isTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return await save({ defaultPath, filters: [{ name: i18n.t("common:fileType.video"), extensions: ["mp4", "mov", "mkv"] }] });
}

// Rendu « en remote » (iframe dans le panneau CEP Adobe) : pas de dialogue Tauri. On demande au
// panneau PARENT d'ouvrir le sélecteur de fichiers NATIF de CEP (chemins disque réels) via postMessage.
const isRemote = typeof window !== "undefined" && !!(window as unknown as { __NR_REMOTE__?: boolean }).__NR_REMOTE__;

// `maybe` signifie seulement que le conteneur semble plausible, pas que le codec sera décodé.
// Règle retenue : accepter `probably`, ou la confirmation MediaSource.
function browserSupportsMime(video: HTMLVideoElement, mime: string): boolean {
  const direct = video.canPlayType(mime) === "probably";
  const mse = typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function"
    && MediaSource.isTypeSupported(mime);
  return direct || mse;
}

// Le panneau distant demande toujours le MP4 H.264, format vidéo le plus compatible de ce flux.
let _remoteCodec: "h264" | null = null;
function remoteProxyCodec(): "h264" {
  if (_remoteCodec) return _remoteCodec;
  let c: "h264" = "h264";
  try {
    const v = document.createElement("video");
    if (browserSupportsMime(v, 'video/mp4; codecs="avc1.42E01E"')) c = "h264";
  } catch { /* garde H.264 */ }
  _remoteCodec = c;
  try { console.info("[NetsuRush] codec aperçu (remote) :", c); } catch { /* noop */ }
  return c;
}

// Le standalone Tauri utilise le WebView2 installé sur le PC, dont la disponibilité HEVC varie
// selon Windows/runtime/codec système. Garder H.265 dès qu'il est réellement annoncé ; sinon,
// négocier H.264 au lieu de servir un MP4 dont seul l'AAC serait lu (son + image noire).
let _standaloneCodec: "hevc" | "h264" | null = null;
function standaloneProxyCodec(): "hevc" | "h264" {
  if (_standaloneCodec) return _standaloneCodec;
  let c: "hevc" | "h264" = "h264";
  try {
    const v = document.createElement("video");
    const hevcMimes = [
      'video/mp4; codecs="hvc1"',
      'video/mp4; codecs="hev1"',
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
      'video/mp4; codecs="hev1.1.6.L93.B0"',
    ];
    if (hevcMimes.some((mime) => browserSupportsMime(v, mime))) c = "hevc";
  } catch { /* garde H.264 */ }
  _standaloneCodec = c;
  try { console.info("[NetsuRush] codec aperçu (WebView2) :", c); } catch { /* noop */ }
  return c;
}
function requestParentFiles(multiple: boolean, exts: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || window.parent === window) return resolve(null);
    const id = `nrfiles-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; id?: string; paths?: string[] } | null;
      if (!d || d.type !== "nr:files:result" || d.id !== id) return;
      window.removeEventListener("message", onMsg);
      resolve(Array.isArray(d.paths) && d.paths.length ? d.paths : null);
    };
    window.addEventListener("message", onMsg);
    window.parent.postMessage({ type: "nr:files", id, multiple, exts }, "*");
    setTimeout(() => { window.removeEventListener("message", onMsg); resolve(null); }, 120000);
  });
}

async function openUrl(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    if (isTauri) {
      const { openUrl: open } = await import("@tauri-apps/plugin-opener");
      await open(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
    return true;
  } catch {
    return false;
  }
}
// Ouvre un FICHIER/dossier local dans l'app système par défaut (lien de note → fichier).
async function openPath(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    if (isTauri) {
      const { openPath: open } = await import("@tauri-apps/plugin-opener");
      await open(path);
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function abToB64(ab: ArrayBuffer): string {
  const bytes = new Uint8Array(ab);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ---- Fenêtre détachée du board (Tauri v2) ----
// Le board sync déjà entre fenêtres via le core (push/onPush en SSE). Ici : créer/fermer la 2e
// fenêtre (label "reference", même renderer au hash #reference) + épingler always-on-top.
// Pas de confirmation de fermeture : l'autosave (scène __autosave__ restaurée au démarrage) garantit
// qu'aucun travail n'est perdu en quittant → un dialogue « enregistrer ? » serait une fausse alerte.
const REF_LABEL = "reference";

const wallpaper: WallpaperApi = {
  import: (srcPath, opts) => call("wallpaper:import", [srcPath, opts || {}]),
  list: () => call("wallpaper:list"),
  variant: (id, opts) => call("wallpaper:variant", [id, opts]),
  remove: (id) => call("wallpaper:remove", [id]),
};

const reference: RefApi = {
  listScenes: () => call("reference:listScenes"),
  loadScene: (id) => call("reference:loadScene", [id]),
  saveScene: (scene) => call("reference:saveScene", [scene]),
  deleteScene: (id) => call("reference:deleteScene", [id]),
  saveAsset: (bytes, ext) => call("reference:saveAsset", [{ __b64: abToB64(bytes) }, ext]),
  fetchAsset: (url) => call("reference:fetchAsset", [url]),
  resolveMedia: (url) => call("reference:resolveMedia", [url]),
  upscaleItem: (opts) => call("reference:upscaleItem", [opts]),
  dropAsset: (p) => call("reference:dropAsset", [p]),
  extractMedia: (url) => call("reference:extractMedia", [url]),
  extractFrames: (opts) => call("reference:extractFrames", [opts]),
  exportBoard: (scene, destPath, opts) => call("netsu:export", [scene, destPath, opts]),
  importBoard: (srcPath) => call("netsu:import", [srcPath]),
  weigh: (scene, opts) => call("netsu:weigh", [scene, opts]),
  chooseNetsu: () =>
    dlgOpen({ multiple: false, filters: [{ name: "Board NetsuRush", extensions: ["netsu"] }] }) as Promise<string | null>,
  saveNetsuPath: async (defaultName) => {
    if (!isTauri) return null;
    const { save } = await import("@tauri-apps/plugin-dialog");
    return await save({ defaultPath: defaultName, filters: [{ name: "Board NetsuRush", extensions: ["netsu"] }] });
  },
  openProject: (srcPath) => call("netsu:openProject", [srcPath]),
  saveProject: (filePath, scene) => call("netsu:saveProject", [filePath, scene]),
  saveProjectAs: (opts) => call("netsu:saveProjectAs", [opts]),
  closeProject: (filePath) => call("netsu:closeProject", [filePath]),
  recentProjects: (type) => call("netsu:recents", [type]),
  forgetProject: (filePath) => call("netsu:forget", [filePath]),
  // No-op : aucune garde de fermeture (l'autosave protège déjà le board). Conservé pour l'API.
  setDirty: () => {},
  // Depuis la fenêtre principale : ouvre (ou refocus) la fenêtre détachée flottante.
  detach: () => {
    void (async () => {
      if (!isTauri) return;
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel(REF_LABEL);
      if (existing) {
        await existing.setFocus().catch(() => {});
        return;
      }
      const win = new WebviewWindow(REF_LABEL, {
        url: "index.html#reference",
        title: i18n.t("common:window.reference"),
        decorations: false,
        alwaysOnTop: true,
        width: 720,
        height: 560,
        minWidth: 360,
        minHeight: 320,
        // false → la WebView gère le DnD HTML5 (glisser une carte vers le board + déposer des
        // fichiers OS arrivent via dataTransfer). true (défaut) le confie à l'OS et BLOQUE le DnD HTML5.
        dragDropEnabled: false,
      });
      win.once("tauri://error", (e) => console.error("[reference] échec ouverture fenêtre détachée", e));
    })();
  },
  // Depuis la fenêtre détachée : la ferme et redonne le focus à la principale. Le focus est
  // best-effort (try/catch) pour ne JAMAIS empêcher la fermeture si setFocus échoue.
  attach: () => {
    void (async () => {
      if (!isTauri) return;
      const { getCurrentWindow, Window } = await import("@tauri-apps/api/window");
      try {
        const main = await Window.getByLabel("main");
        await main?.setFocus();
      } catch {
        /* focus best-effort */
      }
      await getCurrentWindow().close();
    })();
  },
  setAlwaysOnTop: (on) => {
    void (async () => {
      if (!isTauri) return;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setAlwaysOnTop(on).catch(() => {});
    })();
  },
  push: (payload) => { void call("reference:push", [payload]); },
  onPush: (cb) => on("reference:push", cb),
};

const script: ScriptApi = {
  recordings: (dir) => call("script:recordings", [dir]),
  mediaPool: () => call("script:mediaPool"),
  importMedia: (paths) => call("script:importMedia", [paths]),
  listDocs: (resolveProject) => call("script:listDocs", [resolveProject ?? null]),
  loadDoc: (id) => call("script:loadDoc", [id]),
  saveDoc: (doc) => call("script:saveDoc", [doc]),
  deleteDoc: (id) => call("script:deleteDoc", [id]),
  listVersions: (docId) => call("script:listVersions", [docId]),
  saveVersion: (docId, label, doc) => call("script:saveVersion", [docId, label, doc]),
  getVersion: (id) => call("script:getVersion", [id]),
  deleteVersion: (id) => call("script:deleteVersion", [id]),
  buildTimeline: (opts) => call("script:buildTimeline", [opts]),
};

const collections: CollectionsApi = {
  list: () => call("collections:list"),
  load: (id) => call("collections:load", [id]),
  save: (c) => call("collections:save", [c]),
  delete: (id) => call("collections:delete", [id]),
  addShots: (id, shots) => call("collections:addShots", [id, shots]),
  removeShot: (id, shotId) => call("collections:removeShot", [id, shotId]),
  updateShot: (id, shotId, patch) => call("collections:updateShot", [id, shotId, patch]),
  saveIcon: (bytes, ext) => call("collections:saveIcon", [{ __b64: abToB64(bytes) }, ext]),
  listFolders: () => call("collections:listFolders"),
  saveFolder: (f) => call("collections:saveFolder", [f]),
  deleteFolder: (id) => call("collections:deleteFolder", [id]),
  move: (id, folderId) => call("collections:move", [id, folderId]),
  allTags: () => call("collections:allTags"),
  archive: (id, opts) => call("collections:archive", [id, opts]),
  relocateArchive: (id, opts) => call("collections:relocateArchive", [id, opts]),
  queueState: () => call("collections:queueState"),
  queueEnqueue: (id, req) => call("collections:queueEnqueue", [id, req]),
  queueCancel: (entryId) => call("collections:queueCancel", [entryId]),
  onQueue: (cb) => on("collections:queue", cb as (p: unknown) => void),
  offline: (id) => call("collections:offline", [id]),
  relinkPath: (id, oldPath, newPath) => call("collections:relinkPath", [id, oldPath, newPath]),
  relinkDir: (id, dir) => call("collections:relinkDir", [id, dir]),
};

const library: LibraryApi = {
  list: () => call("library:list"),
  addPaths: (paths) => call("library:addPaths", [paths]),
  addDir: (dir) => call("library:addDir", [dir]),
  remove: (id) => call("library:remove", [id]),
  removeMany: (ids) => call("library:removeMany", [ids]),
  restore: (undo) => call("library:restore", [undo]),
  move: (id, folderId) => call("library:move", [id, folderId]),
  listFolders: () => call("library:listFolders"),
  saveFolder: (f) => call("library:saveFolder", [f]),
  deleteFolder: (id, withItems) => call("library:deleteFolder", [id, withItems]),
  offline: () => call("library:offline"),
  relinkPath: (oldPath, newPath) => call("library:relinkPath", [oldPath, newPath]),
  relinkDir: (dir) => call("library:relinkDir", [dir]),
};

const outbox: OutboxApi = {
  list: () => call("outbox:list"),
  enqueue: (entry) => call("outbox:enqueue", [entry]),
  remove: (id) => call("outbox:remove", [id]),
  clear: (which) => call("outbox:clear", [which]),
  settings: () => call("outbox:settings"),
  setSettings: (patch) => call("outbox:setSettings", [patch]),
  flush: (host) => call("outbox:flush", [host]),
  onChanged: (cb) => on("outbox:changed", cb as (p: unknown) => void),
};

const power: PowerApi = {
  state: () => call("power:state"),
  reconcile: () => call("power:reconcile"),
  close: (host) => call("power:close", [host]),
  reopen: () => call("power:reopen"),
  restart: (host) => call("power:restart", [host]),
  onChanged: (cb) => on("power:changed", cb as (p: unknown) => void),
  onProgress: (cb) => on("power:progress", cb as (p: unknown) => void),
};

const snapshot: SnapshotApi = {
  state: () => call("snapshot:state"),
  clear: () => call("snapshot:clear"),
  peek: (kind: string, arg?: string) => call("snapshot:peek", [kind, arg]),
  build: (opts) => call("snapshot:build", [opts ?? {}]),
  onChanged: (cb) => on("snapshot:changed", cb as (p: unknown) => void),
  onProgress: (cb) => on("snapshot:progress", cb as (p: unknown) => void),
};

const cache: CacheApi = {
  overview: () => call("cache:overview"),
  tree: () => call("cache:tree"),
  clear: (opts) => call("cache:clear", [opts]),
  purgePreviewRanges: (ranges) => call("cache:purgePreviewRanges", [ranges]),
  missing: () => call("cache:missing"),
  vacuum: () => call("cache:vacuum"),
  settings: () => call("cache:settings"),
  setSettings: (patch) => call("cache:setSettings", [patch]),
  check: () => call("cache:check"),
  sessionEvent: (opts) => call("cache:sessionEvent", [opts]),
  setDir: (opts) => call("cache:setDir", [opts]),
  reindex: () => call("cache:reindex"),
  onProgress: (cb) => on("cache:progress", cb as (p: unknown) => void),
  onWarn: (cb) => on("cache:warn", cb as (p: unknown) => void),
  onChanged: (cb) => on("cache:changed", cb as (p: unknown) => void),
};

const notebook: NotebookApi = {
  list: () => call("notebook:list"),
  saveNotebook: (nb) => call("notebook:saveNotebook", [nb]),
  deleteNotebook: (id) => call("notebook:deleteNotebook", [id]),
  forScript: (scriptId, title) => call("notebook:forScript", [scriptId, title ?? null]),
  load: (id) => call("notebook:load", [id]),
  loadPage: (id) => call("notebook:loadPage", [id]),
  savePage: (page) => call("notebook:savePage", [page]),
  deletePage: (id) => call("notebook:deletePage", [id]),
  duplicatePage: (id) => call("notebook:duplicatePage", [id]),
  trashList: (nbId) => call("notebook:trashList", [nbId]),
  restorePage: (id) => call("notebook:restorePage", [id]),
  purgePage: (id) => call("notebook:purgePage", [id]),
  emptyTrash: (nbId) => call("notebook:emptyTrash", [nbId]),
  search: (nbId, query) => call("notebook:search", [nbId, query]),
  saveDatabase: (db) => call("notebook:saveDatabase", [db]),
  deleteDatabase: (id) => call("notebook:deleteDatabase", [id]),
  backlinks: (notebookId, pageId) => call("notebook:backlinks", [notebookId, pageId]),
  saveAsset: async (bytes, ext, notebookId) => {
    const r: { ok: boolean; path?: string; error?: string } = await call("notebook:saveAsset", [{ __b64: abToB64(bytes) }, ext, notebookId]);
    return r.ok && r.path ? { ...r, url: `${BASE}/media?p=${encodeURIComponent(r.path)}${tkParam}` } : r;
  },
  readAsset: (path) => call("notebook:readAsset", [path]),
  // Le core range les médias en tokens relatifs : il lui faut NOTRE gabarit d'URL pour les rendre
  // (base + jeton), lui seul ne connaît ni le port retenu ni le jeton de la session.
  openProject: (filePath) => call("notebook:openProject", [filePath, { prefix: `${BASE}/media?p=`, suffix: tkParam }]),
  saveProjectAs: (opts) => call("notebook:saveProjectAs", [{ ...opts, url: { prefix: `${BASE}/media?p=`, suffix: tkParam } }]),
  closeProject: (filePath) => call("notebook:closeProject", [filePath]),
  projectOf: (notebookId) => call("notebook:projectOf", [notebookId]),
  linkMeta: (url) => call("notebook:linkMeta", [url]),
  writeExport: (filePath, text) => call("notebook:writeExport", [filePath, text]),
  exportFile: (opts) => call("notebook:exportFile", [opts]),
  // Le core réécrit les tokens d'assets en URLs /media : on lui passe notre gabarit (base + token).
  importFile: ({ bytes, ...rest }) =>
    call("notebook:importFile", [{ ...rest, bytes: { __b64: abToB64(bytes) }, mediaPrefix: `${BASE}/media?p=`, mediaSuffix: tkParam }]),
  push: (payload) => { void call("notebook:push", [payload]); },
  onPush: (cb) => on("notebook:push", cb),
  // Fenêtre détachée du Carnet — même mécano que le board Référence (label dédié, hash #notebook).
  detach: () => {
    void (async () => {
      if (!isTauri) return;
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel("notebook");
      if (existing) {
        await existing.setFocus().catch(() => {});
        return;
      }
      const win = new WebviewWindow("notebook", {
        url: "index.html#notebook",
        title: i18n.t("common:window.notebook"),
        decorations: false,
        width: 860,
        height: 640,
        minWidth: 420,
        minHeight: 360,
        dragDropEnabled: false, // DnD HTML5 (fichiers/blocs) géré par la WebView, pas par l'OS
      });
      win.once("tauri://error", (e) => console.error("[notebook] échec ouverture fenêtre détachée", e));
    })();
  },
  attach: () => {
    void (async () => {
      if (!isTauri) return;
      const { getCurrentWindow, Window } = await import("@tauri-apps/api/window");
      try {
        const main = await Window.getByLabel("main");
        await main?.setFocus();
      } catch { /* focus best-effort */ }
      await getCurrentWindow().close();
    })();
  },
};

const chat: ChatApi = {
  agents: () => call("chat:agents"),
  configure: (cfg) => call("chat:configure", [cfg]),
  send: (opts) => call("chat:send", [opts]),
  cancel: (runId) => call("chat:cancel", [runId]),
  respondApproval: (callId, approved) => call("chat:approval:respond", [callId, approved]),
  tools: () => call("chat:tools"),
  onEvent: (cb) => on("chat:event", cb as (p: unknown) => void),
  onApproval: (cb) => on("chat:approval", cb as (p: unknown) => void),
  history: {
    list: () => call("chat:history:list"),
    load: (id) => call("chat:history:load", [id]),
    save: (conv) => call("chat:history:save", [conv]),
    delete: (id) => call("chat:history:delete", [id]),
  },
};

export function makeCoreClient(): NrApi {
  const client: NrApi = {
    // WebView2 n'a pas d'équivalent à app.getGPUFeatureStatus (Electron) → on renvoie l'info
    // dispo côté renderer (présence WebGPU) sans appeler le core (évite un canal 404).
    gpuStatus: () =>
      Promise.resolve({
        features: { webgpu: typeof navigator !== "undefined" && "gpu" in navigator ? "enabled" : "unavailable" },
      }),
    optimizeDiagnose: () => call("optimize:diagnose"),
    optimizeRenderJobs: () => call("optimize:renderJobs"),
    optimizeStopRender: () => call("optimize:stopRender"),
    optimizeClearRenderQueue: () => call("optimize:clearRenderQueue"),
    optimizeClearFinishedJobs: () => call("optimize:clearFinishedJobs"),
    optimizeDeleteRenderJob: (id) => call("optimize:deleteRenderJob", [id]),
    optimizeReloadProject: () => call("optimize:reloadProject"),
    optimizeOpenPage: (page) => call("optimize:openPage", [page]),
    optimizeFreeGpu: () => call("optimize:freeGpu"),
    optimizeFreeCpu: () => call("optimize:freeCpu"),
    optimizeFreeRam: () => call("optimize:freeRam"),
    optimizeListProcesses: () => call("optimize:listProcesses"),
    optimizeKillProcess: (pid) => call("optimize:killProcess", [pid]),
    optimizeDeadProcesses: () => call("optimize:deadProcesses"),
    optimizeCleanDead: () => call("optimize:cleanDead"),
    optimizeNoiseProcesses: () => call("optimize:noiseProcesses"),
    optimizeKillNoise: (pids) => call("optimize:killNoise", [pids]),
    optimizeWatchdog: () => call("optimize:watchdog"),
    optimizeSetWatchdog: (prefs) => call("optimize:setWatchdog", [prefs]),
    optimizeDismissWatchdog: () => call("optimize:dismissWatchdog"),
    onOptimizeWatchdog: (cb) => on("optimize:watchdog", cb as (p: unknown) => void),
    optimizeResources: (root) => call("optimize:resources", [root]),
    optimizeSessionHealth: () => call("optimize:sessionHealth"),
    optimizePrefs: () => call("optimize:prefs"),
    optimizeApplyPrefs: (changes) => call("optimize:applyPrefs", [changes]),
    optimizePrefsBackups: () => call("optimize:prefsBackups"),
    optimizeRestorePrefs: (name) => call("optimize:restorePrefs", [name]),
    optimizeSnapshot: () => call("optimize:snapshot"),
    optimizeListSnapshots: () => call("optimize:listSnapshots"),
    optimizeScanCache: (root) => call("optimize:scanCache", [root]),
    optimizeCleanCache: (paths) => call("optimize:cleanCache", [paths]),
    boostDiagnose: (app) => call("boost:diagnose", [app]),
    boostProcs: () => call("boost:procs"),
    boostScanCache: (app, dir) => call("boost:scanCache", [app, dir]),
    boostCleanCache: (app, targets, opts) => call("boost:cleanCache", [app, targets, opts ?? {}]),
    boostPurge: (app, target) => call("boost:purge", [app, target]),
    boostHygiene: (app, op) => call("boost:hygiene", [app, op]),
    boostDeletePreviews: (app) => call("boost:deletePreviews", [app]),
    boostPrefs: (app) => call("boost:prefs", [app]),
    boostApplyPrefs: (app, changes) => call("boost:applyPrefs", [app, changes]),
    boostProxyAudit: (app) => call("boost:proxyAudit", [app]),
    boostAttachProxies: (app, pairs) => call("boost:attachProxies", [app, pairs]),
    boostSetEnableProxies: (app, on) => call("boost:setEnableProxies", [app, on]),
    onBoostProgress: (cb) => on("boost:progress", cb as (p: unknown) => void),
    configGet: () => call("config:get"),
    prefsGet: () => call("prefs:get"),
    prefsSet: (patch) => call("prefs:set", [patch]),
    onPrefsChanged: (cb) => on("prefs:changed", cb as (p: unknown) => void),
    configSetLang: (lang) => call("config:setLang", [lang]),
    discordState: () => call("discord:state"),
    discordSetPrefs: (patch) => call("discord:setPrefs", [patch]),
    discordSetContext: (ctx) => call("discord:setContext", [ctx]),
    onDiscordChanged: (cb) => on("discord:changed", cb as (p: unknown) => void),
    setupStatus: () => call("setup:status"),
    setupRun: (options) => call("setup:run", [options]),
    compatibilityStatus: (opts) => call("compat:status", [opts ?? {}]),
    onSetupProgress: (cb) => on("setup:progress", cb as (p: unknown) => void),
    consoleLogs: () => call("console:logs").then((logs) => ({ ok: true, logs: logs || [] })),
    consoleClear: () => call("console:clear"),
    onConsoleLog: (cb) => on("console:log", cb as (p: unknown) => void),
    bugReport: (request) => call("bug:report", [request]),
    bugStatus: () => call("bug:status"),
    bugContext: () => call("bug:context"),
    status: () => call("resolve:status"),
    listMediaPool: () => call("resolve:listMediaPool"),
    importToMediaPool: (paths) => call("resolve:import", [paths]),
    importToBin: (paths, bin) => call("resolve:importToBin", [paths, bin]),
    buildTimeline: (opts) => call("resolve:buildTimeline", [opts]),
    listTimelines: () => call("resolve:listTimelines"),
    timelineTree: () => call("resolve:timelineTree"),
    timelineThumbs: (opts) => call("resolve:timelineThumbs", [opts ?? {}]),
    onTimelineThumb: (cb) => on("resolve:timelineThumb", cb as (p: unknown) => void),
    cutTimeline: (opts) => call("resolve:cutTimeline", [opts]),
    onTimelineCutProgress: (cb) => on("timelinecut:progress", cb as (p: unknown) => void),
    analyzeTimelineCut: (opts) => call("resolve:analyzeTimelineCut", [opts]),
    buildCutTimeline: (opts) => call("resolve:buildCutTimeline", [opts]),
    readTimelineCuts: (opts) => call("resolve:readTimelineCuts", [opts ?? {}]),
    onResolveChanged: (cb) => on("resolve:changed", cb as (p: unknown) => void),
    refreshNow: () => { void call("resolve:refreshNow").catch(() => {}); },
    probe: (p) => call("ffmpeg:probe", [p]),
    playInfo: (p) => call("player:info", [p]),
    streamUrl: (p, t, mode) => `${BASE}/stream?p=${encodeURIComponent(p)}&t=${t || 0}&mode=${mode}${tkParam}`,
    audioTracks: (p) => call("ffmpeg:audioTracks", [p]),
    detectScenes: (p, threshold, model, options) => call("ffmpeg:detectScenes", [p, threshold, model, options]),
    cachedScenes: (p, model, threshold, options) => call("ffmpeg:cachedScenes", [p, model, threshold, options]),
    detectConcurrency: () => call("ffmpeg:detectConcurrency"),
    getCutEdits: (p, model, optionsKey) => call("cut:getEdits", [p, model, optionsKey]),
    saveCutEdits: (p, model, edits, optionsKey) => call("cut:saveEdits", [p, model, edits, optionsKey]),
    clearCutEdits: (p, model, optionsKey) => call("cut:clearEdits", [p, model, optionsKey]),
    onScenesProgress: (cb) => on("scenes:progress", cb as (p: unknown) => void),
    // En remote (panneau CEP) → codec que le moteur SAIT lire : H.264 si dispo, sinon WebM/VP8
    // (garanti dans tout Chromium, même un CEF sans codecs propriétaires). Sondé une fois.
    proxy: (opts) => {
      const request = { ...opts, settings: opts.settings ?? readPreviewSettings().proxy };
      const automaticCodec = isRemote ? remoteProxyCodec() : isTauri ? standaloneProxyCodec() : undefined;
      const codec = request.codec ?? (request.settings.format === "hevc" ? automaticCodec : undefined);
      return call("ffmpeg:proxy", [{ ...request, ...(codec ? { codec } : {}) }]);
    },
    proxyCancel: (token) => { call("ffmpeg:proxyCancel", [token]).catch(() => {}); },
    proxyCancelMany: (tokens) => { call("ffmpeg:proxyCancelMany", [tokens]).catch(() => {}); },
    proxyCancelAll: () => { call("ffmpeg:proxyCancelAll").catch(() => {}); },
    thumbnail: (p, t, priority) => call("ffmpeg:thumbnail", [{ path: p, time: t, priority, settings: readPreviewSettings().thumbnail }]),
    compareRenderFrames: (opts) => call("ffmpeg:compareFrames", [opts]),
    thumbsBatch: (p, items) => call("ffmpeg:thumbsBatch", [{ path: p, items, settings: readPreviewSettings().thumbnail }]),
    thumbsResolve: (items) => call("ffmpeg:thumbsResolve", [{ items, settings: readPreviewSettings().thumbnail }]),
    exportClip: (opts) => call("ffmpeg:export", [opts]),
    exportClips: (opts) => call("export:clips", [opts]),
    exportCapabilities: (opts) => call("export:capabilities", [opts ?? {}]),
    exportPreviewName: (opts) => call("export:previewName", [opts]),
    onExportProgress: (cb) => on("export:progress", cb as (p: unknown) => void),
    aeExport: (opts) => call("ae:export", [opts]),
    onAeProgress: (cb) => on("ae:progress", cb as (p: unknown) => void),
    transferSources: (opts) => call("transfer:sources", [opts]),
    transferRead: (opts) => call("transfer:read", [opts]),
    transferRun: (opts) => call("transfer:run", [opts]),
    onTransferProgress: (cb) => on("transfer:progress", cb as (p: unknown) => void),
    adobeStatus: () => call("adobe:status"),
    adobeSnapshot: (app) => call("adobe:snapshot", [app]),
    adobeLaunch: (app) => call("adobe:launch", [app]),
    adobeScan: (app) => call("adobe:cmd", [app, { cmd: "scan" }]),
    adobeBuildTimeline: (opts) => call("adobe:buildTimeline", [opts]),
    adobeImport: (app, paths) => call("adobe:import", [{ app, paths }]),
    adobeInstallPanel: () => call("adobe:installPanel"),
    adobeSetPanelAutoUpdate: (on) => call("adobe:setPanelAutoUpdate", [on]),
    onAdobePanelUpdated: (cb) => on("adobe:panelUpdated", cb as (p: unknown) => void),
    adobeDiagnose: () => call("adobe:diagnose"),
    onAdobeUpdate: (cb) => on("adobe:update", cb as (p: unknown) => void),
    transcribe: (opts) => call("voice:transcribe", [opts]),
    detectSilences: (opts) => call("voice:detectSilences", [opts]),
    detectFillers: (opts) => call("voice:detectFillers", [opts]),
    exportSubtitles: (opts) => call("voice:exportSubtitles", [opts]),
    exportCut: (opts) => call("voice:exportCut", [opts]),
    waveform: (opts) => call("voice:waveform", [opts]),
    searchTranscripts: (opts) => call("voice:searchTranscripts", [opts]),
    onVoiceProgress: (cb) => on("voice:progress", cb as (p: unknown) => void),
    upscaleRun: (opts) => call("upscale:run", [opts]),
    upscaleShaderRun: (opts) => call("upscale:shaderRun", [opts]),
    upscaleTestFrame: (opts) => call("upscale:testFrame", [opts]),
    onUpscaleProgress: (cb) => on("upscale:progress", cb as (p: unknown) => void),
    processInterpolate: (opts) => call("process:interpolate", [opts]),
    processDepth: (opts) => call("process:depth", [opts]),
    processRemoveBg: (opts) => call("process:removeBg", [opts]),
    processTestFrame: (opts) => call("process:testFrame", [opts]),
    onProcessProgress: (cb) => on("process:progress", cb as (p: unknown) => void),
    modelsList: () => call("models:list"),
    modelsDownload: (id, replace) => call("models:download", [id, replace === true]),
    modelsImport: (id, source) => call("models:import", [id, source]),
    modelsCancel: (id) => call("models:cancel", [id]),
    modelsDelete: (id) => call("models:delete", [id]),
    modelsDiskUsage: () => call("models:diskUsage"),
    modelsGpu: () => call("models:gpu"),
    onModelsProgress: (cb) => on("models:progress", cb as (p: unknown) => void),
    pipelineRun: (opts) => call("pipeline:run", [opts]),
    onPipelineProgress: (cb) => on("pipeline:progress", cb as (p: unknown) => void),
    rotoOpen: (opts) => call("roto:open", [opts]),
    rotoAddPoint: (opts) => call("roto:addPoint", [opts]),
    rotoClearPoints: (opts) => call("roto:clearPoints", [opts]),
    rotoUndoPoint: () => call("roto:undoPoint"),
    rotoPreviewPoint: (opts) => call("roto:previewPoint", [opts]),
    rotoMask: (opts) => call("roto:mask", [opts]),
    rotoSetPost: (opts) => call("roto:setPost", [opts]),
    rotoSetView: (opts) => call("roto:setView", [opts]),
    rotoSetObjects: (opts) => call("roto:setObjects", [opts]),
    rotoRemovePoint: (opts) => call("roto:removePoint", [opts]),
    rotoMovePoint: (opts) => call("roto:movePoint", [opts]),
    rotoClearTracking: () => call("roto:clearTracking"),
    rotoDedupe: (opts) => call("roto:dedupe", [opts || {}]),
    rotoPropagate: (opts) => call("roto:propagate", [opts || {}]),
    rotoCancel: () => call("roto:cancel"),
    rotoRefine: (opts) => call("roto:refine", [opts]),
    rotoSetRefined: (opts) => call("roto:setRefined", [opts]),
    rotoExport: (opts) => call("roto:export", [opts]),
    rotoObjectRemove: (opts) => call("roto:objectRemove", [opts]),
    onRotoProgress: (cb) => on("roto:progress", cb as (p: unknown) => void),
    dictateTranscribe: (opts) => call("dictate:transcribe", [opts]),
    dictateCppStatus: () => call("dictate:cppStatus"),
    indexClip: (p, force, frames, model, options) => call("search:index", [p, force, frames, model, options]),
    indexConcurrency: () => call("search:concurrency"),
    warmSearchIndex: () => call("search:warm"),
    runSearch: (opts) => call("search:run", [opts]),
    dedup: (opts) => call("search:dedup", [opts]),
    cluster: (opts) => call("search:cluster", [opts]),
    search: (text, topK) => call("search:query", [text, topK]),
    searchStatus: (o) => call("search:status", [o]),
    searchModelState: () => call("search:modelState"),
    searchSetModel: (id) => call("search:setModel", [id]),
    projects: () => call("projects:list"),
    forgetProject: (name) => call("projects:forget", [name]),
    projectPaths: (names) => call("projects:paths", [names]),
    scanProjects: () => call("projects:scan"),
    onProjectScan: (cb) => on("projects:scan", cb as (p: unknown) => void),
    searchIndexed: () => call("search:indexed"),
    cancelIndexJobs: () => call("search:cancelIndex"),
    searchShots: (p) => call("search:shots", [p]),
    faceIndex: (p, force, model, options) => call("face:index", [p, force, model, options]),
    faceSearch: (opts) => call("face:search", [opts]),
    faceDetect: (p) => call("face:detect", [p]),
    faceStatus: (o) => call("face:status", [o]),
    faceEngines: () => call("face:engines"),
    faceIndexed: () => call("face:indexed"),
    faceGallery: (o) => call("face:gallery", [o]),
    charList: (o) => call("char:list", [o]),
    charCreate: (o) => call("char:create", [o]),
    charUpdate: (o) => call("char:update", [o]),
    charDelete: (id) => call("char:delete", [id]),
    charAddSample: (o) => call("char:addSample", [o]),
    charRemoveSample: (id) => call("char:removeSample", [id]),
    charSamples: (id) => call("char:samples", [id]),
    charIdentify: (o) => call("char:identify", [o]),
    charSearch: (o) => call("char:search", [o]),
    charShots: (o) => call("char:shots", [o]),
    charLabelIndex: (o) => call("char:labelIndex", [o]),
    charMerge: (o) => call("char:merge", [o]),
    charDuplicates: (o) => call("char:duplicates", [o]),
    onSearchProgress: (cb) => on("search:progress", cb as (p: unknown) => void),
    startDrag: () => {},
    chooseDir: () => dlgOpen({ directory: true }) as Promise<string | null>,
    chooseFiles: () =>
      isRemote
        ? requestParentFiles(true, VIDEO_EXT)
        : (dlgOpen({ multiple: true, filters: [{ name: i18n.t("common:fileType.video"), extensions: VIDEO_EXT }] }) as Promise<string[] | null>),
    chooseMediaFiles: () =>
      isRemote
        ? requestParentFiles(true, MEDIA_EXT)
        : (dlgOpen({ multiple: true, filters: [{ name: i18n.t("common:fileType.media"), extensions: MEDIA_EXT }] }) as Promise<string[] | null>),
    chooseImages: () =>
      isRemote
        ? requestParentFiles(true, IMAGE_EXT)
        : (dlgOpen({ multiple: true, filters: [{ name: i18n.t("common:fileType.image"), extensions: IMAGE_EXT }] }) as Promise<string[] | null>),
    chooseAnyFile: () =>
      isRemote
        ? requestParentFiles(false, []).then((a) => (a && a[0]) || null)
        : (dlgOpen({ multiple: false }) as Promise<string | null>),
    pathsForFiles: (files) => resolveFilePaths(files),
    saveFile: (defaultName) => dlgSave(defaultName),
    mediaUrl: (p) => `${BASE}/media?p=${encodeURIComponent(p)}${tkParam}`,
    ytStreamUrl: (id) => `${BASE}/ytstream?id=${encodeURIComponent(id)}${tkParam}`,
    openExternal: (url) => openUrl(url),
    openPath: (p) => openPath(p),
    setAlwaysOnTop: (on) => {
      void (async () => {
        if (!isTauri) return;
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setAlwaysOnTop(on).catch(() => {});
      })();
    },
    setWindowSize: (w, h) => {
      void (async () => {
        if (!isTauri) return;
        const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
          import("@tauri-apps/api/window"),
          import("@tauri-apps/api/dpi"),
        ]);
        const win = getCurrentWindow();
        // Une fenêtre maximisée/plein écran/snappée IGNORE setSize (garde l'état → « plein écran »).
        // On retire ces états INCONDITIONNELLEMENT (isMaximized rate l'état sur fenêtre frameless/snap)
        // AVANT de redimensionner, puis on recentre pour une fenêtre nette et visible.
        try { await win.setFullscreen(false); } catch { /* noop */ }
        try { await win.unmaximize(); } catch { /* noop */ }
        try { await win.setSize(new LogicalSize(w, h)); } catch { /* noop */ }
        try { await win.center(); } catch { /* noop */ }
      })();
    },
    reference,
    wallpaper,
    script,
    notebook,
    collections,
    library,
    chat,
    outbox,
    power,
    snapshot,
    cache,
  };
  return client;
}

// True si un core standalone est l'environnement cible (Tauri, ou flag dev forcé).
export const coreAvailable: boolean =
  isTauri || (typeof window !== "undefined" && !!(window as unknown as { __NR_CORE__?: string }).__NR_CORE__);
