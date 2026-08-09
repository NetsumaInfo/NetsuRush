// Observateurs de proximité d'écran PARTAGÉS par toutes les grilles d'aperçus.
//
// Chaque carte demandait ses PROPRES IntersectionObserver (vignette / proxy / visibilité stricte).
// Un rush de 1400 plans montait donc ~4200 observateurs, que le compositeur doit tous recalculer et
// dont chaque callback est distribué séparément : c'est ce qui rendait le défilement saccadé alors
// même que les médias étaient en cache. Ici, un SEUL observateur par marge sert toutes les cartes ;
// la distribution passe par une table élément → callback.
//
// La marge est un nombre de PIXELS, quantifié (QUANTUM_PX) avant de choisir le groupe : les marges
// dérivées de la hauteur de cellule varient d'un pixel à l'autre au redimensionnement, et une marge
// non quantifiée recréerait un observateur par valeur — exactement ce qu'on cherche à éviter.

type ViewportCallback = (intersecting: boolean) => void;

// Un élément peut porter PLUSIEURS abonnés sous la même marge (deux composants qui observent la même
// carte) : la table garde un ensemble par élément, sinon le second abonnement écraserait le premier
// et le premier désabonnement couperait les deux.
interface ObserverGroup {
  observer: IntersectionObserver;
  callbacks: Map<Element, Set<ViewportCallback>>;
}

const QUANTUM_PX = 100;
const groups = new Map<number, ObserverGroup>();

function quantize(marginPx: number): number {
  const px = Number.isFinite(marginPx) ? Math.max(0, marginPx) : 0;
  return Math.round(px / QUANTUM_PX) * QUANTUM_PX;
}

function groupFor(margin: number): ObserverGroup {
  const existing = groups.get(margin);
  if (existing) return existing;
  const callbacks = new Map<Element, Set<ViewportCallback>>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const subscribers = callbacks.get(entry.target);
        if (subscribers) for (const notify of subscribers) notify(entry.isIntersecting);
      }
    },
    { rootMargin: `${margin}px`, threshold: 0 },
  );
  const group: ObserverGroup = { observer, callbacks };
  groups.set(margin, group);
  return group;
}

// Observe `element` avec la marge donnée (px) et rend la fonction de désabonnement. Un élément peut
// être observé sous PLUSIEURS marges (bandes vignette / proxy / visibilité stricte) : ce sont des
// groupes distincts, donc des observateurs distincts, un par marge et non un par carte.
export function observeViewport(element: Element, marginPx: number, callback: ViewportCallback): () => void {
  const margin = quantize(marginPx);
  const group = groupFor(margin);
  const subscribers = group.callbacks.get(element) ?? new Set<ViewportCallback>();
  subscribers.add(callback);
  group.callbacks.set(element, subscribers);
  group.observer.observe(element);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = groups.get(margin);
    const remaining = current?.callbacks.get(element);
    if (!current || !remaining) return;
    remaining.delete(callback);
    if (remaining.size) return;                 // un autre abonné observe encore cet élément
    current.callbacks.delete(element);
    current.observer.unobserve(element);
    if (!current.callbacks.size) {
      current.observer.disconnect();
      groups.delete(margin);
    }
  };
}
