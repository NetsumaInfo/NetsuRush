// Hook du module voix : abonnement à la progression SSE (onVoiceProgress → store) + sources de
// clips (Media Pool Resolve + fichiers locaux ajoutés à la liste). L'orchestration des sidecars
// (transcription, analyse groupée) vit dans le store ; ce hook gère l'entrée et la progression.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { nr, type Clip } from "@/lib/bridge";
import { useApp } from "@/store";
import { hostShort } from "@/lib/host";
import { basename } from "@/lib/utils";

export function useVoiceAnalysis() {
  const { t } = useTranslation("voice");
  const setVoiceProgress = useApp((s) => s.setVoiceProgress);
  const openVoiceClip = useApp((s) => s.openVoiceClip);

  // Progression réelle des sidecars (STAGE:* → pourcentage) poussée dans le store.
  useEffect(() => nr.onVoiceProgress((p) => setVoiceProgress(p.phase, p.pct)), [setVoiceProgress]);

  // Source projet PARTAGÉE avec le store derush (stale-while-revalidate + dédup in-flight) : plus de
  // fetch privé du Media Pool — la liste est déjà en mémoire/snapshot, l'affichage est instantané.
  const poolClips = useApp((s) => s.clips);
  const connected = useApp((s) => s.connected);
  const loadingClips = useApp((s) => s.clipsLoading);
  const storeClipsError = useApp((s) => s.clipsError);
  const [localClips, setLocalClips] = useState<Clip[]>([]);
  const [attempted, setAttempted] = useState(false);

  // Liste unifiée pour l'accueil : fichiers locaux d'abord (ajout volontaire), puis Media Pool.
  const clips = useMemo(() => {
    const pool = new Set(poolClips.map((c) => c.path));
    return [...localClips.filter((c) => !pool.has(c.path)), ...poolClips];
  }, [localClips, poolClips]);

  const loadMediaPool = useCallback(async () => {
    await useApp.getState().loadClips();
    setAttempted(true);
  }, []);

  // Erreur affichée seulement APRÈS une tentative (sinon flash « hors ligne » avant le 1er fetch).
  const clipError = useMemo(() => {
    if (!attempted || loadingClips || connected) return null;
    const host = useApp.getState().activeHost;
    return storeClipsError || (host === "resolve"
      ? t("analysis.resolveOffline")
      : t("analysis.otherHostOffline", { host: hostShort(host) }));
  }, [attempted, loadingClips, connected, storeClipsError, t]);

  // Multi-fichiers : TOUS les fichiers choisis rejoignent la liste (sélectionnables pour le lot),
  // sans ouvrir l'éditeur — un seul fichier choisi s'ouvre directement (raccourci mono-clip).
  const pickLocal = useCallback(async () => {
    const files = await nr.chooseFiles();
    if (!files?.length) return;
    const added: Clip[] = files.map((p) => ({
      path: p, name: basename(p), duration: null, fps: null, resolution: null, format: null, bin: null,
      source: "local",
    }));
    setLocalClips((prev) => {
      const seen = new Set(prev.map((c) => c.path));
      return [...prev, ...added.filter((c) => !seen.has(c.path))];
    });
    if (files.length === 1) openVoiceClip({ path: files[0], name: basename(files[0]), source: "local" });
  }, [openVoiceClip]);

  const selectClip = useCallback((c: Clip) => {
    openVoiceClip({
      path: c.path,
      name: c.name,
      source: c.source === "local" ? "local" : "mediapool",
      fps: c.fps ? parseFloat(c.fps) || undefined : undefined,
    });
  }, [openVoiceClip]);

  return { clips, loadingClips, connected, clipError, loadMediaPool, pickLocal, selectClip };
}
