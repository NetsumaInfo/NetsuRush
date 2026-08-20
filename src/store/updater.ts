import { create } from "zustand";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "current"
  | "error";

export interface UpdateInfo {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
}

interface UpdateState {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  /** Progression EXACTE en pourcent (flottant, 0 → 100). `null` = taille inconnue côté serveur. */
  progress: number | null;
  downloadedBytes: number;
  totalBytes: number;
  error: string | null;
  autoCheck: boolean;
  setAutoCheck: (enabled: boolean) => void;
  autoInstall: boolean;
  setAutoInstall: (enabled: boolean) => void;
  check: (options?: { silent?: boolean }) => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
}

let pendingUpdate: Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater")["check"]>> = null;

/**
 * L'updater passe par le plugin Tauri : il ne dépend NI du core Node NI du réseau applicatif.
 * C'est ce qui permet de proposer une mise à jour depuis l'écran d'installation quand le core
 * est mort. Hors application (navigateur, panneau CEP), il n'y a rien à mettre à jour.
 */
export function updaterAvailable() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function initialAutoCheck() {
  try { return localStorage.getItem("nr.update.auto") !== "0"; } catch { return true; }
}

// Unattended install: OFF unless it was explicitly turned on. Updating is the user's call, and a
// process that closes and relaunches itself must never be something one discovers by surprise.
function initialAutoInstall() {
  try { return localStorage.getItem("nr.update.autoInstall") === "1"; } catch { return false; }
}

// Les événements de progression arrivent à la fréquence des chunks HTTP (plusieurs centaines par
// seconde). Écrire le store à chaque chunk ferait re-render la barre de titre en boucle pendant tout
// le téléchargement. On publie au plus toutes les 80 ms — assez fin pour que le pourcentage défile
// en continu, assez rare pour ne rien coûter. Les paliers 0 et 100 sont TOUJOURS publiés.
const PROGRESS_INTERVAL_MS = 80;

export const useUpdater = create<UpdateState>((set, get) => ({
  phase: "idle",
  info: null,
  progress: null,
  downloadedBytes: 0,
  totalBytes: 0,
  error: null,
  autoCheck: initialAutoCheck(),
  setAutoCheck: (autoCheck) => {
    try { localStorage.setItem("nr.update.auto", autoCheck ? "1" : "0"); } catch { /* noop */ }
    // Nothing to install without the boot probe that finds the version: dropping the check drops
    // the unattended install with it, rather than leaving a toggle that silently does nothing.
    if (!autoCheck) get().setAutoInstall(false);
    set({ autoCheck });
  },
  autoInstall: initialAutoInstall(),
  setAutoInstall: (autoInstall) => {
    try { localStorage.setItem("nr.update.autoInstall", autoInstall ? "1" : "0"); } catch { /* noop */ }
    set({ autoInstall });
    if (autoInstall && !get().autoCheck) get().setAutoCheck(true);
  },
  check: async (options) => {
    const phase = get().phase;
    if (!updaterAvailable()) return;
    // Un téléchargement en cours ou terminé prime : re-sonder écraserait la version déjà récupérée.
    if (phase === "checking" || phase === "downloading" || phase === "downloaded" || phase === "installing") return;
    if (!options?.silent) set({ phase: "checking", error: null, progress: null });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      pendingUpdate = await check({ timeout: 30_000 });
      if (!pendingUpdate) {
        set({ phase: options?.silent ? "idle" : "current", info: null });
        return;
      }
      set({
        phase: "available",
        info: {
          currentVersion: pendingUpdate.currentVersion,
          version: pendingUpdate.version,
          date: pendingUpdate.date,
          body: pendingUpdate.body,
        },
      });
      // Only the boot probe can feed the unattended path: a check fired by hand from the settings
      // page keeps its two clicks, so nobody loses the window they are working in for having
      // pressed "Check for updates".
      if (options?.silent) { bootAvailable = true; void runAutoInstall(); }
    } catch (error) {
      // Sonde de démarrage : un dépôt injoignable ou un réseau coupé n'est pas une information que
      // quelqu'un vient chercher au lancement. On retombe silencieusement sur « rien à proposer ».
      if (options?.silent) set({ phase: "idle" });
      else set({ phase: "error", error: String(error) });
    }
  },
  download: async () => {
    if (!pendingUpdate || get().phase !== "available") return;
    set({ phase: "downloading", progress: 0, downloadedBytes: 0, totalBytes: 0, error: null });
    let downloaded = 0;
    let total = 0;
    let lastEmit = 0;
    try {
      await pendingUpdate.download((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          set({ totalBytes: total, progress: total > 0 ? 0 : null });
          return;
        }
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const now = performance.now();
          if (now - lastEmit < PROGRESS_INTERVAL_MS) return;
          lastEmit = now;
          // Pas d'arrondi et pas de plafond artificiel à 99 : la valeur publiée est la vraie
          // fraction téléchargée, l'affichage décide de sa précision.
          set({ downloadedBytes: downloaded, progress: total > 0 ? Math.min(100, (downloaded / total) * 100) : null });
          return;
        }
        if (event.event === "Finished") set({ downloadedBytes: total || downloaded, progress: 100 });
      });
      set({ phase: "downloaded", progress: 100 });
    } catch (error) {
      set({ phase: "error", error: String(error) });
    }
  },
  install: async () => {
    if (!pendingUpdate || get().phase !== "downloaded") return;
    set({ phase: "installing", error: null });
    try {
      await pendingUpdate.install();
      // L'installateur NSIS tourne en mode `passive` : il ferme l'application, l'écrase et la
      // relance. `relaunch()` couvre le cas où il rend la main sans avoir tué le processus.
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      set({ phase: "error", error: String(error) });
    }
  },
}));

