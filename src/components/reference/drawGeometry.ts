// Géométrie pure du calque de dessin (coords MONDE) : distances, bbox, hit-test, poignées, édition.
import type { DashStyle, DrawShape, RouteStyle } from "./referenceShared";

// Type de tracé effectif d'une ligne/flèche (compat : un `cp` manuel sans `route` = courbe).
export function routeOf(s: DrawShape): RouteStyle {
  return s.route ?? (s.cp ? "curved" : "straight");
}

// Point de contrôle auto d'une courbe : milieu décalé perpendiculairement (~20 % de la longueur).
function autoBow(x0: number, y0: number, x1: number, y1: number): [number, number] {
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const off = len * 0.2;
  return [mx + (-dy / len) * off, my + (dx / len) * off];
}

// Tracé SVG d'une ligne/flèche + angles des tangentes aux extrémités (pour orienter les pointes).
// `endAng` = direction VERS l'arrivée (p1) ; `startAng` = direction VERS le départ (p0).
export function connectorPath(s: DrawShape): { d: string; startAng: number; endAng: number } {
  const [x0, y0, x1, y1] = s.p;
  const route = routeOf(s);
  if (route === "elbow") {
    const dx = x1 - x0, dy = y1 - y0;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const mx = (x0 + x1) / 2;
      return { d: `M ${x0} ${y0} L ${mx} ${y0} L ${mx} ${y1} L ${x1} ${y1}`, endAng: dx >= 0 ? 0 : Math.PI, startAng: dx >= 0 ? Math.PI : 0 };
    }
    const my = (y0 + y1) / 2;
    return { d: `M ${x0} ${y0} L ${x0} ${my} L ${x1} ${my} L ${x1} ${y1}`, endAng: dy >= 0 ? Math.PI / 2 : -Math.PI / 2, startAng: dy >= 0 ? -Math.PI / 2 : Math.PI / 2 };
  }
  if (route === "curved") {
    const cp = s.cp ?? autoBow(x0, y0, x1, y1);
    return {
      d: `M ${x0} ${y0} Q ${cp[0]} ${cp[1]} ${x1} ${y1}`,
      endAng: Math.atan2(y1 - cp[1], x1 - cp[0]),
      startAng: Math.atan2(y0 - cp[1], x0 - cp[0]),
    };
  }
  return { d: `M ${x0} ${y0} L ${x1} ${y1}`, endAng: Math.atan2(y1 - y0, x1 - x0), startAng: Math.atan2(y0 - y1, x0 - x1) };
}

// `strokeDasharray` (unités MONDE, ∝ épaisseur) ; undefined = trait plein.
export function dashArray(dash: DashStyle | undefined, w: number): string | undefined {
  if (!dash || dash === "solid") return undefined;
  if (dash === "dashed") return `${w * 2.6} ${w * 2}`;
  return `${Math.max(0.01, w * 0.01)} ${w * 2}`; // dotted : segment ~nul + linecap rond → points
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function shapeBBox(s: DrawShape): [number, number, number, number] {
  if (s.t === "text") return [s.p[0], s.p[1], s.p[0] + (s.text?.length || 1) * s.w * 0.6, s.p[1] + s.w];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < s.p.length; i += 2) {
    minX = Math.min(minX, s.p[i]); maxX = Math.max(maxX, s.p[i]);
    minY = Math.min(minY, s.p[i + 1]); maxY = Math.max(maxY, s.p[i + 1]);
  }
  return [minX, minY, maxX, maxY];
}

// `bbox` = true (outil sélection) → un clic À L'INTÉRIEUR de la boîte compte ; false (gomme) →
// seulement à proximité du tracé/bord.
export function hitShape(s: DrawShape, x: number, y: number, thr: number, bbox = false): boolean {
  const [a, b, c, d] = shapeBBox(s);
  const inBox = x >= a - thr && x <= c + thr && y >= b - thr && y <= d + thr;
  if (s.t === "text") return inBox;
  if (bbox && (s.t === "rect" || s.t === "ellipse" || s.t === "diamond")) return inBox;
  if (s.t === "pen") {
    for (let i = 0; i + 3 < s.p.length; i += 2) {
      if (distToSeg(x, y, s.p[i], s.p[i + 1], s.p[i + 2], s.p[i + 3]) < thr) return true;
    }
    return false;
  }
  if (s.t === "line" || s.t === "arrow") return distToSeg(x, y, s.p[0], s.p[1], s.p[2], s.p[3]) < thr;
  // rect / ellipse / diamond (gomme) : proche d'un bord, ou intérieur si rempli
  if (!inBox) return false;
  if (s.fill && s.fill !== "none") return true;
  const inner = x > a + thr && x < c - thr && y > b + thr && y < d - thr;
  return !inner;
}

