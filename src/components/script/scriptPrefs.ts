// Préférences NetsuDraft à DEUX niveaux : défauts globaux (localStorage, réglés depuis l'accueil)
// + surcharge PAR DOCUMENT (doc.settings.prefs, réglée depuis le menu ⋯ du doc). `effectivePrefs`
// fusionne les deux — tout consommateur (rendu du rail, surlignage, titres…) lit le résultat.
// Store zustand : les préférences pilotent des CLASSES sur .editor-area (rail-dot/rail-thumb,
// hide-hl) → un changement s'applique sans re-render des NodeViews ProseMirror.
// Pattern jumeau de reference/boardPrefs.ts (merge sur les défauts, clés inconnues tolérées).

import { create } from "zustand";
import type { MediaColor, ScriptDocSettings } from "@/lib/bridge";

export interface ScriptPrefs {
  railStyle: "thumb" | "dot"; // rail gauche : micro-vignette image (défaut) / pastille couleur seule
  hlVisible: boolean; // false = masque toutes les couleurs de liaison dans le texte
  colorMode: "auto" | "role"; // auto = couleur au cycle par plan ; role = couleur unique par défaut, re-teintée à la main (étiquettes)
  defaultColor: MediaColor; // couleur posée en mode « role »
  multiHeadings: boolean; // false = # / ## / ### donnent LE même titre (niveau unique)
  spellcheck: boolean; // correcteur orthographique natif (fr)
  splitRatio: number; // largeur du volet Carnet en split (0.2–0.7)
}

export const SCRIPT_PREFS_DEFAULT: ScriptPrefs = {
  railStyle: "thumb",
  hlVisible: true,
  colorMode: "auto",
  defaultColor: "blue",
  multiHeadings: false,
  spellcheck: true,
  splitRatio: 0.38,
};

const PREFS_KEY = "nr-script-prefs:v1";

// Version du schéma de préférences. À incrémenter quand un DÉFAUT change de valeur : le stocké gagne
// toujours sur le défaut, donc sans migration un réglage jamais choisi resterait figé sur l'ancienne
// valeur. v2 : railStyle passe de "dot" à "thumb" (les pastilles étaient rejetées) — on efface la
// clé stockée pour que le nouveau défaut s'applique.
const PREFS_VERSION = 2;
const MIGRATED_KEYS: Record<number, (keyof ScriptPrefs)[]> = { 2: ["railStyle"] };

function readStored(): ScriptPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || "");
    if (v && typeof v === "object") {
      const from = Number(v.v) || 1;
      const stored = { ...v } as Partial<ScriptPrefs> & { v?: number };
      // Purge les clés dont le défaut a changé depuis la version stockée.
      for (let ver = from + 1; ver <= PREFS_VERSION; ver++) {
        for (const k of MIGRATED_KEYS[ver] ?? []) delete stored[k];
      }
      delete stored.v;
      return { ...SCRIPT_PREFS_DEFAULT, ...stored };
    }
  } catch { /* défauts */ }
  return { ...SCRIPT_PREFS_DEFAULT };
}

function writeStored(prefs: ScriptPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, v: PREFS_VERSION })); } catch { /* stockage plein/absent */ }
}

interface ScriptPrefsState {
  prefs: ScriptPrefs; // défauts GLOBAUX (persistés localStorage)
  setPrefs: (patch: Partial<ScriptPrefs>) => void;
}

export const useScriptPrefs = create<ScriptPrefsState>((set) => ({
  prefs: readStored(),
  setPrefs: (patch) =>
    set((s) => {
      const prefs = { ...s.prefs, ...patch };
      writeStored(prefs);
      return { prefs };
    }),
}));

// Préférences effectives d'un document : défauts globaux + surcharge du doc (partielle).
export function effectivePrefs(settings: ScriptDocSettings | null | undefined, global: ScriptPrefs = useScriptPrefs.getState().prefs): ScriptPrefs {
  const over = settings?.prefs;
  return over && typeof over === "object" ? { ...global, ...over } : global;
}
