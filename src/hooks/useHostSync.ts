import { useEffect } from "react";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import { isAdobeHost } from "@/lib/host";
import { useResolveSync } from "./useResolveSync";
import { useSharedPrefs } from "./useSharedPrefs";

// Cadence de relecture du statut Adobe : le core ne « watch » pas Adobe (c'est le panneau CEP qui
// bat toutes les 5 s vers le core), donc le renderer relit ce statut au lieu d'attendre un push.
const ADOBE_POLL_MS = 8000;

// Synchro du statut de l'HÔTE actif. Resolve garde son watch dédié (useResolveSync) ; côté Adobe la
// seule preuve de vie est le heartbeat du panneau, relu ici périodiquement et à chaque snapshot poussé.
// Monté par la coquille ET par le panneau remote — ce dernier ne rend PAS la coquille, donc rien ne
// rafraîchissait `adobeStatus` dans le panneau CEP et toutes les actions « hôte connecté » y
// restaient masquées.
export function useHostSync() {
  useResolveSync();
  // Réglages de travail partagés entre l'app et le panneau CEP (origines localStorage distinctes).
  useSharedPrefs();
  const activeHost = useApp((s) => s.activeHost);
  useEffect(() => {
    if (!isAdobeHost(activeHost)) return;
    const refresh = () => void useApp.getState().refreshAdobeStatus();
    refresh();
    const timer = setInterval(refresh, ADOBE_POLL_MS);
    const off = nr.onAdobeUpdate((p) => { if (p.app === activeHost) refresh(); });
    return () => { clearInterval(timer); off(); };
  }, [activeHost]);
}
