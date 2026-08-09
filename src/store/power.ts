// Slice « énergie hôte » : fermer / rouvrir le logiciel de montage pour libérer RAM/GPU pendant une
// tâche lourde (découpe en masse, indexation, upscale), puis reprendre le projet. L'état vit côté core
// (persistant) ; ici on le relaie + on gère l'invite automatique proposée au lancement d'une tâche.
import type { StateCreator } from "zustand";
import { nr, type PowerState, type PowerProgress, type PowerHost } from "@/lib/bridge";
import type { AppState } from "./index";

export interface PowerSlice {
  power: PowerState | null;
  powerProgress: PowerProgress | null;
  // Invite « Fermer le logiciel pour libérer la RAM ? » proposée au démarrage d'une tâche lourde.
  ramPrompt: { host: PowerHost; project: string | null } | null;

  // Charge l'état + s'abonne aux SSE `power:changed` / `power:progress`. Appelé une fois par l'App.
  subscribePower: () => () => void;
  closeHost: (host?: PowerHost) => Promise<{ ok: boolean; error?: string }>;
  reopenHost: () => Promise<{ ok: boolean; error?: string }>;
  // Fermer + rouvrir d'un geste : le correctif de la dérive de session (cf. NetsuBoost › Mémoire).
  restartHost: (host?: PowerHost) => Promise<{ ok: boolean; project?: string | null; error?: string }>;
  // Proposée par les hooks de tâche lourde : n'ouvre l'invite que si l'hôte actif est bien ouvert.
  offerCloseForRam: () => void;
  dismissRamPrompt: () => void;
}

export const createPowerSlice: StateCreator<AppState, [], [], PowerSlice> = (set, get, api) => ({
  power: null,
  powerProgress: null,
  ramPrompt: null,

  subscribePower: () => {
    void nr.power?.state().then((p) => p && set({ power: p }));
    void nr.power?.reconcile().then((p) => p && set({ power: p })); // efface un état « fermé » périmé au boot
    const offA = nr.power?.onChanged((p) => set({ power: p, powerProgress: p.busy ? get().powerProgress : null })) ?? (() => {});
    const offB = nr.power?.onProgress((pr) => set({ powerProgress: pr })) ?? (() => {});
    // Réconciliation live : si un hôte marqué « fermé » est en réalité détecté OUVERT (relancé à la
    // main), on demande au core d'effacer l'état — sinon l'offre « Rouvrir » traîne à tort.
    let reconciling = false;
    const offC = api.subscribe((st) => {
      const c = st.power?.closed;
      if (!c || reconciling) return;
      const online = c.host === "resolve" ? !!st.status?.connected
        : c.host === "ppro" ? !!st.adobeStatus?.ppro.running : !!st.adobeStatus?.aeft.running;
      if (!online) return;
      reconciling = true;
      void nr.power?.reconcile().then((p) => { if (p) set({ power: p }); }).finally(() => { reconciling = false; });
    });
    // Filet de sécurité renderer : tant que la bannière dit « fermé », on force aussi une sonde en
    // arrière-plan. Cela couvre une reconnexion ratée par le SSE et actualise le statut sans clic ni
    // redémarrage de NetsuRush.
    const probe = async () => {
      const c = get().power?.closed;
      if (!c || reconciling) return;
      reconciling = true;
      try {
        if (c.host === "resolve") {
          nr.refreshNow();
          await get().refreshStatus(true).catch(() => {});
        } else {
          await get().refreshAdobeStatus().catch(() => {});
        }
        const p = await nr.power?.reconcile().catch(() => null);
        if (p) set({ power: p });
      } finally {
        reconciling = false;
      }
    };
    void probe();
    const probeTimer = window.setInterval(() => { void probe(); }, 4000);
    return () => { offA(); offB(); offC(); window.clearInterval(probeTimer); };
  },

  closeHost: async (host) => {
    const target = host ?? get().activeHost;
    const r = await nr.power?.close(target);
    if (r?.ok) set({ ramPrompt: null });
    return r ?? { ok: false, error: "indisponible" };
  },

  reopenHost: async () => {
    const host = get().power?.closed?.host;
    const r = await nr.power?.reopen();
    if (host === "resolve") await get().refreshStatus(true).catch(() => {});
    else if (host) await get().refreshAdobeStatus().catch(() => {});
    const p = await nr.power?.reconcile().catch(() => null);
    if (p) set({ power: p });
    return r ?? { ok: false, error: "indisponible" };
  },

  restartHost: async (host) => {
    const target = host ?? get().activeHost;
    set({ ramPrompt: null });
    const r = await nr.power?.restart(target);
    if (r?.ok) {
      if (target === "resolve") await get().refreshStatus(true).catch(() => {});
      else await get().refreshAdobeStatus().catch(() => {});
      const p = await nr.power?.reconcile().catch(() => null);
      if (p) set({ power: p });
    }
    return r ?? { ok: false, error: "indisponible" };
  },

  offerCloseForRam: () => {
    const showIfReady = () => {
      const s = get();
      if (s.ramPrompt || s.power?.closed || s.power?.busy) return true;
      const host = s.activeHost;
      if (host === "resolve") {
        // Une fermeture sûre exige un projet identifiable : le core le sauvegarde et vérifie son cache.
        if (!s.status?.connected || !s.status.project) return false;
        set({ ramPrompt: { host, project: s.status.project } });
        return true;
      }
      const app = host === "ppro" ? s.adobeStatus?.ppro : s.adobeStatus?.aeft;
      if (!app?.running) return false;
      set({ ramPrompt: { host, project: null } });
      return true;
    };

    if (showIfReady()) return;
    const s = get();
    // Le statut peut être encore froid quand l'utilisateur ouvre directement NetsuLab : on le charge
    // puis on retente, au lieu de perdre définitivement l'invite.
    if (s.activeHost === "resolve") {
      void s.refreshStatus(true).then(showIfReady).catch(() => {});
    } else {
      void s.refreshAdobeStatus().then(showIfReady).catch(() => {});
    }
  },

  dismissRamPrompt: () => set({ ramPrompt: null }),
});
