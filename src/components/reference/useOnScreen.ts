// Visibilité RÉELLE à l'écran d'un élément monté. La zone de culling couvre jusqu'à 6× l'aire du
// viewport : ce qui y est monté n'est pas forcément visible, et une vidéo qui joue hors champ décode
// pour personne — pire, une boucle aller-retour y fait 15 seeks par seconde. IntersectionObserver
// natif, un observateur par élément : le navigateur calcule l'intersection lui-même, transforms
// comprises, sans jamais forcer de layout côté JS.

import { useEffect, useState, type RefObject } from "react";

export function useOnScreen(ref: RefObject<Element | null>): boolean {
  // Visible par défaut : un média fraîchement monté démarre sans attendre la première mesure.
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([e]) => setOn(e.isIntersecting),
      // Marge d'avance : la lecture reprend juste AVANT d'entrer à l'écran, pour ne pas voir la
      // première frame figée le temps du play().
      { rootMargin: "128px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}
