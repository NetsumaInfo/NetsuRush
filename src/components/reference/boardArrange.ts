// Alignement / répartition / mise en grille d'une SÉLECTION d'items (panneau d'arrangement).
// Logique PURE et testable : prend la liste des items sélectionnés + un mode, renvoie une Map
// id → nouvelle position {x?, y?}. Le store (useReferenceBoard.arrange) applique cette map à `items`
// et empile l'historique. Aucun accès au store ici.

import { MIN_SIZE, type BoardItem } from "./referenceShared";

export type ArrangeMode =
  | "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom"
  | "hdist" | "vdist" | "grid"
  | "block" | "pack" | "row" | "col";

// Géométrie cible (partielle : un mode d'alignement ne touche qu'un axe, un mode de rangement peut
// aussi redimensionner — « bloc » ramène toute la planche à une échelle commune).
export type ArrangePos = { x?: number; y?: number; w?: number; h?: number };

// Sous-ensemble géométrique nécessaire (compatible BoardItem).
type Box = Pick<BoardItem, "id" | "x" | "y" | "w" | "h">;

// Boîte + rotation : la géométrie stockée est le rectangle NON tourné, mais l'emprise réelle à
// l'écran est sa bbox alignée sur les axes. Tout ce qui range, mesure ou aimante travaille dessus.
export type RotBox = Box & Pick<BoardItem, "rotation">;

// Repère normalisé d'un item : (0,0) = coin haut-gauche, (1,1) = coin bas-droit, APRÈS rotation et
// miroirs. Sert d'ancre durable (dessin lié à une image) : l'ancre survit au déplacement, au
// redimensionnement, à la rotation et au miroir de l'item.
export type AnchorBox = Pick<BoardItem, "x" | "y" | "w" | "h" | "rotation" | "flipH" | "flipV">;

// Géométrie minimale acceptée par `rotatedBBox` (un item, une géométrie de geste, un cadre…).
export type RotGeom = { x: number; y: number; w: number; h: number; rotation?: number };

