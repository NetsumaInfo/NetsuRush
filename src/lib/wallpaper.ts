// Fond d'écran de l'interface : types, réglages, persistance et pose des variables CSS.
//
// Module PUR (aucun import du store) : c'est le SEUL endroit qui touche le DOM pour le fond. Les
// réglages vivent en variables CSS sur <html>, jamais en props React — sinon bouger un curseur
// re-rendrait tout l'arbre pendant le glissement, sur une app dont le thread principal décode déjà
// des aperçus vidéo.
import { FULL_CROP, cropIsFull, type CropRect } from "@/lib/cropRect";
import { IS_DETACHED_WINDOW } from "@/lib/windowKind";
import type { ThemeId } from "@/store/types";

/** Quarts de tour seulement : une rotation libre laisse des coins vides qu'aucun zoom ne rattrape. */
export type WallpaperRotation = 0 | 90 | 180 | 270;

/**
 * Rayon de flou maximal, en pixels. Le réglage est CONTINU : le flou de la couche principale est
 * rendu par le compositeur (`filter: blur()`), donc changer de rayon ne coûte pas un encodage et le
 * curseur peut répondre à la frappe. Les marches d'antan imposaient des paliers de 4 px pour une
 * raison qui n'existe plus.
 */
export const MAX_BLUR_PX = 100;

/**
 * Marches d'APPROXIMATION pour l'image que les panneaux repeignent : celle-là doit être floutée
 * dans le fichier (cf. core/wallpaper/encode.js). Miroir exact de BLUR_STEPS côté core.
 */
const WALLPAPER_SURFACE_BLUR_STEPS = [0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 80, 90, 100];

/** Rayon en px → marche encodée la plus proche, pour l'image des panneaux. */
export function surfaceBlurStep(px: number): number {
  let best = 0;
  for (let i = 1; i < WALLPAPER_SURFACE_BLUR_STEPS.length; i++) {
    const closer = Math.abs(WALLPAPER_SURFACE_BLUR_STEPS[i] - px) < Math.abs(WALLPAPER_SURFACE_BLUR_STEPS[best] - px);
    if (closer) best = i;
  }
  return best;
}

/** Un rectangle illisible (absent, hors bornes, inversé) retombe sur l'image entière. */
function normalizeCrop(raw: unknown): CropRect {
  const c = raw as Partial<CropRect> | undefined;
  const inRange = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  if (!c || !inRange(c.x) || !inRange(c.y) || !inRange(c.w) || !inRange(c.h)) return FULL_CROP;
  if ((c.w as number) <= 0 || (c.h as number) <= 0) return FULL_CROP;
  if ((c.x as number) + (c.w as number) > 1.0001 || (c.y as number) + (c.h as number) > 1.0001) return FULL_CROP;
  return { x: c.x as number, y: c.y as number, w: c.w as number, h: c.h as number };
}
/**
 * Plancher d'OPACITÉ des surfaces (le réglage porte l'opacité, pas la transparence — son libellé doit
 * dire « opacité », sinon un utilisateur monte le curseur en croyant effacer les panneaux et les rend
 * pleins).
 *
 * Sous ~45 %, le texte posé sur une photo claire passe sous 4,5:1 : le plancher a d'abord été posé
 * là. Il descend plus bas parce que la lisibilité dépend de l'IMAGE, que seul l'utilisateur voit —
 * sur un fond sombre ou très flouté, 45 % laisse encore les panneaux beaucoup trop pleins. Le seuil
 * garde donc une valeur : en dessous de zéro le panneau ne serait plus une surface du tout.
 */
export const MIN_UI_OPACITY = 15;

/** Le thème d'accessibilité n'accepte aucun fond : son contraste garanti en dépend. */
const NO_WALLPAPER_THEMES = new Set<ThemeId>(["contrast"]);

/**
 * Le fond est UN réglage, pas un par palette. Il était indexé sur le thème, si bien que passer de
 * « Sombre » à « Minuit » faisait disparaître le visuel qu'on venait de choisir — le contraire de ce
 * qu'on attend d'un fond d'écran. Un thème PERSONNALISÉ en garde une copie, puisqu'il enregistre une
 * apparence complète ; les palettes livrées, non.
 */
