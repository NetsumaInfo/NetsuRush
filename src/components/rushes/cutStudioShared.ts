import type { CSSProperties } from "react";
import type { DetectModel } from "@/lib/bridge";
import { fmtTime } from "@/lib/utils";

// Un plan détecté : bornes en secondes (in/out) et, si dispo, en frames source (inFrame/outFrame).
//
// `path` = fichier source du plan. Absent quand toute la grille tient dans UN fichier (le cas des
// vues qui n'ouvrent qu'un rush) : l'appelant retombe alors sur le chemin de la vue. Il est
// TOUJOURS renseigné dès qu'une grille enchaîne plusieurs rushs — un plan ne sait plus d'où il
// vient autrement, et l'aperçu comme l'export visent le mauvais fichier.
export interface Segment {
  id: number;
  in: number;
  out: number;
  inFrame?: number;
  outFrame?: number;
  path?: string;
}

// Compteur d'identifiants de plans, partagé à l'échelle du module (jamais réinitialisé : un id
// reste unique pour toute la session, y compris après fusion ou réouverture d'un rush).
let segId = 1;
export function nextSegId(): number {
  return segId++;
}

// Préréglages de précision (seuil TransNetV2). Plus à droite = détecte plus finement.
// `labelKey` = clé i18n (ns « derush ») résolue au rendu.
export const PRESETS: { labelKey: string; thr: number }[] = [
  { labelKey: "shared.presetRapide", thr: 0.6 },
  { labelKey: "shared.presetEquilibre", thr: 0.5 },
  { labelKey: "shared.presetPrecis", thr: 0.35 },
  { labelKey: "shared.presetMax", thr: 0.2 },
];

// Modèles de détection de plans au choix. `label` = nom propre (jamais traduit) ;
// `hintKey` = clé i18n de l'indice, résolue au rendu.
export const MODELS: { id: DetectModel; label: string; hintKey: string }[] = [
  { id: "transnetv2", label: "TransNetV2", hintKey: "shared.modelHintTransnet" },
  { id: "omnishotcut", label: "OmniShotCut", hintKey: "shared.modelHintOmni" },
  { id: "autoshot", label: "AutoShot", hintKey: "shared.modelHintAutoShot" },
];
export const modelLabel = (m: DetectModel) => MODELS.find((x) => x.id === m)?.label ?? m;

// Chrome COMMUN à toutes les barres d'action de multi-sélection (compteur + tout sélectionner +
// options + action). Barre PLATE collée sous l'entête : lignes fines haut/bas (border-y), pas de
// carte flottante (ni rounded/ring/shadow), padding vertical léger. Les marges négatives annulent
// le p-4 du conteneur défilant pour occuper toute la largeur ; -top-4 aligne le seuil sticky sur
// cette remontée (sinon le sticky re-cale la barre 16px plus bas → espace parasite sous l'entête).
// N'inclut PAS le flex/gap : chaque barre ajoute le sien (flex-wrap OU nowrap+overflow-x-auto).
export const SELECTION_BAR_CLASS =
  "sticky -top-4 z-10 -mx-4 -mt-4 flex-row rounded-none border-0 border-y border-border bg-background px-4 py-1 shadow-none ring-0";

// Horodatage des plans : [h:]mm:ss (préfixe heure seulement au-delà d'une heure).
export const fmt = (t: number) => fmtTime(t, { hours: true });

// Géométrie de la grille de plans — PARTAGÉE par le Découpage et les Collections (une seule
// définition, sinon les deux grilles dérivent l'une de l'autre à la première retouche).
//
// `cols` est un NOMBRE DE COLONNES, tenu quelle que soit la largeur : rétrécir la fenêtre ou ouvrir
// le lecteur latéral rétrécit les vignettes, il n'en renvoie pas une à la ligne. La grille faisait
// avant `auto-fill` sur une largeur de cellule bornée : la dernière carte tombait à la ligne dès
// qu'on pinçait le panneau, et le réglage de densité ne décidait plus de rien.
//
// Seul garde-fou : une cellule ne descend pas sous MIN_CELL (illisible). En dessous on retire des
// colonnes — c'est ce qui garde le panneau CEP (~560 px) et la fenêtre épinglée utilisables.
const GRID_GAP = 12;   // gap-3
const GRID_PAD = 12;          // pl-1 pr-2 de la zone défilante
const MIN_CELL = 120;
const MIN_CELL_NARROW = 96;   // vue étroite : on accepte plus petit pour garder des colonnes

