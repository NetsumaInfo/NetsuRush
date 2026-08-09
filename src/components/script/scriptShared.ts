// Modèle & helpers partagés du module Script.
// Les types de données traversent l'IPC → définis dans bridge.ts, ré-exportés ici pour le module.

import { Pilcrow, Heading1, Heading2, Heading3, Heading, List, ListOrdered, MessageSquare, ListTodo, Film, Music, Hash, Brush, AudioLines, Lightbulb, Minus, type LucideIcon } from "lucide-react";
import type { MediaColor, MediaTrack, ScriptBlock, ScriptBlockMedia, ScriptBlockType, ScriptDoc, ScriptDocMeta } from "@/lib/bridge";
import { MEDIA_COLORS } from "./editor/mediaColors";
import { useScriptPrefs } from "./scriptPrefs";
import i18n from "@/i18n";

export type { MediaColor, MediaTrack, ScriptBlock, ScriptBlockMedia, ScriptBlockType, ScriptDoc, ScriptDocMeta };
export { MEDIA_COLORS };

export const SCRIPT_AUDIO_DIR_KEY = "nr-script-audiodir";
export const SCRIPT_RECORDINGS_DIR_KEY = "nr-script-recdir";
export const SCRIPT_RECORDINGS_DEST_KEY = "nr-script-recdest";

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function makeBlock(type: ScriptBlockType = "text"): ScriptBlock {
  return { id: uid(), type, text: "", tags: [], checked: false, data: "", order: 0, media: [] };
}

// Mode d'affichage de l'éditeur (barre du haut).
export type ScriptView = "all" | "no-audio" | "text-only";

// Couleur du prochain média : mode « auto » = première couleur libre (sinon cycle) ; mode « role »
// = couleur par défaut des préférences (étiquettes posées à la main, ex. bleu = interview).
export function nextColor(existing: ScriptBlockMedia[]): MediaColor {
  const prefs = useScriptPrefs.getState().prefs;
  if (prefs.colorMode === "role") return prefs.defaultColor;
  const used = new Set(existing.map((m) => m.color));
  return MEDIA_COLORS.find((c) => !used.has(c)) ?? MEDIA_COLORS[existing.length % MEDIA_COLORS.length];
}

// Prochaine piste libre du bon type (V* pour la vidéo, A* pour l'audio).
export function nextTrack(existing: ScriptBlockMedia[], kind: ScriptBlockMedia["kind"]): MediaTrack {
  const prefix = kind === "audio" ? "A" : "V";
  const slots: MediaTrack[] = kind === "audio" ? ["A1", "A2", "A3"] : ["V1", "V2", "V3"];
  const used = new Set(existing.filter((m) => m.track.startsWith(prefix)).map((m) => m.track));
  return slots.find((s) => !used.has(s)) ?? slots[slots.length - 1];
}

// Crée un média attaché. Piste & couleur attribuées selon ce qui existe déjà dans le bloc.
export function makeMedia(
  kind: ScriptBlockMedia["kind"],
  filePath: string,
  label: string,
  fps = 0,
  existing: ScriptBlockMedia[] = [],
  range?: { inFrame: number; outFrame: number | null; source?: ScriptBlockMedia["source"] },
): ScriptBlockMedia {
  return {
    id: uid(),
    kind,
    track: nextTrack(existing, kind),
    color: nextColor(existing),
    filePath,
    resolveItemId: null,
    inFrame: range?.inFrame ?? 0,
    outFrame: range?.outFrame ?? null,
    fps,
    label,
    source: range?.source,
  };
}

export function emptyDoc(title = i18n.t("script:common.newScript"), resolveProject: string | null = null): ScriptDoc {
  return { id: uid(), title, resolveProject, blocks: [makeBlock("text")] };
}

