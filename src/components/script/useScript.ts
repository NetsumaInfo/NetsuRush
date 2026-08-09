// Store LOCAL du module Script (zustand, hors useApp — comme useReferenceBoard). Tient le document
// courant en mémoire + l'état d'édition ET l'état des panneaux (fermés par défaut : focus écriture ;
// pilotés d'ici pour permettre l'ouverture CONTEXTUELLE — ex. /transcript ouvre le panneau Footages
// en mode Paroles). L'éditeur Tiptap est la source de vérité du CONTENU : il resérialise via
// `replaceBlocks` ; toute mutation de bloc hors éditeur passe par `scriptEditorApi`, jamais par ici.
// La persistance/autosave sont des hooks séparés.

import { create } from "zustand";
import i18n from "@/i18n";
import type { ScriptDocSettings } from "@/lib/bridge";
import type { ScriptBlock, ScriptBlockMedia, ScriptDoc } from "./scriptShared";
import { emptyDoc, makeBlock } from "./scriptShared";

// Ce qu'il faut pour attacher un média ; piste & couleur sont attribuées à la création (makeMedia).
export interface MediaSpec {
  kind: ScriptBlockMedia["kind"];
  filePath: string;
  label: string;
  fps: number;
  inFrame?: number;
  outFrame?: number | null;
  source?: ScriptBlockMedia["source"];
}

// Mode d'ouverture du panneau Footages : navigation libre, onglet Vidéos, onglet Audio (source
// UNIQUE d'ajout de médias — plus aucun picker à droite), ou recherche par paroles.
export type FootagesMode = "browse" | "videos" | "audio" | "paroles";

interface ScriptState {
  doc: ScriptDoc | null;
  selected: string | null; // id du bloc sélectionné/focus
  dirty: boolean;
  tagFilter: string | null;
  favTags: string[];
  sectionSel: string[]; // sections cochées dans l'onglet Plan (export partiel) ; vide = tout
  hideTodos: boolean; // masque les à-faire dans le TEXTE (ils restent gérés dans le panneau droit)

  // Panneaux (focus écriture : tout fermé par défaut, ouverture à la demande ou contextuelle).
  footagesOpen: boolean;
  footagesMode: FootagesMode;
  rightOpen: boolean;
  splitOpen: boolean; // volet Carnet à droite du script (split dans l'onglet)

  newDoc: (resolveProject?: string | null) => void;
  loadDoc: (doc: ScriptDoc) => void;
  closeDoc: () => void;
  markSaved: () => void;

  setTitle: (title: string) => void;
  // Réglages PAR DOCUMENT (surcharge de prefs, sections repliées…) — fusion partielle, persistés
  // avec le doc (colonne script_doc.settings).
  setDocSettings: (patch: Partial<ScriptDocSettings>) => void;
  // Remplace TOUS les blocs d'un coup — l'éditeur Tiptap est la source de vérité pendant l'édition,
  // il resérialise vers ce modèle (persistance + timeline). Ne touche PAS `selected` (stable).
  replaceBlocks: (blocks: ScriptBlock[]) => void;

  setSelected: (id: string | null) => void;
  setTagFilter: (tag: string | null) => void;
  toggleFavTag: (tag: string) => void;
  toggleHideTodos: () => void;
  toggleSectionSel: (sectionId: string) => void;
  clearSectionSel: () => void;

  toggleFootages: () => void;
  requestFootages: (mode: FootagesMode) => void; // ouverture contextuelle (ex. /transcript)
  closeFootages: () => void;
  toggleRight: () => void;
  toggleSplit: () => void;
}

// Masquage des à-faire dans le texte, persisté hors document (préférence d'affichage globale).
const HIDE_TODOS_KEY = "nr-script-hidetodos";

// Tags favoris (assignables Ctrl+1…9) persistés hors document : partagés entre tous les scripts.
const FAV_KEY = "nr-script-favtags:v1";
function readFavTags(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string").slice(0, 9) : [];
  } catch {
    return [];
  }
}

