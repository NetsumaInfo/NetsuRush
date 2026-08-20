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
import {
  DEFAULT_PINNED_BUTTONS, DEFAULT_PINNED_BUTTONS_END, DEFAULT_BAR_BUTTONS, DEFAULT_BAR_BUTTONS_END,
  PINNED_BUTTONS, PINNED_SIDES, type PinnedButtonId, type PinnedSide,
} from "./toolbarButtons";

// Cadence d'échantillonnage « même que la source » : l'extraction relit la vraie cadence de la vidéo
// au lieu de rééchantillonner. Sentinelle plutôt qu'un champ à part → un seul réglage à lire.
export const SOURCE_FPS = 0;

// Fond du board : grille de points (repère spatial) ou aplat monochrome.
export interface BoardBg {
  mode: "dots" | "solid";
  color: string;
  // Opacity of the BACKGROUND ALONE (fill + dots) — media stay opaque. Below 1, the window
  // lets whatever sits behind it show through.
  opacity: number;
}
export const BG_KEY = "nr-ref-bg";
// Below this the dots become unreadable and the board loses any visible limit.
export const BG_OPACITY_MIN = 0.1;
// Floor for MEDIA, aligned on the background one: at 10% the image is still a landmark, below
// that it is only a memory — and a board nobody can find again is a board lost.
export const MEDIA_OPACITY_MIN = 0.1;
export function clampMediaOpacity(v: number): number {
  return Math.min(1, Math.max(MEDIA_OPACITY_MIN, v));
}
export function clampBgOpacity(v: number): number {
  return Math.min(1, Math.max(BG_OPACITY_MIN, v));
}
export function readBg(): BoardBg {
  const fallback: BoardBg = { mode: "solid", color: "var(--color-bg)", opacity: 1 };
  try {
    const v = JSON.parse(localStorage.getItem(BG_KEY) || "");
    if (v && (v.mode === "dots" || v.mode === "solid") && typeof v.color === "string") {
      const o = Number(v.opacity);
      return { mode: v.mode, color: v.color, opacity: Number.isFinite(o) ? clampBgOpacity(o) : 1 };
    }
  } catch { /* défaut ci-dessous */ }
  return fallback;
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
  // Fenêtre épinglée (format coin) : garder une barre d'outils RÉDUITE (poser, dessiner, cadrer,
  // annuler) au lieu d'une planche nue. Le reste — enregistrer, ouvrir, partager, réglages — n'y
  // apparaît jamais, le clic droit le porte déjà.
  pinnedToolbar: boolean;
  // Content and edge of that reduced bar: everyone works pinned to a different screen corner,
  // with their own tools. Render order stays that of `PINNED_BUTTONS`.
  // The two ends of the bar, DISJOINT and in the wanted order: that is what the Settings drag
  // and drop lays out. On a pinned bar, the useful room is at both ends.
  pinnedButtons: PinnedButtonId[];
  pinnedButtonsEnd: PinnedButtonId[];
  // Same for the FULL bar: it is arranged too.
  barButtons: PinnedButtonId[];
  barButtonsEnd: PinnedButtonId[];
  // Version of the DEFAULT layout of the full bar. Settings close the bar, mouse-through sits
  // just before, and the two arrows stay against each other: a layout saved under the older
  // order has to be taken over once.
  barLayoutVersion?: number;
  pinnedSide: PinnedSide;
  // What the background opacity reaches, beyond the background itself. The INTERFACE stays
  // opaque by default: a translucent title bar over a busy desktop stops being readable. The
  // placement frame follows — it is a landmark, not an object to keep in front of a desktop.
  seeThroughShell: boolean;
  seeThroughPlaceFrame: boolean;
  // Opacity of the WHOLE board content (media, notes, frames, strokes), multiplied by each
  // item's own. This is the second slider: seeing through your references to draw underneath.
  contentOpacity: number;
  // Mouse-transparent mode warning already dismissed? Explained once, not twice.
  mouseThroughWarned: boolean;
  // What the item bar does when the app loses focus (a click in another application). Default
  // `keep`: the board is a reference held BESIDE the tool being worked in, so its bar staying put
  // is what lets the next click land on a control instead of on re-selecting the item.
  blurBehavior: BlurBehavior;
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
  // Un média LOCAL posé sur le board est-il copié dans le dossier compagnon du projet ?
  // Sans ça, le projet ne garde qu'un pointeur : le fichier renommé, effacé ou resté sur l'autre
  // machine, et la case est vide. La copie rend le projet autonome — l'original n'est jamais touché.
  copyLocalIntoProject: boolean;
  // Plafond par fichier de cette copie, en Mo, appliqué aux SEULES vidéos : les images passent
  // toujours. Un board porte volontiers dix boucles de quelques Mo, jamais dix rushes de 12 Go.
  copyLocalMaxMB: number;
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
  // Aimant : accrochage d'un item déplacé sur les bords, centres et coins des voisins.
  snap: boolean;
  snapThreshold: number;   // distance d'accrochage en pixels ÉCRAN (÷ zoom avant usage)
  snapStick: number;       // écart conservé au collage bord à bord (0 = les médias se touchent)
  // Rangement d'une sélection (sélecteur « Ranger »). Mémorisé pour que le geste suivant reparte
  // du même réglage, et sert aussi de mode appliqué à l'import d'un dossier.
  arrangeLayout: ArrangeLayout;
  arrangeUniform: "none" | "height" | "width" | "area";
  arrangeGap: number;      // écart entre items (unités monde), 0–200
  arrangeSort: "none" | "name";
  // Version des DÉFAUTS de rangement. Ranger sans uniformiser laissait une vignette à côté d'une
  // affiche : le geste ne rangeait rien de visible. Le passage à « même hauteur » doit atteindre les
  // installations existantes, dont les préférences portent encore l'ancien défaut.
  arrangeDefaultsVersion?: number;
  autoArrangeOnImport: boolean; // ranger automatiquement un lot importé (dossier, sélection multiple)
  // Accrochage automatique des tracés aux médias (flèche entre deux images, trait posé sur une image).
  autoAnchorDraw: boolean;
  paletteSize: number;     // nombre de couleurs extraites par défaut (3–12)
  // --- Pen tablets. Three machines to serve at once and they do NOT want the same thing: a display
  // tablet next to a mouse (hover works, the keyboard is there), a tablet with no screen (hover
  // works, aiming is the hard part), and a touch-first machine (no hover, no keyboard, no wheel).
  // Hence `auto` on everything a device probe can settle by itself — see tabletInput.probeDevices.
  penPressure: boolean;    // pen pressure drives the stroke width
  penMinWidth: number;     // width left at zero pressure, as a share of the nominal width (0.1–1)
  penTilt: boolean;        // a leaned pen lays down a broader mark
  penEraserTip: boolean;   // the inverted end of the stylus erases, whatever tool is selected
  penBarrel: PenBarrel;    // what the side button does
  palmRejection: boolean;  // ignore a finger while the stylus is in play
  touchGestures: boolean;  // pinch to zoom, two fingers to navigate
  penDragPans: AutoToggle; // dragging the empty board navigates instead of selecting
  touchUi: AutoToggle;     // keep hover-revealed controls permanently out
  bigTargets: boolean;     // wider hit areas on the small icon buttons
}

