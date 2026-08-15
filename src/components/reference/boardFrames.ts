// Cadres conteneurs : qui est DEDANS, et comment le cadre épouse son contenu.
// L'appartenance a deux étages. Le premier est GÉOMÉTRIQUE : le centre de l'item tombe dans le
// rectangle du cadre. Le second est le LIEN, que l'utilisateur peut couper (`detached`) sans sortir
// l'item du cadre — une image délinéarisée reste posée au même endroit mais le cadre ne l'emmène plus
// et cesse de s'ajuster sur elle. Ce module est la SOURCE UNIQUE des deux tests : geste, ajustement
// automatique, bouton de lien et menu contextuel doivent répondre exactement la même chose.

import { rotatedBBox } from "./boardArrange";
import { MIN_SIZE, type BoardItem, type Geom } from "./referenceShared";

// Marges laissées autour du contenu quand le cadre s'ajuste — les mêmes qu'à la pose d'un cadre
// autour d'une sélection, sinon un cadre ajusté n'aurait pas l'air d'un cadre posé à la main.
export const FRAME_PAD = 28;
export const FRAME_TOP = 52; // place de l'étiquette de titre, posée au-dessus du bord haut

export interface Rect { x: number; y: number; w: number; h: number }

// Un item peut-il vivre dans un cadre ? (un cadre n'entre pas dans un cadre, le calque de dessin
// n'a pas de géométrie propre).
export function framable(it: BoardItem): boolean {
  return it.kind !== "frame" && it.kind !== "draw";
}

function centerInside(f: Rect, cx: number, cy: number): boolean {
  return cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// Emprise (rotation comprise) d'une géométrie.
export function geomBox(g: Geom): Rect {
  const b = rotatedBBox(g);
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}

// Items LIÉS au cadre : centre dedans, lien intact. Ce sont eux que le cadre emmène et sur lesquels
// il s'ajuste.
export function frameContentIds(frame: BoardItem, items: BoardItem[]): string[] {
  return items
    .filter((it) => framable(it) && !it.detached && it.id !== frame.id && centerInside(frame, it.x + it.w / 2, it.y + it.h / 2))
    .map((it) => it.id);
}

// Cadre qui entoure un POINT. Sert aux tracés du calque de dessin, qui ne sont pas des items mais
// qu'un cadre emmène quand même. Cadres imbriqués : le plus petit gagne (c'est celui qu'on voit
// entourer l'élément).
export function frameAtPoint(cx: number, cy: number, items: BoardItem[], skipId?: string): BoardItem | null {
  let best: BoardItem | null = null;
  for (const f of items) {
    if (f.kind !== "frame" || f.id === skipId) continue;
    if (!centerInside(f, cx, cy)) continue;
    if (!best || f.w * f.h < best.w * best.h) best = f;
  }
  return best;
}

// Cadre qui ENTOURE l'item (test géométrique seul : un item délié est toujours « dans » son cadre,
// c'est ce qui permet de proposer de le relier).
export function enclosingFrame(item: BoardItem, items: BoardItem[]): BoardItem | null {
  if (!framable(item)) return null;
  return frameAtPoint(item.x + item.w / 2, item.y + item.h / 2, items, item.id);
}

// Cadre qui TIENT l'item (entourage + lien intact).
export function linkedFrame(item: BoardItem, items: BoardItem[]): BoardItem | null {
  return item.detached ? null : enclosingFrame(item, items);
}

// --- Ajustement du cadre sur son contenu ------------------------------------------------------
// Un cadre suit ce qu'il contient : pousser une image vers le bas ouvre de la place vers le bas,
// la remonter referme derrière elle. Mais un cadre POSÉ AU LARGE (un cadre vide de 640×420 dans
// lequel on vient de glisser une vignette) ne doit pas se rétracter d'un coup sur cette vignette :
// l'espace vide y est intentionnel, c'est de la place réservée.
//
// D'où un ajustement bord par bord : au début du geste, un bord déjà COLLÉ à son contenu (à une
// marge près) le suit dans les deux sens ; un bord au large ne fait que reculer pour laisser passer.
// Un cadre posé autour d'une sélection a ses quatre bords collés — il épouse donc son contenu.
const STICK = FRAME_PAD; // écart en deçà duquel un bord est considéré collé au contenu

export interface FrameHug {
  base: Rect;                  // rectangle du cadre au début du geste
  others: Rect | null;         // emprise des AUTRES items liés, figée au début du geste
  stick: { l: boolean; t: boolean; r: boolean; b: boolean };
}

// Rectangle voulu par un contenu donné (contenu + marges).
function wanted(content: Rect) {
  return {
    l: content.x - FRAME_PAD,
    t: content.y - FRAME_TOP,
    r: content.x + content.w + FRAME_PAD,
    b: content.y + content.h + FRAME_PAD,
  };
}

// Prépare l'ajustement d'un cadre pour un geste sur `movingId` : tout ce qui ne bouge pas est réduit
// à un seul rectangle, si bien que chaque frame du geste ne coûte plus qu'une union.
export function frameHugStart(frame: BoardItem, items: BoardItem[], movingId: string): FrameHug {
  const base: Rect = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
  const ids = new Set(frameContentIds(frame, items));
  let others: Rect | null = null;
  let all: Rect | null = null;
  for (const it of items) {
    if (!ids.has(it.id)) continue;
    const box = geomBox(it);
    all = union(all, box);
    if (it.id !== movingId) others = union(others, box);
  }
  const stick = { l: false, t: false, r: false, b: false };
  if (all) {
    const w = wanted(all);
    stick.l = Math.abs(base.x - w.l) <= STICK;
    stick.t = Math.abs(base.y - w.t) <= STICK;
    stick.r = Math.abs(base.x + base.w - w.r) <= STICK;
    stick.b = Math.abs(base.y + base.h - w.b) <= STICK;
  }
  return { base, others, stick };
}

// Cadre ajusté pour l'emprise courante de l'item manipulé. `box` = null (ou item sorti du cadre) →
// le cadre s'ajuste sur ce qui reste. `null` en retour = rien à changer.
export function frameHugRect(hug: FrameHug, box: Rect | null): Geom | null {
  const { base, stick } = hug;
  // Item traîné hors du cadre : il cesse de compter, le cadre se referme sur le reste. Sans cette
  // borne, sortir un item étirerait son cadre sur toute la distance parcourue.
  const content = union(hug.others, box && overlaps(base, box) ? box : null);
  if (!content) return null;
  const w = wanted(content);
  const l = stick.l ? w.l : Math.min(base.x, w.l);
  const t = stick.t ? w.t : Math.min(base.y, w.t);
  const r = Math.max(l + MIN_SIZE, stick.r ? w.r : Math.max(base.x + base.w, w.r));
  const b = Math.max(t + MIN_SIZE, stick.b ? w.b : Math.max(base.y + base.h, w.b));
  if (l === base.x && t === base.y && r === base.x + base.w && b === base.y + base.h) return null;
  return { x: l, y: t, w: r - l, h: b - t, rotation: 0 };
}
