// Repérage dans un FLUX de rushs : où l'on est, et comment y sauter.
//
// La grille d'un flux est une grille ordinaire — mêmes colonnes, mêmes cartes, un seul défilement,
// aucun séparateur qui coupe le rythme. Le prix de cette continuité, c'est qu'on ne voit plus la
// frontière entre deux rushs : ce module la calcule à partir du seul défilement, pour que l'entête
// puisse dire de quel rush viennent les vignettes qu'on a sous les yeux et pour qu'un saut direct
// reste possible.
//
// Tout se déduit de la géométrie déjà connue (nombre de colonnes, hauteur de rangée) : pas
// d'observateur par carte, rien à mesurer dans le DOM, donc rien qui puisse gêner le défilement.

import { useEffect, useState } from "react";
import type { Segment } from "./cutStudioShared";

const GRID_GAP = 12;   // gap-3, comme gridContainerStyle

/** Rang du premier plan de chaque rush dans la grille aplatie, + le total en dernière position. */
export function flowOffsets(segments: Segment[], paths: string[]): number[] {
  const counts = new Map<string, number>();
  for (const s of segments) {
    const p = s.path ?? paths[0] ?? "";
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const offsets: number[] = [];
  let acc = 0;
  for (const path of paths) {
    offsets.push(acc);
    acc += counts.get(path) ?? 0;
  }
  offsets.push(acc);
  return offsets;
}

/** Rush auquel appartient le plan de rang `index`. Rend 0 si le flux est vide. */
export function flowIndexOfShot(offsets: number[], index: number): number {
  for (let i = offsets.length - 2; i >= 0; i--) if (index >= offsets[i]) return i;
  return 0;
}

/** Hauteur d'une rangée de la grille, gouttière comprise. */
export const rowHeight = (cell: number) => (cell * 9) / 16 + GRID_GAP;

// `cell` vaut 0 tant que la largeur de la grille n'est pas mesurée. Sans ce garde-fou, la seule
// gouttière ferait office de hauteur de rangée : le repérage annoncerait des rangées de 12 px et
// désignerait le mauvais rush pendant la frame qui précède la mesure.
const measured = (cell: number, cols: number) => cell > 0 && cols > 0;

/** Rang du premier plan de la rangée affichée en haut de la zone défilante. */
export function firstVisibleShot(scrollTop: number, cell: number, cols: number): number {
  if (!measured(cell, cols)) return 0;
  return Math.max(0, Math.floor(scrollTop / rowHeight(cell)) * cols);
}

/** Position de défilement qui amène le premier plan d'un rush en haut de la zone. */
export function scrollOffsetOfShot(index: number, cell: number, cols: number): number {
  if (!measured(cell, cols)) return 0;
  return Math.floor(index / cols) * rowHeight(cell);
}

// Rush en cours de lecture visuelle : suit le défilement. L'état ne change que quand on FRANCHIT une
// frontière de rush — défiler à l'intérieur d'un même rush ne déclenche donc aucun rendu.
//
// La lecture est calée sur la FRAME, pas sur l'événement : un défilement à la molette en émet des
// dizaines par frame, et chacun lit `scrollTop` (une mesure de layout). Une seule par frame suffit,
// puisque rien n'est peint entre-temps.
export function useFlowPosition(
  el: HTMLElement | null,
  offsets: number[],
  cell: number,
  cols: number,
  enabled: boolean,
): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!el || !enabled) { setIndex(0); return; }
    let frame: number | null = null;
    const read = () => {
      frame = null;
      setIndex(flowIndexOfShot(offsets, firstVisibleShot(el.scrollTop, cell, cols)));
    };
    const onScroll = () => { if (frame == null) frame = requestAnimationFrame(read); };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [el, offsets, cell, cols, enabled]);
  return index;
}