// Réindexe `order` sur la position dans le tableau (source de vérité = ordre du tableau).
function reindex(blocks: ScriptBlock[]): ScriptBlock[] {
  return blocks.map((b, i) => (b.order === i ? b : { ...b, order: i }));
}

export const useScript = create<ScriptState>((set) => ({
  doc: null,
  selected: null,
  dirty: false,
  tagFilter: null,
  favTags: readFavTags(),
  sectionSel: [],
  hideTodos: localStorage.getItem(HIDE_TODOS_KEY) === "1",

  footagesOpen: false,
  footagesMode: "browse",
  rightOpen: false,
  splitOpen: false,

  newDoc: (resolveProject = null) => {
    const doc = emptyDoc(i18n.t("script:common.newScript"), resolveProject);
    set({ doc, selected: doc.blocks[0]?.id ?? null, dirty: true, tagFilter: null, sectionSel: [] });
  },
  loadDoc: (doc) => {
    // Compat : un vieux document (localStorage mock) peut avoir media en objet unique → tableau.
    const blocks = doc.blocks.map((b) => ({
      ...b,
      media: Array.isArray(b.media) ? b.media : b.media ? [b.media as ScriptBlockMedia] : [],
    }));
    set({ doc: { ...doc, blocks }, selected: blocks[0]?.id ?? null, dirty: false, tagFilter: null, sectionSel: [] });
  },
  closeDoc: () => set({ doc: null, selected: null, dirty: false, tagFilter: null, sectionSel: [] }),
  markSaved: () => set({ dirty: false }),

  setTitle: (title) => set((s) => (s.doc ? { doc: { ...s.doc, title }, dirty: true } : {})),

  setDocSettings: (patch) =>
    set((s) => (s.doc ? { doc: { ...s.doc, settings: { ...(s.doc.settings ?? {}), ...patch } }, dirty: true } : {})),

  replaceBlocks: (blocks) =>
    set((s) => {
      if (!s.doc) return {};
      const next = blocks.length ? reindex(blocks) : [makeBlock("text")];
      const sel = next.some((b) => b.id === s.selected) ? s.selected : null;
      return { doc: { ...s.doc, blocks: next }, selected: sel, dirty: true };
    }),

  setSelected: (id) => set({ selected: id }),
  setTagFilter: (tag) => set((s) => ({ tagFilter: s.tagFilter === tag ? null : tag })),
  toggleFavTag: (tag) =>
    set((s) => {
      const favTags = s.favTags.includes(tag) ? s.favTags.filter((t) => t !== tag) : [...s.favTags, tag].slice(0, 9);
      try { localStorage.setItem(FAV_KEY, JSON.stringify(favTags)); } catch { /* stockage plein/absent */ }
      return { favTags };
    }),
  toggleHideTodos: () =>
    set((s) => {
      const hideTodos = !s.hideTodos;
      try { localStorage.setItem(HIDE_TODOS_KEY, hideTodos ? "1" : "0"); } catch { /* stockage plein/absent */ }
      return { hideTodos };
    }),
  toggleSectionSel: (sectionId) =>
    set((s) => ({
      sectionSel: s.sectionSel.includes(sectionId)
        ? s.sectionSel.filter((x) => x !== sectionId)
        : [...s.sectionSel, sectionId],
    })),
  clearSectionSel: () => set({ sectionSel: [] }),

  toggleFootages: () => set((s) => ({ footagesOpen: !s.footagesOpen })),
  requestFootages: (mode) => set({ footagesOpen: true, footagesMode: mode }),
  closeFootages: () => set({ footagesOpen: false }),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
  toggleSplit: () => set((s) => ({ splitOpen: !s.splitOpen })),
}));

// Lecture impérative (hors render) pour la persistance.
export const scriptState = () => useScript.getState();