const STORAGE_KEY = "nr-wallpaper.v4";
/**
 * Emplacements précédents, relus une seule fois à la reprise. Tous portaient une TABLE indexée par
 * thème : on en retient le premier fond réellement choisi.
 *  - v1 : son curseur d'opacité s'appelait « Transparence de l'interface » alors qu'il portait une
 *    OPACITÉ. Les valeurs hautes enregistrées là ne sont pas un choix, ce sont les victimes du
 *    malentendu — elles retombent au défaut.
 *  - v2 : `blur` y était un INDICE de marche (0..12), pas un rayon. Relu tel quel, un « 12 »
 *    deviendrait un flou de 12 px là où l'utilisateur avait demandé 64.
 */
const LEGACY_MAP_KEYS = ["nr-wallpaper.v3", "nr-wallpaper.v2", "nr-wallpaper.v1"] as const;
const MISREAD_OPACITY_FROM = 80;
/** Échelle de marches de la v2, seule table qui donne un sens à un `blur` enregistré là-bas. */
const V2_BLUR_STEPS = [0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64];

export interface WallpaperConfig {
  /** Entrée de la bibliothèque, ou `null` = aucun fond. */
  id: string | null;
  /** Région de l'image effectivement affichée, normalisée 0..1. Remplace déplacement et zoom : un
   *  rectangle tracé SUR l'image dit exactement ce qu'on garde, deux curseurs le faisaient deviner. */
  crop: CropRect;
  rotate: WallpaperRotation;
  flipH: boolean;
  flipV: boolean;
  /** Rayon de flou en pixels, continu (0..MAX_BLUR_PX). Rendu en CSS sur la couche principale. */
  blur: number;
  opacity: number;
  saturate: number;
  /** Jouer l'animation (sans effet sur un fond fixe). */
  animate: boolean;
  /** Figer quand la fenêtre passe en arrière-plan. */
  pauseUnfocused: boolean;
  /** Figer pendant les traitements lourds (détection, upscale, export, roto…), reprise automatique. */
  pauseWhileBusy: boolean;
  /** Opacité des surfaces de l'app (fond, cartes, sidebar) — les menus restent opaques. */
  uiOpacity: number;
  /** Poser aussi le fond dans les fenêtres détachées (board de référence, carnet). */
  onDetached: boolean;
}

export const DEFAULT_WALLPAPER_CONFIG: WallpaperConfig = {
  id: null,
  crop: FULL_CROP,
  rotate: 0,
  flipH: false,
  flipV: false,
  blur: 8,
  opacity: 55,
  saturate: 100,
  animate: true,
  pauseUnfocused: true,
  pauseWhileBusy: true,
  // 60 % : l'image se lit franchement à travers les panneaux, le texte reste au-dessus de 4,5:1.
  // Au-delà de ~85 % le fond n'existe plus visuellement en dehors des marges.
  uiOpacity: 60,
  onDetached: true,
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function num(raw: unknown, fallback: number, low: number, high: number): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? clamp(Math.round(value), low, high) : fallback;
}

/** Toute valeur douteuse retombe sur le défaut : un réglage corrompu ne doit pas casser l'apparence. */
export function normalizeWallpaperConfig(raw: unknown): WallpaperConfig {
  const source = (raw ?? {}) as Partial<WallpaperConfig>;
  const d = DEFAULT_WALLPAPER_CONFIG;
  return {
    id: typeof source.id === "string" && source.id ? source.id : null,
    crop: normalizeCrop(source.crop),
    rotate: ([0, 90, 180, 270] as const).includes(source.rotate as WallpaperRotation) ? (source.rotate as WallpaperRotation) : d.rotate,
    flipH: typeof source.flipH === "boolean" ? source.flipH : d.flipH,
    flipV: typeof source.flipV === "boolean" ? source.flipV : d.flipV,
    blur: num(source.blur, d.blur, 0, MAX_BLUR_PX),
    opacity: num(source.opacity, d.opacity, 0, 100),
    saturate: num(source.saturate, d.saturate, 0, 200),
    animate: typeof source.animate === "boolean" ? source.animate : d.animate,
    pauseUnfocused: typeof source.pauseUnfocused === "boolean" ? source.pauseUnfocused : d.pauseUnfocused,
    pauseWhileBusy: typeof source.pauseWhileBusy === "boolean" ? source.pauseWhileBusy : d.pauseWhileBusy,
    uiOpacity: num(source.uiOpacity, d.uiOpacity, MIN_UI_OPACITY, 100),
    onDetached: typeof source.onDetached === "boolean" ? source.onDetached : d.onDetached,
  };
}

