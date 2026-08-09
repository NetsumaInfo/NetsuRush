// Raccourcis globaux du board (partagés entre la page onglet et la fenêtre détachée). Liste de
// référence (aussi affichée dans Paramètres ▸ Raccourcis) :
//   Coller (Ctrl/⌘+V) · Supprimer la sélection (Suppr/Retour) · Désélectionner (Échap) ·
//   Tout sélectionner (Ctrl/⌘+A) · Dupliquer (Ctrl/⌘+D) · Annuler (Ctrl/⌘+Z) ·
//   Rétablir (Ctrl/⌘+Maj+Z ou Ctrl+Y) · Enregistrer (Ctrl/⌘+S) · Enregistrer sous (Ctrl/⌘+Maj+S) ·
//   Ouvrir un projet (Ctrl/⌘+O) · Déplacer la sélection (Flèches,
//   Maj = ×10) · Tout cadrer (Ctrl/⌘+0) · Zoom (Ctrl/⌘+= / Ctrl/⌘+-, ou molette) ·
//   Pan : Espace+glissé ou clic-milieu.

import { useEffect } from "react";
import i18n from "@/i18n";
import { useBoard } from "./useReferenceBoard";
import { shifted } from "./drawGeometry";
import { isTyping, comboFromEvent } from "@/lib/shortcuts";
import { uid, type ShortcutAction } from "./referenceShared";
import type { BoardHandle } from "./ReferenceBoard";

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

export function useBoardShortcuts(
  boardRef: React.RefObject<BoardHandle | null>,
  actions: { onSave?: () => void; onSaveAs?: () => void; onOpenProject?: () => void } = {},
) {
  const { onSave, onSaveAs, onOpenProject } = actions;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(document.activeElement) || !e.clipboardData) return;
      // Rien d'exploitable (presse-papiers vide, lien irrésoluble) → feedback au lieu du silence.
      void boardRef.current?.addPaste(e.clipboardData).then((ok) => {
        if (ok === false) useBoard.getState().setNotice({ kind: "error", text: i18n.t("reference:board.clipboardEmptyLink") });
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(document.activeElement)) return;
      const st = useBoard.getState();

      // Nudge (flèches) — directionnel, non rebindable. Pas ÷ scale = pixels ÉCRAN constants quel que
      // soit le zoom ; touche maintenue = 1 entrée d'undo (tag).
      if (!(e.ctrlKey || e.metaKey) && ARROWS[e.key]) {
        const step = (e.shiftKey ? 10 : 1) / st.view.scale;
        const [dx, dy] = ARROWS[e.key];
        if (st.drawSel) {
          e.preventDefault();
          const shapes = st.items.find((i) => i.kind === "draw")?.shapes ?? [];
          st.drawSetShapes(shapes.map((s) => (s.id === st.drawSel ? shifted(s, dx * step, dy * step) : s)), true, `nudge-shape:${st.drawSel}`);
          return;
        }
        if (!st.selectedIds.length) return;
        e.preventDefault();
        st.moveBy(st.selectedIds, dx * step, dy * step, true, `nudge:${st.selectedIds.join(",")}`);
        return;
      }

      // Raccourcis-commandes REBINDABLES : combo courant → action (via prefs.shortcutKeys).
      const keys = st.prefs.shortcutKeys;
      const combo = comboFromEvent(e);
      const action = (Object.keys(keys) as ShortcutAction[]).find((a) => keys[a] === combo);
      if (!action) return;

      switch (action) {
        case "delete":
          if (st.drawSel) {
            e.preventDefault();
            st.drawSetShapes((st.items.find((i) => i.kind === "draw")?.shapes ?? []).filter((s) => s.id !== st.drawSel));
            st.selectDrawShape(null);
          } else if (st.selectedIds.length) {
            e.preventDefault();
            st.removeSelected();
          }
          break;
        case "deselect":
          st.select(null); // pas de preventDefault (Échap sert aussi ailleurs)
          break;
        case "selectAll":
          e.preventDefault();
          st.selectAll();
          break;
        case "duplicate":
          e.preventDefault();
          if (st.drawSel) {
            // Duplique la forme de dessin sélectionnée (décalée de ~16px écran).
            const shapes = st.items.find((i) => i.kind === "draw")?.shapes ?? [];
            const src = shapes.find((s) => s.id === st.drawSel);
            if (src) {
              const off = 16 / st.view.scale;
              const copy = { ...shifted(src, off, off), id: uid() };
              st.drawSetShapes([...shapes, copy]);
              st.selectDrawShape(copy.id);
            }
          } else {
            // Duplication multi : les appels du même tick partagent un snapshot → 1 entrée d'undo.
            st.selectedIds.forEach((id) => st.duplicateItem(id));
          }
          break;
        case "undo":
          // Annuler — historique UNIFIÉ (tout le contenu du board : médias, texte, cadres, dessin).
          e.preventDefault();
          st.undo();
          break;
        case "redo":
          e.preventDefault();
          st.redo();
          break;
        case "save":
          e.preventDefault();
          onSave?.();
          break;
        case "saveAs":
          e.preventDefault();
          onSaveAs?.();
          break;
        case "openProject":
          e.preventDefault();
          onOpenProject?.();
          break;
        case "fit":
          e.preventDefault();
          boardRef.current?.fit();
          break;
        case "zoomIn":
          e.preventDefault();
          boardRef.current?.zoomBy(1.25);
          break;
        case "zoomOut":
          e.preventDefault();
          boardRef.current?.zoomBy(0.8);
          break;
      }
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey);
    };
  }, [boardRef, onSave, onSaveAs, onOpenProject]);
}
