// Niveau de détail des VIDÉOS et SÉQUENCES du board.
//
// Un <video> décode à la résolution SOURCE quelle que soit sa taille affichée : à la vue d'ensemble,
// des dizaines de décodeurs tournaient à plein régime pour des cases de quelques dizaines de pixels.
// Une séquence, elle, échange son <img> à chaque frame — même gaspillage à la même échelle.
//
// Le critère est en pixels ÉCRAN, comme boardImageLod : un item minuscule à l'écran passe en mode
// TIMBRE-POSTE — la frame d'affiche (vignette du core) remplace le lecteur vidéo, et une séquence se
// fige sur sa frame courante. Bande morte d'une octave (entrée 96 / sortie 192), soit exactement le
// pas du zoom quantifié : jamais deux bascules dans le même mouvement de molette. L'échange vers
// l'affiche n'est fait qu'une fois celle-ci DÉCODÉE — jamais de case vide (cf. boardImageLod).
//
// À l'échange inverse (retour au lecteur), le <video> porte l'affiche en `poster` natif : la frame
// fixe reste peinte jusqu'à la première frame décodée, donc pas de flash noir non plus.

import { useEffect, useState } from "react";
import { useBoard } from "./useReferenceBoard";
import { isRemoteRef, type BoardItem } from "./referenceShared";
import { preload, thumbFor, zoomCeil } from "./boardImageLod";

// Bande morte du mode timbre-poste, en hauteur ÉCRAN. À 96 px, le mouvement d'une vidéo est un
// détail ; l'affiche du core (360 px de haut au cran le plus bas) reste suréchantillonnée.
export const STILL_ENTER_SCREEN_H = 96;
export const STILL_LEAVE_SCREEN_H = 192;

/** L'item est-il assez petit à l'écran pour se figer ? `onStill` = état courant (bande morte). */
export function stillSized(item: BoardItem, zoom: number, onStill: boolean): boolean {
  const h = item.h * zoom;
  return h > 0 && h <= (onStill ? STILL_LEAVE_SCREEN_H : STILL_ENTER_SCREEN_H);
}

/** Instant de la frame d'affiche : le début du cut pour une vidéo trimée, sinon la première frame. */
export function posterTime(item: BoardItem): number {
  return item.trimIn && item.trimIn > 0 ? item.trimIn : 0;
}

/** Une vidéo LOCALE lisible peut être remplacée par son affiche ; un flux relayé ou distant, non. */
export function videoLodEligible(item: BoardItem, zoom: number, onStill: boolean): boolean {
  return item.kind === "video"
    && !!item.ref
    && !isRemoteRef(item.ref)
    && !item.loading
    && !item.missing
    && stillSized(item, zoom, onStill);
}

/**
 * Affiche (frame fixe) à montrer À LA PLACE du lecteur vidéo quand l'item est minuscule à l'écran.
 * null = lecteur normal. Tant que l'affiche n'est pas résolue ET décodée, le lecteur reste en place :
 * l'échange est invisible ou n'a pas lieu.
 */
export function useVideoStill(item: BoardItem): string | null {
  const zoom = useBoard((s) => zoomCeil(s.view.scale));
  const [still, setStill] = useState<string | null>(null);

  const wants = videoLodEligible(item, zoom, still != null);
  const time = posterTime(item);

  useEffect(() => {
    if (!wants) { setStill(null); return; }
    let alive = true;
    void thumbFor(item.ref, time).then((src) => {
      if (!src || !alive) return;
      void preload(src).then((ok) => { if (alive && ok) setStill(src); });
    });
    return () => { alive = false; };
  }, [wants, item.ref, time]);

  return still;
}
