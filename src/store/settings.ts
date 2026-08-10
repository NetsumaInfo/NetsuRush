// Slice « paramètres » : thème de l'app. Le thème pilote l'attribut data-theme sur <html>
// (les blocs [data-theme] de src/index.css surchargent la palette de marque) et persiste en
// localStorage.
import type { StateCreator } from "zustand";
import type { DetectModel, DetectOptions } from "@/lib/bridge";
import { nr } from "@/lib/bridge";
import { DEFAULT_DETECT_OPTIONS, normalizeDetectOptions, type NormalizedDetectOptions } from "@/lib/detection";
import type { AppState } from "./index";
import { THEMES, type ThemeId } from "./types";
import { type DictateHotkey, DEFAULT_DICTATE_HOTKEY, parseHotkey } from "@/components/dictate/dictateHotkey";
import type { ShortcutMap } from "@/lib/shortcuts";
import { readCutKeys, DEFAULT_CUT_KEYS, CUT_KEYS_STORAGE } from "@/components/rushes/cutShortcuts";
import { activateLanguage, detectDefaultLang, LANG_STORAGE_KEY, type LangCode } from "@/i18n";
import { clearThumbs } from "@/lib/thumbCache";
import {
  applyWallpaperVars, DEFAULT_WALLPAPER_CONFIG, normalizeWallpaperConfig, readWallpaperConfig, writeWallpaperConfig,
  type WallpaperConfig,
} from "@/lib/wallpaper";
import {
  applyThemeColors, readThemeColors, writeThemeColors,
  type ThemeColorKey, type ThemeColorMap,
} from "@/lib/themeColors";
import {
  appearanceKey, cleanThemeName, isCustomThemeId, nextCustomThemeId, readCustomThemes, writeCustomThemes,
  type Appearance, type CustomTheme,
} from "@/lib/customThemes";
import { DEFAULT_PREVIEW_SETTINGS, readPreviewSettings, writePreviewSettings } from "@/lib/previewSettings";
import { DEFAULT_SEARCH_PERF, readSearchPerf, writeSearchPerf, type SearchPerfSettings } from "@/lib/searchPerf";
import { readFrames, writeFrames, type SamplingFrames } from "@/lib/sampling";
import type { PreviewGenerationSettings } from "@/lib/bridge";
import {
  DEFAULT_TIMELINE_INSERTIONS,
  normalizeTimelineInsertions,
  coerceTimelineInsertion,
  type TimelineHost,
  type TimelineInsertionMode,
  type TimelineInsertions,
} from "@/features/timeline/insertion";

const STORAGE_KEY = "nr-theme";
const SEARCH_CUT_MODEL_KEY = "nr-search-cut-model";
const HOVER_VOLUME_KEY = "nr-hover-volume";
const HOVER_MUTED_KEY = "nr-hover-muted";
const PLAYER_VOLUME_KEY = "nr-player-volume";
const CUT_MODEL_KEY = "nr.cut.model";
const CUT_PRESET_KEY = "nr.cut.preset";
const DETECT_OPTIONS_KEY = "nr.cut.detection-options.v1";
const CUT_GRIDPLAY_KEY = "nr.cut.gridplay";
const CUT_COLS_KEY = "nr.cols";
const CUT_PLAYEROPEN_KEY = "nr.playerOpen";
const DICTATE_HOTKEY_KEY = "nr-dictate-hotkey:v1";
const DICTATE_HOTKEY_LEGACY_KEY = "nr-dictate-hotkey";
const DICTATE_ENABLED_KEY = "nr-dictate-enabled";
const DICTATE_MODEL_KEY = "nr-dictate-model";
const DICTATE_LIVE_KEY = "nr-dictate-live";
const DICTATE_MIC_KEY = "nr-dictate-mic";
const DICTATE_UNLOAD_KEY = "nr-dictate-unload";
const TIMELINE_INSERTIONS_KEY = "nr.timeline.insertions.v1";
const CUSTOM_THEME_KEY = "nr-theme-custom";

