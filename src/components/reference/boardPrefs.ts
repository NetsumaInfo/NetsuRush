// Préférences/réglages PERSISTÉS du board (localStorage). Pures fonctions de lecture/écriture +
// types + valeurs par défaut, isolées du store : fond du board, enregistrement auto, cadre de pose,
// et préférences globales (favoris polices, défauts des notes, navigation). Le store (useReferenceBoard)
// initialise son état avec ces `read*` et persiste via les clés exportées.

import type { UpscaleModel, ShaderModel, NetsuLevel, NetsuQuality } from "@/lib/bridge";
import { mergeKeys } from "@/lib/shortcuts";
import {
  HANDWRITING_FONT, DEFAULT_DRAW_KEYS, DEFAULT_SHORTCUT_KEYS, DOWNLOADABLE_EMBED_PROVIDERS,
  type DrawKeys, type ShortcutKeys, type EmbedProvider,
} from "./referenceShared";

// Cadence d'échantillonnage « même que la source » : l'extraction relit la vraie cadence de la vidéo
// au lieu de rééchantillonner. Sentinelle plutôt qu'un champ à part → un seul réglage à lire.
export const SOURCE_FPS = 0;

// Fond du board : grille de points (repère spatial) ou aplat monochrome.
export interface BoardBg {
  mode: "dots" | "solid";
  color: string;
}
export const BG_KEY = "nr-ref-bg";
export function readBg(): BoardBg {
  try {
    const v = JSON.parse(localStorage.getItem(BG_KEY) || "");
    if (v && (v.mode === "dots" || v.mode === "solid") && typeof v.color === "string") return v;
  } catch { /* défaut ci-dessous */ }
  return { mode: "solid", color: "var(--color-bg)" };
}

// Réglages d'enregistrement auto (panneau Paramètres). `ms` = délai de debounce de l'autosave.
export interface SaveOpts {
  enabled: boolean;
  ms: number;
}
export const SAVE_KEY = "nr-ref-save";
export function readSave(): SaveOpts {
  try {
    const v = JSON.parse(localStorage.getItem(SAVE_KEY) || "");
    if (v && typeof v.enabled === "boolean" && typeof v.ms === "number") return v;
  } catch { /* défaut ci-dessous */ }
  return { enabled: true, ms: 500 };
}

