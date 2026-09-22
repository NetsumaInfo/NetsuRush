import { useEffect, useRef, type RefObject } from "react";

// Ferme un panneau flottant non modal quand on clique ailleurs.
//
// Ces panneaux (Paramètres NetsuCut, Paramètres du board) n'ont pas de voile : sans cette écoute,
// seuls la croix et Échap les ferment, alors que cliquer à côté est le geste attendu.
//
// Deux zones ne comptent PAS comme « ailleurs » :
//   - les popups Base UI (select, menu, tooltip) : ils sont dans un portail au niveau du body, donc
//     hors du panneau dans le DOM alors qu'ils lui appartiennent ;
//   - le bouton qui ouvre le panneau (`data-settings-toggle`) : sinon la fermeture au pointerdown
//     et le toggle au click se neutralisent, et le panneau ne se fermerait jamais par son bouton.
//
// Écoute en capture sur `pointerdown` : le panneau part avant que le clic ne s'applique dessous.
export function useOutsideDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
) {
  // Le rappel est souvent une lambda inline : on le garde dans une ref pour ne pas réabonner
  // l'écoute à chaque rendu.
  const cb = useRef(onDismiss);
  cb.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element) || !target.isConnected) return;
      const el = ref.current;
      if (el && el.contains(target)) return;
      if (target.closest("[data-base-ui-portal],[data-settings-toggle]")) return;
      cb.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [ref, open]);
}