// Emprise réelle (AABB) d'un item, rotation comprise. Le centre est invariant par rotation.
export function rotatedBBox(it: RotGeom): { x: number; y: number; w: number; h: number; cx: number; cy: number } {
  const r = ((it.rotation || 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  const w = it.w * c + it.h * s;
  const h = it.w * s + it.h * c;
  const cx = it.x + it.w / 2;
  const cy = it.y + it.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy };
}

// AABB englobant une liste d'items (emprises tournées comprises). Liste vide → boîte nulle.
export function boundsOf(items: RotBox[]): { x: number; y: number; w: number; h: number } {
  if (!items.length) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    const b = rotatedBBox(it);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Monde → repère normalisé de l'item (annule la rotation autour du centre, puis les miroirs).
export function toItemSpace(it: AnchorBox, wx: number, wy: number): { fx: number; fy: number } {
  const cx = it.x + it.w / 2;
  const cy = it.y + it.h / 2;
  const t = ((it.rotation || 0) * Math.PI) / 180;
  const dx = wx - cx;
  const dy = wy - cy;
  const lx = dx * Math.cos(t) + dy * Math.sin(t);
  const ly = -dx * Math.sin(t) + dy * Math.cos(t);
  let fx = it.w ? lx / it.w + 0.5 : 0.5;
  let fy = it.h ? ly / it.h + 0.5 : 0.5;
  if (it.flipH) fx = 1 - fx;
  if (it.flipV) fy = 1 - fy;
  return { fx, fy };
}

// Repère normalisé de l'item → monde (inverse exact de `toItemSpace`).
export function fromItemSpace(it: AnchorBox, fx: number, fy: number): { x: number; y: number } {
  const ux = it.flipH ? 1 - fx : fx;
  const uy = it.flipV ? 1 - fy : fy;
  const lx = (ux - 0.5) * it.w;
  const ly = (uy - 0.5) * it.h;
  const t = ((it.rotation || 0) * Math.PI) / 180;
  const cx = it.x + it.w / 2;
  const cy = it.y + it.h / 2;
  return {
    x: cx + lx * Math.cos(t) - ly * Math.sin(t),
    y: cy + lx * Math.sin(t) + ly * Math.cos(t),
  };
}

// Uniformisation de taille : « même hauteur », « même largeur », « même surface ».
export type NormalizeMode = "height" | "width" | "area";

// Nouvelle taille des items sélectionnés, à CENTRE CONSTANT (rien ne se déplace, tout grossit ou
// rétrécit sur place). La mesure porte sur l'emprise tournée, donc une image à 45° est ramenée sur
// son emprise réelle et non sur ses dimensions brutes. <2 items → map vide.
export function computeNormalize(sel: RotBox[], mode: NormalizeMode): Map<string, { x: number; y: number; w: number; h: number }> {
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  if (sel.length < 2) return out;

  const boxes = sel.map((it) => ({ it, b: rotatedBBox(it) }));
  const value = (b: { w: number; h: number }) => (mode === "height" ? b.h : mode === "width" ? b.w : b.w * b.h);
  const values = boxes.map(({ b }) => value(b));
  if (values.some((v) => !(v > 0))) return out;
  const avg = values.reduce((t, v) => t + v, 0) / values.length;

  for (const { it, b } of boxes) {
    const k = mode === "area" ? Math.sqrt(avg / (b.w * b.h)) : avg / value(b);
    const w = Math.max(MIN_SIZE, it.w * k);
    const h = Math.max(MIN_SIZE, it.h * k);
    out.set(it.id, { x: b.cx - w / 2, y: b.cy - h / 2, w, h });
  }
  return out;
}

// Item tel que le rangement le voit : géométrie tournée + de quoi le trier par nom.
export type ArrangeBox = RotBox & Pick<BoardItem, "title" | "ref">;

// Options de rangement (écart et ordre) — les modes d'alignement/répartition les ignorent.
export interface ArrangeOpts {
  gap?: number;                  // écart entre items (unités monde)
  sort?: "none" | "name";        // "name" = titre, sinon nom de fichier de `ref`
}

const DEFAULT_GAP = 16;

// Nom lisible d'un item : titre saisi, sinon nom de fichier du localisateur.
export function itemName(it: { title?: string; ref?: string }): string {
  const t = (it.title || "").trim();
  if (t) return t;
  const ref = it.ref || "";
  return (ref.split(/[\\/]/).pop() || ref).trim();
}

// Tri « par nom » naturel : `shot_2` avant `shot_10`. Les items sans nom finissent en queue, dans
// leur ordre courant (comportement de BeeRef, qui range par nom de fichier puis par ordre d'ajout).
function sortByName(sel: ArrangeBox[]): ArrangeBox[] {
  const named = sel.filter((i) => itemName(i));
  const rest = sel.filter((i) => !itemName(i));
  named.sort((a, b) => itemName(a).localeCompare(itemName(b), undefined, { numeric: true, sensitivity: "base" }));
  return [...named, ...rest];
}

// Packer de rectangles : espaces libres découpés au fur et à mesure (rectangles rangés du plus haut
// au plus court, placement dans le premier espace libre qui accepte, découpe à droite et en dessous).
// Renvoie une position par rectangle DANS L'ORDRE D'ENTRÉE, plus l'emprise totale obtenue.
function packRects(sizes: { w: number; h: number }[], maxWidth: number): { pos: { x: number; y: number }[]; w: number; h: number } {
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b].h - sizes[a].h);
  const spaces: { x: number; y: number; w: number; h: number }[] = [{ x: 0, y: 0, w: maxWidth, h: Infinity }];
  const pos: { x: number; y: number }[] = new Array(sizes.length);
  let w = 0;
  let h = 0;

  for (const i of order) {
    const box = sizes[i];
    for (let j = spaces.length - 1; j >= 0; j--) {
      const sp = spaces[j];
      if (box.w > sp.w || box.h > sp.h) continue;
      pos[i] = { x: sp.x, y: sp.y };
      w = Math.max(w, sp.x + box.w);
      h = Math.max(h, sp.y + box.h);
      if (box.w === sp.w && box.h === sp.h) {
        const last = spaces.pop()!;
        if (j < spaces.length) spaces[j] = last;
      } else if (box.h === sp.h) {
        sp.x += box.w;
        sp.w -= box.w;
      } else if (box.w === sp.w) {
        sp.y += box.h;
        sp.h -= box.h;
      } else {
        spaces.push({ x: sp.x + box.w, y: sp.y, w: sp.w - box.w, h: box.h });
        sp.y += box.h;
        sp.h -= box.h;
      }
      break;
    }
    if (!pos[i]) pos[i] = { x: 0, y: h }; // filet de sécurité : ne jamais renvoyer de trou
  }
  return { pos, w, h };
}