function readTimelineInsertions(): TimelineInsertions {
  if (typeof localStorage === "undefined") return { ...DEFAULT_TIMELINE_INSERTIONS };
  try {
    const stored = localStorage.getItem(TIMELINE_INSERTIONS_KEY);
    if (stored) return normalizeTimelineInsertions(JSON.parse(stored));
    // Migration unique depuis l'ancien emplacement dans le profil d'export actif.
    const profiles = JSON.parse(localStorage.getItem("nr.export.profiles.v2") || "[]") as Array<{ id?: string; timelineInsertions?: unknown }>;
    const activeId = localStorage.getItem("nr.export.active.v2");
    const active = profiles.find((profile) => profile.id === activeId) ?? profiles[0];
    return normalizeTimelineInsertions(active?.timelineInsertions);
  }
  catch { return { ...DEFAULT_TIMELINE_INSERTIONS }; }
}

function readTheme(): ThemeId {
  if (typeof localStorage === "undefined") return "dark";
  const stored = localStorage.getItem(STORAGE_KEY) as ThemeId | null;
  return stored && THEMES.some((theme) => theme.id === stored) ? stored : "dark";
}

// Volume (0..1) de l'aperçu vidéo SURVOLÉ dans les grilles (défaut 20 %). Les aperçus en lecture
// automatique restent muets quoi qu'il arrive — seule la carte sous la souris sonne.
function readHoverVolume(): number {
  if (typeof localStorage === "undefined") return 0.2;
  const v = parseFloat(localStorage.getItem(HOVER_VOLUME_KEY) ?? "");
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.2;
}
function readHoverMuted(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(HOVER_MUTED_KEY) === "1";
}

// Volume (0..1) des GRANDS lecteurs (NetsuCut, Collections, Voix, Upscale) — une seule valeur pour
// toute l'app : régler le son quelque part le règle partout, et il survit au changement d'onglet
// (chaque onglet est démonté au changement, donc un état local serait perdu).
// Le volume est global à tous les lecteurs. Défaut produit = 20 % ; volume 0 EST le muet et est
// persisté, donc couper un lecteur coupe aussi tous les autres jusqu'à réactivation.
function readPlayerVolume(): number {
  if (typeof localStorage === "undefined") return 0.2;
  const raw = localStorage.getItem(PLAYER_VOLUME_KEY);
  if (raw == null) return 0.2;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.2;
}

// --- Défauts de NetsuCut (panneau Paramètres du module, engrenage de l'accueil) ---
// Modèle de détection sur lequel un rush s'ouvre. L'auto-sélection à l'ouverture (le modèle qui a
// DÉJÀ un cache de plans) prime : elle reflète une donnée réelle, pas une préférence.
function readCutModel(): DetectModel {
  if (typeof localStorage === "undefined") return "transnetv2";
  const stored = localStorage.getItem(CUT_MODEL_KEY);
  return stored === "omnishotcut" || stored === "autoshot" ? stored : "transnetv2";
}
// Index dans PRESETS (0 Rapide → 3 Max). Défaut 1 = Équilibré. Sans effet sous OmniShotCut (auto).
function readCutPreset(): number {
  if (typeof localStorage === "undefined") return 1;
  const v = parseInt(localStorage.getItem(CUT_PRESET_KEY) ?? "", 10);
  return Number.isFinite(v) && v >= 0 && v <= 3 ? v : 1;
}
// Lecture auto des aperçus de la grille au démarrage.
function readCutGridPlay(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(CUT_GRIDPLAY_KEY) === "1";
}
// Densité de la grille (cible de colonnes, 2..8) et lecteur de droite ouvert. Réglables à la fois
// depuis la barre du studio et le panneau Paramètres → ils vivent ICI, écrivain unique (deux
// composants qui écriraient la même clé chacun de leur côté se désynchroniseraient).
function readCutCols(): number {
  if (typeof localStorage === "undefined") return 4;
  const v = parseInt(localStorage.getItem(CUT_COLS_KEY) ?? "", 10);
  return Number.isFinite(v) && v >= 2 && v <= 8 ? v : 4;
}
function readCutPlayerOpen(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(CUT_PLAYEROPEN_KEY) !== "0";
}

