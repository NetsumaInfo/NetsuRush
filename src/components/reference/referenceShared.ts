// Modèle de données + helpers du board de référence (style mood-board adapté React).
// Un board = une scène = une liste d'items posés en coordonnées MONDE (board), affichés
// à travers une couche pan/zoom. Toute la géométrie d'un item vit en coordonnées board ;
// l'écran ne sert qu'aux gestes (souris) puis on reconvertit.

import { nr, type NetsuEmbed, type NetsuLevel, type NetsuQuality } from "@/lib/bridge";
import i18n from "@/i18n";
import { comboFromEvent, isCompleteCombo, type ShortcutMap } from "@/lib/shortcuts";
import { embedSrc } from "./embeds";

export type ItemKind = "image" | "video" | "youtube" | "embed" | "text" | "frame" | "draw" | "sequence";

// Ce qu'un fichier .netsu garde des médias. L'ordre est celui du plus léger au plus lourd : il est
// repris tel quel par le dialogue de partage, les réglages du board et l'inspecteur d'item.
// La sémantique de chaque niveau vit côté core (core/netsu/levels.js), source unique des règles.
export const EMBED_LEVELS: NetsuLevel[] = ["link", "preview", "margin", "full"];
export const EMBED_QUALITIES: NetsuQuality[] = ["eco", "standard", "high"];
// Marges proposées (s). Des paliers plutôt qu'un curseur : personne n'a besoin de 3,7 s de marge.
export const EMBED_MARGINS = [1, 2, 5, 10];

// Cible d'un lien posé sur une note texte. `target` = URL (kind "url"), chemin disque ("file"),
// ou id d'item du board ("item"). `label` = texte affiché optionnel (sinon dérivé de target).
export interface BoardLink {
  kind: "url" | "file" | "item";
  target: string;
  label?: string;
}

// Outils du mode dessin maison (le texte se pose via l'outil texte du board, pas ici).
// `marker` = surligneur : trait de stylo large et semi-transparent (forme `pen` + `op`).
export type DrawTool = "select" | "pen" | "marker" | "line" | "arrow" | "rect" | "ellipse" | "diamond" | "eraser";

// Outils du mode dessin + leur raccourci PAR DÉFAUT (une lettre). Partagé par la barre de dessin
// (icônes en plus) et les Paramètres (édition des raccourcis). `select` n'a pas de touche.
export const DRAW_TOOL_DEFS: { tool: DrawTool; labelKey: string; key: string }[] = [
  { tool: "pen", labelKey: "draw.tool.pen", key: "p" },
  { tool: "marker", labelKey: "draw.tool.marker", key: "m" },
  { tool: "line", labelKey: "draw.tool.line", key: "l" },
  { tool: "arrow", labelKey: "draw.tool.arrow", key: "f" },
  { tool: "rect", labelKey: "draw.tool.rect", key: "r" },
  { tool: "ellipse", labelKey: "draw.tool.ellipse", key: "o" },
  { tool: "diamond", labelKey: "draw.tool.diamond", key: "d" },
  { tool: "eraser", labelKey: "draw.tool.eraser", key: "g" },
];
// Map outil → touche (raccourcis personnalisables, persistés dans les préférences du board).
export type DrawKeys = Record<string, string>;
export const DEFAULT_DRAW_KEYS: DrawKeys = Object.fromEntries(DRAW_TOOL_DEFS.map((d) => [d.tool, d.key]));

// --- Raccourcis-COMMANDES du board (rebindables, combos inclus) ---
// Chaque action = 1 combo canonique (« Ctrl+Shift+Z », « Delete »…). `useBoardShortcuts` matche
// l'événement clavier via `comboFromEvent`. Les Paramètres éditent `prefs.shortcutKeys`.
export type ShortcutAction =
  | "delete" | "deselect" | "selectAll" | "duplicate"
  | "undo" | "redo" | "save" | "saveAs" | "openProject" | "fit" | "zoomIn" | "zoomOut";
