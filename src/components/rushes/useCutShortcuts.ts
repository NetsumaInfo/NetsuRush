import { useEffect, useRef } from "react";
import { useApp } from "@/store";
import { isTyping, matchAction } from "@/lib/shortcuts";
import type { CutShortcutAction } from "./cutShortcuts";

// Touches que les cartes de plan gèrent elles-mêmes quand elles ont le focus (cf. SceneCard) :
// sélection au clavier et lecture. Sans cette garde, une carte focalisée déclencherait À LA FOIS son
// action locale et le raccourci global (Espace = sélection ET lecture/pause).
const CARD_OWNED = new Set([" ", "Enter", "p", "P"]);

// Raccourcis-commandes de NetsuCut. Miroir de `useBoardShortcuts` : écouteur unique sur window,
// inerte pendant la frappe, appariement combo → action via les touches persistées (`cutKeys`).
// Une action absente de `actions` est simplement inerte (ex. envoi timeline hors connexion) : c'est
// l'appelant qui décide de ce qui est disponible, pas le hook.
export function useCutShortcuts(
  actions: Partial<Record<CutShortcutAction, () => void>>,
  opts?: { frameStep?: (d: number) => void },
) {
  const cutKeys = useApp((s) => s.cutKeys);
  // Les actions se referment sur l'état du rendu courant → l'objet est neuf à chaque rendu. On le lit
  // via une ref pour que l'écouteur ne se ré-abonne QUE sur changement de raccourcis, tout en
  // appelant toujours la dernière version.
  const latest = useRef({ actions, opts });
  useEffect(() => { latest.current = { actions, opts }; });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(document.activeElement)) return;
      if (CARD_OWNED.has(e.key) && document.activeElement?.closest("[data-scene-card]")) return;
      const { actions: acts, opts: o } = latest.current;

      // Geste NON rebindable, testé AVANT l'appariement (même place que le nudge du board) :
      // les flèches nues naviguent entre les PLANS, Maj+flèches garde le pas à l'IMAGE.
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        if (!o?.frameStep) return;
        e.preventDefault();
        o.frameStep(e.key === "ArrowLeft" ? -1 / 24 : 1 / 24);
        return;
      }

      const action = matchAction(cutKeys, e) as CutShortcutAction | undefined;
      if (!action) return;
      const run = acts[action];
      if (!run) return;
      // Échap sert aussi ailleurs (fermeture de dialogues) → on ne le consomme pas.
      if (action !== "deselect") e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cutKeys]);
}
