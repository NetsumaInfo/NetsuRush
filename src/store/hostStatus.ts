// Sélecteur PARTAGÉ de l'état de l'hôte actif. Chaque vue testait `!!s.status?.connected`, c'est-à-dire
// le pont Python de Resolve : sur Premiere/After Effects les actions « projet » (envoyer vers la
// timeline, ranger, importer) restaient donc grisées alors que le panneau CEP répondait.
import { isAdobeHost } from "@/lib/host";
import type { AppState } from "./index";

/** L'hôte ACTIF est joignable : Resolve = pont Python, Adobe = heartbeat du panneau CEP (< 12 s). */
export function hostConnected(state: AppState): boolean {
  const host = state.activeHost;
  if (!isAdobeHost(host)) return !!state.status?.connected;
  return !!state.adobeStatus?.[host]?.panelConnected;
}

/** Projet ouvert dans l'hôte actif (nom d'affichage), ou null s'il n'y en a pas. */
export function hostProject(state: AppState): string | null {
  const host = state.activeHost;
  if (!isAdobeHost(host)) return state.status?.project ?? null;
  return state.adobeSnapshots[host]?.project ?? null;
}