export const SHORTCUT_DEFS: { action: ShortcutAction; labelKey: string; combo: string }[] = [
  { action: "delete", labelKey: "shortcut.delete", combo: "Delete" },
  { action: "deselect", labelKey: "shortcut.deselect", combo: "Escape" },
  { action: "selectAll", labelKey: "shortcut.selectAll", combo: "Ctrl+A" },
  { action: "duplicate", labelKey: "shortcut.duplicate", combo: "Ctrl+D" },
  { action: "undo", labelKey: "shortcut.undo", combo: "Ctrl+Z" },
  { action: "redo", labelKey: "shortcut.redo", combo: "Ctrl+Shift+Z" },
  { action: "save", labelKey: "shortcut.save", combo: "Ctrl+S" },
  { action: "saveAs", labelKey: "shortcut.saveAs", combo: "Ctrl+Shift+S" },
  { action: "openProject", labelKey: "shortcut.openProject", combo: "Ctrl+O" },
  { action: "fit", labelKey: "shortcut.fit", combo: "Ctrl+0" },
  { action: "zoomIn", labelKey: "shortcut.zoomIn", combo: "Ctrl+=" },
  { action: "zoomOut", labelKey: "shortcut.zoomOut", combo: "Ctrl+-" },
];
export type ShortcutKeys = ShortcutMap;
export const DEFAULT_SHORTCUT_KEYS: ShortcutKeys = Object.fromEntries(SHORTCUT_DEFS.map((d) => [d.action, d.combo]));

// La mécanique de combos vit dans @/lib/shortcuts (partagée avec NetsuCut) ; ré-exportée ici pour
// que le board continue de tout tirer de son module.
export { comboFromEvent, isCompleteCombo };

// Type de pointe de flèche/ligne, posée à chaque extrémité.
export type ArrowHead = "none" | "arrow" | "triangle" | "dot" | "bar";
// Style du trait (plein / tirets / pointillés) — `strokeDasharray` dérivé de l'épaisseur.
export type DashStyle = "solid" | "dashed" | "dotted";
// Type de tracé d'une ligne/flèche : droite, courbe (quadratique), coudée (segments orthogonaux).
export type RouteStyle = "straight" | "curved" | "elbow";

// Forme de dessin (coordonnées MONDE board). `p` = points aplatis : pen → suite de points ;
// line/arrow/rect/ellipse/diamond → [x0,y0,x1,y1] ; text → [x,y] (ancre haut-gauche). `w` = épaisseur
// du trait en unités MONDE (ou taille de police pour le texte). Tout scale avec le board (façon ink).
// `cp` = point de contrôle (courbe quadratique) pour une ligne/flèche cintrée manuellement.
// `h1`/`h2` = pointe à l'extrémité de départ / d'arrivée (line + arrow ; défaut arrow → h2 "arrow").
// `dash` = style du trait ; `route` = type de tracé (line/arrow). `op` = opacité 0–1 (undefined = 1,
// le surligneur trace à ~0,45). `r` = coins arrondis (rect seulement).
export interface DrawShape {
  id: string;
  t: "pen" | "line" | "arrow" | "rect" | "ellipse" | "diamond" | "text";
  c: string;
  w: number;
  p: number[];
  fill?: string;
  text?: string;
  cp?: [number, number];
  h1?: ArrowHead;
  h2?: ArrowHead;
  dash?: DashStyle;
  route?: RouteStyle;
  op?: number;
  r?: boolean;
}

