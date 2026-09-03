// Arbitre GLOBAL du survol des vignettes : UNE SEULE carte peut être « sous le pointeur » à la fois,
// dans toute l'app (grille de plans, collections, résultats de recherche, sélecteur de médias).
//
// `mouseleave` n'est pas fiable pour ça. Deux cas mesurés laissaient des aperçus en lecture derrière
// le pointeur :
//   1. le DÉFILEMENT — la molette fait glisser les cartes sous un pointeur immobile ; Chromium
//      n'émet ses événements de frontière qu'au mouvement suivant, donc la carte quittée reste
//      « survolée » indéfiniment ;
//   2. le RE-RENDU de l'habillage — la carte monte/démonte ses boutons et racines Base UI au survol ;
//      quand l'élément sous le curseur disparaît, la sortie n'est jamais notifiée.
// Résultat : plusieurs <video> jouaient en fond, avec du son, alors que la souris était ailleurs.
//
// D'où deux garde-fous complémentaires : une carte qui prend le survol RELÂCHE celle d'avant, et un
// contrôle géométrique (rectangle vs dernière position connue du pointeur) relâche la carte courante
// dès qu'elle n'est plus sous le curseur — au mouvement comme au défilement.

interface HoverClaim {
  el: HTMLElement | null;
  release: () => void;
}

let claim: HoverClaim | null = null;
let px = -1;
let py = -1;
let raf = 0;
let bound = false;

function drop() {
  const current = claim;
  claim = null;
  current?.release();
}

// La carte courante est-elle encore sous le pointeur ? Une boîte vide = carte démontée ou repliée
// par `content-visibility` → elle ne peut plus être survolée.
function stale(): boolean {
  if (!claim?.el) return false;
  if (px < 0) return false;   // aucune position connue (survol pris au clavier / au montage)
  const r = claim.el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return true;
  return px < r.left || px >= r.right || py < r.top || py >= r.bottom;
}

// Coalescé en rAF : le contrôle lit une géométrie, on ne le fait donc qu'une fois par image, jamais
// à chaque `pointermove` ou `scroll` (ils arrivent par paquets pendant un défilement).
function schedule() {
  if (!claim || raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (stale()) drop();
  });
}

function onPointer(e: PointerEvent) {
  px = e.clientX;
  py = e.clientY;
  schedule();
}

function onHidden() {
  if (document.hidden) drop();
}

// Le pointeur sort de la FENÊTRE. `relatedTarget` nul = il ne va sur aucun élément du document,
// donc il a quitté la page. C'est le seul signal fiable quand la souris part vers une autre
// application sans clic : la fenêtre garde le focus (pas de `blur` sous WebView2), plus aucun
// `pointermove` n'arrive, et le contrôle géométrique ne peut donc plus rien relâcher — la carte
// quittée restait en lecture, avec son son.
function onOut(e: PointerEvent | MouseEvent) {
  if (!e.relatedTarget) drop();
}

function bind() {
  if (bound || typeof window === "undefined") return;
  bound = true;
  window.addEventListener("pointermove", onPointer, { passive: true, capture: true });
  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  // Le pointeur quitte la fenêtre (ou l'app perd le focus) : plus rien n'est survolé.
  window.addEventListener("blur", drop);
  window.addEventListener("pointerout", onOut, { passive: true, capture: true });
  window.addEventListener("mouseout", onOut, { passive: true, capture: true });   // souris sans PointerEvent
  document.documentElement.addEventListener("pointerleave", drop);
  document.addEventListener("visibilitychange", onHidden);
}

/** Déclare que `el` est la carte survolée. Relâche la précédente. Renvoie de quoi rendre le survol
 *  (à appeler sur `mouseleave` ET au démontage — sinon une carte démontée garderait le jeton). */
export function claimHoverPreview(el: HTMLElement | null, release: () => void): () => void {
  bind();
  if (claim && claim.release !== release) drop();
  claim = { el, release };
  return () => { if (claim?.release === release) claim = null; };
}
