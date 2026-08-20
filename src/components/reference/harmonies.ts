// Color-wheel math for the palette studio: HSV conversions, harmony rules, tone ramps.
// Pure functions, no dependency. The wheel is the classic HSV disk (angle = hue, radius =
// saturation); value is carried per slot so a brightness tweak survives a wheel drag.

import { rgbFromHex } from "./colorFormat";

/** h in degrees 0–360, s and v in 0–1. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

// One color of the working palette. `locked` shields it from harmony re-derivation,
// randomize and wheel drags — the Adobe padlock.
export interface Slot extends Hsv {
  locked: boolean;
}

// The nine rules of the Adobe wheel, in its display order. "custom" derives nothing.
export const HARMONY_RULES = [
  "custom", "analogous", "complementary", "split", "triadic",
  "square", "compound", "shades", "monochromatic",
] as const;
export type HarmonyRule = (typeof HARMONY_RULES)[number];

const mod360 = (h: number) => ((h % 360) + 360) % 360;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function hsvFromHex(hex: string): Hsv {
  const c = rgbFromHex(hex) ?? { r: 128, g: 128, b: 128 };
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: mod360(h), s: max === 0 ? 0 : d / max, v: max };
}

export function hexFromHsv({ h, s, v }: Hsv): string {
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  const to = (x: number) => Math.round(clamp01(x) * 255).toString(16).padStart(2, "0");
  return `#${to(f(5))}${to(f(3))}${to(f(1))}`;
}

// Hue offset of slot `i` relative to the rule's base color. Patterns shorter than the
// palette repeat (a 5-swatch triad yields 0/120/240/0/120); the repeat is told apart by
// the tone ladder below, not by hue.
const PATTERNS: Partial<Record<HarmonyRule, number[]>> = {
  complementary: [0, 180],
  split: [0, 150, 210],
  triadic: [0, 120, 240],
  square: [0, 90, 180, 270],
  compound: [0, 30, 180, 210],
};

function offsetAt(rule: HarmonyRule, i: number, n: number): number {
  if (rule === "analogous") return (i - (n - 1) / 2) * 25; // symmetric fan, 25° apart
  const p = PATTERNS[rule];
  return p ? p[i % p.length] : 0;
}

// How many earlier slots share this slot's hue offset (0 for the first occurrence).
function occurrence(rule: HarmonyRule, i: number): number {
  const p = PATTERNS[rule];
  return p ? Math.floor(i / p.length) : 0;
}

// Full re-derivation from the anchor slot: hue offsets AND fresh tone ladders. Used when
// the rule changes, a swatch is added, or the palette is randomized. Locked slots survive.
export function applyRule(rule: HarmonyRule, slots: Slot[], anchor: number): Slot[] {
  if (rule === "custom" || !slots.length) return slots;
  const n = slots.length;
  const base = slots[Math.min(anchor, n - 1)];
  const baseOff = offsetAt(rule, Math.min(anchor, n - 1), n);
  return slots.map((slot, i) => {
    if (slot.locked || i === anchor) return slot;
    if (rule === "shades") {
      // Same hue and saturation, value ladder from light to dark across the strip.
      const v = clamp01(0.95 - (i / Math.max(1, n - 1)) * 0.7);
      return { ...slot, h: base.h, s: base.s, v };
    }
    if (rule === "monochromatic") {
      // Same hue; alternate full and washed saturation while descending in value.
      const v = clamp01(1 - (i / Math.max(1, n - 1)) * 0.55);
      const s = i % 2 ? clamp01(base.s * 0.35) : base.s;
      return { ...slot, h: base.h, s, v };
    }
    const k = occurrence(rule, i);
    return {
      ...slot,
      h: mod360(base.h + offsetAt(rule, i, n) - baseOff),
      s: clamp01(base.s * (1 - 0.12 * k)),
      v: clamp01(base.v * (1 - 0.15 * k)),
    };
  });
}

// Light re-derivation while a handle is dragged: hue (and saturation for the tone rules)
// follows the dragged slot, but every slot keeps its own value and saturation so per-slot
// tweaks are not flattened mid-gesture.
export function followAnchor(rule: HarmonyRule, slots: Slot[], anchor: number): Slot[] {
  if (rule === "custom" || !slots.length) return slots;
  const n = slots.length;
  const base = slots[Math.min(anchor, n - 1)];
  const baseOff = offsetAt(rule, Math.min(anchor, n - 1), n);
  return slots.map((slot, i) => {
    if (slot.locked || i === anchor) return slot;
    if (rule === "shades") return { ...slot, h: base.h, s: base.s };
    if (rule === "monochromatic") return { ...slot, h: base.h };
    return { ...slot, h: mod360(base.h + offsetAt(rule, i, n) - baseOff) };
  });
}

// Tone ramp of a color: light pastel to deep shade, hue untouched. Feeds the strip that
// lets one pick a variant of the active swatch.
export function tonesOf(color: Hsv, count = 7): Hsv[] {
  return Array.from({ length: count }, (_, i) => {
    const t = count > 1 ? i / (count - 1) : 0;
    return { h: color.h, s: clamp01(color.s * (0.25 + 0.75 * t)), v: clamp01(0.98 - 0.75 * t) };
  });
}