// Item du board. `ref` = localisateur DURABLE (persisté) : chemin disque, URL distante, ou
// id YouTube. `src` = URL d'AFFICHAGE dérivée (nrmedia://, objectURL, URL distante) — transitoire,
// recalculée au chargement d'une scène (un objectURL ne survit pas à un reload).
export interface BoardItem {
  id: string;
  kind: ItemKind;
  ref: string;
  src: string;
  // Géométrie en coordonnées board (coin haut-gauche + taille + rotation degrés).
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: number;
  // Ratio natif (verrouille le redimensionnement proportionnel).
  natW?: number;
  natH?: number;
  // Mode de lecture (vidéo/YouTube) : "loop" = boucle infinie (défaut) ; "pingpong" = aller-retour
  // (vidéo locale seulement, YouTube ne lit pas en arrière) ; "off" = figé, ne joue JAMAIS même au
  // Play global. Le Play global n'agit que sur les items en "loop"/"pingpong".
  playMode?: "loop" | "pingpong" | "off";
  // YouTube / vidéo : trim in/out en secondes (la lecture boucle sur [trimIn, trimOut]).
  trimIn?: number;
  trimOut?: number;
  dur?: number;       // durée du média (s) quand connue → borne le sélecteur de portée
  // Ce que le fichier .netsu garde de CE média, quand le défaut du board ne convient pas (une
  // référence clé qu'on veut en pleine qualité, un rush de 2 h qu'on ne veut qu'en lien).
  // Non renseigné = réglage du board. Sémantique : core/netsu/levels.js.
  embed?: NetsuEmbed;
  title?: string;
  opacity?: number;
  // Miroir horizontal / vertical.
  flipH?: boolean;
  flipV?: boolean;
  // Rognage normalisé (fractions 0..1 du média source) : x,y coin haut-gauche, w,h taille.
  crop?: { x: number; y: number; w: number; h: number };
  // Note texte (kind === "text") / titre de cadre (kind === "frame").
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  bg?: string;        // fond de la note ("transparent" possible)
  highlight?: string; // surlignage DERRIÈRE le texte (distinct de `bg`, "transparent" = aucun)
  lineHeight?: number; // interligne (multiplicateur ; défaut 1.2)
  indent?: number;     // niveau d'indentation (paliers de 24px de marge gauche ; 0 = aucun)
  bullet?: boolean;    // liste à puces (les puces sont écrites dans le texte, ce flag = état du bouton)
  numbered?: boolean;  // liste numérotée (mêmes principes que `bullet` : « 1. » écrits dans le texte)
  strike?: boolean;    // barré
  // Lien posé sur une note : URL web (ouvre le navigateur), fichier local (ouvre l'app système),
  // ou autre item du board (recadre la caméra dessus). Note cliquable hors édition.
  link?: BoardLink;
  // Cadre (kind === "frame") : remplissage intérieur — "none" (contour seul), "tint" (léger aplat
  // teinté du contour) ou "solid" (couleur opaque `fillColor`). `filled` conservé (legacy → "solid").
  fillMode?: "none" | "tint" | "solid";
  filled?: boolean;
  fillColor?: string;
  titleBg?: string;   // fond de l'étiquette de titre du cadre ("transparent" possible ; défaut surface)
  align?: "left" | "center" | "right" | "justify";
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  // Dessin (kind === "draw", item singleton board-wide) : formes libres en coords monde.
  shapes?: DrawShape[];
  // Séquence d'images (kind === "sequence") : `frames` = refs DURABLES de
  // chaque frame (chemins disque / URLs), affichées une à la fois. `frame` = index courant (persisté,
  // rouvre sur la même image). `fps` = cadence de base (défaut 12), `speed` = multiplicateur de vitesse
  // (×0.5/×1/×2). `seqPlay` = lecture auto en cours (avance les frames ; bornée par le gel global).
  frames?: string[];
  frame?: number;
  fps?: number;
  speed?: number;
  seqPlay?: boolean;
  // Portée de boucle de la séquence = sous-plage de frames [seqIn, seqOut] (index ; défaut = toutes).
  // L'avance auto reste DANS cette plage. `playMode` (partagé avec la vidéo) donne le TYPE de boucle :
  // "loop" (rejoue seqIn après seqOut), "pingpong" (aller-retour), "off" (joue une fois puis s'arrête).
  seqIn?: number;
  seqOut?: number;
  // Placeholder de TÉLÉCHARGEMENT : carré avec loader posé sur le board pendant le download/extraction
  // d'un lien, remplacé par le vrai média à l'arrivée (retiré en cas d'échec). Transitoire (non persisté).
  loading?: boolean;
  // Lien d'origine d'un média EXTRAIT (yt-dlp/gallery-dl depuis un post social) → permet de
  // rebasculer l'item en carte embed ancrée (et inversement de re-télécharger depuis l'embed).
  sourceUrl?: string;
  // Sauvegarde du média AVANT upscale → permet de revenir en arrière (non destructif : l'upscale
  // ne supprime plus l'ancien fichier). Présent ⇒ l'item a été upscalé et peut être restauré.
  // Aussi réutilisé par la séquence pour MÉMORISER le média d'origine (vidéo/YouTube) → bouton « revenir
  // à l'original » (kind/sourceUrl portés pour restaurer le bon type, y compris un lecteur YouTube).
  prevMedia?: { kind?: ItemKind; ref: string; src: string; trimIn?: number; trimOut?: number; crop?: BoardItem["crop"]; sourceUrl?: string };
  // Fichier DÉJÀ téléchargé d'un item repassé en lecteur/carte embed. Repasser à l'embed n'est qu'un
  // changement d'affichage : garder le localisateur ici rend le retour au média local immédiat
  // (aucun yt-dlp rejoué). Effacé si les Paramètres demandent la suppression du fichier à la bascule.
  localMedia?: { kind: ItemKind; ref: string; src: string; natW?: number; natH?: number };
  // Média MANQUANT après import d'un .netsu : le fichier (gros média référencé, non embarqué) n'a pas
  // été retrouvé localement. `ref` est vide ⇒ l'item rend un placeholder « Relocaliser ». Effacé dès
  // qu'on repointe le fichier.
  missing?: {
    name: string;
    size: number;
    kind: string;
    locator?: string;
    frameLocators?: Array<string | null>;
  };
}