// Rangement « bloc » : LIGNES JUSTIFIÉES, comme une galerie photo. Chaque ligne est remplie jusqu'à
// la largeur cible puis étirée EXACTEMENT à cette largeur, si bien que la planche est un rectangle
// plein — aucun trou, aucun chevauchement — où chaque média garde son ratio et pèse visuellement
// autant que les autres. C'est le seul mode qui redimensionne : ranger un lot d'images sans les
// remettre à l'échelle laisse une vignette 200 px à côté d'une affiche 4000 px, et on ne voit rien.
//
// L'aire totale de la sélection est conservée : la planche rangée occupe la même surface qu'avant,
// elle ne saute pas d'échelle sous le curseur.
function computeBlock(sel: ArrangeBox[], gap: number, sort?: "none" | "name"): Map<string, ArrangePos> {
  const out = new Map<string, ArrangePos>();
  const sorted = sort === "name" ? sortByName(sel) : [...sel];
  const boxes = sorted
    .map((it) => ({ it, b: rotatedBBox(it) }))
    .filter(({ b }) => b.w > 0 && b.h > 0);
  const n = boxes.length;
  if (n < 2) return out;

  const ratios = boxes.map(({ b }) => b.w / b.h);
  const sumR = ratios.reduce((t, r) => t + r, 0);
  const area = boxes.reduce((t, { b }) => t + b.w * b.h, 0);
  // Hauteur de ligne de référence : celle qui redonne l'aire d'origine une fois tout le monde à la
  // même hauteur (Σ ratio × H² = aire).
  const baseH = Math.max(MIN_SIZE, Math.sqrt(area / sumR));
  // Nombre d'items par ligne visant une planche un peu plus large que haute (les écrans le sont) :
  // colonnes² × ratio moyen ≈ 1,4 × n.
  const perRow = Math.max(1, Math.ceil(Math.sqrt((1.4 * n * n) / sumR)));
  const targetW = perRow * (sumR / n) * baseH + gap * (perRow - 1);

  // Remplissage glouton : on ferme la ligne dès qu'elle DÉPASSE la largeur cible (la justification
  // la ramènera dessus), ce qui donne des lignes régulières même avec des ratios très différents.
  const rows: { idx: number[]; sum: number }[] = [];
  let row: { idx: number[]; sum: number } = { idx: [], sum: 0 };
  ratios.forEach((r, i) => {
    row.idx.push(i);
    row.sum += r;
    if (row.sum * baseH + gap * (row.idx.length - 1) >= targetW) { rows.push(row); row = { idx: [], sum: 0 }; }
  });
  if (row.idx.length) rows.push(row);

  // Chaque ligne est justifiée à `targetW`, SAUF la dernière si elle n'a pas débordé : l'étirer
  // ferait exploser une ligne d'un seul média jusqu'à la largeur de toute la planche.
  const heights = rows.map((r, k) => {
    const inner = targetW - gap * (r.idx.length - 1);
    const fit = inner / r.sum;
    const last = k === rows.length - 1;
    return Math.max(MIN_SIZE, last ? Math.min(fit, baseH) : fit);
  });

  const blockH = heights.reduce((t, h) => t + h, 0) + gap * (rows.length - 1);
  const bb = boxes.map(({ b }) => b);
  const minX = Math.min(...bb.map((b) => b.x));
  const maxX = Math.max(...bb.map((b) => b.x + b.w));
  const minY = Math.min(...bb.map((b) => b.y));
  const maxY = Math.max(...bb.map((b) => b.y + b.h));
  const originX = (minX + maxX) / 2 - targetW / 2;
  let y = (minY + maxY) / 2 - blockH / 2;

  rows.forEach((r, k) => {
    const rowH = heights[k];
    let x = originX;
    for (const i of r.idx) {
      const { it, b } = boxes[i];
      // Échelle UNIFORME appliquée à la géométrie stockée : l'emprise tournée suit exactement, donc
      // un média incliné se range sur ce qu'il occupe vraiment à l'écran.
      const k2 = rowH / b.h;
      const w = Math.max(MIN_SIZE, it.w * k2);
      const h = Math.max(MIN_SIZE, it.h * k2);
      const bw = b.w * k2;
      out.set(it.id, { x: x + bw / 2 - w / 2, y: y + rowH / 2 - h / 2, w, h });
      x += bw + gap;
    }
    y += rowH + gap;
  });
  return out;
}