// Side button of a stylus. `menu` is what the platform already does with it — a barrel press IS a
// right click as far as the WebView is concerned — so it costs nothing and stays the default;
// `pan` trades that menu for navigation, which is the gesture a tablet has no other way to reach.
export type PenBarrel = "menu" | "pan";

// A setting the device probe can answer on its own, overridable both ways.
export type AutoToggle = "auto" | "on" | "off";

// Dispositions proposées par le sélecteur de rangement (sous-ensemble d'ArrangeMode : les
// alignements et répartitions restent des boutons directs, ils ne « rangent » pas une planche).
export type ArrangeLayout = "block" | "pack" | "grid" | "row" | "col";

// Reaction of the selected item's floating bar to the window losing focus:
//  - `keep`     : nothing moves (default) ;
//  - `hide`     : the bar goes away, the selection stays and the bar comes back on refocus ;
//  - `deselect` : the selection is dropped, as if the board had been clicked in the empty.
export type BlurBehavior = "keep" | "hide" | "deselect";
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
  pinnedToolbar: true,
  pinnedButtons: [...DEFAULT_PINNED_BUTTONS],
  pinnedButtonsEnd: [...DEFAULT_PINNED_BUTTONS_END],
  barButtons: [...DEFAULT_BAR_BUTTONS],
  barButtonsEnd: [...DEFAULT_BAR_BUTTONS_END],
  barLayoutVersion: 1,
  pinnedSide: "top",
  seeThroughShell: false,
  seeThroughPlaceFrame: true,
  contentOpacity: 1,
  mouseThroughWarned: false,
  blurBehavior: "keep",
  seqFps: 12,
  seqHeight: 240,
  seqMaxFrames: 200,
  seqMarginSec: 0,
  autoDownloadOnline: true,
  onlineDefaultsVersion: 1,
  autoDownloadProviders: [...DOWNLOADABLE_EMBED_PROVIDERS],
  copyLocalIntoProject: true,
  copyLocalMaxMB: 512,
  dropDownloadOnEmbed: false,
  upQuick: false,
  upEngine: "ia",
  upModel: "light",
  upShader: "artcnn_c4f32",
  upScale: 2,
  upDenoise: 0.5,
  drawKeys: DEFAULT_DRAW_KEYS,
  shortcutKeys: DEFAULT_SHORTCUT_KEYS,
  snap: true,
  snapThreshold: 8,
  snapStick: 0,
  arrangeLayout: "block",
  arrangeUniform: "height",
  arrangeGap: 16,
  arrangeSort: "none",
  arrangeDefaultsVersion: 1,
  autoArrangeOnImport: true,
  autoAnchorDraw: true,
  paletteSize: 6,
  penPressure: true,
  penMinWidth: 0.35,
  penTilt: false,
  penEraserTip: true,
  penBarrel: "menu",
  palmRejection: true,
  touchGestures: true,
  penDragPans: "auto",
  touchUi: "auto",
  bigTargets: false,
};
// A button only lives in ONE zone, and only known buttons survive.
function splitZones(v: Record<string, unknown>, startKey: string, endKey: string) {
  if (!Array.isArray(v[startKey])) return {};
  const known = (list: unknown): PinnedButtonId[] =>
    Array.isArray(list) ? list.filter((id): id is PinnedButtonId => PINNED_BUTTONS.some((b) => b.id === id)) : [];
  const end = known(v[endKey]);
  return { [startKey]: known(v[startKey]).filter((id) => !end.includes(id)), [endKey]: end };
}

