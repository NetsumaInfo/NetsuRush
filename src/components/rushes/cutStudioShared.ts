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
// `cols` n'est PAS un nombre de colonnes mais une CIBLE de densité : on en dérive une largeur de
// cellule bornée, la grille fait `auto-fill`, donc le nombre réel de colonnes suit la largeur
// disponible (lecteur latéral ouvert, panneau CEP ~560 px, fenêtre épinglée).
export const GRID_GAP = 12;   // gap-3
const GRID_PAD = 8;           // px-1 de la zone défilante

export function gridMetrics(width: number, cols: number, narrow = false) {
  if (!width) return { cell: 0, actualCols: cols, cellH: 0 };
  const inner = width - GRID_PAD;
  // Vue étroite : cellule plafonnée (~190 px) pour TOUJOURS garder plusieurs colonnes, sinon une
  // densité basse donne une carte géante pleine largeur.
  const cell = narrow
    ? Math.max(130, Math.min(190, inner / cols))
    : Math.max(140, Math.min(320, inner / cols));
  const actualCols = Math.max(1, Math.floor((inner + GRID_GAP) / (cell + GRID_GAP)));
  // Hauteur RÉELLE d'une carte (aspect-video) = largeur de colonne × 9/16. Sert de
  // `contain-intrinsic-size` aux cartes hors écran : un placeholder de la mauvaise hauteur fait
  // osciller le layout au scroll (rangées blanches en densité forte).
  const cellH = Math.round((((inner - (actualCols - 1) * GRID_GAP) / actualCols) * 9) / 16);
  return { cell, actualCols, cellH };
}

// Plafond de lecture auto = miniatures VISIBLES + une rangée tampon (préchargée).
export function autoplayCeiling(width: number, height: number, cols: number, narrow = false): number {
  const { cell, actualCols } = gridMetrics(width, cols, narrow);
  if (!cell || !height) return 0;
  const rows = Math.max(1, Math.ceil(height / ((cell * 9) / 16 + GRID_GAP)));
  return actualCols * (rows + 1);
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
const GRANT_MS = 30;
let playingActive = 0;
type PlaySlot = { order: number; granted: boolean; grant: () => void };
let slotQueue: PlaySlot[] = [];
let slotTimer: ReturnType<typeof setInterval> | null = null;
// Recalcule le plafond (page visible) ; relance le pump car de nouveaux créneaux peuvent s'ouvrir.
export function setMaxPlaying(n: number) {
  maxPlaying = Math.max(1, Math.floor(n));
  pumpSlots();
}
function pumpSlots() {
  if (slotTimer) return;
  slotTimer = setInterval(() => {
    if (!slotQueue.length) { if (slotTimer) { clearInterval(slotTimer); slotTimer = null; } return; }
    if (playingActive >= maxPlaying) return;
    slotQueue.sort((a, b) => a.order - b.order);
    const s = slotQueue.shift();
    if (!s) return;
    playingActive++;
    s.granted = true;
    s.grant();
  }, GRANT_MS);
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
  if (slotTimer) { clearInterval(slotTimer); slotTimer = null; }
  slotQueue = [];
  playingActive = 0;
}

// Pause des aperçus quand on défile VITE (flick) ; lecture conservée en scroll lent (repérage).
// Basé sur la VÉLOCITÉ (px/ms), pas un simple on/off : un scroll lent ne coupe pas la lecture.
// On expose juste un flag `fast` ; côté carte on met en PAUSE l'élément <video> (qui reste monté) —
// on ne gate JAMAIS son montage (sinon la lecture auto risquerait de ne plus démarrer si le flag
// se coince). Auto-réparant : un timer remet `fast=false` dès l'arrêt du scroll.
let scrollFast = false;
let lastTop = 0;
let lastTs = 0;
let fastTimer: ReturnType<typeof setTimeout> | null = null;
const fastSubs = new Set<() => void>();
const FAST_PX_PER_MS = 2.2;   // ~2200 px/s : flick = pause, scroll de lecture = continue
function setFast(v: boolean) {
  if (v === scrollFast) return;
  scrollFast = v;
  fastSubs.forEach((f) => f());
}
export function notifyScroll(scrollTop: number, ts: number): void {
  const dy = Math.abs(scrollTop - lastTop);
  const dt = ts - lastTs;
  lastTop = scrollTop;
  lastTs = ts;
  // dt borné : on ignore le 1er event après une pause (dt énorme) pour éviter un faux « rapide ».
  if (dt > 0 && dt < 200) setFast(dy / dt > FAST_PX_PER_MS);
  if (fastTimer) clearTimeout(fastTimer);
  fastTimer = setTimeout(() => setFast(false), 120);   // arrêt/ralentissement du scroll → reprise
}
export function subscribeScrollFast(cb: () => void): () => void {
  fastSubs.add(cb);
  return () => { fastSubs.delete(cb); };
}
export function getScrollFast(): boolean {
  return scrollFast;
}
// Handler `onScroll` prêt à câbler sur n'importe quel conteneur défilant d'une grille d'aperçus
// (CutStudio, recherche IA, board picker) → émet la vélocité pour le flick-pause. Comportement
// identique au handler inline historique de CutStudio.
export function onGridScroll(e: { currentTarget: { scrollTop: number } }): void {
  notifyScroll(e.currentTarget.scrollTop, performance.now());
}