// Palette de notes (fonds pastel type post-it + transparent).
export const NOTE_COLORS = ["#fde68a", "#fca5a5", "#a7f3d0", "#bfdbfe", "#ddd6fe", "#1f2937", "transparent"];

// Police manuscrite par défaut des notes (Caveat var, embarquée offline via @fontsource).
export const HANDWRITING_FONT = "'Caveat Variable', 'Comic Sans MS', cursive";

// Polices proposées dans l'éditeur de texte (la manuscrite en tête = défaut des notes).
export const FONT_FAMILIES: { labelKey: string; value: string }[] = [
  { labelKey: "font.presetHandwriting", value: HANDWRITING_FONT },
  { labelKey: "font.presetInter", value: "'Inter Variable', Inter, system-ui, sans-serif" },
  { labelKey: "font.presetSans", value: "ui-sans-serif, system-ui, sans-serif" },
  { labelKey: "font.presetSerif", value: "ui-serif, Georgia, serif" },
  { labelKey: "font.presetMono", value: "ui-monospace, 'Cascadia Code', monospace" },
];

// Police des titres (cadres, etc.) — Inter, indépendante du défaut manuscrit des notes.
const UI_FONT = "'Inter Variable', Inter, system-ui, sans-serif";

// Énumère TOUTES les polices installées sur la machine via la Local Font Access API
// (queryLocalFonts, dispo dans WebView2 — contexte sécurisé). Familles dédupliquées + triées.
// Repli sur FONT_FAMILIES si l'API manque ou si la permission est refusée. Caché (1er appel paie).
let _systemFonts: string[] | null = null;
export async function loadSystemFonts(): Promise<string[]> {
  if (_systemFonts) return _systemFonts;
  try {
    const q = (window as unknown as {
      queryLocalFonts?: () => Promise<Array<{ family: string }>>;
    }).queryLocalFonts;
    if (typeof q === "function") {
      const fonts = await q();
      const fams = Array.from(new Set(fonts.map((f) => f.family)))
        .sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
      if (fams.length) return (_systemFonts = fams);
    }
  } catch { /* API absente ou permission refusée → repli */ }
  return (_systemFonts = FONT_FAMILIES.map((f) => f.value));
}