export const PREFS_KEY = "nr-ref-prefs";
export function readPrefs(): BoardPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || "");
    if (v && typeof v === "object") return {
      ...PREFS_DEFAULT, ...v,
      // Migrate the former linked-by-default behavior once; subsequent explicit choices are kept.
      autoDownloadOnline: v.onlineDefaultsVersion === 1 ? v.autoDownloadOnline !== false : true,
      onlineDefaultsVersion: 1,
      // Uniformisation de taille au rangement : imposée une fois aux réglages d'avant, puis c'est
      // le choix de l'utilisateur qui prime.
      arrangeUniform: v.arrangeDefaultsVersion === 1 ? v.arrangeUniform ?? PREFS_DEFAULT.arrangeUniform : PREFS_DEFAULT.arrangeUniform,
      arrangeDefaultsVersion: 1,
      upShader: v.upShader === "anime4k" ? "anime4k_aa_hq"
        : v.upShader === "artcnn_quality" ? "artcnn_c4f32" : v.upShader ?? PREFS_DEFAULT.upShader,
      // A button dropped from the product must not linger in a saved bar, and an unknown edge
      // must not leave the bar without a place to sit.
      ...splitZones(v, "pinnedButtons", "pinnedButtonsEnd"),
      ...splitZones(v, "barButtons", "barButtonsEnd"),
      ...(v.barLayoutVersion === 1 ? {} : {
        barButtons: [...DEFAULT_BAR_BUTTONS], barButtonsEnd: [...DEFAULT_BAR_BUTTONS_END],
      }),
      barLayoutVersion: 1,
      pinnedSide: PINNED_SIDES.some((s) => s.id === v.pinnedSide) ? v.pinnedSide : PREFS_DEFAULT.pinnedSide,
      favFonts: Array.isArray(v.favFonts) ? v.favFonts : [],
      autoDownloadProviders: Array.isArray(v.autoDownloadProviders)
        ? v.autoDownloadProviders : PREFS_DEFAULT.autoDownloadProviders,
      // Un plafond relu depuis un réglage corrompu ne doit jamais devenir « copie illimitée » ni
      // « rien ne passe » : il décide de gigaoctets recopiés ou d'items laissés en pointeur.
      copyLocalMaxMB: Number.isFinite(v.copyLocalMaxMB) && v.copyLocalMaxMB >= 0
        ? Math.min(65536, Number(v.copyLocalMaxMB)) : PREFS_DEFAULT.copyLocalMaxMB,
      // fusion (jamais de raccourci manquant si une nouvelle action/outil apparaît après une sauvegarde)
      drawKeys: mergeKeys(DEFAULT_DRAW_KEYS, v.drawKeys),
      shortcutKeys: mergeKeys(DEFAULT_SHORTCUT_KEYS, v.shortcutKeys),
    };
  } catch { /* défaut ci-dessous */ }
  return PREFS_DEFAULT;
}
