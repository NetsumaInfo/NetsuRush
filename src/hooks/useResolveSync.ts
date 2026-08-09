import { useEffect } from "react";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";

// Synchro renderer↔Resolve. Le core POLL une signature légère de Resolve (projet / timeline ouverte
// / nb clips / nb timelines) à cadence lente et pousse `resolve:changed` sur diff → ici on refetch
// CIBLÉ (statut, Media Pool si on le regarde, status d'index, listes de timelines). On relance aussi
// un poll IMMÉDIAT au focus de la fenêtre (réactif quand l'utilisateur revient depuis Resolve).
// Monté une seule fois (App). `useApp.getState()` lit le store hors React → aucune dépendance.
export function useResolveSync() {
  useEffect(() => {
    // Boot : fetch INITIAL du statut. Sans ça `status` reste null (pastille amber « inconnu ») jusqu'au
    // clic « rafraîchir » — le watch ne broadcast QUE sur diff, donc un Resolve déjà connecté au démarrage
    // ne déclenche jamais de mise à jour. Le pont Python est froid au 1er appel (import DaVinciResolveScript)
    // → cet await prend qq s puis passe vert seul.
    void useApp.getState().refreshStatus();
    const off = nr.onResolveChanged((c) => {
      const s = useApp.getState();
      if (c.status) void s.refreshStatus(true);
      if (c.mediaPool) {
        if (s.derushView === "browser") void s.loadClips();
        void s.refreshSearchStatus();
      }
      if (c.timelines) s.bumpTimelinesEpoch();
    });
    const onFocus = () => nr.refreshNow();
    window.addEventListener("focus", onFocus);
    return () => { off(); window.removeEventListener("focus", onFocus); };
  }, []);
}
