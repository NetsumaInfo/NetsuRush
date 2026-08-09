// Liste des timelines du projet ouvert, tenue à jour. Partagée par le sélecteur de destination du
// derush (useTimelineTarget) et par celui adossé au profil d'export (ExportTimelineTarget).
// HÔTE-CONSCIENTE : sur Premiere/After Effects les séquences/comps viennent du snapshot du panneau
// CEP — appeler `nr.listTimelines` y listait les timelines RESOLVE (le sélecteur proposait « V0 »
// alors qu'on montait dans Premiere).
import { useEffect, useRef, useState } from "react";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import { useAdobeTimelines } from "./useAdobeTimelines";

export interface TimelineList {
  timelines: { name: string; current: boolean }[];
  current: string | null;
  loading: boolean;        // scan des timelines en cours (1er chargement ou refresh)
  refresh: () => Promise<void>;
}

export function useTimelineList(enabled = true): TimelineList {
  const adobe = useAdobeTimelines();
  const [timelines, setTimelines] = useState<{ name: string; current: boolean }[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const hasDataRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  // Un changement de timeline/projet reçu pendant une lecture ne doit pas être perdu : il programme
  // une seconde lecture dès que la première libère le pont séquentiel.
  const refreshQueuedRef = useRef(false);
  const project = useApp((s) => s.status?.project ?? null);
  const openTimeline = useApp((s) => s.status?.timeline ?? null);
  const projectRef = useRef(project);
  const dataProjectRef = useRef<string | null>(project);
  useEffect(() => { projectRef.current = project; }, [project]);

  function refresh(): Promise<void> {
    if (refreshPromiseRef.current) {
      refreshQueuedRef.current = true;
      return refreshPromiseRef.current;
    }
    const run = async () => {
      do {
        refreshQueuedRef.current = false;
        setLoading(true);
        const requestProject = projectRef.current;
        // Stale-while-revalidate : liste vide → snapshot instantané, puis vérité live. Une erreur live
        // ne remplace JAMAIS une liste valide par [] : le cache reste visible jusqu'au prochain succès.
        if (!hasDataRef.current) {
          try {
            const snapshotState = await nr.snapshot?.state();
            const snapshotMatches = !requestProject || !snapshotState?.project || snapshotState.project === requestProject;
            const peek = snapshotMatches ? await nr.snapshot?.peek("timelines") : null;
            if (requestProject === projectRef.current && peek?.ok && peek.timelines?.length) {
              hasDataRef.current = true;
              setTimelines(peek.timelines);
              setCurrent(peek.current ?? null);
            }
          } catch { /* pas de snapshot */ }
        }
        try {
          const r = await nr.listTimelines();
          if (requestProject === projectRef.current && r.ok) {
            hasDataRef.current = true;
            setTimelines(r.timelines || []);
            setCurrent(r.current ?? null);
          }
        } catch { /* lecture transitoire : conserver les dernières données valides */ }
        setLoading(false);
      } while (refreshQueuedRef.current);
    };
    refreshPromiseRef.current = run().finally(() => { refreshPromiseRef.current = null; });
    return refreshPromiseRef.current;
  }
  // Resolve signale projet/timeline changés via timelinesEpoch (resolve:changed) → on resynchronise la
  // liste sans attendre un focus fenêtre (sinon, au switch de projet, la liste reste celle de l'ancien).
  const timelinesEpoch = useApp((s) => s.timelinesEpoch);
  useEffect(() => {
    if (project && dataProjectRef.current && dataProjectRef.current !== project) {
      hasDataRef.current = false;
      setTimelines([]);
      setCurrent(null);
    }
    if (project) dataProjectRef.current = project;
    if (enabled && !adobe.active) void refresh();
    /* eslint-disable-next-line */
  }, [enabled, adobe.active, timelinesEpoch, project, openTimeline]);

  // Hôte Adobe : tout est déjà en mémoire (snapshot du panneau) → aucune lecture à attendre.
  if (adobe.active) {
    const currentAdobe = adobe.timelines.find((t) => t.current)?.name ?? null;
    return { timelines: adobe.timelines, current: currentAdobe, loading: false, refresh: adobe.refresh };
  }
  return { timelines, current, loading, refresh };
}
