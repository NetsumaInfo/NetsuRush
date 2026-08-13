// Liaison des tracés aux médias : accrochage automatique en fin de tracé, puis résolution des
// coordonnées à chaque rendu. Logique PURE (aucun store, aucun DOM) — testable telle quelle.
//
// Deux natures de liaison, un seul mécanisme (repère normalisé de l'item, rotation et miroirs
// compris, cf. `toItemSpace` / `fromItemSpace`) :
//   - `own` + `ownPts` : forme posée SUR un média (trait, rectangle, ellipse…) → elle le suit en bloc ;
//   - `a1` / `a2`      : extrémités d'une ligne/flèche ancrées à un média chacune → une flèche
//                        tracée d'une image vers une autre reste tendue entre les deux.
// L'item disparu ⇒ l'ancre est effacée et la forme reste où elle était : jamais de tracé fantôme.

import type { BoardItem, DrawShape, ShapeAnchor } from "./referenceShared";
import { fromItemSpace, toItemSpace, type AnchorBox } from "./boardArrange";
import { shapeBBox } from "./drawGeometry";

// Kinds qui peuvent porter un tracé : tout ce qui est un média ou un conteneur visible.
const ANCHORABLE = new Set(["image", "video", "youtube", "embed", "sequence", "frame", "palette", "text"]);

// Part de la bbox d'une forme qui doit tomber dans un item pour qu'elle lui appartienne.
const OWN_COVERAGE = 0.8;

export type AnchorItem = Pick<BoardItem, "id" | "kind" | "x" | "y" | "w" | "h" | "rotation" | "flipH" | "flipV" | "z">;

function box(it: AnchorItem): AnchorBox {
  return { x: it.x, y: it.y, w: it.w, h: it.h, rotation: it.rotation, flipH: it.flipH, flipV: it.flipV };
}

// Item (le plus haut) contenant le point donné. Le test se fait dans le repère de l'item, donc une
// image tournée est testée sur sa vraie surface et non sur sa bbox.
export function itemAtPoint(items: AnchorItem[], x: number, y: number): AnchorItem | null {
  let win: AnchorItem | null = null;
  for (const it of items) {
    if (!ANCHORABLE.has(it.kind) || !it.w || !it.h) continue;
    const { fx, fy } = toItemSpace(box(it), x, y);
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
    if (!win || it.z > win.z) win = it;
  }
  return win;
}

// Item qui « contient » la boîte donnée (recouvrement ≥ 80 %, mesuré sur les AABB). Sert au trait
// libre : dessiner sur une image l'y attache, dessiner à cheval sur le vide ne l'attache pas.
function itemCovering(items: AnchorItem[], bb: [number, number, number, number]): AnchorItem | null {
  const [x0, y0, x1, y1] = bb;
  const area = Math.max(1e-6, (x1 - x0) * (y1 - y0));
  let win: AnchorItem | null = null;
  for (const it of items) {
    if (!ANCHORABLE.has(it.kind) || !it.w || !it.h) continue;
    const ix = Math.max(0, Math.min(x1, it.x + it.w) - Math.max(x0, it.x));
    const iy = Math.max(0, Math.min(y1, it.y + it.h) - Math.max(y0, it.y));
    if ((ix * iy) / area < OWN_COVERAGE) continue;
    if (!win || it.z > win.z) win = it;
  }
  return win;
}

function anchorAt(it: AnchorItem, x: number, y: number): ShapeAnchor {
  const { fx, fy } = toItemSpace(box(it), x, y);
  return { id: it.id, fx, fy };
}

// Accrochage automatique d'une forme fraîchement tracée. Renvoie la forme (éventuellement ancrée) ;
// la forme d'entrée n'est jamais modifiée.
export function attachShape(shape: DrawShape, items: AnchorItem[]): DrawShape {
  if (!items.length) return shape;

  if (shape.t === "line" || shape.t === "arrow") {
    const [x0, y0, x1, y1] = shape.p;
    const a = itemAtPoint(items, x0, y0);
    const b = itemAtPoint(items, x1, y1);
    if (!a && !b) return shape;
    const next: DrawShape = { ...shape };
    if (a) next.a1 = anchorAt(a, x0, y0);
    if (b) next.a2 = anchorAt(b, x1, y1);
    return next;
  }

  const owner = itemCovering(items, shapeBBox(shape));
  if (!owner) return shape;
  return { ...shape, own: owner.id, ownPts: normalizePts(shape.p, owner) };
}