// Sonde unique par session : `UpdateButton` est monté à CHAQUE écran (installation, gate, shell) et
// remonte à chaque transition. Sans ce verrou, on relancerait une requête réseau à chaque bascule.
let bootstrapped = false;

// The unattended install needs both: a version found by the BOOT probe, and a shell that armed it.
let bootAvailable = false;
let armedAt: number | null = null;

// « Au lancement » veut dire au lancement. Passé ce délai, l'utilisateur travaille : un installeur
// lent ne doit pas fermer la fenêtre au milieu d'un export ou d'une indexation. Au-delà, la version
// téléchargée attend simplement le bouton « Mettre à jour » de la barre de titre.
const LAUNCH_WINDOW_MS = 120_000;

/**
 * Download and restart on the version the boot probe found, with no click — opt-in only, and only
 * at launch, when nothing is running yet. A failed download simply stops here: the title-bar button
 * holds the same update and the usual two clicks still work.
 */
async function runAutoInstall() {
  if (armedAt === null || !bootAvailable) return;
  const state = useUpdater.getState();
  if (!state.autoInstall || state.phase !== "available") return;
  bootAvailable = false;
  await state.download();
  if (useUpdater.getState().phase !== "downloaded") return;
  if (performance.now() - armedAt > LAUNCH_WINDOW_MS) return;
  await useUpdater.getState().install();
}

/**
 * Arms the unattended install. Called by the shell ONCE the application is really up: on the setup
 * and login screens a relaunch would cut the runtime download or an in-flight sign-in. Arming after
 * the probe already answered is the normal case — hence the immediate retry.
 */
export function armAutoInstall() {
  if (armedAt !== null) return;
  armedAt = performance.now();
  void runAutoInstall();
}

/**
 * Recherche de démarrage. Volontairement effacée : différée hors du chemin de boot, puis exécutée
 * pendant un temps mort du navigateur, et muette en cas d'échec. Une seule requête HTTPS (~1 ko de
 * manifeste), aucun travail périodique, aucune écriture disque.
 */
export function scheduleUpdateBootstrapCheck() {
  if (bootstrapped || !updaterAvailable()) return;
  bootstrapped = true;
  if (!useUpdater.getState().autoCheck) return;
  const run = () => { void useUpdater.getState().check({ silent: true }); };
  window.setTimeout(() => {
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 10_000 });
    else run();
  }, 6_000);
}
