// Raccourcis globaux du board (partagés entre la page onglet et la fenêtre détachée). Liste de
// référence (aussi affichée dans Paramètres ▸ Raccourcis) :
//   Copier (Ctrl/⌘+C) · Couper (Ctrl/⌘+X) · Coller (Ctrl/⌘+V) · Supprimer la sélection (Suppr) ·
//   Désélectionner (Échap) · Tout sélectionner (Ctrl/⌘+A) · Dupliquer (Ctrl/⌘+D) ·
//   Supprimer marche AUSSI avec Retour arrière, hors de toute liaison configurable ·
//   Annuler (Ctrl/⌘+Z) · Rétablir (Ctrl/⌘+Maj+Z) · Enregistrer (Ctrl/⌘+S) ·
//   Enregistrer sous (Ctrl/⌘+Maj+S) · Ouvrir un projet (Ctrl/⌘+O) ·
//   Déplacer la sélection (Flèches, Maj = ×10) · Tout cadrer (Ctrl/⌘+0) ·
//   Cadrer la sélection (Maj+F) · Zoom (Ctrl/⌘+= / Ctrl/⌘+-, ou molette) ·
//   Même hauteur (Maj+H) · Même largeur (Maj+W) · Même surface (Maj+S) · Ranger (Maj+O) ·
//   Tout réinitialiser (R) · Extraire la palette (G) · Premier plan (Pg↑) · Arrière-plan (Pg↓) ·
//   Pan : Espace+glissé ou clic-milieu · Aimant : Alt = désactivé le temps du geste.

import { useEffect } from "react";
import i18n from "@/i18n";
import { useBoard } from "./useReferenceBoard";
import { shifted } from "./drawGeometry";
import { isTyping, comboFromEvent } from "@/lib/shortcuts";
import { uid, SHORTCUT_DEFS } from "./referenceShared";
import { extractPaletteToBoard } from "./boardPaletteActions";
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
      // Le presse-papiers SYSTÈME gagne quand il porte un média (on vient de copier une image dans un
      // navigateur) ; sinon on colle le presse-papiers INTERNE, qui lui garde toute une sélection.
      const hasMedia = Array.from(e.clipboardData.items ?? []).some((it) => it.type.startsWith("image/") || it.type.startsWith("video/"))
        || (e.clipboardData.files?.length ?? 0) > 0;
      if (!hasMedia && useBoard.getState().clipCount) {
        e.preventDefault();
        const n = boardRef.current?.pasteItems() ?? 0;
        if (n) useBoard.getState().setNotice({ kind: "ok", text: i18n.t("reference:board.pastedItems", { count: n }) });
        return;
      }
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
      // En mode dessin, les LETTRES NUES appartiennent aux outils (stylo, gomme…) : on ne leur vole
      // pas la touche. Les combos avec modificateur (Ctrl+Z, Ctrl+S…) restent actifs partout.
      if (st.drawMode && !(e.ctrlKey || e.metaKey || e.altKey) && combo.length === 1) return;
      // Ordre de résolution FIXE (celui de la liste de référence) : si deux actions se retrouvent sur
      // le même combo — un rebind maladroit dans les Paramètres — c'est toujours la même qui gagne,
      // et jamais l'ordre d'insertion d'un objet enregistré au fil du temps.
      let action = SHORTCUT_DEFS.map((d) => d.action).find((a) => keys[a] === combo);
      // Filet de sécurité NON rebindable : Retour arrière supprime aussi. Supprimer sa sélection ne
      // doit jamais dépendre d'un réglage — c'est le geste le plus fréquent du board.
      if (!action && (e.key === "Backspace" || e.key === "Delete")) action = "delete";
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
        case "fitSelection":
          e.preventDefault();
          boardRef.current?.fitSelection();
          break;
        case "copy":
          if (!st.selectedIds.length) break;
          e.preventDefault();
          void boardRef.current?.copySelection(false);
          break;
        case "cut":
          if (!st.selectedIds.length) break;
          e.preventDefault();
          void boardRef.current?.copySelection(true);
          break;
        case "extractPalette":
          e.preventDefault();
          void extractPaletteToBoard();
          break;
        case "resetAll":
          if (!st.selectedIds.length) break;
          e.preventDefault();
          st.reset("all");
          break;
        case "normalizeHeight":
          e.preventDefault();
          st.normalize("height");
          break;
        case "normalizeWidth":
          e.preventDefault();
          st.normalize("width");
          break;
        case "normalizeArea":
          e.preventDefault();
          st.normalize("area");
          break;
        case "arrangeDefault": {
          e.preventDefault();
          const p = st.prefs;
          st.tidy({ layout: p.arrangeLayout, uniform: p.arrangeUniform, gap: p.arrangeGap, sort: p.arrangeSort });
          break;
        }
        case "toFront":
          if (!st.selectedIds.length) break;
          e.preventDefault();
          st.bringSelectedToFront();
          break;
        case "toBack":
          if (!st.selectedIds.length) break;
          e.preventDefault();
          st.sendSelectedToBack();
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