/** Rattrape ce qu'un emplacement précédent ne pouvait pas dire correctement. */
function migrate(config: WallpaperConfig, from: string, raw: unknown): WallpaperConfig {
  if (from === "nr-wallpaper.v3") return config; // même forme, seule l'indexation par thème disparaît
  const stepIndex = (raw as Partial<WallpaperConfig> | undefined)?.blur;
  const blur = typeof stepIndex === "number" && stepIndex >= 0 && stepIndex < V2_BLUR_STEPS.length
    ? V2_BLUR_STEPS[Math.round(stepIndex)]
    : config.blur;
  const uiOpacity = from === "nr-wallpaper.v1" && config.uiOpacity >= MISREAD_OPACITY_FROM
    ? DEFAULT_WALLPAPER_CONFIG.uiOpacity
    : config.uiOpacity;
  return { ...config, blur, uiOpacity };
}

/**
 * Aplatit une table indexée par thème en UN réglage : le premier fond réellement choisi. Sans image,
 * les autres réglages ne veulent rien dire — on repart du défaut plutôt que d'hériter d'un flou
 * appartenant à un thème dont on ne garde rien.
 */
function flattenLegacyMap(raw: Record<string, unknown>, from: string): WallpaperConfig | null {
  for (const stored of Object.values(raw)) {
    const config = migrate(normalizeWallpaperConfig(stored), from, stored);
    if (config.id) return config;
  }
  return null;
}

export function readWallpaperConfig(): WallpaperConfig {
  if (typeof localStorage === "undefined") return DEFAULT_WALLPAPER_CONFIG;
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current !== null) return normalizeWallpaperConfig(JSON.parse(current));
    for (const key of LEGACY_MAP_KEYS) {
      const stored = localStorage.getItem(key);
      if (stored === null) continue;
      const config = flattenLegacyMap(JSON.parse(stored) as Record<string, unknown>, key);
      if (!config) continue;
      writeWallpaperConfig(config); // reprise faite : la migration ne rejoue pas
      return config;
    }
    return DEFAULT_WALLPAPER_CONFIG;
  } catch {
    return DEFAULT_WALLPAPER_CONFIG;
  }
}

export function writeWallpaperConfig(config: WallpaperConfig): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* quota : l'apparence n'est pas critique */ }
}

/**
 * Un fond est actif s'il a une source, si le thème l'accepte, et si la fenêtre courante en veut.
 *
 * Le cas de la fenêtre détachée est DANS cette fonction et nulle part ailleurs : porté seulement par
 * la couche de rendu, il laissait la classe `nr-wallpaper-on` posée sur une fenêtre sans fond, donc
 * des panneaux voilés (le `--nr-wp-dim` du fond) au-dessus de rien.
 */
export function wallpaperActive(config: WallpaperConfig, theme: ThemeId): boolean {
  if (!config.id || NO_WALLPAPER_THEMES.has(theme)) return false;
  // Opacité nulle = pas de fond, donc pas de traitement du tout : sinon les panneaux gardaient leur
  // teinte translucide au-dessus de rien et l'interface n'était jamais EXACTEMENT le thème choisi.
  if (config.opacity <= 0) return false;
  // Une fenêtre détachée (board, carnet) sert à travailler par-dessus un autre logiciel : le fond y
  // est un choix, pas un acquis.
  return !IS_DETACHED_WINDOW || config.onDetached;
}

export function themeAllowsWallpaper(theme: ThemeId): boolean {
  return !NO_WALLPAPER_THEMES.has(theme);
}

export interface WallpaperMediaStyle {
  /** Déplacement, agrandissement, quart de tour et miroirs, dans cet ordre. */
  transform: string;
}

/**
 * Traduction PURE du recadrage en CSS. Seule traduction du modèle vers l'écran : la fenêtre de
 * recadrage dessine le rectangle sur l'image, le fond l'applique — une seconde traduction finirait
 * par diverger et l'aperçu mentirait.
 *
 * `transform` est lu de droite à gauche par CSS : on retourne, on tourne, on agrandit d'un facteur
 * qui amène la région choisie à la taille de la fenêtre, puis on la recentre.
 */
