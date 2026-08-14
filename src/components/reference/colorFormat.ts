// Formats d'écriture d'une couleur de palette. Un moodboard sert à ALIMENTER un autre outil : on y
// prend une teinte pour la coller dans une feuille de style, un correcteur Resolve, Photoshop ou
// Figma — et chacun attend sa notation. N'offrir que l'hexadécimal obligeait à convertir à la main.
//
// Les cinq retenus couvrent l'essentiel : hex et rgb (web, partout), hsl (CSS, raisonnement en
// teinte/saturation), hsb (le « TSL » des logiciels de dessin — Photoshop, Krita, sélecteurs de
// couleur), oklch (CSS moderne, perceptuellement uniforme). Chaîne rendue = chaîne COPIÉE : ce qui
// est affiché se colle tel quel.
//
// Aucune dépendance : les conversions tiennent en quelques lignes et éviter un paquet de plus sur un
// besoin aussi restreint est le bon arbitrage.

export const COLOR_FORMATS = ["hex", "rgb", "hsl", "hsb", "oklch"] as const;
export type ColorFormat = (typeof COLOR_FORMATS)[number];

// Libellé du sélecteur : le nom du format, en majuscules, tel qu'on le nomme partout ailleurs.
export const COLOR_FORMAT_LABEL: Record<ColorFormat, string> = {
  hex: "HEX", rgb: "RGB", hsl: "HSL", hsb: "HSB", oklch: "OKLCH",
};

/** Composantes 0–255 d'une couleur `#rrggbb` (ou `#rgb`). Rend null si la chaîne n'est pas lisible. */
export function rgbFromHex(hex: string): { r: number; g: number; b: number } | null {
  const s = hex.trim().replace(/^#/, "");
  const full = s.length === 3 ? s.replace(/./g, (c) => c + c) : s;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Teinte/saturation communes à HSL et HSB : mêmes max/min, seule la 3e composante diverge.
function hueChroma(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, max, min, d };
}

// sRGB → OKLab → OKLCH (Björn Ottosson). Le passage par le linéaire est indispensable : appliquer la
// matrice sur du sRGB encodé en gamma donnerait des teintes fausses.
function oklch(r255: number, g255: number, b255: number) {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(r255), g = lin(g255), b = lin(b255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.sqrt(a * a + bb * bb);
  let H = (Math.atan2(bb, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Couleur `#rrggbb` écrite dans `format`. Une chaîne illisible est rendue telle quelle. */
export function formatColor(hex: string, format: ColorFormat = "hex"): string {
  const c = rgbFromHex(hex);
  if (!c) return hex;
  if (format === "hex") return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  if (format === "rgb") return `rgb(${c.r}, ${c.g}, ${c.b})`;
  if (format === "oklch") {
    const { L, C, H } = oklch(c.r, c.g, c.b);
    return `oklch(${pct(L)} ${C.toFixed(3)} ${Math.round(H)})`;
  }
  const { h, max, min, d } = hueChroma(c.r / 255, c.g / 255, c.b / 255);
  if (format === "hsb") {
    // HSB (= HSV) : la « brightness » est le canal maximal, pas la moyenne des extrêmes de HSL.
    return `hsb(${Math.round(h)}, ${pct(max ? d / max : 0)}, ${pct(max)})`;
  }
  const l = (max + min) / 2;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return `hsl(${Math.round(h)}, ${pct(sat)}, ${pct(l)})`;
}
