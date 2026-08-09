// Alimente la Rich Presence Discord en contexte : quel module est ouvert, sur quel projet.
// Le core (core/discordRpc.js) tient la connexion, le throttle de 15 s et les réglages — d'où un hook
// qui se contente de pousser, sans se soucier de la fréquence.
import { useEffect } from "react";
import { useApp } from "@/store";
import { NAV } from "@/components/nav";
import { nr } from "./bridge";

/**
 * À monter UNE SEULE fois, dans le shell principal. La fenêtre détachée du board et le panneau Adobe
 * sont le MÊME renderer : les y monter ferait pousser deux contextes concurrents au core.
 */
export function useDiscordPresence() {
  const tab = useApp((s) => s.tab);
  const project = useApp((s) => s.status?.project);
  const clip = useApp((s) => s.selected?.name);

  useEffect(() => {
    // Libellé lisible (« NetsuCut »), pas l'id d'onglet. Les Paramètres n'ont pas d'entrée NAV.
    const label = NAV.find((n) => n.id === tab)?.label ?? (tab === "settings" ? "Paramètres" : null);
    // À défaut de projet Resolve (hôte fermé, rushs locaux), le rush ouvert dit tout aussi bien
    // sur quoi on travaille.
    void nr.discordSetContext?.({ module: label, project: project || clip || null })?.catch?.(() => {});
  }, [tab, project, clip]);
}