// Item texte par défaut (note adhésive).
export function makeTextItem(x: number, y: number, z: number): BoardItem {
  return {
    id: uid(),
    kind: "text",
    ref: "",
    src: "",
    x,
    y,
    w: 260,
    h: 96,
    rotation: 0,
    z,
    text: "",
    fontSize: 28,
    fontFamily: HANDWRITING_FONT,
    color: "#ffffff",
    bg: "transparent",
    align: "left",
  };
}

// Cadre (conteneur titré) posé DERRIÈRE un groupe d'images. z bas → reste en fond.
// `opts` = défauts configurés (Paramètres › Nouveaux cadres).
export function makeFrameItem(x: number, y: number, opts?: { color?: string; fillMode?: "none" | "tint" | "solid" }): BoardItem {
  return {
    id: uid(),
    kind: "frame",
    ref: "",
    src: "",
    x,
    y,
    w: 640,
    h: 420,
    rotation: 0,
    z: 0,
    text: i18n.t("reference:item.frameDefault"),
    fontSize: 14,
    fontFamily: UI_FONT,
    color: opts?.color ?? "#60a5fa",
    fillMode: opts?.fillMode ?? "tint",
  };
}

// Calque de dessin maison — SINGLETON board-wide (géométrie ignorée). Tracés rendus en plein
// board (DrawLayer) alignés au pan/zoom. Persisté via la liste d'items.
export function makeDrawItem(): BoardItem {
  return { id: uid(), kind: "draw", ref: "", src: "", x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 0, shapes: [] };
}


export interface BoardScene {
  id: string;
  name: string;
  // Projet ouvert depuis un fichier .netsu : chemin du document (et son éventuel statut lecture
  // seule, cas d'une archive v1). Absent = scène de la bibliothèque interne.
  filePath?: string | null;
  fileReadonly?: boolean;
  items: BoardItem[];
  // Vue sauvegardée (pan/zoom) pour rouvrir la scène cadrée pareil.
  view?: BoardView;
  updatedAt?: number;
}

// Pan (translation écran) + zoom de la couche board.
export interface BoardView {
  tx: number;
  ty: number;
  scale: number;
}

export interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

export const MIN_SIZE = 48;
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 8;

// id court non cryptographique (suffit pour des clés DOM/scène locales).
export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// `ref` distant (URL web / data / blob) vs chemin disque local. SOURCE UNIQUE de ce test (utilisé
// par l'affichage, l'upscale, l'extraction de frames, la vignette de scène…). Un `ref` local est un
// chemin de fichier → certaines actions (upscale, extraction) ne s'appliquent qu'à lui.
export function isRemoteRef(ref: string): boolean {
  return /^(https?:|data:|blob:)/i.test(ref);
}

// z-index max / min d'une liste d'items (plan d'empilement). SOURCE UNIQUE du calcul (ajout d'item,
// duplication, fusion en séquence, premier/arrière-plan). Liste vide → 0.
export function topZ(items: { z: number }[]): number {
  return items.reduce((m, it) => Math.max(m, it.z), 0);
}
export function bottomZ(items: { z: number }[]): number {
  return items.reduce((m, it) => Math.min(m, it.z), 0);
}

// Écran → board : annule pan puis zoom.
export function screenToBoard(view: BoardView, px: number, py: number): { x: number; y: number } {
  return { x: (px - view.tx) / view.scale, y: (py - view.ty) / view.scale };
}

// Glisser-déposer interne (carte du MediaPicker → board). Payload sérialisé dans le dataTransfer ;
// `in`/`out` présents = plan (item vidéo trimé), absents = rush/média entier.
export const NR_MEDIA_DND = "application/x-nr-media";
export interface NrMediaDrag {
  file: string;
  title?: string;
  in?: number;
  out?: number;
}

// Extensions d'image / vidéo (consommées par kindFromPath ET le moteur d'embeds isVideoUrl/isImageUrl).
export const IMAGE_RE = /\.(jpg|jpeg|png|gif|webp|bmp|tif|tiff|avif|svg)$/i;
export const VIDEO_RE = /\.(mp4|mov|mkv|m4v|avi|webm|wmv|flv|mts|m2ts|ts|mpg|mpeg|3gp)$/i;