export function shifted(s: DrawShape, dx: number, dy: number): DrawShape {
  const cp = s.cp ? ([s.cp[0] + dx, s.cp[1] + dy] as [number, number]) : undefined;
  return { ...s, p: s.p.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)), cp };
}

// Poignées d'édition de la forme sélectionnée (coords MONDE) : extrémités des lignes/flèches
// (+ poignée de cintrage au milieu) et coins des rectangles/ellipses.
export type Handle = { k: string; x: number; y: number; bend?: boolean };
export function handlesFor(s: DrawShape): Handle[] {
  if (s.t === "line" || s.t === "arrow") {
    const [x0, y0, x1, y1] = s.p;
    const ends: Handle[] = [{ k: "p0", x: x0, y: y0 }, { k: "p1", x: x1, y: y1 }];
    // tracé coudé : pas de poignée de cintrage (le coude est implicite).
    if (routeOf(s) === "elbow") return ends;
    // milieu visuel de la courbe (passe par 0.25·P0 + 0.5·CP + 0.25·P1)
    const mx = s.cp ? 0.25 * x0 + 0.5 * s.cp[0] + 0.25 * x1 : (x0 + x1) / 2;
    const my = s.cp ? 0.25 * y0 + 0.5 * s.cp[1] + 0.25 * y1 : (y0 + y1) / 2;
    return [...ends, { k: "bend", x: mx, y: my, bend: true }];
  }
  if (s.t === "rect" || s.t === "ellipse" || s.t === "diamond") {
    const [x0, y0, x1, y1] = s.p;
    return [
      { k: "c0", x: x0, y: y0 }, { k: "c1", x: x1, y: y0 },
      { k: "c2", x: x1, y: y1 }, { k: "c3", x: x0, y: y1 },
    ];
  }
  return [];
}

// Applique le déplacement d'une poignée à (x,y) MONDE. `straight` = seuil monde sous lequel on
// redresse une flèche/ligne (on retire le point de contrôle).
export function editShape(s: DrawShape, k: string, x: number, y: number, straight: number): DrawShape {
  const p = [...s.p];
  if (s.t === "line" || s.t === "arrow") {
    if (k === "p0") { p[0] = x; p[1] = y; }
    else if (k === "p1") { p[2] = x; p[3] = y; }
    else if (k === "bend") {
      const sx = (p[0] + p[2]) / 2, sy = (p[1] + p[3]) / 2;
      // sous le seuil → on redresse (retire le cintrage) ; sinon courbe via point de contrôle.
      if (Math.hypot(x - sx, y - sy) < straight) return { ...s, p, cp: undefined, route: "straight" };
      return { ...s, p, cp: [2 * x - sx, 2 * y - sy], route: "curved" };
    }
    return { ...s, p };
  }
  if (s.t === "rect" || s.t === "ellipse" || s.t === "diamond") {
    if (k === "c0") { p[0] = x; p[1] = y; }
    else if (k === "c1") { p[2] = x; p[1] = y; }
    else if (k === "c2") { p[2] = x; p[3] = y; }
    else if (k === "c3") { p[0] = x; p[3] = y; }
    return { ...s, p };
  }
  return s;
}

// Tracé du stylo LISSÉ : courbes quadratiques dont les ancres sont les MI-POINTS entre échantillons
// (chaque point capté devient point de contrôle) → encre fluide sans osciller, passe près de tous les
// points. ≤2 points → segment simple. Le hit-test reste sur les segments bruts (approximation fidèle).
export function penPath(p: number[]): string {
  if (p.length < 2) return "";
  if (p.length <= 4) {
    let d = `M ${p[0]} ${p[1]}`;
    for (let i = 2; i < p.length; i += 2) d += ` L ${p[i]} ${p[i + 1]}`;
    return d;
  }
  let d = `M ${p[0]} ${p[1]}`;
  for (let i = 2; i + 3 < p.length; i += 2) {
    const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
    d += ` Q ${p[i]} ${p[i + 1]} ${mx} ${my}`;
  }
  d += ` L ${p[p.length - 2]} ${p[p.length - 1]}`;
  return d;
}