// Commandes du menu slash « / ». `type` = change le type du bloc ; `action` = effet spécial.
export interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  type?: ScriptBlockType;
  level?: number; // heading : niveau 1-3
  action?: "attach" | "audio" | "tag" | "transcript";
  keywords: string[];
}
export function slashCommands(): SlashCommand[] { return [
  { id: "text", label: i18n.t("script:slash.text.label"), hint: i18n.t("script:slash.text.hint"), icon: Pilcrow, type: "text", keywords: i18n.t("script:slash.text.keywords").split("|") },
  // « Titre » unique (défaut : un script n'a pas besoin de 3 grandeurs) ; les 3 niveaux
  // n'apparaissent que si la préférence multiHeadings est active (filterSlash).
  ...(["heading", "heading1", "heading2", "heading3"] as const).map((id, index) => ({ id, label: i18n.t(`script:slash.${id}.label`), hint: i18n.t(`script:slash.${id}.hint`), icon: [Heading, Heading1, Heading2, Heading3][index], type: "heading" as const, level: [2, 1, 2, 3][index], keywords: i18n.t(`script:slash.${id}.keywords`).split("|") })),
  { id: "bullet", label: i18n.t("script:slash.bullet.label"), hint: i18n.t("script:slash.bullet.hint"), icon: List, type: "bullet", keywords: i18n.t("script:slash.bullet.keywords").split("|") },
  { id: "numbered", label: i18n.t("script:slash.numbered.label"), hint: i18n.t("script:slash.numbered.hint"), icon: ListOrdered, type: "numbered", keywords: i18n.t("script:slash.numbered.keywords").split("|") },
  { id: "note", label: i18n.t("script:slash.note.label"), hint: i18n.t("script:slash.note.hint"), icon: MessageSquare, type: "note", keywords: i18n.t("script:slash.note.keywords").split("|") },
  { id: "callout", label: i18n.t("script:slash.callout.label"), hint: i18n.t("script:slash.callout.hint"), icon: Lightbulb, type: "callout", keywords: i18n.t("script:slash.callout.keywords").split("|") },
  { id: "divider", label: i18n.t("script:slash.divider.label"), hint: i18n.t("script:slash.divider.hint"), icon: Minus, type: "divider", keywords: i18n.t("script:slash.divider.keywords").split("|") },
  { id: "todo", label: i18n.t("script:slash.todo.label"), hint: i18n.t("script:slash.todo.hint"), icon: ListTodo, type: "todo", keywords: i18n.t("script:slash.todo.keywords").split("|") },
  { id: "storyboard", label: i18n.t("script:slash.storyboard.label"), hint: i18n.t("script:slash.storyboard.hint"), icon: Brush, type: "storyboard", keywords: i18n.t("script:slash.storyboard.keywords").split("|") },
  { id: "footage", label: i18n.t("script:slash.footage.label"), hint: i18n.t("script:slash.footage.hint"), icon: Film, action: "attach", keywords: i18n.t("script:slash.footage.keywords").split("|") },
  { id: "audio", label: i18n.t("script:slash.audio.label"), hint: i18n.t("script:slash.audio.hint"), icon: Music, action: "audio", keywords: i18n.t("script:slash.audio.keywords").split("|") },
  { id: "transcript", label: i18n.t("script:slash.transcript.label"), hint: i18n.t("script:slash.transcript.hint"), icon: AudioLines, action: "transcript", keywords: i18n.t("script:slash.transcript.keywords").split("|") },
  { id: "tag", label: i18n.t("script:slash.tag.label"), hint: i18n.t("script:slash.tag.hint"), icon: Hash, action: "tag", keywords: i18n.t("script:slash.tag.keywords").split("|") },
]; }

const MULTI_HEADING_IDS = new Set(["heading1", "heading2", "heading3"]);

export function filterSlash(query: string, multiHeadings = false): SlashCommand[] {
  const q = query.trim().toLowerCase();
  const pool = slashCommands().filter((c) =>
    multiHeadings ? c.id !== "heading" : !MULTI_HEADING_IDS.has(c.id),
  );
  if (!q) return pool;
  return pool.filter(
    (c) => c.label.toLowerCase().includes(q) || c.keywords.some((k) => k.includes(q)),
  );
}

