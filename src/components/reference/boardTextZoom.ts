// Lisibilité du texte au dézoom. La taille de police d'une note vit en unités MONDE : à l'échelle
// 0,05 une note de 28 px n'occupe plus qu'un pixel et demi à l'écran — la planche devient un damier
// de traits gris. On agrandit donc la police À L'AFFICHAGE quand le board est dézoomé, jusqu'à ce que
// le texte retrouve une taille écran minimale, et pas plus : le facteur est plafonné, si bien qu'au
// dézoom extrême le texte redevient minuscule (c'est attendu — à cette échelle on regarde la
// composition, pas les mots). Rien n'est écrit dans le document : c'est un effet de VUE, l'export et
// le fichier gardent la taille choisie.

import type { BoardItem } from "./referenceShared";

// Taille écran (px CSS) visée au dézoom.
export const TEXT_MIN_SCREEN = 12;
// Agrandissement maximal. Au-delà, le texte déborderait de sa note bien avant d'être lisible.
export const TEXT_MAX_BOOST = 6;
// Largeur moyenne d'un glyphe en fraction du corps (approximation suffisante : elle ne sert qu'à
// estimer combien de lignes le texte occupera une fois grossi).
const CHAR_W = 0.52;
// Marge intérieure d'une note (p-3 de part et d'autre).
const NOTE_PAD = 24;

// Facteur demandé par le ZOOM seul : 1 tant que le texte est déjà assez gros à l'écran, puis de quoi
// revenir à TEXT_MIN_SCREEN, borné par TEXT_MAX_BOOST.
export function zoomTextFactor(fontSize: number, scale: number, maxBoost = TEXT_MAX_BOOST): number {
  const px = Math.max(0.0001, fontSize * scale);
  if (px >= TEXT_MIN_SCREEN) return 1;
  return Math.min(maxBoost, TEXT_MIN_SCREEN / px);
}

// Hauteur estimée du texte à un facteur donné (retour à la ligne compris).
function heightAt(lines: string[], fontSize: number, lineHeight: number, boxW: number, f: number): number {
  const fs = fontSize * f;
  const cpl = Math.max(1, Math.floor(boxW / (fs * CHAR_W)));
  let rows = 0;
  for (const l of lines) rows += Math.max(1, Math.ceil(l.length / cpl));
  return rows * fs * lineHeight;
}

// Facteur maximal qui laisse le texte DANS sa note. Un mot posé dans une grande note peut grossir
// beaucoup ; un paragraphe qui remplit déjà sa boîte ne grossit pas du tout — sinon le dézoom ne
// montrerait plus que ses trois premiers mots, ce qui est moins lisible que rien.
export function textFitFactor(item: BoardItem, maxBoost = TEXT_MAX_BOOST): number {
  const text = item.text ?? "";
  const fontSize = item.fontSize ?? 18;
  if (!text || fontSize <= 0) return maxBoost;
  const boxW = item.w - NOTE_PAD;
  const boxH = item.h - NOTE_PAD;
  if (boxW <= 0 || boxH <= 0) return 1;
  const lines = text.split("\n");
  const lh = item.lineHeight ?? 1.2;
  if (heightAt(lines, fontSize, lh, boxW, maxBoost) <= boxH) return maxBoost;
  // Recherche dichotomique : la hauteur croît avec le facteur, douze passes suffisent au pixel près.
  let lo = 1, hi = maxBoost;
  if (heightAt(lines, fontSize, lh, boxW, lo) > boxH) return 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (heightAt(lines, fontSize, lh, boxW, mid) <= boxH) lo = mid;
    else hi = mid;
  }
  return lo;
}

// Facteur retenu pour une note : le zoom demande, la boîte limite.
export function noteTextFactor(item: BoardItem, scale: number): number {
  const want = zoomTextFactor(item.fontSize ?? 18, scale);
  return want <= 1 ? 1 : Math.max(1, Math.min(want, textFitFactor(item)));
}

// Facteur retenu pour le TITRE d'un cadre : étiquette d'une seule ligne, tronquée par l'affichage —
// on la borne à la largeur du cadre pour qu'un titre grossi ne devienne pas trois points de suspension.
export function frameTitleFactor(item: BoardItem, scale: number, label: string): number {
  const fontSize = item.fontSize ?? 14;
  const want = zoomTextFactor(fontSize, scale);
  if (want <= 1) return 1;
  const boxW = item.w - NOTE_PAD;
  const need = Math.max(1, label.length) * fontSize * CHAR_W;
  const fit = boxW > 0 && need > 0 ? boxW / need : 1;
  return Math.max(1, Math.min(want, fit));
}