// Bornes du réglage de densité — les MÊMES que celles que le store applique à `cutCols`.
export const COLS_MIN = 2;
export const COLS_MAX = 8;

export function gridMetrics(width: number, cols: number, narrow = false) {
  if (!width) return { cell: 0, actualCols: cols, maxCols: COLS_MAX };
  const inner = width - GRID_PAD;
  const floor = narrow ? MIN_CELL_NARROW : MIN_CELL;
  const cellFor = (n: number) => (inner - (n - 1) * GRID_GAP) / n;
  // Widest column count this width can hold without going under the cell floor. The +/- needs it:
  // above it, raising the setting changes nothing on screen.
  let maxCols = 1;
  while (maxCols < COLS_MAX && cellFor(maxCols + 1) >= floor) maxCols++;
  let actualCols = Math.max(1, Math.floor(cols));
  while (actualCols > 1 && cellFor(actualCols) < floor) actualCols--;
  const cell = cellFor(actualCols);
  return { cell, actualCols, maxCols };
}

// Density steps drive what is ON SCREEN, not the remembered setting. The +/- used to write `cols`
// while the grid renders `actualCols`, which `gridMetrics` shaves down to hold MIN_CELL: in a
// pinned window the setting could read 6 while the grid showed 3, so the first three clicks on "−"
// moved nothing. Stepping from the real count makes every click land.
export function stepCols(actualCols: number, d: number, maxCols = COLS_MAX): number {
  const ceiling = Math.min(COLS_MAX, Math.max(1, maxCols));
  return Math.min(ceiling, Math.max(COLS_MIN, Math.round(actualCols) + d));
}
// "−" = fewer columns = bigger thumbnails; "+" = more columns, capped by what the width can hold.
export const canFewerCols = (actualCols: number) => actualCols > COLS_MIN;
export const canMoreCols = (actualCols: number, maxCols: number) => actualCols < Math.min(COLS_MAX, maxCols);

// Style du CONTENEUR de grille : colonnes + hauteur de rangée publiée en variable CSS. Les cartes
// (`.nr-grid-card`) lisent `--nr-cell-h` par héritage, donc changer de densité met à jour le
// placeholder hors écran de toutes les cartes SANS en rerendre une seule.
//
// La valeur est celle de la MÊME formule que le navigateur applique (`aspect-video` sur une piste
// `1fr`) et elle n'est PAS arrondie : la hauteur estimée d'une carte hors écran est alors celle
// qu'elle aura une fois rendue, donc `scrollHeight` ne bouge pas quand une rangée entre à l'écran.
// C'est ce qui fait sauter la barre de défilement quand l'estimation dérive, même d'un demi-pixel
// par rangée : sur plusieurs centaines de plans, l'écart cumulé redimensionne le curseur en plein
// défilement.
export function gridContainerStyle(actualCols: number, cell: number): CSSProperties {
  const style: Record<string, string> = { gridTemplateColumns: `repeat(${actualCols}, minmax(0, 1fr))` };
  // `cell` vaut 0 tant que la largeur n'est pas mesurée : on laisse alors le repli du CSS plutôt que
  // d'annoncer des rangées de hauteur nulle (toutes les cartes deviendraient « pertinentes » d'un coup).
  if (cell > 0) style["--nr-cell-h"] = `${((cell * 9) / 16).toFixed(3)}px`;
  return style as CSSProperties;
}