// Calcule les nouvelles positions des items sélectionnés selon le mode. <2 items → map vide.
// Les positions renvoyées sont celles du rectangle STOCKÉ (x/y de l'item), calculées depuis son
// emprise tournée : un item à 45° se range sur ce qu'il occupe vraiment à l'écran.
export function computeArrange(sel: ArrangeBox[], mode: ArrangeMode, opts: ArrangeOpts = {}): Map<string, ArrangePos> {
  const pos = new Map<string, ArrangePos>();
  if (sel.length < 2) return pos;

  const gap = Math.max(0, opts.gap ?? DEFAULT_GAP);
  if (mode === "block") return computeBlock(sel, gap, opts.sort);
  const box = new Map(sel.map((i) => [i.id, rotatedBBox(i)]));
  const bb = (i: ArrangeBox) => box.get(i.id)!;
  // Décalage entre l'origine stockée et l'origine de l'emprise (nul si l'item n'est pas tourné).
  const offX = (i: ArrangeBox) => i.x - bb(i).x;
  const offY = (i: ArrangeBox) => i.y - bb(i).y;

  const minX = Math.min(...sel.map((i) => bb(i).x));
  const maxX = Math.max(...sel.map((i) => bb(i).x + bb(i).w));
  const minY = Math.min(...sel.map((i) => bb(i).y));
  const maxY = Math.max(...sel.map((i) => bb(i).y + bb(i).h));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Un alignement ne doit JAMAIS empiler. Aligner trente images sur un bord les mettait toutes sur
  // la même colonne — donc les unes SUR les autres, planche illisible. Les positions alignées sont
  // gardées telles quelles ; seul ce qui se chevauche est repoussé le long de l'AUTRE axe, dans son
  // ordre d'origine. Une petite sélection déjà lisible ne bouge pas d'un pixel.
  const spread = (axis: "x" | "y") => {
    const start = (i: ArrangeBox) => (axis === "y" ? bb(i).y : bb(i).x);
    const size = (i: ArrangeBox) => (axis === "y" ? bb(i).h : bb(i).w);
    const off = (i: ArrangeBox) => (axis === "y" ? offY(i) : offX(i));
    let cursor = -Infinity;
    for (const i of [...sel].sort((a, b) => start(a) - start(b))) {
      const at = Math.max(start(i), cursor);
      if (at !== start(i)) pos.set(i.id, { ...pos.get(i.id), [axis]: at + off(i) });
      cursor = at + size(i) + gap;
    }
  };

  if (mode === "left" || mode === "right" || mode === "hcenter") {
    if (mode === "left") sel.forEach((i) => pos.set(i.id, { x: minX + offX(i) }));
    else if (mode === "right") sel.forEach((i) => pos.set(i.id, { x: maxX - bb(i).w + offX(i) }));
    else sel.forEach((i) => pos.set(i.id, { x: cx - bb(i).w / 2 + offX(i) }));
    spread("y");
  } else if (mode === "top" || mode === "bottom" || mode === "vcenter") {
    if (mode === "top") sel.forEach((i) => pos.set(i.id, { y: minY + offY(i) }));
    else if (mode === "bottom") sel.forEach((i) => pos.set(i.id, { y: maxY - bb(i).h + offY(i) }));
    else sel.forEach((i) => pos.set(i.id, { y: cy - bb(i).h / 2 + offY(i) }));
    spread("x");
  } else if (mode === "hdist") {
    // Écart PLANCHER = `gap` : quand les items ne tiennent pas dans leur propre emprise, un pas
    // négatif les faisait se chevaucher. Répartir doit écarter le groupe, jamais le replier.
    const sorted = [...sel].sort((a, b) => bb(a).x - bb(b).x);
    const step = Math.max(gap, (maxX - minX - sorted.reduce((t, i) => t + bb(i).w, 0)) / (sorted.length - 1));
    let x = minX;
    sorted.forEach((i) => { pos.set(i.id, { x: x + offX(i) }); x += bb(i).w + step; });
  } else if (mode === "vdist") {
    const sorted = [...sel].sort((a, b) => bb(a).y - bb(b).y);
    const step = Math.max(gap, (maxY - minY - sorted.reduce((t, i) => t + bb(i).h, 0)) / (sorted.length - 1));
    let y = minY;
    sorted.forEach((i) => { pos.set(i.id, { y: y + offY(i) }); y += bb(i).h + step; });
  } else if (mode === "grid") {
    const sorted = opts.sort === "name" ? sortByName(sel) : [...sel].sort((a, b) => bb(a).y - bb(b).y || bb(a).x - bb(b).x);
    const cols = Math.ceil(Math.sqrt(sorted.length));
    const rows = Math.ceil(sorted.length / cols);
    const cellW = Math.max(...sel.map((i) => bb(i).w)) + gap;
    const cellH = Math.max(...sel.map((i) => bb(i).h)) + gap;
    // Grille centrée sur le centre de la sélection : on réorganise sur place, le groupe ne saute pas.
    const originX = cx - (cols * cellW - gap) / 2;
    const originY = cy - (rows * cellH - gap) / 2;
    sorted.forEach((i, k) => pos.set(i.id, {
      x: originX + (k % cols) * cellW + (cellW - gap - bb(i).w) / 2 + offX(i),
      y: originY + Math.floor(k / cols) * cellH + (cellH - gap - bb(i).h) / 2 + offY(i),
    }));
  } else if (mode === "row" || mode === "col") {
    const vertical = mode === "col";
    const sorted = opts.sort === "name"
      ? sortByName(sel)
      : [...sel].sort((a, b) => (vertical ? bb(a).y - bb(b).y : bb(a).x - bb(b).x));
    const total = sorted.reduce((t, i) => t + (vertical ? bb(i).h : bb(i).w), 0) + gap * (sorted.length - 1);
    let cursor = (vertical ? cy : cx) - total / 2;
    sorted.forEach((i) => {
      if (vertical) {
        pos.set(i.id, { x: cx - bb(i).w / 2 + offX(i), y: cursor + offY(i) });
        cursor += bb(i).h + gap;
      } else {
        pos.set(i.id, { x: cursor + offX(i), y: cy - bb(i).h / 2 + offY(i) });
        cursor += bb(i).w + gap;
      }
    });
  } else if (mode === "pack") {
    const sorted = opts.sort === "name" ? sortByName(sel) : sel;
    const sizes = sorted.map((i) => ({ w: bb(i).w + gap, h: bb(i).h + gap }));
    // Largeur de départ = côté d'un carré de même aire (avec un peu d'air), comme les packers usuels.
    const area = sizes.reduce((t, s) => t + s.w * s.h, 0);
    const startW = Math.max(...sizes.map((s) => s.w), Math.ceil(Math.sqrt(area / 0.95)));
    const packed = packRects(sizes, startW);
    // Recentrage du bloc obtenu sur le centre de la sélection.
    const dx = cx - packed.w / 2;
    const dy = cy - packed.h / 2;
    sorted.forEach((i, k) => pos.set(i.id, {
      x: dx + packed.pos[k].x + offX(i),
      y: dy + packed.pos[k].y + offY(i),
    }));
  }
  return pos;
}
