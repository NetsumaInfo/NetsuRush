// Thèmes personnalisés : un nom, une palette de départ, des couleurs retouchées et un fond d'écran.
//
// Un thème perso n'est PAS une douzième palette CSS : il s'appuie sur une palette livrée (`base`) et
// la retouche. Générer un bloc `[data-theme]` à la volée obligerait à injecter du CSS au runtime et à
// garantir soi-même les contrastes des dix variables dérivées — alors qu'une base éprouvée + des
// retouches ciblées donnent le même résultat avec un plancher de qualité.
//
// Module PUR : aucun import du store, aucune écriture DOM.
import type { ThemeColorOverrides } from "@/lib/themeColors";
import { normalizeWallpaperConfig, type WallpaperConfig } from "@/lib/wallpaper";
import type { ThemeId } from "@/store/types";

export interface CustomTheme {
  /** Préfixé pour ne jamais entrer en collision avec un identifiant de palette livrée. */
  id: string;
  name: string;
  /** Palette livrée servant de socle : elle fournit tout ce que les retouches ne couvrent pas. */
  base: ThemeId;
  colors: ThemeColorOverrides;
  /**
   * Fond d'écran COMPLET, pas seulement son image : un thème enregistre une apparence, et le flou ou
   * l'opacité en font autant partie que le visuel. Le fond « courant » est global (cf. wallpaper.ts) ;
   * celui-ci en est une copie figée, restaurée quand on rappelle le thème.
   */
  wallpaper: WallpaperConfig;
}

/** Ce qu'un thème capture. Sert à créer, à mettre à jour, et à comparer pour savoir s'il a bougé. */
export interface Appearance {
  base: ThemeId;
  colors: ThemeColorOverrides;
  wallpaper: WallpaperConfig;
}

/** Le thème enregistré correspond-il à ce qui est affiché ? Décide si « Enregistrer » a un sens. */
export function appearanceMatches(theme: CustomTheme, current: Appearance): boolean {
  return theme.base === current.base
    && JSON.stringify(theme.colors) === JSON.stringify(current.colors)
    && JSON.stringify(theme.wallpaper) === JSON.stringify(current.wallpaper);
}

const STORAGE_KEY = "nr-custom-themes.v1";
export const CUSTOM_THEME_PREFIX = "custom:";
const MAX_NAME = 40;

export function isCustomThemeId(id: string): boolean {
  return id.startsWith(CUSTOM_THEME_PREFIX);
}

/** Nom nettoyé et borné. Un nom vide retombe sur un libellé neutre plutôt que sur une carte muette. */
export function cleanThemeName(raw: string, fallback: string): string {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return name || fallback;
}

export function readCustomThemes(): CustomTheme[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry): entry is CustomTheme =>
        Boolean(entry)
        && typeof (entry as CustomTheme).id === "string"
        && isCustomThemeId((entry as CustomTheme).id)
        && typeof (entry as CustomTheme).name === "string"
        && typeof (entry as CustomTheme).base === "string")
      // Un thème enregistré avant que le fond ne soit capturé en entier n'en portait que l'image :
      // on la garde, le reste retombe sur les défauts plutôt que sur rien du tout.
      .map((entry) => {
        const legacyId = (entry as unknown as { wallpaperId?: string | null }).wallpaperId ?? null;
        const { wallpaperId: _dropped, ...theme } = entry as CustomTheme & { wallpaperId?: string | null };
        return { ...theme, wallpaper: normalizeWallpaperConfig(entry.wallpaper ?? { id: legacyId }) };
      });
  } catch {
    return [];
  }
}

export function writeCustomThemes(themes: CustomTheme[]): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(themes)); } catch { /* quota : l'apparence n'est pas critique */ }
}

/** Identifiant STABLE et unique : il sert de clé aux réglages de fond et de couleurs. */
export function nextCustomThemeId(existing: CustomTheme[]): string {
  const used = new Set(existing.map((theme) => theme.id));
  for (let n = 1; ; n++) {
    const id = `${CUSTOM_THEME_PREFIX}${n}`;
    if (!used.has(id)) return id;
  }
}

/**
 * Clé sous laquelle vivent les réglages (fond, couleurs) : le thème personnalisé actif, sinon la
 * palette. Fonction PURE pour être appelée depuis un sélecteur de store — les écritures et les
 * lectures DOIVENT passer par elle, sinon on modifie un thème pendant qu'on en affiche un autre.
 */
export function appearanceKey(theme: string, customThemeId: string | null): string {
  return customThemeId ?? theme;
}
