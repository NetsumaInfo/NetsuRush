import { create } from "zustand";

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "current" | "error";

export interface UpdateInfo {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
}

interface UpdateState {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  progress: number | null;
  error: string | null;
  autoCheck: boolean;
  setAutoCheck: (enabled: boolean) => void;
  check: () => Promise<void>;
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

export const useUpdater = create<UpdateState>((set, get) => ({
  phase: "idle",
  info: null,
  progress: null,
  error: null,
  autoCheck: initialAutoCheck(),
  setAutoCheck: (autoCheck) => {
    try { localStorage.setItem("nr.update.auto", autoCheck ? "1" : "0"); } catch { /* noop */ }
    set({ autoCheck });
  },
  check: async () => {
    if (!updaterAvailable() || get().phase === "checking" || get().phase === "downloading") return;
    set({ phase: "checking", error: null, progress: null });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      pendingUpdate = await check({ timeout: 30_000 });
      if (!pendingUpdate) {
        set({ phase: "current", info: null });
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
    } catch (error) {
      set({ phase: "error", error: String(error) });
    }
  },
  install: async () => {
    if (!pendingUpdate || get().phase === "downloading") return;
    set({ phase: "downloading", progress: 0, error: null });
    let downloaded = 0;
    let total = 0;
    try {
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") downloaded += event.data.chunkLength;
        if (event.event === "Finished") set({ progress: 100 });
        else set({ progress: total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : null });
      });
      const { exit } = await import("@tauri-apps/plugin-process");
      await exit(0);
    } catch (error) {
      set({ phase: "error", error: String(error) });
    }
  },
}));