export function kindFromPath(p: string): ItemKind | null {
  if (IMAGE_RE.test(p)) return "image";
  if (VIDEO_RE.test(p)) return "video";
  return null;
}

// Moteur d'embeds en ligne (parsing YouTube/plateformes/socials + reconstruction d'URL d'iframe).
// Déplacé dans `embeds.ts` ; réexporté ici pour ne casser aucun import existant (tous les modules
// du board importent ces symboles depuis "./referenceShared").
export {
  youtubeId,
  isYoutubeShorts,
  youtubeNatSize,
  giphyGifUrl,
  parseVideoEmbed,
  EMBED_PLAYER_PROVIDERS,
  DOWNLOADABLE_EMBED_PROVIDERS,
  isVideoUrl,
  isImageUrl,
} from "./embeds";
export type { EmbedProvider } from "./embeds";

// --- Mesure du ratio natif (partagée ingestion / envoi externe) ------------------------------
const MAX_INITIAL = 420; // côté max d'un item fraîchement posé (px board)

export function fitSize(natW: number, natH: number, max = MAX_INITIAL): { w: number; h: number } {
  if (!natW || !natH) return { w: max, h: Math.round(max * 0.5625) };
  const r = Math.min(1, max / Math.max(natW, natH));
  return { w: Math.round(natW * r), h: Math.round(natH * r) };
}

export function probeImage(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = src;
  });
}

export function probeVideo(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight });
    v.onerror = () => resolve({ w: 0, h: 0 });
    v.src = src;
  });
}

// Mesure du ratio natif d'un média selon son kind — SOURCE UNIQUE de la branche image/vidéo
// (voies d'ingestion du board + envoi externe `sendPathToBoard`).
export function probeNat(kind: ItemKind, src: string): Promise<{ w: number; h: number }> {
  return kind === "image" ? probeImage(src) : probeVideo(src);
}

// Conteneurs vidéo lus nativement par WebView2 (Chromium). Le reste (mkv, ts, avi, wmv, flv…) doit
// passer par le remux ffmpeg à la volée (/stream copy), sinon le <video> ne charge rien.
const NATIVE_VIDEO = new Set(["mp4", "m4v", "mov", "webm"]);

// Localisateur durable → URL d'affichage. Chemin disque → core HTTP (/media Range-aware, ou /stream
// remux pour les conteneurs non lus) ; URL http(s)/data/blob → telle quelle ; youtube → YoutubeItem.
export function displaySrc(kind: ItemKind, ref: string): string {
  if (kind === "text" || kind === "frame" || kind === "draw") return "";
  // Séquence : pas de src unique (chaque frame calcule son src d'affichage via seqFrameSrc).
  if (kind === "sequence") return "";
  if (kind === "youtube") return ref;
  if (kind === "embed") return embedSrc(ref);
  if (!ref) return "";
  if (isRemoteRef(ref)) return ref;
  // Vidéo locale : mp4/mov/webm lisibles tels quels ; mkv & co passent par /stream copy, un remux
  // ffmpeg en direct — celui-là ne peut pas sortir du serveur HTTP, il n'existe pas comme fichier.
  if (kind === "video") {
    const ext = ref.split(".").pop()?.toLowerCase() || "";
    if (!NATIVE_VIDEO.has(ext)) return nr.streamUrl(ref, 0, "copy");
  }
  // Tout le reste est un FICHIER sur le disque → protocole asset de la coquille. Le serveur HTTP du
  // core partage son origine avec /rpc et le flux d'événements, et un webview n'ouvre que 6
  // connexions par origine : un board qui monte des dizaines de médias les mettait tous en file
  // derrière quatre créneaux libres. Le protocole asset est intercepté dans le processus, sans
  // socket. Hors Tauri (navigateur, panneau CEP), `assetUrl` retombe de lui-même sur /media.
  return nr.assetUrl(ref);
}
