// Slice « Optimisation » : met en cache le dernier diagnostic perf de l'hôte pour qu'il survive aux
// changements d'onglet (évite de re-sonder le pont à chaque retour sur l'onglet). Lecture seule —
// les actions de nettoyage/arrêt sont déclenchées par les composants et NE passent PAS par le store.
// Deux hôtes, deux diagnostics : Resolve (`optDiag`, pont Python) et Adobe (`boostDiag`, indexé par
// application pour qu'un passage Premiere ↔ After Effects ne jette pas celui de l'autre).
import type { StateCreator } from "zustand";
import type { AppState } from "./index";
import { nr } from "@/lib/bridge";
import type { AdobeApp, BoostDiagnosis, BoostProgress, OptimizeDiagnosis } from "@/lib/bridge";

export interface OptimizeSlice {
  optDiag: OptimizeDiagnosis | null;
  optDiagLoading: boolean;
  optDiagError: string | null;
  runDiagnose: () => Promise<void>;
  boostDiag: Partial<Record<AdobeApp, BoostDiagnosis>>;
  boostLoading: boolean;
  boostError: string | null;
  boostProgress: BoostProgress | null;
  runBoostDiagnose: (app: AdobeApp) => Promise<void>;
  initBoostProgress: () => () => void;
}

export const createOptimizeSlice: StateCreator<AppState, [], [], OptimizeSlice> = (set, get) => ({
  optDiag: null,
  optDiagLoading: false,
  optDiagError: null,
  runDiagnose: async () => {
    set({ optDiagLoading: true, optDiagError: null });
    try {
      const diag = await nr.optimizeDiagnose();
      set({ optDiag: diag, optDiagLoading: false });
    } catch (e) {
      set({ optDiagLoading: false, optDiagError: String(e) });
    }
  },
  boostDiag: {},
  boostLoading: false,
  boostError: null,
  boostProgress: null,
  runBoostDiagnose: async (app) => {
    set({ boostLoading: true, boostError: null });
    try {
      const diag = await nr.boostDiagnose(app);
      set({ boostDiag: { ...get().boostDiag, [app]: diag }, boostLoading: false });
    } catch (e) {
      set({ boostLoading: false, boostError: String(e) });
    }
  },
  // Abonnement monté par le panneau NetsuBoost, pas par l'App : l'onglet est chargé en `lazy`, un
  // écouteur permanent pour une vue rarement ouverte ne se justifie pas.
  initBoostProgress: () => {
    const off = nr.onBoostProgress((p) => {
      // Le core signale la fin par pct=100 avec un message nul : on efface plutôt que de laisser une
      // barre pleine figée après la réouverture de l'application.
      set({ boostProgress: p && p.pct < 100 ? p : null });
    });
    return () => {
      off();
      set({ boostProgress: null });
    };
  },
});