export function fitStyle(config: WallpaperConfig): WallpaperMediaStyle {
  const { crop } = config;
  const parts: string[] = [];
  if (!cropIsFull(crop)) {
    // La région choisie REMPLIT toujours la fenêtre : la faire « entrer » laisserait des bandes
    // vides, ce qu'aucun fond d'écran ne veut. Le débord est le prix du remplissage.
    const scale = Math.max(1 / crop.w, 1 / crop.h);
    // Le centre de la région doit tomber au centre de la fenêtre. `translate` est exprimé en % de
    // l'élément, donc APRÈS l'agrandissement : d'où le facteur `scale` dans le calcul.
    const centerX = crop.x + crop.w / 2;
    const centerY = crop.y + crop.h / 2;
    parts.push(`translate(${(-(centerX - 0.5) * scale * 100).toFixed(3)}%, ${(-(centerY - 0.5) * scale * 100).toFixed(3)}%)`);
    parts.push(`scale(${scale.toFixed(4)})`);
  }
  if (config.rotate) parts.push(`rotate(${config.rotate}deg)`);
  if (config.flipH || config.flipV) parts.push(`scale(${config.flipH ? -1 : 1}, ${config.flipV ? -1 : 1})`);
  const transform = parts.length ? parts.join(" ") : "none";
  return { transform };
}

/** Réglages numériques qui n'agissent QUE par variables CSS, donc réglables pendant un glissement. */
const WALLPAPER_LIVE_KEYS = ["blur", "opacity", "saturate", "uiOpacity"] as const;
export type WallpaperLiveKey = (typeof WALLPAPER_LIVE_KEYS)[number];

/**
 * Pose les variables CSS d'UN réglage, sans passer par le store ni le disque : le compositeur seul
 * travaille, donc le rendu suit le doigt pendant le glissement.
 *
 * Un réglage peut piloter PLUSIEURS variables — l'opacité en pilote deux, parce que les panneaux
 * repeignent le fond à partir de l'image brute et ont besoin qu'on leur rejoue le voile que la
 * couche principale applique en `opacity`. Les nommer dans le composant du curseur les ferait
 * diverger, et c'est exactement ce qui se voyait : le fond suivait, les panneaux non.
 */
export function previewWallpaperSetting(key: WallpaperLiveKey, value: number): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  if (key === "blur") style.setProperty("--nr-wp-blur", `${value}px`);
  else if (key === "saturate") style.setProperty("--nr-wp-saturate", `${value}%`);
  else if (key === "uiOpacity") style.setProperty("--nr-ui-opacity", String(value / 100));
  else {
    style.setProperty("--nr-wp-opacity", String(value / 100));
    // Le voile est de la couleur du FOND DE L'APP, jamais du noir. La couche principale pose son
    // média en `opacity` PAR-DESSUS le fond de l'app : à 40 %, on voit 60 % de `--color-bg`. Un voile
    // noir dans les panneaux les rendait donc plus SOMBRES que le thème dès qu'on baissait l'opacité,
    // et à 0 % ils viraient au noir au lieu de redevenir exactement le thème choisi.
    style.setProperty("--nr-wp-dim", `color-mix(in srgb, var(--color-bg) ${(100 - value).toFixed(1)}%, transparent)`);
  }
}

/**
 * Pose l'état complet du fond sur <html>. Appelée au démarrage, à chaque changement de thème et à
 * chaque réglage commité : rien d'autre ne touche le DOM pour le fond.
 */
export function applyWallpaperVars(config: WallpaperConfig, theme: ThemeId): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const active = wallpaperActive(config, theme);
  root.classList.toggle("nr-wallpaper-on", active);
  if (!active) return;
  for (const key of WALLPAPER_LIVE_KEYS) previewWallpaperSetting(key, config[key]);
  root.style.setProperty("--nr-wp-transform", fitStyle(config).transform);
}

/**
 * Image de repli servie aux panneaux qui SURVOLENT le contenu (tiroir latéral). Ces panneaux ne
 * peuvent pas être simplement translucides : on verrait l'interface située dessous, pas le fond. Ils
 * repeignent donc le fond eux-mêmes, à partir d'une image fixe — pour une vidéo, ce serait un second
 * décodeur pour rien.
 */
export function setWallpaperSurfaceImage(url: string | null): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--nr-wp-surface-image", url ? `url("${url}")` : "none");
}