// Modèle de découpe utilisé par l'indexation SigLIP (phase « découpe des plans »). Persisté à part
// du modèle de découpe Derush — c'est le défaut de la recherche, réglable dans les paramètres.
function readSearchCutModel(): DetectModel {
  if (typeof localStorage === "undefined") return "transnetv2";
  const stored = localStorage.getItem(SEARCH_CUT_MODEL_KEY);
  return stored === "omnishotcut" || stored === "autoshot" ? stored : "transnetv2";
}

function readDetectionOptions(): NormalizedDetectOptions {
  if (typeof localStorage === "undefined") return normalizeDetectOptions(DEFAULT_DETECT_OPTIONS);
  try {
    return normalizeDetectOptions(JSON.parse(localStorage.getItem(DETECT_OPTIONS_KEY) || "null"));
  } catch {
    return normalizeDetectOptions(DEFAULT_DETECT_OPTIONS);
  }
}

// Dictée globale : raccourci push-to-talk maintenu + activation. Persistés en localStorage.
function readDictateHotkey(): DictateHotkey {
  if (typeof localStorage === "undefined") return DEFAULT_DICTATE_HOTKEY;
  const stored = localStorage.getItem(DICTATE_HOTKEY_KEY);
  if (stored) return parseHotkey(stored) ?? DEFAULT_DICTATE_HOTKEY;
  const legacy = localStorage.getItem(DICTATE_HOTKEY_LEGACY_KEY);
  if (legacy) localStorage.setItem(DICTATE_HOTKEY_KEY, legacy);
  return parseHotkey(legacy) ?? DEFAULT_DICTATE_HOTKEY;
}
function readDictateEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(DICTATE_ENABLED_KEY) !== "0";
}
// Modèle ASR dédié à la dictée (indépendant du moteur de l'onglet Voix). Défaut whisper-turbo.
function readDictateModel(): string {
  if (typeof localStorage === "undefined") return "whisper-turbo";
  return localStorage.getItem(DICTATE_MODEL_KEY) || "whisper-turbo";
}
// Aperçu en direct : re-transcription périodique pendant l'écoute (texte live dans la pastille).
function readDictateLive(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(DICTATE_LIVE_KEY) !== "0";
}
// Micro choisi (deviceId MediaDevices ; "" = micro par défaut du système).
function readDictateMic(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(DICTATE_MIC_KEY) || "";
}
// Déchargement du modèle après inactivité (ms ; 0 = garder chaud en VRAM). Défaut 5 min.
function readDictateUnloadMs(): number {
  if (typeof localStorage === "undefined") return 300000;
  const v = parseInt(localStorage.getItem(DICTATE_UNLOAD_KEY) ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : 300000;
}

// Langue de l'interface (i18n). detectDefaultLang() lit la préférence sauvegardée, sinon la locale
// système mappée, sinon fr. La bascule effective des ressources i18next se fait dans setLang.
function readLang(): LangCode {
  return detectDefaultLang();
}

function applyTheme(theme: ThemeId): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

let transitionTimer: ReturnType<typeof setTimeout> | undefined;

// Crossfade : pose la classe le temps de la bascule, la retire ensuite (cf. .theme-transition CSS).
function applyThemeAnimated(theme: ThemeId): void {
  if (typeof document === "undefined") return applyTheme(theme);
  const root = document.documentElement;
  root.classList.add("theme-transition");
  applyTheme(theme);
  clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => root.classList.remove("theme-transition"), 280);
}

