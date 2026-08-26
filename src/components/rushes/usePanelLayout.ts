import { useCallback } from "react";
import { useApp } from "@/store";
import { usePanelResize, type PanelResize } from "@/hooks/usePanelResize";

interface PanelLayout extends PanelResize {
  cols: number;
  setCols: React.Dispatch<React.SetStateAction<number>>;
  // Lecteur de droite affiché ou masqué (persisté) : permet de dégager toute la largeur pour la
  // grille de vignettes (utile en fenêtre étroite / épinglée dans un coin).
  playerOpen: boolean;
  setPlayerOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export const PANEL_MIN = 260;
export const PANEL_MAX = 560;

// Mise en page persistée : nombre de colonnes de la grille (−/+) et largeur du panneau lecteur
// (poignée glissable, cf. `usePanelResize` pour les gestes).
// `cols` et `playerOpen` vivent dans le store : le panneau Paramètres du module les règle AUSSI, et
// deux composants qui écriraient la même clé chacun de leur côté se désynchroniseraient. La largeur
// du panneau reste locale — elle s'écrit à chaque frame de glissé, aucun autre écran ne la touche.
export function usePanelLayout(): PanelLayout {
  const cols = useApp((s) => s.cutCols);
  const setColsStore = useApp((s) => s.setCutCols);
  const playerOpen = useApp((s) => s.cutPlayerOpen);
  const setPlayerOpenStore = useApp((s) => s.setCutPlayerOpen);

  // Enveloppes compatibles `Dispatch<SetStateAction<T>>` → les appelants gardent leurs mises à jour
  // fonctionnelles (`setCols((c) => c + 1)`) sans rien changer.
  const setCols = useCallback<React.Dispatch<React.SetStateAction<number>>>(
    (v) => setColsStore(typeof v === "function" ? v(useApp.getState().cutCols) : v),
    [setColsStore],
  );
  const setPlayerOpen = useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
    (v) => setPlayerOpenStore(typeof v === "function" ? v(useApp.getState().cutPlayerOpen) : v),
    [setPlayerOpenStore],
  );

  const resize = usePanelResize({
    storageKey: "nr.panelW",
    min: PANEL_MIN,
    max: PANEL_MAX,
    open: playerOpen,
    setOpen: setPlayerOpen,
  });

  return { ...resize, cols, setCols, playerOpen, setPlayerOpen };
}
