// Aimant du board : accrochage d'un rectangle en mouvement sur les autres (bords, centres, coins)
// et collage bord à bord. Logique PURE et testable — aucun accès au store, aucune unité écran :
// tout est en coordonnées MONDE, l'appelant convertit son seuil écran en monde (÷ zoom).

export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Ligne d'aide affichée pendant le geste : `axis: "x"` = ligne VERTICALE à l'abscisse `at`.
export interface SnapGuide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

const NONE: SnapResult = { dx: 0, dy: 0, guides: [] };

// Candidat d'accrochage sur un axe : correction à appliquer + coordonnée de la ligne d'aide +
// étendue de l'autre rectangle (pour tracer un guide qui relie visuellement les deux).
interface Cand {
  delta: number;
  at: number;
  from: number;
  to: number;
}

function best(cands: Cand[], threshold: number): Cand | null {
  let win: Cand | null = null;
  for (const c of cands) {
    if (Math.abs(c.delta) > threshold) continue;
    if (!win || Math.abs(c.delta) < Math.abs(win.delta)) win = c;
  }
  return win;
}

// Accrochage d'un rectangle déplacé sur une liste de voisins.
// - `threshold` : distance d'accrochage en unités monde (l'appelant passe px_écran / zoom).
// - `stick` : écart conservé lors d'un collage bord à bord (0 = les images se touchent).
// Les deux axes sont traités indépendamment : un item peut se caler dans un COIN (accroché en X sur
// un voisin et en Y sur un autre).
export function snapMove(moving: SnapRect, others: SnapRect[], threshold: number, stick = 0): SnapResult {
  if (!(threshold > 0) || !others.length) return NONE;

  const mL = moving.x;
  const mR = moving.x + moving.w;
  const mCX = moving.x + moving.w / 2;
  const mT = moving.y;
  const mB = moving.y + moving.h;
  const mCY = moving.y + moving.h / 2;

  const xs: Cand[] = [];
  const ys: Cand[] = [];

  for (const o of others) {
    const oL = o.x;
    const oR = o.x + o.w;
    const oCX = o.x + o.w / 2;
    const oT = o.y;
    const oB = o.y + o.h;
    const oCY = o.y + o.h / 2;
    const spanY = { from: Math.min(mT, oT), to: Math.max(mB, oB) };
    const spanX = { from: Math.min(mL, oL), to: Math.max(mR, oR) };

    // Alignement : bord gauche/droit/centre du déplacé sur ceux du voisin.
    xs.push({ delta: oL - mL, at: oL, ...spanY });
    xs.push({ delta: oR - mR, at: oR, ...spanY });
    xs.push({ delta: oCX - mCX, at: oCX, ...spanY });
    // Collage bord à bord : on vient poser le déplacé CONTRE le voisin, à `stick` d'écart. Avec
    // `stick = 0` (défaut) les deux médias se touchent exactement — un seul candidat couvre donc
    // aussi bien le collage que l'alignement croisé, et l'écart demandé n'entre jamais en
    // concurrence avec un contact à zéro.
    xs.push({ delta: oL - stick - mR, at: oL - stick, ...spanY });
    xs.push({ delta: oR + stick - mL, at: oR + stick, ...spanY });

    ys.push({ delta: oT - mT, at: oT, ...spanX });
    ys.push({ delta: oB - mB, at: oB, ...spanX });
    ys.push({ delta: oCY - mCY, at: oCY, ...spanX });
    ys.push({ delta: oT - stick - mB, at: oT - stick, ...spanX });
    ys.push({ delta: oB + stick - mT, at: oB + stick, ...spanX });
  }

  const wx = best(xs, threshold);
  const wy = best(ys, threshold);
  const guides: SnapGuide[] = [];
  if (wx) guides.push({ axis: "x", at: wx.at, from: wx.from, to: wx.to });
  if (wy) guides.push({ axis: "y", at: wy.at, from: wy.from, to: wy.to });
  return { dx: wx ? wx.delta : 0, dy: wy ? wy.delta : 0, guides };
}

// Accrochage d'une VALEUR isolée (un bord en cours de redimensionnement) sur des coordonnées
// candidates. Renvoie la valeur accrochée, ou la valeur d'origine si rien n'est assez proche.
export function snapValue(value: number, candidates: number[], threshold: number): { value: number; at: number | null } {
  if (!(threshold > 0)) return { value, at: null };
  let win: number | null = null;
  for (const c of candidates) {
    if (Math.abs(c - value) > threshold) continue;
    if (win == null || Math.abs(c - value) < Math.abs(win - value)) win = c;
  }
  return win == null ? { value, at: null } : { value: win, at: win };
}

// Coordonnées candidates d'une liste de voisins : bords + centres, par axe.
export function snapCandidates(others: SnapRect[]): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (const o of others) {
    x.push(o.x, o.x + o.w / 2, o.x + o.w);
    y.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  return { x, y };
}
