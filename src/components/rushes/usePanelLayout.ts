import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useApp } from "@/store";

interface PanelLayout {
  cols: number;
  setCols: React.Dispatch<React.SetStateAction<number>>;
  panelW: number;
  setPanelW: React.Dispatch<React.SetStateAction<number>>;
  panelRef: RefObject<HTMLElement | null>;
  resizingRef: RefObject<boolean>;
  startPanelDrag: (e: ReactPointerEvent<HTMLElement>) => void;
  // Lecteur de droite affiché ou masqué (persisté) : permet de dégager toute la largeur pour la
  // grille de vignettes (utile en fenêtre étroite / épinglée dans un coin).
  playerOpen: boolean;
  setPlayerOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

// Mise en page persistée : nombre de colonnes de la grille (−/+) et largeur du panneau lecteur
// (poignée glissable).
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

  const [panelW, setPanelW] = useState<number>(() => {
    const v = parseInt(localStorage.getItem("nr.panelW") || "", 10);
    return Number.isFinite(v) && v >= 240 && v <= 600 ? v : 360;
  });
  useEffect(() => { localStorage.setItem("nr.panelW", String(panelW)); }, [panelW]);

  const panelRef = useRef<HTMLElement>(null);
  const resizingRef = useRef(false);
  const dragRef = useRef<{ x: number; w: number; next: number; raf: number | null } | null>(null);
  function startPanelDrag(e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    if (!panelRef.current) return;
    dragRef.current = { x: e.clientX, w: panelW, next: panelW, raf: null };
    resizingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (ev: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      d.next = Math.min(560, Math.max(260, d.w + (d.x - ev.clientX)));
      if (d.raf != null) return;
      d.raf = requestAnimationFrame(() => {
        const current = dragRef.current;
        if (!current) return;
        current.raf = null;
        // Mise à jour DOM directe : le flex et la grille CSS suivent en temps réel, sans rendre à
        // nouveau CutStudio et toutes ses cartes React à chaque pixel.
        if (panelRef.current) panelRef.current.style.width = `${current.next}px`;
      });
    };
    const onUp = () => {
      const d = dragRef.current;
      if (d?.raf != null) cancelAnimationFrame(d.raf);
      dragRef.current = null;
      resizingRef.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (d) {
        // Un seul rendu final resynchronise les mesures, le plafond vidéo et la persistance.
        if (panelRef.current) panelRef.current.style.width = `${d.next}px`;
        setPanelW(d.next); // un seul rendu + une seule persistance au relâchement
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    e.preventDefault();
  }

  return { cols, setCols, panelW, setPanelW, panelRef, resizingRef, startPanelDrag, playerOpen, setPlayerOpen };
}
