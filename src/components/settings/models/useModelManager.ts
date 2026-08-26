import { useCallback, useEffect, useRef, useState } from "react";
import { nr, type GpuVram, type ModelProgress, type ModelStatus } from "@/lib/bridge";

// État du gestionnaire de modèles : statut installé par id, progression de téléchargement en cours,
// espace disque total. Source unique consommée par Paramètres › Modèles ET l'écran d'install.
export interface ModelManager {
  status: Record<string, ModelStatus>;   // id → { installed, sizeBytes }
  downloading: Record<string, number | null>; // id → pct (null = indéterminé) pendant le download
  // Étape en cours (download / verify / install). Sans elle, tout ce qui suit le téléchargement
  // s'affichait « … » sur une barre indéterminée : impossible de distinguer une vérification
  // d'empreinte ou un `pip install` d'un téléchargement qui repartirait de zéro.
  stages: Record<string, string>;
  removing: Record<string, boolean>;     // suppression disque en cours
  errors: Record<string, string>;
  diskTotal: number;
  gpu: GpuVram | null;                   // null = pas de GPU NVIDIA mesurable → aucun avertissement
  loading: boolean;
  restartRequired: boolean;
  /** Installation refusée : le modèle occupe la place d'un exclusif déjà installé. */
  conflict: { id: string; blockedBy: string[] } | null;
  dismissConflict: () => void;
  /** `replace` = l'utilisateur a confirmé la désinstallation du concurrent. */
  download: (id: string, replace?: boolean) => Promise<void>;
  importFile: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  restart: () => Promise<void>;
}

export function useModelManager(): ModelManager {
  const [status, setStatus] = useState<Record<string, ModelStatus>>({});
  const [downloading, setDownloading] = useState<Record<string, number | null>>({});
  const [stages, setStages] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [diskTotal, setDiskTotal] = useState(0);
  const [gpu, setGpu] = useState<GpuVram | null>(null);
  const [loading, setLoading] = useState(true);
  const [restartRequired, setRestartRequired] = useState(false);
  const [conflict, setConflict] = useState<{ id: string; blockedBy: string[] } | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const [list, disk, vram] = await Promise.all([nr.modelsList(), nr.modelsDiskUsage(), nr.modelsGpu()]);
    if (!alive.current) return;
    if (list.ok) {
      setStatus(Object.fromEntries(list.models.map((m) => [m.id, m])));
      // Restaure les téléchargements réellement actifs dans le core après navigation/remontage.
      setDownloading(Object.fromEntries(
        list.models.filter((m) => m.downloading).map((m) => [m.id, m.progress ?? null]),
      ));
    }
    if (disk.ok) setDiskTotal(disk.totalBytes);
    setGpu(vram);
    setLoading(false);
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    // Progression SSE : met à jour le pct par id, nettoie à la fin.
    const off = nr.onModelsProgress((p: ModelProgress) => {
      if (!alive.current) return;
      if (p.stage === "done" || p.stage === "canceled") {
        setDownloading((d) => { const n = { ...d }; delete n[p.id]; return n; });
        setStages((s) => { const n = { ...s }; delete n[p.id]; return n; });
        refresh();
        if (p.stage === "done") setRestartRequired(true);
      } else if (p.stage === "error") {
        setDownloading((d) => { const n = { ...d }; delete n[p.id]; return n; });
        setStages((s) => { const n = { ...s }; delete n[p.id]; return n; });
        if (p.error) setErrors((e) => ({ ...e, [p.id]: p.error as string }));
      } else {
        setDownloading((d) => ({ ...d, [p.id]: p.pct ?? null }));
        if (p.stage) setStages((s) => (s[p.id] === p.stage ? s : { ...s, [p.id]: p.stage as string }));
      }
    });
    return () => { alive.current = false; off(); };
  }, [refresh]);

  const download = useCallback(async (id: string, replace?: boolean) => {
    setErrors((e) => { const n = { ...e }; delete n[id]; return n; });
    setDownloading((d) => ({ ...d, [id]: 0 }));
    const r = await nr.modelsDownload(id, replace);
    if (!alive.current) return;
    if (!r.ok) {
      setDownloading((d) => { const n = { ...d }; delete n[id]; return n; });
      // Conflit d'exclusivité : ce n'est pas un échec à afficher en rouge, c'est un choix à faire.
      if (r.conflict) { setConflict({ id, blockedBy: r.conflict.blockedBy }); return; }
      // Runtime que NetsuRush n'a pas le droit de récupérer lui-même (SDK propriétaire derrière un
      // compte) : on ouvre la page officielle, le core reprend la main dès que l'archive est là.
      if (r.needsSource && r.url) void nr.openExternal(r.url);
      if (r.error) setErrors((e) => ({ ...e, [id]: r.error as string }));
    } else {
      // Fin gérée par le SSE 'done' ; filet de sécurité si l'event manque.
      setDownloading((d) => { const n = { ...d }; delete n[id]; return n; });
      refresh();
      setRestartRequired(true);
    }
  }, [refresh]);

  const restart = useCallback(async () => {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  }, []);

  const importFile = useCallback(async (id: string) => {
    setErrors((errors) => { const next = { ...errors }; delete next[id]; return next; });
    const paths = await nr.chooseFiles();
    const source = paths?.[0];
    if (!source) return;
    const result = await nr.modelsImport(id, source);
    if (!alive.current) return;
    if (!result.ok) {
      if (result.error) setErrors((errors) => ({ ...errors, [id]: result.error as string }));
      return;
    }
    await refresh();
    setRestartRequired(true);
  }, [refresh]);

  const cancel = useCallback(async (id: string) => {
    await nr.modelsCancel(id);
    // La barre s'efface via le SSE 'canceled' ; rescanner aussitôt rend les fichiers partiels
    // supprimables (« Reprendre » + corbeille) sans devoir rouvrir les Paramètres.
    if (!alive.current) return;
    setDownloading((d) => { const n = { ...d }; delete n[id]; return n; });
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    setErrors((e) => { const n = { ...e }; delete n[id]; return n; });
    setRemoving((d) => ({ ...d, [id]: true }));
    try {
      const r = await nr.modelsDelete(id);
      if (!alive.current) return;
      if (!r.ok && r.error) setErrors((e) => ({ ...e, [id]: r.error as string }));
      await refresh();
    } finally {
      if (alive.current) setRemoving((d) => { const n = { ...d }; delete n[id]; return n; });
    }
  }, [refresh]);

  return {
    status, downloading, stages, removing, errors, diskTotal, gpu, loading, restartRequired,
    conflict, dismissConflict: () => setConflict(null),
    download, importFile, cancel, remove, refresh, restart,
  };
}
