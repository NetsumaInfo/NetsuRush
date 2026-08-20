// Pictograms for the harmony rules. A rule is a GEOMETRY on the wheel — a triangle, an axis, a
// fan — and the drawing says it faster than its name does: "split complementary" means nothing
// to most people, a Y inside a ring is immediately readable. Drawn here rather than pulled from
// an icon set, because no set carries color-theory diagrams.
//
// Each icon is the same ring with the rule's own dots and chords, in `currentColor`, so it
// inherits the button's state (active, hover, disabled) without extra styling.

import type { HarmonyRule } from "./harmonies";

const C = 12;      // center of the 24×24 viewBox
// Ring radius the dots sit on. Pushed near the edge on purpose: at button size the pattern is
// what has to read, so the drawing fills the box (a dot still clears it — 9.5 + its 2.2 radius).
const R = 9.5;
const DOT = 2.2;
const STROKE = 1.4;

// Angle in degrees measured from the top, clockwise — the way a color wheel is read.
function pt(deg: number, r: number = R): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

// dots: angles (or [angle, radius]) carrying a swatch. chords: pairs of angles joined by a line.
// spokes: angles joined to the CENTER. closed: chain the dots into a polygon.
interface Spec {
  dots: (number | [number, number])[];
  chords?: [number, number][];
  spokes?: number[];
  closed?: boolean;
}

const SPECS: Record<HarmonyRule, Spec> = {
  // Free placement: scattered dots, nothing joins them.
  custom: { dots: [[20, 5], [145, 6.5], [265, 4.5]] },
  // Neighbouring hues: a narrow fan off the center.
  analogous: { dots: [-32, 0, 32], spokes: [-32, 0, 32] },
  // Opposite hues: one axis across the wheel.
  complementary: { dots: [0, 180], chords: [[0, 180]] },
  // Base plus the two hues flanking its opposite: a Y.
  split: { dots: [0, 150, 210], chords: [[0, 150], [0, 210]] },
  triadic: { dots: [0, 120, 240], closed: true },
  square: { dots: [0, 90, 180, 270], closed: true },
  // Two paired axes, crossing.
  compound: { dots: [0, 30, 180, 210], chords: [[0, 210], [30, 180]] },
  // One hue, walked in brightness: a single spoke.
  shades: { dots: [90], spokes: [90] },
  // One hue, sampled along its spoke.
  monochromatic: { dots: [[90, 3.2], [90, 6.35], [90, 9.5]], spokes: [90] },
};

export function HarmonyIcon({ rule, className }: { rule: HarmonyRule; className?: string }) {
  const s = SPECS[rule];
  const at = (d: number | [number, number]) => (Array.isArray(d) ? pt(d[0], d[1]) : pt(d));

  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <circle cx={C} cy={C} r={R} stroke="currentColor" strokeWidth={STROKE} opacity="0.3" />
      {s.closed && (
        <polygon
          points={s.dots.map((d) => at(d).join(",")).join(" ")}
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinejoin="round"
        />
      )}
      {s.chords?.map(([a, b], i) => {
        const [x1, y1] = pt(a);
        const [x2, y2] = pt(b);
        return <line key={`c${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />;
      })}
      {s.spokes?.map((a, i) => {
        const [x, y] = pt(a);
        return <line key={`s${i}`} x1={C} y1={C} x2={x} y2={y} stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />;
      })}
      {s.dots.map((d, i) => {
        const [x, y] = at(d);
        return <circle key={`d${i}`} cx={x} cy={y} r={DOT} fill="currentColor" />;
      })}
    </svg>
  );
}