// --- Statistiques & temps de montage RÉEL ----------------------------------
// La gouttière = position cumulée dans la timeline qui sera montée. Chaque bloc dure :
//  • plan vidéo avec in/out connus → durée RÉELLE de la coupe = (out-in+1)/fps ;
//  • bloc texte seul (voix off) ou média de durée inconnue → repli sur le temps de LECTURE
//    (≈200 mots/min) ; c'est l'estimation de la narration en attendant un vrai plan.
// Les titres ne durent rien (séparateurs de section).
export const WPM = 200;

export function stripHtml(html: string): string {
  const d = document.createElement("div");
  d.innerHTML = html || "";
  return (d.textContent || "").trim();
}

export function countWords(text: string): number {
  const d = document.createElement("div");
  d.innerHTML = text || "";
  // Les @mentions sont de la MÉTADONNÉE, pas du texte narré : exclues du minutage.
  d.querySelectorAll("[data-page-id]").forEach((el) => el.remove());
  const t = (d.textContent || "").trim();
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

// Types de bloc NON NARRÉS : ni minutage, ni sous-titres, ni timeline.
const NON_NARRATED = new Set<ScriptBlockType>(["heading", "storyboard", "divider", "callout"]);

// Mots narrés d'un bloc (titres, storyboards, encadrés, séparateurs exclus).
export function narrationWords(b: ScriptBlock): number {
  return NON_NARRATED.has(b.type) ? 0 : countWords(b.text);
}

// Ids de média LIÉS dans le HTML d'un bloc, dans l'ORDRE d'apparition (spans .nr-hl, dédupliqués).
// C'est la source de l'ordre TIMELINE : l'ordre des passages surlignés = l'ordre du montage.
export function parseLinkedIds(html: string): string[] {
  if (!html || !html.includes("data-media-id")) return [];
  const d = document.createElement("div");
  d.innerHTML = html;
  const out: string[] = [];
  d.querySelectorAll(".nr-hl[data-media-id]").forEach((el) => {
    const id = el.getAttribute("data-media-id");
    if (id && !out.includes(id)) out.push(id);
  });
  return out;
}

// Durée d'un média si elle est connue (in/out + cadence), sinon null (clip entier non probé / audio).
export function mediaDurationSec(media: ScriptBlockMedia | null): number | null {
  if (!media || media.outFrame == null || !media.fps) return null;
  return (media.outFrame - media.inFrame + 1) / media.fps;
}

// Durée RÉELLE d'un bloc dans la timeline : plus long plan VIDÉO trimé ; sinon estimation lecture.
export function blockDurationSec(b: ScriptBlock): number {
  if (b.type === "heading" || b.type === "storyboard" || b.type === "divider" || b.type === "callout") return 0;
  const vids = b.media.filter((m) => m.kind === "video").map(mediaDurationSec).filter((d): d is number => d != null);
  if (vids.length) return Math.max(...vids);
  return (narrationWords(b) / WPM) * 60;
}

export function docStats(doc: ScriptDoc | null): { paragraphs: number; words: number; seconds: number } {
  if (!doc) return { paragraphs: 0, words: 0, seconds: 0 };
  const words = doc.blocks.reduce((a, b) => a + narrationWords(b), 0);
  const seconds = doc.blocks.reduce((a, b) => a + blockDurationSec(b), 0);
  return { paragraphs: doc.blocks.length, words, seconds };
}

// Secondes → mm:ss (ou h:mm:ss).
export function fmtClock(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Durée lisible « ~4min 21s » pour la barre de stats.
export function fmtDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}min ${String(s).padStart(2, "0")}s` : `${s}s`;
}

// Durée courte d'un plan « 8.30s » (pilule média) ; bascule en mm:ss au-delà de la minute.
export function fmtSecs(sec: number): string {
  return sec >= 60 ? fmtClock(sec) : `${sec.toFixed(2)}s`;
}

// Payload de glisser-déposer d'un footage (panneau gauche → zone vidéo d'un bloc).
// startSec/endSec = hit de recherche par paroles : l'attache pose l'in-point au mot exact
// (fps réel relu via playInfo au drop — les frames dépendent de la cadence source).
export const NR_FOOTAGE_DND = "application/x-nr-footage";
export interface FootageDrag { filePath: string; label: string; fps: number; startSec?: number; endSec?: number; kind?: "video" | "audio"; source?: ScriptBlockMedia["source"] }

// Typage d'un média par son extension — source unique du tri « son ↔ image » (tiroir Footages,
// drop depuis l'Explorateur). Un chemin qui n'est ni l'un ni l'autre n'est pas un média.
const AUDIO_EXT = /\.(mp3|wav|aac|m4a|flac|ogg|opus|aif|aiff|wma)$/i;
const VIDEO_EXT = /\.(mp4|mov|mkv|avi|m4v|webm|mxf|mts|m2ts|ts|wmv|flv|mpg|mpeg|braw|r3d)$/i;
export const isAudioPath = (p: string) => AUDIO_EXT.test(p);
export const mediaKindFromPath = (p: string): "video" | "audio" | null =>
  AUDIO_EXT.test(p) ? "audio" : VIDEO_EXT.test(p) ? "video" : null;

export const secToFrame = (sec: number, fps: number) => Math.round(sec * (fps || 24));
export const frameToSec = (frame: number, fps: number) => frame / (fps || 24);

// Frame → timecode lisible mm:ss (ou h:mm:ss). fps nécessaire pour convertir.
export function fmtTimecode(frame: number, fps: number): string {
  const total = Math.max(0, Math.floor(frameToSec(frame, fps)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// Timecode PRÉCIS À LA FRAME (m:ss:ff) pour l'éditeur de plan : il travaille à la frame, et
// `fmtTimecode` (m:ss) y perd justement l'information qu'on vient y régler.
export function fmtFrames(frame: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps || 24));
  const f = Math.max(0, Math.round(frame));
  const total = Math.floor(f / rate);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}:${String(f % rate).padStart(2, "0")}`;
}