// Points monde → points normalisés dans le repère de l'item (paires x,y).
function normalizePts(p: number[], it: AnchorItem): number[] {
  const b = box(it);
  const out: number[] = new Array(p.length);
  for (let i = 0; i + 1 < p.length; i += 2) {
    const { fx, fy } = toItemSpace(b, p[i], p[i + 1]);
    out[i] = fx;
    out[i + 1] = fy;
  }
  return out;
}

// Points normalisés → points monde.
function worldPts(p: number[], it: AnchorItem): number[] {
  const b = box(it);
  const out: number[] = new Array(p.length);
  for (let i = 0; i + 1 < p.length; i += 2) {
    const { x, y } = fromItemSpace(b, p[i], p[i + 1]);
    out[i] = x;
    out[i + 1] = y;
  }
  return out;
}

// Retire toute liaison en figeant la forme telle qu'elle est affichée (coordonnées monde).
export function detachShape(shape: DrawShape, byId: Map<string, AnchorItem>): DrawShape {
  const solved = resolveShape(shape, byId);
  const { own: _own, ownPts: _pts, a1: _a1, a2: _a2, ...rest } = solved;
  return { ...rest, p: solved.p };
}

// Nombre de médias auxquels une forme est liée (affiché par l'inspecteur de forme).
export function anchorCount(shape: DrawShape): number {
  if (shape.own) return 1;
  return (shape.a1 ? 1 : 0) + (shape.a2 ? 1 : 0);
}

// Résout une forme dans le monde à partir de la géométrie COURANTE des items liés.
// Ancre orpheline (item supprimé) → la liaison est simplement abandonnée, les points affichés
// restent ceux de la dernière position connue.
export function resolveShape(shape: DrawShape, byId: Map<string, AnchorItem>): DrawShape {
  if (shape.own && shape.ownPts) {
    const owner = byId.get(shape.own);
    if (!owner) return shape;
    return { ...shape, p: worldPts(shape.ownPts, owner) };
  }
  if (!shape.a1 && !shape.a2) return shape;
  const p = [...shape.p];
  const a = shape.a1 ? byId.get(shape.a1.id) : null;
  const b = shape.a2 ? byId.get(shape.a2.id) : null;
  if (a && shape.a1) {
    const pt = fromItemSpace(box(a), shape.a1.fx, shape.a1.fy);
    p[0] = pt.x;
    p[1] = pt.y;
  }
  if (b && shape.a2) {
    const pt = fromItemSpace(box(b), shape.a2.fx, shape.a2.fy);
    p[2] = pt.x;
    p[3] = pt.y;
  }
  return { ...shape, p };
}

// Index des items utilisable par `resolveShape`.
export function indexItems(items: AnchorItem[]): Map<string, AnchorItem> {
  return new Map(items.map((it) => [it.id, it]));
}

// Résout toute une liste de formes. Renvoie la LISTE D'ORIGINE si rien n'est lié (évite de recréer
// un tableau à chaque rendu sur un board sans liaison).
export function resolveShapes(shapes: DrawShape[], items: AnchorItem[]): DrawShape[] {
  if (!shapes.some((s) => s.own || s.a1 || s.a2)) return shapes;
  const byId = indexItems(items);
  return shapes.map((s) => resolveShape(s, byId));
}

// Réancre une forme éditée à la main (déplacement, poignée) sur les mêmes items : sans ça, une forme
// liée reviendrait à sa position d'origine au rendu suivant.
export function reanchorShape(shape: DrawShape, byId: Map<string, AnchorItem>): DrawShape {
  if (shape.own) {
    const owner = byId.get(shape.own);
    if (!owner) return { ...shape, own: undefined, ownPts: undefined };
    return { ...shape, ownPts: normalizePts(shape.p, owner) };
  }
  if (!shape.a1 && !shape.a2) return shape;
  const next = { ...shape };
  if (shape.a1) {
    const a = byId.get(shape.a1.id);
    next.a1 = a ? anchorAt(a, shape.p[0], shape.p[1]) : undefined;
  }
  if (shape.a2) {
    const b = byId.get(shape.a2.id);
    next.a2 = b ? anchorAt(b, shape.p[2], shape.p[3]) : undefined;
  }
  return next;
}