export interface SettingsSlice {
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
  // Fond d'écran de l'interface : UN réglage global, pas un par palette. Indexé sur le thème, il
  // disparaissait dès qu'on passait de « Sombre » à « Minuit » — le contraire de ce qu'on attend.
  wallpaper: WallpaperConfig;
  setWallpaper: (patch: Partial<WallpaperConfig>) => void;
  /** Remet les réglages du fond aux défauts, en GARDANT l'image choisie. */
  resetWallpaper: () => void;
  // Thèmes personnalisés : palette de départ + couleurs + fond, sous un nom. `customThemeId` non nul
  // signifie qu'un thème perso est actif ; `theme` porte alors sa palette de SOCLE.
  customThemes: CustomTheme[];
  customThemeId: string | null;
  /** Clé des retouches de COULEUR : le thème perso actif, sinon la palette (le fond, lui, est global). */
  themeKey: () => string;
  /** Apparence affichée en ce moment — ce qu'un thème enregistre, et ce à quoi on le compare. */
  currentAppearance: () => Appearance;
  /** Sélectionne une palette livrée OU un thème personnalisé. */
  selectTheme: (id: string) => void;
  /** Crée un thème à partir de l'apparence courante (couleurs + fond) et l'active. */
  createCustomTheme: (name: string) => void;
  /** Réenregistre l'apparence courante DANS un thème existant (bouton « Enregistrer »). */
  updateCustomTheme: (id: string) => void;
  renameCustomTheme: (id: string, name: string) => void;
  deleteCustomTheme: (id: string) => void;
  // Retouches de couleur posées PAR-DESSUS le thème courant (accent, texte, fonds, bordures).
  themeColors: ThemeColorMap;
  setThemeColor: (key: ThemeColorKey, value: string | null) => void;
  resetThemeColors: () => void;
  // Langue de l'interface (fr/en/es/de/ja/zh). Bascule à chaud les ressources i18next.
  lang: LangCode;
  setLang: (l: LangCode) => void;
  // Modèle de découpe de la recherche SigLIP (défaut d'indexation).
  searchCutModel: DetectModel;
  setSearchCutModel: (m: DetectModel) => void;
  // Aperçu au survol : volume du son (0..1) + coupure globale.
  hoverVolume: number;
  setHoverVolume: (v: number) => void;
  hoverMuted: boolean;
  setHoverMuted: (m: boolean) => void;
  // Volume de lecture partagé par toute l'app (0 = muet global persistant).
  playerVolume: number;
  setPlayerVolume: (v: number) => void;
  previewSettings: PreviewGenerationSettings;
  setPreviewSettings: (settings: PreviewGenerationSettings) => void;
  resetPreviewSettings: () => void;
  // Options de performance de la recherche (partagées avec les autres fenêtres, cf. useSharedPrefs).
  searchPerf: SearchPerfSettings;
  setSearchPerf: (patch: Partial<SearchPerfSettings>) => void;
  resetSearchPerf: () => void;
  // Images analysées par plan à l'indexation (1 à 3). Où les prendre est décidé par le service.
  searchFrames: SamplingFrames;
  setSearchFrames: (frames: SamplingFrames) => void;
  // Raccourcis clavier de NetsuCut (action → combo), édités depuis l'accueil du module.
  cutKeys: ShortcutMap;
  setCutKeys: (k: ShortcutMap) => void;
  resetCutKeys: () => void;
  // Défauts de NetsuCut (panneau Paramètres du module).
  cutModel: DetectModel;
  setCutModel: (m: DetectModel) => void;
  cutPreset: number;
  setCutPreset: (i: number) => void;
  detectionOptions: NormalizedDetectOptions;
  setDetectionOptions: (options: DetectOptions) => void;
  resetDetectionOptions: () => void;
  cutGridPlay: boolean;
  setCutGridPlay: (on: boolean) => void;
  cutCols: number;
  setCutCols: (n: number) => void;
  cutPlayerOpen: boolean;
  setCutPlayerOpen: (on: boolean) => void;
  timelineInsertions: TimelineInsertions;
  setTimelineInsertion: (host: TimelineHost, mode: TimelineInsertionMode) => void;
  // Dictée globale push-to-talk : raccourci maintenu + activation.
  dictateHotkey: DictateHotkey;
  setDictateHotkey: (h: DictateHotkey) => void;
  dictateEnabled: boolean;
  setDictateEnabled: (on: boolean) => void;
  dictateModel: string;
  setDictateModel: (id: string) => void;
  dictateLive: boolean;
  setDictateLive: (on: boolean) => void;
  dictateMic: string;
  setDictateMic: (id: string) => void;
  dictateUnloadMs: number;
  setDictateUnloadMs: (ms: number) => void;
}

