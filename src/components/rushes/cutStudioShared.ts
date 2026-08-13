import type { CSSProperties } from "react";
import type { DetectModel } from "@/lib/bridge";
import { fmtTime } from "@/lib/utils";

// Un plan détecté : bornes en secondes (in/out) et, si dispo, en frames source (inFrame/outFrame).
export interface Segment {
  id: number;
  in: number;
  out: number;
  inFrame?: number;
  outFrame?: number;
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

export function gridMetrics(width: number, cols: number, narrow = false) {
  if (!width) return { cell: 0, actualCols: cols };
  const inner = width - GRID_PAD;
  const floor = narrow ? MIN_CELL_NARROW : MIN_CELL;
  const cellFor = (n: number) => (inner - (n - 1) * GRID_GAP) / n;
  let actualCols = Math.max(1, Math.floor(cols));
  while (actualCols > 1 && cellFor(actualCols) < floor) actualCols--;
  const cell = cellFor(actualCols);
  return { cell, actualCols };
}

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

// AVANCE DE LECTURE, en pixels : une carte prend son créneau AVANT d'entrer dans le viewport, donc
// son aperçu tourne déjà quand elle apparaît. Source UNIQUE — `useSceneCardMedia` en fait sa bande
// d'observation et `autoplayCeiling` compte les rangées correspondantes. Les deux ont divergé une
// fois : le plafond ignorait des rangées qui réclamaient pourtant un créneau, et les cartes du bas
// n'en obtenaient jamais.
export const PLAY_LEAD_PX = 400;

// Plafond de lecture auto = miniatures VISIBLES + les rangées d'avance, écrêté par
// `MAX_PLAYING_HARD` dans setMaxPlaying.
export function autoplayCeiling(width: number, height: number, cols: number, narrow = false): number {
  const { cell, actualCols } = gridMetrics(width, cols, narrow);
  if (!cell || !height) return 0;
  const rowH = (cell * 9) / 16 + GRID_GAP;
  const rows = Math.max(1, Math.ceil(height / rowH));
  // + les rangées de l'AVANCE DE LECTURE (au-dessus ET au-dessous du viewport) : sans elles, les
  // cartes anticipées prendraient les créneaux des cartes visibles au lieu de s'ajouter.
  const lead = Math.ceil(PLAY_LEAD_PX / rowH);
  return actualCols * (rows + 2 * lead);
}

// Gestionnaire de créneaux de lecture pour « Tout lire » : limite le nombre de <video> qui
// jouent EN MÊME TEMPS ET échelonne les démarrages (un toutes les GRANT_MS, plan le plus haut
// d'abord). Quand une carte rend son créneau (scroll/arrêt), le suivant démarre. Le survol
// court-circuite (hors quota).
// Le plafond N'EST PAS fixe : CutStudio le recalcule = nombre de miniatures VISIBLES (+1 rangée
// tampon) via setMaxPlaying, à chaque resize/changement de colonnes → toutes les visibles jouent.
// Décodage = NVDEC matériel (≠ limite stricte de sessions NVENC à l'encode) → plusieurs décodes
// 720p courts en parallèle passent.
let maxPlaying = 24;
// PLAFOND DUR, indépendant du nombre de miniatures qui tiennent à l'écran. La seule limite réelle
// est celle de Chromium (~75 lecteurs média par frame) : au-delà, une <video> n'est plus créée du
// tout, sans erreur. On borne donc l'ENSEMBLE des éléments montés, lecture + pause retenue
// (cf. previewVideoPool.MAX_PAUSED), pas le seul nombre de cartes visibles.
//
// À 32, une grille dense sur grand écran dépassait le plafond AVANT même d'avoir couvert le
// viewport : les cartes du bas restaient sur leur vignette en permanence, ce qui se lit comme
// « tout ne se met pas en lecture ». Le transport n'est plus le facteur limitant (les aperçus
// passent par le protocole asset de la coquille, pas par les 6 connexions HTTP par origine du
// webview), donc le plafond peut enfin suivre ce que la grille affiche.
export const MAX_PLAYING_HARD = 52;
// L'échelonnement existe pour ne pas créer trente éléments média dans la même frame. Il ne doit pas
// devenir la limite : à un créneau toutes les 30 ms, remplir un écran après un arrêt de défilement
// prenait plus d'une seconde — on voyait la grille « rattraper » rangée par rangée.
//
// Rythme sur la FRAME (requestAnimationFrame) et non sur un minuteur : un `setInterval` fait son
// travail entre deux frames, donc en concurrence directe avec le défilement, et son premier tick
// arrivait jusqu'à un intervalle complet après la demande — un retard pur, sur la carte même qu'on
// regarde. En rAF, le premier créneau tombe à la frame suivante et les montages s'alignent sur la
// peinture.
const GRANT_BURST = 4;
let playingActive = 0;
type PlaySlot = { order: number; granted: boolean; grant: () => void };
let slotQueue: PlaySlot[] = [];
let slotFrame: number | null = null;
// Recalcule le plafond (page visible) ; relance le pump car de nouveaux créneaux peuvent s'ouvrir.
export function setMaxPlaying(n: number) {
  maxPlaying = Math.min(MAX_PLAYING_HARD, Math.max(1, Math.floor(n)));
  pumpSlots();
}
function pumpSlots() {
  if (slotFrame != null || typeof requestAnimationFrame !== "function") return;
  slotFrame = requestAnimationFrame(() => {
    slotFrame = null;
    if (!slotQueue.length || playingActive >= maxPlaying) return;
    slotQueue.sort((a, b) => a.order - b.order);
    let granted = 0;
    while (granted < GRANT_BURST && playingActive < maxPlaying) {
      const s = slotQueue.shift();
      if (!s) break;
      playingActive++;
      granted++;
      s.granted = true;
      s.grant();
    }
    // On ne redemande une frame QUE si ce tour a servi quelque chose et qu'il reste du monde. Plafond
    // atteint = on s'arrête net : redemander une frame ferait tourner un tri par frame, pour rien,
    // aussi longtemps que la grille reste ouverte — du travail sur le thread principal qui ne peut que
    // gêner le défilement qu'il est censé servir. Les deux événements capables de rouvrir un créneau
    // (libération d'un slot, changement de plafond) rappellent `pumpSlots` eux-mêmes.
    if (granted && slotQueue.length) pumpSlots();
  });
}
export function acquirePlaySlot(order: number, grant: () => void): () => void {
  const slot: PlaySlot = { order, granted: false, grant };
  slotQueue.push(slot);
  pumpSlots();
  return () => {
    const i = slotQueue.indexOf(slot);
    if (i >= 0) slotQueue.splice(i, 1);
    if (slot.granted) { playingActive = Math.max(0, playingActive - 1); pumpSlots(); }
  };
}
// Réinitialise l'état (module-level) : sinon, fermer puis rouvrir un rush déjà découpé hérite
// d'un compteur faussé (playingActive bloqué) → « Lecture auto » qui ne lance plus les aperçus.
export function resetPlaySlots() {
  if (slotFrame != null) { cancelAnimationFrame(slotFrame); slotFrame = null; }
  slotQueue = [];
  playingActive = 0;
}
