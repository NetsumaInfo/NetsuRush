// Préférences du module Carnet (persistées localStorage, partagées entre carnets) : apparence de la
// page, comportement de l'éditeur et raccourcis clavier rebindables. Structure miroir de boardPrefs.
import { DEFAULT_NOTEBOOK_SHORTCUT_KEYS } from "./notebookShortcuts";

export type NbPageWidth = "narrow" | "medium" | "wide" | "full";
// Classe Tailwind du conteneur d'édition selon la largeur choisie.
export const PAGE_WIDTH_CLASS: Record<NbPageWidth, string> = {
  narrow: "max-w-2xl", medium: "max-w-3xl", wide: "max-w-5xl", full: "max-w-none",
};

export interface NotebookPrefs {
  shortcutKeys: Record<string, string>;  // action → combo (rebindable dans les Paramètres)
  pageWidth: NbPageWidth;                // largeur du document
  fontScale: number;                     // échelle de police de l'éditeur (0.85 – 1.3)
  showBreadcrumb: boolean;               // fil d'Ariane au-dessus du document
  autosaveMs: number;                    // délai d'autosave (débounce)
  confirmDelete: boolean;                // demander confirmation avant d'envoyer à la corbeille
  spellcheck: boolean;                   // correcteur orthographique (dictionnaire fr/en embarqué)
  sidebarOpen: boolean;                  // sidebar visible (Ctrl+\ la replie)
  sidebarWidth: number;                  // largeur de la sidebar (px, redimensionnable)
}

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 380;

export const PREFS_KEY = "nr-nb-prefs";

const PREFS_DEFAULT: NotebookPrefs = {
  shortcutKeys: { ...DEFAULT_NOTEBOOK_SHORTCUT_KEYS },
  pageWidth: "medium",
  fontScale: 1,
  showBreadcrumb: true,
  autosaveMs: 700,
  confirmDelete: true,
  spellcheck: true,
  sidebarOpen: true,
  sidebarWidth: 256,
};

// Lit les prefs (merge sur les défauts : les nouvelles clés apparaissent sans casser l'existant).
export function readPrefs(): NotebookPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || "");
    if (v && typeof v === "object") {
      return {
        ...PREFS_DEFAULT,
        ...v,
        shortcutKeys: { ...DEFAULT_NOTEBOOK_SHORTCUT_KEYS, ...(v.shortcutKeys || {}) },
      };
    }
  } catch { /* prefs absentes/corrompues → défauts */ }
  return { ...PREFS_DEFAULT, shortcutKeys: { ...DEFAULT_NOTEBOOK_SHORTCUT_KEYS } };
}
