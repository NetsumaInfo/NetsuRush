// Alignement / répartition / mise en grille d'une SÉLECTION d'items (panneau d'arrangement).
// Logique PURE et testable : prend la liste des items sélectionnés + un mode, renvoie une Map
// id → nouvelle position {x?, y?}. Le store (useReferenceBoard.arrange) applique cette map à `items`
// et empile l'historique. Aucun accès au store ici.

import type { BoardItem } from "./referenceShared";

export type ArrangeMode =
  | "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom"
  | "hdist" | "vdist" | "grid";

// Position cible (partielle : seul l'axe concerné par le mode est touché).
export type ArrangePos = { x?: number; y?: number };

// Sous-ensemble géométrique nécessaire (compatible BoardItem).
type Box = Pick<BoardItem, "id" | "x" | "y" | "w" | "h">;

// Calcule les nouvelles positions des items sélectionnés selon le mode. <2 items → map vide
// (rien à aligner). Mêmes formules qu'avant l'extraction (déplacement strict, pas de refonte).
export function computeArrange(sel: Box[], mode: ArrangeMode): Map<string, ArrangePos> {
  const pos = new Map<string, ArrangePos>();
  if (sel.length < 2) return pos;

  const minX = Math.min(...sel.map((i) => i.x));
  const maxX = Math.max(...sel.map((i) => i.x + i.w));
  const minY = Math.min(...sel.map((i) => i.y));
  const maxY = Math.max(...sel.map((i) => i.y + i.h));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  if (mode === "left") sel.forEach((i) => pos.set(i.id, { x: minX }));
  else if (mode === "right") sel.forEach((i) => pos.set(i.id, { x: maxX - i.w }));
  else if (mode === "hcenter") sel.forEach((i) => pos.set(i.id, { x: cx - i.w / 2 }));
  else if (mode === "top") sel.forEach((i) => pos.set(i.id, { y: minY }));
  else if (mode === "bottom") sel.forEach((i) => pos.set(i.id, { y: maxY - i.h }));
  else if (mode === "vcenter") sel.forEach((i) => pos.set(i.id, { y: cy - i.h / 2 }));
  else if (mode === "hdist") {
    const sorted = [...sel].sort((a, b) => a.x - b.x);
    const gap = (maxX - minX - sorted.reduce((t, i) => t + i.w, 0)) / (sorted.length - 1);
    let x = minX;
    sorted.forEach((i) => { pos.set(i.id, { x }); x += i.w + gap; });
  } else if (mode === "vdist") {
    const sorted = [...sel].sort((a, b) => a.y - b.y);
    const gap = (maxY - minY - sorted.reduce((t, i) => t + i.h, 0)) / (sorted.length - 1);
    let y = minY;
    sorted.forEach((i) => { pos.set(i.id, { y }); y += i.h + gap; });
  } else if (mode === "grid") {
    const sorted = [...sel].sort((a, b) => a.y - b.y || a.x - b.x);
    const cols = Math.ceil(Math.sqrt(sorted.length));
    const cellW = Math.max(...sel.map((i) => i.w)) + 16;
    const cellH = Math.max(...sel.map((i) => i.h)) + 16;
    sorted.forEach((i, k) => pos.set(i.id, {
      x: minX + (k % cols) * cellW,
      y: minY + Math.floor(k / cols) * cellH,
    }));
  }
  return pos;
}