export const createSettingsSlice: StateCreator<AppState, [], [], SettingsSlice> = (set, get) => {
  const initial = readTheme();
  const initialWallpaper = readWallpaperConfig();
  const initialThemeColors = readThemeColors();
  const initialCustomThemes = readCustomThemes();
  const storedCustomId = typeof localStorage === "undefined" ? null : localStorage.getItem(CUSTOM_THEME_KEY);
  const initialCustom = initialCustomThemes.find((theme) => theme.id === storedCustomId) ?? null;
  const initialKey = initialCustom?.id ?? initial;
  const initialPalette = initialCustom?.base ?? initial;
  applyTheme(initialPalette);
  applyThemeColors(initialThemeColors[initialKey]);
  applyWallpaperVars(initialWallpaper, initialPalette);

  /** Pose palette + couleurs + fond d'un coup : les trois doivent bouger ensemble ou pas du tout. */
  const applyAppearance = (palette: ThemeId, colorKey: string, wallpaper: WallpaperConfig, state: AppState) => {
    applyThemeAnimated(palette);
    applyThemeColors(state.themeColors[colorKey]);
    applyWallpaperVars(wallpaper, palette);
  };

  return {
    theme: initial,
    customThemes: initialCustomThemes,
    customThemeId: initialCustom?.id ?? null,
    themeKey: () => {
      const { customThemeId, theme } = get();
      return appearanceKey(theme, customThemeId);
    },
    currentAppearance: () => {
      const state = get();
      return {
        base: state.theme,
        colors: { ...(state.themeColors[appearanceKey(state.theme, state.customThemeId)] ?? {}) },
        wallpaper: state.wallpaper,
      };
    },
    setTheme: (theme) => {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, theme);
        localStorage.removeItem(CUSTOM_THEME_KEY);
      }
      // Choisir une palette livrée QUITTE le thème personnalisé : sinon ses couleurs resteraient
      // posées par-dessus et la palette choisie n'apparaîtrait jamais telle qu'elle est. Le FOND, lui,
      // ne bouge pas : il est global, et le voir disparaître à chaque essai de palette est absurde.
      applyAppearance(theme, theme, get().wallpaper, { ...get(), customThemeId: null } as AppState);
      set({ theme, customThemeId: null });
    },
    selectTheme: (id) => {
      if (!isCustomThemeId(id)) return get().setTheme(id as ThemeId);
      const custom = get().customThemes.find((theme) => theme.id === id);
      if (!custom) return;
      if (typeof localStorage !== "undefined") localStorage.setItem(CUSTOM_THEME_KEY, id);
      // Rappeler un thème RESTAURE son fond : c'est une apparence enregistrée, pas une simple palette.
      writeWallpaperConfig(custom.wallpaper);
      applyAppearance(custom.base, custom.id, custom.wallpaper, get());
      set({ theme: custom.base, customThemeId: custom.id, wallpaper: custom.wallpaper });
    },
    createCustomTheme: (name) => {
      const state = get();
      const id = nextCustomThemeId(state.customThemes);
      // Le thème CAPTURE l'apparence courante : on nomme ce qu'on voit, on ne repart pas de zéro.
      const custom: CustomTheme = { id, name: cleanThemeName(name, id), ...state.currentAppearance() };
      const themes = [...state.customThemes, custom];
      const colors = { ...state.themeColors, [id]: custom.colors };
      writeCustomThemes(themes);
      writeThemeColors(colors);
      if (typeof localStorage !== "undefined") localStorage.setItem(CUSTOM_THEME_KEY, id);
      set({ customThemes: themes, themeColors: colors, customThemeId: id });
      applyAppearance(custom.base, id, custom.wallpaper, get());
    },
    updateCustomTheme: (id) => {
      const state = get();
      if (!state.customThemes.some((theme) => theme.id === id)) return;
      const appearance = state.currentAppearance();
      const themes = state.customThemes.map((theme) => (theme.id === id ? { ...theme, ...appearance } : theme));
      // Les retouches de couleur vivent sous la clé du thème ACTIF : les recopier sous son id garde
      // les deux d'accord quand on enregistre depuis une palette livrée.
      const colors = { ...state.themeColors, [id]: appearance.colors };
      writeCustomThemes(themes);
      writeThemeColors(colors);
      set({ customThemes: themes, themeColors: colors });
    },
    renameCustomTheme: (id, name) => {
      const themes = get().customThemes.map((theme) =>
        theme.id === id ? { ...theme, name: cleanThemeName(name, theme.name) } : theme);
      writeCustomThemes(themes);
      set({ customThemes: themes });
    },
    deleteCustomTheme: (id) => {
      const state = get();
      const themes = state.customThemes.filter((theme) => theme.id !== id);
      const colors = { ...state.themeColors };
      delete colors[id];
      writeCustomThemes(themes);
      writeThemeColors(colors);
      set({ customThemes: themes, themeColors: colors });
      // Supprimer le thème ACTIF ramène à sa palette de socle, jamais à un écran sans apparence.
      if (state.customThemeId === id) get().setTheme(state.theme);
    },
    wallpaper: initialWallpaper,
    setWallpaper: (patch) => {
      const next = normalizeWallpaperConfig({ ...get().wallpaper, ...patch });
      writeWallpaperConfig(next);
      applyWallpaperVars(next, get().theme);
      set({ wallpaper: next });
    },
    themeColors: initialThemeColors,
    setThemeColor: (color, value) => {
      const { themeColors } = get();
      const key = get().themeKey();
      const current = { ...(themeColors[key] ?? {}) };
      if (value) current[color] = value;
      else delete current[color];
      const all = { ...themeColors, [key]: current };
      writeThemeColors(all);
      applyThemeColors(current);
      set({ themeColors: all });
    },
    resetThemeColors: () => {
      const { themeColors } = get();
      const key = get().themeKey();
      const all = { ...themeColors, [key]: {} };
      writeThemeColors(all);
      applyThemeColors({});
      set({ themeColors: all });
    },
    resetWallpaper: () => {
      // L'image est conservée : « réinitialiser » vise les réglages, pas le choix du visuel — sinon
      // le bouton devient une suppression déguisée.
      const next = { ...DEFAULT_WALLPAPER_CONFIG, id: get().wallpaper.id };
      writeWallpaperConfig(next);
      applyWallpaperVars(next, get().theme);
      set({ wallpaper: next });
    },
    lang: readLang(),
    setLang: (lang) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(LANG_STORAGE_KEY, lang);
      void activateLanguage(lang); // bascule à chaud les ressources i18next + attribut <html lang>
      // Copie durable dans nr.config.json (best-effort ; lue au prochain boot du core). No-op hors app.
      nr.configSetLang?.(lang).catch(() => {});
      set({ lang });
    },
    searchCutModel: readSearchCutModel(),
    setSearchCutModel: (searchCutModel) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(SEARCH_CUT_MODEL_KEY, searchCutModel);
      set({ searchCutModel });
    },
    hoverVolume: readHoverVolume(),
    setHoverVolume: (hoverVolume) => {
      const v = Math.min(1, Math.max(0, hoverVolume));
      if (typeof localStorage !== "undefined") localStorage.setItem(HOVER_VOLUME_KEY, String(v));
      set({ hoverVolume: v });
    },
    hoverMuted: readHoverMuted(),
    setHoverMuted: (hoverMuted) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(HOVER_MUTED_KEY, hoverMuted ? "1" : "0");
      set({ hoverMuted });
    },
    playerVolume: readPlayerVolume(),
    setPlayerVolume: (playerVolume) => {
      const v = Math.min(1, Math.max(0, playerVolume));
      if (typeof localStorage !== "undefined") localStorage.setItem(PLAYER_VOLUME_KEY, String(v));
      set({ playerVolume: v });
    },
    previewSettings: readPreviewSettings(),
    setPreviewSettings: (settings) => {
      const previewSettings = writePreviewSettings(settings);
      clearThumbs();
      set({ previewSettings });
    },
    resetPreviewSettings: () => {
      const previewSettings = writePreviewSettings(DEFAULT_PREVIEW_SETTINGS);
      clearThumbs();
      set({ previewSettings });
    },
    searchPerf: readSearchPerf(),
    setSearchPerf: (patch) => set({ searchPerf: writeSearchPerf({ ...get().searchPerf, ...patch }) }),
    resetSearchPerf: () => set({ searchPerf: writeSearchPerf(DEFAULT_SEARCH_PERF) }),
    searchFrames: readFrames(),
    setSearchFrames: (frames) => set({ searchFrames: writeFrames(frames) }),
    cutKeys: readCutKeys(),
    setCutKeys: (cutKeys) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(CUT_KEYS_STORAGE, JSON.stringify(cutKeys));
      set({ cutKeys });
    },
    resetCutKeys: () => {
      if (typeof localStorage !== "undefined") localStorage.removeItem(CUT_KEYS_STORAGE);
      set({ cutKeys: { ...DEFAULT_CUT_KEYS } });
    },
    cutModel: readCutModel(),
    setCutModel: (cutModel) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(CUT_MODEL_KEY, cutModel);
      set({ cutModel });
    },
    cutPreset: readCutPreset(),
    setCutPreset: (cutPreset) => {
      const i = Math.min(3, Math.max(0, Math.round(cutPreset)));
      if (typeof localStorage !== "undefined") localStorage.setItem(CUT_PRESET_KEY, String(i));
      set({ cutPreset: i });
    },
    detectionOptions: readDetectionOptions(),
    setDetectionOptions: (options) => {
      const detectionOptions = normalizeDetectOptions(options);
      if (typeof localStorage !== "undefined") localStorage.setItem(DETECT_OPTIONS_KEY, JSON.stringify(detectionOptions));
      set({ detectionOptions });
    },
    resetDetectionOptions: () => {
      const detectionOptions = normalizeDetectOptions(DEFAULT_DETECT_OPTIONS);
      if (typeof localStorage !== "undefined") localStorage.removeItem(DETECT_OPTIONS_KEY);
      set({ detectionOptions });
    },
    cutGridPlay: readCutGridPlay(),
    setCutGridPlay: (cutGridPlay) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(CUT_GRIDPLAY_KEY, cutGridPlay ? "1" : "0");
      set({ cutGridPlay });
    },
    cutCols: readCutCols(),
    setCutCols: (cutCols) => {
      const n = Math.min(8, Math.max(2, Math.round(cutCols)));
      if (typeof localStorage !== "undefined") localStorage.setItem(CUT_COLS_KEY, String(n));
      set({ cutCols: n });
    },
    cutPlayerOpen: readCutPlayerOpen(),
    setCutPlayerOpen: (cutPlayerOpen) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(CUT_PLAYEROPEN_KEY, cutPlayerOpen ? "1" : "0");
      set({ cutPlayerOpen });
    },
    timelineInsertions: readTimelineInsertions(),
    setTimelineInsertion: (host, mode) => set((state) => {
      const timelineInsertions = { ...state.timelineInsertions, [host]: coerceTimelineInsertion(host, mode) };
      if (typeof localStorage !== "undefined") localStorage.setItem(TIMELINE_INSERTIONS_KEY, JSON.stringify(timelineInsertions));
      return { timelineInsertions };
    }),
    dictateHotkey: readDictateHotkey(),
    setDictateHotkey: (dictateHotkey) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(DICTATE_HOTKEY_KEY, JSON.stringify(dictateHotkey));
      set({ dictateHotkey });
    },
    dictateEnabled: readDictateEnabled(),
    setDictateEnabled: (dictateEnabled) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(DICTATE_ENABLED_KEY, dictateEnabled ? "1" : "0");
      set({ dictateEnabled });
    },
    dictateModel: readDictateModel(),
    setDictateModel: (dictateModel) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(DICTATE_MODEL_KEY, dictateModel);
      set({ dictateModel });
    },
    dictateLive: readDictateLive(),
    setDictateLive: (dictateLive) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(DICTATE_LIVE_KEY, dictateLive ? "1" : "0");
      set({ dictateLive });
    },
    dictateMic: readDictateMic(),
    setDictateMic: (dictateMic) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(DICTATE_MIC_KEY, dictateMic);
      set({ dictateMic });
    },
    dictateUnloadMs: readDictateUnloadMs(),
    setDictateUnloadMs: (dictateUnloadMs) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(DICTATE_UNLOAD_KEY, String(dictateUnloadMs));
      set({ dictateUnloadMs });
    },
  };
};