// Cadre « zone de pose » : contour englobant le contenu (repère des limites). Activable (Paramètres).
export const PLACE_KEY = "nr-ref-place";
export function readPlaceFrame(): boolean {
  try {
    const v = localStorage.getItem(PLACE_KEY);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch { /* défaut ci-dessous */ }
  return true;
}

// Préférences persistées du board (panneau Paramètres). Favoris de polices + valeurs par défaut des
// nouvelles notes + comportements de navigation/affichage. localStorage, partagé entre toutes les scènes.
export interface BoardPrefs {
  favFonts: string[];        // polices favorites (épinglées en tête du FontPicker)
  defaultFont: string;       // police par défaut des nouvelles notes
  defaultFontSize: number;   // taille par défaut
  defaultTextColor: string;  // couleur de texte par défaut
  defaultNoteBg: string;     // fond de note par défaut ("transparent" possible)
  defaultFrameColor: string; // couleur (contour/titre) par défaut des nouveaux cadres
  defaultFrameFill: "none" | "tint" | "solid"; // remplissage par défaut des nouveaux cadres
  mediaMaxSize: number;      // côté max d'un média fraîchement posé (px board) — taille de pose
  // Ce que le fichier .netsu garde des médias, par défaut. Un item peut le surcharger (BoardItem.embed).
  // Aperçu par défaut : la plage jouée pèse quelques Mo là où la source en pèse des milliers.
  embedLevel: NetsuLevel;
  embedQuality: NetsuQuality;
  embedMargin: number;       // marge avant/après (s) du niveau « Marge » — bornes réajustables après coup
  invertZoom: boolean;       // inverser le sens de la molette
  zoomSpeed: number;         // sensibilité du zoom molette (multiplicateur)
  pauseMediaWhileNavigating: boolean; // suspendre les médias pendant pan/zoom/déplacement d'item
  dotGap: number;            // espacement de la grille de points (px)
  fitOnOpen: boolean;        // recadrer tous les items à l'ouverture d'une scène
  // Extraction de séquence (vidéo → frames d'aperçu). Aperçu jetable → volontairement léger.
  seqFps: number;            // cadence d'échantillonnage (images/s) — SOURCE_FPS = celle de la vidéo
  seqHeight: number;         // qualité = hauteur des frames (px)
  seqMaxFrames: number;      // plafond de frames (évite de cribler le disque)
  seqMarginSec: number;      // marge de sécurité gardée avant/après l'in-out (s) — pour réajuster
  // Online media downloads locally by default. YouTube is deliberately excluded and stays linked.
  autoDownloadOnline: boolean;
  onlineDefaultsVersion: number;
  // Plateformes concernées par ce téléchargement automatique (les autres restent en carte embed).
  autoDownloadProviders: EmbedProvider[];
  // Repasser un média téléchargé en lecteur/carte embed doit-il SUPPRIMER le fichier local ?
  // Défaut NON : la bascule n'est qu'un changement d'affichage, le retour au fichier reste immédiat.
  dropDownloadOnEmbed: boolean;
  // Upscale par défaut d'un item média (pré-remplit la popup d'upscale → moins de clics, plus rapide).
  // `upQuick` = le bouton Upscale lance DIRECTEMENT avec ces réglages, sans ouvrir la popup.
  upQuick: boolean;
  upEngine: "ia" | "turbo"; // moteur : IA (Real-ESRGAN/CUGAN, qualité max) ou Turbo (shader GPU, quasi temps réel)
  upModel: UpscaleModel;   // modèle IA par défaut (anime doux, réel rapide, réel max…)
  upShader: ShaderModel;   // shader Turbo par défaut (ArtCNN, Anime4K, réel net…)
  upScale: 1 | 2 | 4;      // facteur par défaut (1× = restauration à la définition d'origine)
  upDenoise: number;       // débruitage par défaut (0..1) — n'agit que sur les modèles IA qui le gèrent
  drawKeys: DrawKeys;      // raccourcis clavier des outils de dessin (personnalisables) — outil → lettre
  shortcutKeys: ShortcutKeys; // raccourcis-commandes du board (personnalisables) — action → combo
}
const PREFS_DEFAULT: BoardPrefs = {
  favFonts: [],
  defaultFont: HANDWRITING_FONT,
  defaultFontSize: 28,
  defaultTextColor: "#ffffff",
  defaultNoteBg: "transparent",
  defaultFrameColor: "#60a5fa",
  defaultFrameFill: "tint",
  mediaMaxSize: 420,
  embedLevel: "preview",
  embedQuality: "standard",
  embedMargin: 2,
  invertZoom: false,
  zoomSpeed: 1,
  pauseMediaWhileNavigating: true,
  dotGap: 24,
  fitOnOpen: false,
  seqFps: 12,
  seqHeight: 240,
  seqMaxFrames: 200,
  seqMarginSec: 0,
  autoDownloadOnline: true,
  onlineDefaultsVersion: 1,
  autoDownloadProviders: [...DOWNLOADABLE_EMBED_PROVIDERS],
  dropDownloadOnEmbed: false,
  upQuick: false,
  upEngine: "ia",
  upModel: "light",
  upShader: "artcnn_c4f32",
  upScale: 2,
  upDenoise: 0.5,
  drawKeys: DEFAULT_DRAW_KEYS,
  shortcutKeys: DEFAULT_SHORTCUT_KEYS,
};
export const PREFS_KEY = "nr-ref-prefs";
export function readPrefs(): BoardPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || "");
    if (v && typeof v === "object") return {
      ...PREFS_DEFAULT, ...v,
      // Migrate the former linked-by-default behavior once; subsequent explicit choices are kept.
      autoDownloadOnline: v.onlineDefaultsVersion === 1 ? v.autoDownloadOnline !== false : true,
      onlineDefaultsVersion: 1,
      upShader: v.upShader === "anime4k" ? "anime4k_aa_hq"
        : v.upShader === "artcnn_quality" ? "artcnn_c4f32" : v.upShader ?? PREFS_DEFAULT.upShader,
      favFonts: Array.isArray(v.favFonts) ? v.favFonts : [],
      autoDownloadProviders: Array.isArray(v.autoDownloadProviders)
        ? v.autoDownloadProviders : PREFS_DEFAULT.autoDownloadProviders,
      // fusion (jamais de raccourci manquant si une nouvelle action/outil apparaît après une sauvegarde)
      drawKeys: mergeKeys(DEFAULT_DRAW_KEYS, v.drawKeys),
      shortcutKeys: mergeKeys(DEFAULT_SHORTCUT_KEYS, v.shortcutKeys),
    };
  } catch { /* défaut ci-dessous */ }
  return PREFS_DEFAULT;
}
