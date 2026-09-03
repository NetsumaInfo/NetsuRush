// Soulèvement au survol des cartes, SANS déplacer la zone de survol.
//
// Le piège : porter `hover:-translate-y-0.5` sur l'élément qui REÇOIT le survol crée une boucle.
// Le pointeur entre par le bas de la carte, elle monte de 2 px, son bord bas repasse au-dessus du
// pointeur, le survol tombe, elle redescend sous le pointeur, elle remonte… La carte vibre, et sur
// une vignette d'aperçu la <video> démarre et s'arrête en boucle.
//
// Le remède : deux éléments. Une COQUILLE immobile qui porte le survol (`group`, la taille, les
// gestionnaires, le focus) et une COUCHE VISUELLE qui, elle, se soulève — bordure, fond, coins,
// débordement et contenu. Un transform ne change pas la mise en page : la coquille garde sa boîte,
// donc le pointeur ne la quitte jamais.
//
// Ne JAMAIS remettre un `hover:-translate-y-*` sur une cible de survol : c'est ce bug-là.

import { cn } from "@/lib/utils";

/** Couche visuelle d'une carte de grille (coquille en `aspect-video`, taille déjà posée). */
export function hoverLiftLayer(...extra: (string | false | null | undefined)[]): string {
  return cn(
    "absolute inset-0 transition-transform group-hover:-translate-y-0.5 motion-reduce:transform-none",
    ...extra,
  );
}

/** Couche visuelle d'une carte dont la HAUTEUR vient de son contenu (coquille en flux). */
export function hoverLiftFlow(...extra: (string | false | null | undefined)[]): string {
  return cn(
    "transition-transform group-hover:-translate-y-0.5 motion-reduce:transform-none",
    ...extra,
  );
}