// Saisie libre d'un timecode : « 1:23:12 » (m:ss:ff), « 1:23 » (m:ss) ou « 83.5 » (secondes).
// null = non interprétable → l'appelant garde la valeur précédente.
export function parseFrames(text: string, fps: number): number | null {
  const rate = Math.max(1, Math.round(fps || 24));
  const parts = text.trim().split(":");
  if (parts.length > 3 || parts.some((p) => p !== "" && !/^\d*\.?\d*$/.test(p))) return null;
  const nums = parts.map((p) => Number(p || 0));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (nums.length === 3) return Math.round((nums[0] * 60 + nums[1]) * rate + nums[2]);
  if (nums.length === 2) return Math.round((nums[0] * 60 + nums[1]) * rate);
  return Math.round(nums[0] * rate);
}

// Tous les tags présents dans un document (dédupliqués, ordre d'apparition).
export function docTags(doc: ScriptDoc | null): string[] {
  if (!doc) return [];
  const set = new Set<string>();
  for (const b of doc.blocks) for (const t of b.tags) set.add(t);
  return [...set];
}

// --- Table des matières / sections (export partiel) -----
// Une section = un titre + les blocs qui le suivent jusqu'au prochain titre. Les blocs AVANT le
// premier titre forment une section implicite « Début ». Utilisé par l'onglet Plan (saut + export).
export interface DocSection {
  id: string;        // id du bloc titre (ou "__intro__" pour l'avant-premier-titre)
  title: string;
  level: number;      // niveau du titre (1-3) — indentation de la table des matières
  blockIds: string[]; // blocs de la section, TITRE INCLUS
  seconds: number;    // durée cumulée de la section
}

export function docSections(doc: ScriptDoc | null): DocSection[] {
  if (!doc) return [];
  const out: DocSection[] = [];
  let cur: DocSection | null = null;
  for (const b of doc.blocks) {
    if (b.type === "heading") {
      cur = { id: b.id, title: stripHtml(b.text) || i18n.t("script:common.untitled"), level: b.level ?? 2, blockIds: [b.id], seconds: 0 };
      out.push(cur);
      continue;
    }
    if (!cur) {
      cur = { id: "__intro__", title: i18n.t("script:common.start"), level: 1, blockIds: [], seconds: 0 };
      out.push(cur);
    }
    cur.blockIds.push(b.id);
    cur.seconds += blockDurationSec(b);
  }
  return out;
}
