import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { nr, type SearchHit } from "@/lib/bridge";
import { basename, thumbTime } from "@/lib/utils";
export { basename };

const PAGE = 80;   // plans affichés par lot (vignettes chargées paresseusement → modal instantané)

export type ShotBrowser = ReturnType<typeof useShotBrowser>;

// État + logique de navigation des plans (médias indexés → clip → grille paginée).
// Extrait du composant pour garder ReferencePicker fin (état regroupé hors du corps).
export function useShotBrowser() {
  const { t } = useTranslation("search");
  const [indexedPaths, setIndexedPaths] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [clip, setClip] = useState<string | null>(null);     // clip ouvert (vue Découpes)
  const [shots, setShots] = useState<SearchHit[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [shown, setShown] = useState(PAGE);
  const [loadingThumbs, setLoadingThumbs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);     // conteneur scrollable (vue Découpes)
  const sentinelRef = useRef<HTMLDivElement>(null);    // déclencheur de chargement auto en bas

  useEffect(() => {
    (async () => {
      try {
        const r = await nr.searchIndexed();
        setIndexedPaths(Object.keys(r.indexed || {}));
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const clips = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = indexedPaths.map((p) => ({ path: p, name: basename(p) }));
    list.sort((a, b) => a.name.localeCompare(b.name));
    return q ? list.filter((c) => c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q)) : list;
  }, [indexedPaths, query]);

  // Vignettes = le cache PARTAGÉ de l'application, celui qu'affiche le découpage (`thumbTime`) :
  // un rush déjà découpé s'ouvre ici sans un seul ffmpeg. On résout d'abord ce qui existe, puis on
  // ne fabrique que le manquant (file basse priorité côté core), et on re-résout pour les chemins.
  const loadThumbs = useCallback(async (path: string, list: SearchHit[], from: number, to: number) => {
    const page = list.slice(from, to);
    if (!page.length) return;
    const items = page.map((s) => ({ path, time: thumbTime(s.start_sec, s.end_sec) }));
    const indexOfTime = new Map(page.map((s) => [thumbTime(s.start_sec, s.end_sec).toFixed(2), s.scene_index]));
    const absorb = (files: { time: number; file: string | null }[]) => {
      setThumbs((prev) => {
        const next = { ...prev };
        for (const f of files) {
          const si = indexOfTime.get(Number(f.time).toFixed(2));
          if (f.file && si != null) next[si] = nr.mediaUrl(f.file);
        }
        return next;
      });
    };
    setLoadingThumbs(true);
    try {
      const known = await nr.thumbsResolve(items);
      absorb(known);
      if (known.some((f) => !f.file)) {
        await nr.thumbsBatch(path, items.map((it) => ({ time: it.time, frame: 0 })));
        absorb(await nr.thumbsResolve(items));
      }
    } catch {
      /* vignettes non critiques : on garde le placeholder */
    } finally {
      setLoadingThumbs(false);
    }
  }, []);

  const openClip = useCallback(async (path: string) => {
    setClip(path);
    setShots(null);
    setThumbs({});
    setShown(PAGE);
    setError(null);
    try {
      const r = await nr.searchShots(path);
      if (r.error) { setShots([]); setError(r.error); return; }
      const list = r.shots || [];
      setShots(list);
      loadThumbs(path, list, 0, PAGE);
    } catch (e) {
      setShots([]);
      setError(t("shotBrowser.cutsUnavailable", { error: String(e) }));
    }
  }, [loadThumbs, t]);

  const loadMore = useCallback(() => {
    if (!clip || !shots || loadingThumbs || shown >= shots.length) return;
    const next = shown + PAGE;
    loadThumbs(clip, shots, shown, next);
    setShown(next);
  }, [clip, shots, loadingThumbs, shown, loadThumbs]);

  // Référence toujours à jour de loadMore : l'observer la lit sans se recréer à chaque rendu.
  const loadMoreRef = useRef(loadMore);
  useEffect(() => { loadMoreRef.current = loadMore; }, [loadMore]);

  // Ferme la vue Découpes et revient à la liste des médias.
  const closeClip = useCallback(() => {
    setClip(null);
    setShots(null);
    setError(null);
  }, []);

  // Chargement auto à l'approche du bas (scroll infini) : observe une sentinelle dans le conteneur.
  // loadMore est lu via ref (toujours frais) pour ne pas recréer l'observer à chaque rendu.
  // On reconstruit l'observer sur les mêmes transitions qu'avant (shots/shown/loadingThumbs/clip)
  // afin de relancer un chargement si la sentinelle reste visible une fois le lot précédent terminé.
  useEffect(() => {
    const root = scrollRef.current;
    const el = sentinelRef.current;
    if (!root || !el || !shots || shown >= shots.length) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) loadMoreRef.current(); },
      { root, rootMargin: "400px" },   // précharge avant d'atteindre le bord
    );
    io.observe(el);
    return () => io.disconnect();
    // Déps volontaires : loadingThumbs/clip ne sont lus que via loadMoreRef, mais on veut
    // reconstruire l'observer à leur changement (relance le scroll infini quand un lot finit).
    // oxlint-disable-next-line react-doctor/exhaustive-deps
  }, [shots, shown, loadingThumbs, clip]);

  return {
    query, setQuery,
    clip, shots, thumbs, shown, error, loading,
    indexedPaths, clips,
    scrollRef, sentinelRef,
    openClip, closeClip,
  };
}
