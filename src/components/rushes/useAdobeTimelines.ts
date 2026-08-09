// Source Timeline Live pour un hôte ADOBE. Contrairement à Resolve (pont Python interrogé timeline
// par timeline), les plans montés d'une séquence Premiere / comp After Effects arrivent DÉJÀ dans le
// snapshot poussé par le panneau CEP : ouvrir une timeline ne demande donc rien à l'hôte, tout est
// en mémoire. Le core persiste ce snapshot sur disque (`core/adobe.js`) → la vue reste navigable
// Adobe fermé, et après un redémarrage du core.
import { useCallback, useEffect, useMemo } from "react";
import { nr, type AdobeApp, type AdobeSnapshot, type TimelineCut } from "@/lib/bridge";
import { useApp } from "@/store";
import { hostTimelineCuts, hostTimelineNames, isAdobeHost } from "@/lib/host";

export interface AdobeTimelines {
  /** L'hôte actif est Premiere/After Effects → c'est cette source qui pilote la vue. */
  active: boolean;
  app: AdobeApp | null;
  /** Un snapshot exploitable est chargé (au moins une séquence / comp). */
  ready: boolean;
  /** Le panneau CEP répond : le scan renverra du frais. Sinon on lit le cache disque. */
  live: boolean;
  timelines: { name: string; current: boolean }[];
  cuts: (name: string) => TimelineCut[];
  /** Vignette de carte = 1er plan de chaque séquence, lu dans le snapshot (aucun scan hôte). */
  thumbs: Map<string, { path: string; in: number }>;
  /** Redemande un scan au panneau ; la réponse revient en SSE `adobe:update`. */
  refresh: () => Promise<void>;
}

function firstFrames(snap: AdobeSnapshot | null | undefined): Map<string, { path: string; in: number }> {
  const out = new Map<string, { path: string; in: number }>();
  if (!snap) return out;
  for (const sequence of snap.sequences) {
    const first = hostTimelineCuts(snap, sequence.name)[0];
    if (first) out.set(sequence.name, { path: first.path, in: first.in });
  }
  return out;
}

export function useAdobeTimelines(): AdobeTimelines {
  const activeHost = useApp((s) => s.activeHost);
  const app = isAdobeHost(activeHost) ? activeHost : null;
  const snap = useApp((s) => (app ? s.adobeSnapshots[app] ?? null : null));
  const adobeStatus = useApp((s) => s.adobeStatus);
  const loadAdobeSnapshot = useApp((s) => s.loadAdobeSnapshot);
  const scanAdobe = useApp((s) => s.scanAdobe);

  // Premier chargement + rafraîchissement quand le panneau republie (« Envoyer vers NetsuRush »,
  // scan auto à l'ouverture du panneau, ou notre propre demande de scan).
  useEffect(() => {
    if (!app) return;
    void loadAdobeSnapshot(app);
    return nr.onAdobeUpdate((p) => {
      if (p.app === app) void loadAdobeSnapshot(app);
    });
  }, [app, loadAdobeSnapshot]);

  const timelines = useMemo(() => hostTimelineNames(snap), [snap]);
  const thumbs = useMemo(() => firstFrames(snap), [snap]);
  const cuts = useCallback((name: string) => hostTimelineCuts(snap, name), [snap]);
  const refresh = useCallback(async () => { if (app) await scanAdobe(app); }, [app, scanAdobe]);

  return {
    active: !!app,
    app,
    ready: timelines.length > 0,
    live: !!app && !!adobeStatus?.[app]?.panelConnected,
    timelines,
    cuts,
    thumbs,
    refresh,
  };
}
