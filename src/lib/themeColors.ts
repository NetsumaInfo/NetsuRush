// Retouches de couleur par-dessus un thème : l'utilisateur reprend la main sur l'accent, le texte,
// les fonds, sans écrire de CSS ni quitter le thème choisi.
//
// Module PUR (aucun import du store). Les valeurs sont posées en variables inline sur <html> : elles
// gagnent donc sur le bloc `[data-theme="…"]` de la feuille de style, qui reste la référence par
// défaut. Retirer une retouche suffit à retrouver le thème d'origine — rien n'est réécrit.
/** Ce qu'on autorise à retoucher. Volontairement court : ces cinq variables portent l'identité
 *  visuelle, et le reste de la palette en dérive dans `index.css`. */
export const THEME_COLOR_KEYS = ["primary", "fg", "bg", "surface", "border"] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

export type ThemeColorOverrides = Partial<Record<ThemeColorKey, string>>;
/** Clé = palette livrée OU thème personnalisé. */
export type ThemeColorMap = Partial<Record<string, ThemeColorOverrides>>;

const STORAGE_KEY = "nr-theme-colors.v1";
/** Seuil de luminance relative au-delà duquel un texte noir passe mieux qu'un texte blanc. */
const LIGHT_LUMINANCE = 0.55;

const VAR_NAME: Record<ThemeColorKey, string> = {
  primary: "--color-primary",
  fg: "--color-fg",
  bg: "--color-bg",
  surface: "--color-surface",
  border: "--color-border",
};

/** #rgb / #rrggbb → composantes 0..255. Toute autre notation renvoie `null` (pas de devinette). */
function parseHex(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

/** Luminance relative (WCAG) : sert à choisir un texte lisible SUR la couleur choisie. */
function relativeLuminance(color: string): number | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Texte à poser SUR l'accent. Calculé, jamais figé : un accent jaune avec un `--color-primary-fg`
 * blanc resté en dur devient illisible sur les boutons primaires.
 */
export function foregroundFor(color: string): string | null {
  const luminance = relativeLuminance(color);
  if (luminance === null) return null;
  return luminance > LIGHT_LUMINANCE ? "#0a0a0c" : "#ffffff";
}

/**
 * Pose UNE variable, sans toucher au store ni au disque. Sert pendant le glissement dans le
 * sélecteur : le rendu suit le doigt (le compositeur seul travaille) alors qu'un aller-retour par le
 * store réécrirait localStorage et re-rendrait la page à chaque frame.
 */
export function applyThemeColorVar(key: ThemeColorKey, value: string | null): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  if (value) style.setProperty(VAR_NAME[key], value);
  else style.removeProperty(VAR_NAME[key]);
  if (key !== "primary") return;
  const accentForeground = value ? foregroundFor(value) : null;
  if (accentForeground) style.setProperty("--color-primary-fg", accentForeground);
  else style.removeProperty("--color-primary-fg");
}

export function readThemeColors(): ThemeColorMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, unknown>;
    const out: ThemeColorMap = {};
    for (const [theme, overrides] of Object.entries(raw)) {
      const clean: ThemeColorOverrides = {};
      for (const key of THEME_COLOR_KEYS) {
        const value = (overrides as ThemeColorOverrides | undefined)?.[key];
        if (typeof value === "string" && parseHex(value)) clean[key] = value;
      }
      if (Object.keys(clean).length) out[theme] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeThemeColors(map: ThemeColorMap): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* quota : l'apparence n'est pas critique */ }
}

/**
 * Applique (ou retire) les retouches du thème courant. Seul point qui touche le DOM pour les
 * couleurs — appelé au démarrage, à chaque changement de thème et à chaque retouche.
 */
export function applyThemeColors(overrides: ThemeColorOverrides | undefined): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  for (const key of THEME_COLOR_KEYS) {
    const value = overrides?.[key];
    if (value) style.setProperty(VAR_NAME[key], value);
    else style.removeProperty(VAR_NAME[key]);
  }
  // Le texte posé sur l'accent suit l'accent, sinon un accent clair rend les boutons primaires
  // illisibles. Sans retouche d'accent, on rend la main au thème.
  const accentForeground = overrides?.primary ? foregroundFor(overrides.primary) : null;
  if (accentForeground) style.setProperty("--color-primary-fg", accentForeground);
  else style.removeProperty("--color-primary-fg");
}
