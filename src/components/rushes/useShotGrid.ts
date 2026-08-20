// État commun d'une grille de plans hors derush (Collections, Timeline Live) : colonnes, lecture
// auto, plafond de lecture recalculé sur la zone visible. Tout ce qui touche aux APERÇUS (cache
// d'URL, préchauffe, boutons de génération) vient de `usePreviewCache` — la MÊME implémentation que
// le Découpage, et plus une copie qui dérive.
//
// Densité et lecture auto viennent des réglages de NetsuCut (`cutCols`/`cutGridPlay`) : ces grilles
// affichent les MÊMES cartes que le Découpage, une densité par module se réglait trois fois.
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/store";
import { autoplayCeiling, gridMetrics, resetPlaySlots, setMaxPlaying } from "./cutStudioShared";
import { usePreviewCache, type PreviewRange, type PreviewSource, type PreviewThumbRange } from "./previewCache";

// Réexportés : les vues parlaient de `ProxyShot`/`ThumbShot` avant que le pipeline d'aperçu ne soit
// partagé. Mêmes formes, un seul endroit où elles sont définies.
export type ProxyShot = PreviewRange;
export type ThumbShot = PreviewThumbRange;

/** `narrow` = vue étroite (panneau CEP, fenêtre épinglée) : plafonne la cellule pour garder
 *  plusieurs colonnes. La géométrie rendue est celle du Découpage (`gridMetrics`). */
export function useShotGrid({ narrow = false }: { narrow?: boolean } = {}) {
  const preview = usePreviewCache();
  const cols = useApp((s) => s.cutCols);
  const setColsStore = useApp((s) => s.setCutCols);
  // Enveloppe compatible `Dispatch<SetStateAction<number>>` : les appelants gardent `setCols((c) => c + 1)`.
  const setCols = useCallback<React.Dispatch<React.SetStateAction<number>>>(
    (v) => setColsStore(typeof v === "function" ? v(useApp.getState().cutCols) : v),
    [setColsStore],
  );
  // La lecture auto est un ÉTAT de vue amorcé par le réglage (comme CutStudio) : la basculer ici ne
  // change pas le défaut de démarrage des autres modules.
  const [gridPlay, setGridPlay] = useState(() => useApp.getState().cutGridPlay);
  const gridScrollRef = useRef<HTMLDivElement>(null);

  // Créneaux de lecture remis à zéro à l'entrée/sortie (évite un compteur faussé hérité).
  useEffect(() => { resetPlaySlots(); return () => resetPlaySlots(); }, []);

  // Largeur de la zone défilante → géométrie de la grille ET plafond de lecture, recalculés au
  // resize / changement de densité (mêmes formules que le Découpage).
  const [gridW, setGridW] = useState(0);
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const recompute = () => {
      const cw = el.clientWidth, ch = el.clientHeight;
      if (!cw || !ch) return;
      setGridW(cw);
      const ceiling = autoplayCeiling(cw, ch, cols, narrow);
      if (ceiling) setMaxPlaying(ceiling);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cols, narrow]);
  const { cell, actualCols } = gridMetrics(gridW, cols, narrow);

  // Hauteur de cellule mesurée = palier d'encodage des proxys (largeur carte × 9/16 × DPR, cf.
  // SceneCard) → la pré-génération vise le MÊME fichier que la lecture à la demande.
  function proxyHeight(): number | undefined {
    const el = gridScrollRef.current;
    if (!el?.clientWidth) return undefined;
    const cardW = gridMetrics(el.clientWidth, cols, narrow).cell;
    return Math.round(((cardW * 9) / 16) * (window.devicePixelRatio || 1));
  }

  return {
    cols, setCols, cell, actualCols, gridPlay, setGridPlay, gridScrollRef,
    getProxy: preview.getProxy,
    bust: preview.bustProxy,
    peekProxy: preview.peekProxy,
    warmThumbs: preview.warmThumbs,
    warmProxies: preview.warmProxies,
    proxyGen: preview.proxyGen,
    generateProxies: (source: PreviewSource<ProxyShot>) => preview.generateProxies(source, proxyHeight()),
    thumbsGen: preview.thumbsGen,
    generateThumbs: preview.generateThumbs,
  };
}
