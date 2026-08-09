// Raccourcis-COMMANDES de NetsuCut (rebindables, combos inclus). Chaque action = 1 combo canonique.
// `useCutShortcuts` matche l'événement clavier via `matchAction` ; l'accueil du module édite
// `cutKeys` (store des réglages). La mécanique de combos est partagée (@/lib/shortcuts) avec le board.
//
// Les gestes NON rebindables (Maj+←/→ = image préc/suiv, Maj+clic = plage, Ctrl+clic = bascule) ne
// sont pas listés ici : ils vivent en dur dans `useCutShortcuts`/`CutStudio`, comme le nudge du board.

import { mergeKeys, type ShortcutMap } from "@/lib/shortcuts";

export type CutShortcutAction =
  | "playPause" | "prevShot" | "nextShot" | "firstShot" | "lastShot"
  | "speedDown" | "speedPlay" | "speedUp"
  | "merge" | "removeShot" | "selectAll" | "deselect" | "undo" | "redo"
  | "detect" | "export" | "sendTimeline" | "togglePlayer"
  | "preset1" | "preset2" | "preset3" | "preset4";

export const CUT_SHORTCUT_DEFS: { action: CutShortcutAction; labelKey: string; combo: string }[] = [
  { action: "playPause", labelKey: "shortcut.playPause", combo: "Space" },
  { action: "prevShot", labelKey: "shortcut.prevShot", combo: "ArrowLeft" },
  { action: "nextShot", labelKey: "shortcut.nextShot", combo: "ArrowRight" },
  { action: "firstShot", labelKey: "shortcut.firstShot", combo: "Home" },
  { action: "lastShot", labelKey: "shortcut.lastShot", combo: "End" },
  { action: "speedDown", labelKey: "shortcut.speedDown", combo: "J" },
  { action: "speedPlay", labelKey: "shortcut.speedPlay", combo: "K" },
  { action: "speedUp", labelKey: "shortcut.speedUp", combo: "L" },
  { action: "merge", labelKey: "shortcut.merge", combo: "M" },
  { action: "removeShot", labelKey: "shortcut.removeShot", combo: "Delete" },
  { action: "selectAll", labelKey: "shortcut.selectAll", combo: "A" },
  { action: "deselect", labelKey: "shortcut.deselect", combo: "Escape" },
  { action: "undo", labelKey: "shortcut.undo", combo: "Ctrl+Z" },
  { action: "redo", labelKey: "shortcut.redo", combo: "Ctrl+Shift+Z" },
  { action: "detect", labelKey: "shortcut.detect", combo: "D" },
  { action: "export", labelKey: "shortcut.export", combo: "E" },
  { action: "sendTimeline", labelKey: "shortcut.sendTimeline", combo: "T" },
  { action: "togglePlayer", labelKey: "shortcut.togglePlayer", combo: "P" },
  { action: "preset1", labelKey: "shortcut.preset1", combo: "1" },
  { action: "preset2", labelKey: "shortcut.preset2", combo: "2" },
  { action: "preset3", labelKey: "shortcut.preset3", combo: "3" },
  { action: "preset4", labelKey: "shortcut.preset4", combo: "4" },
];

export const DEFAULT_CUT_KEYS: ShortcutMap = Object.fromEntries(CUT_SHORTCUT_DEFS.map((d) => [d.action, d.combo]));

export const CUT_KEYS_STORAGE = "nr.cut.keys";

export function readCutKeys(): ShortcutMap {
  if (typeof localStorage === "undefined") return { ...DEFAULT_CUT_KEYS };
  try { return mergeKeys(DEFAULT_CUT_KEYS, JSON.parse(localStorage.getItem(CUT_KEYS_STORAGE) || "")); }
  catch { return { ...DEFAULT_CUT_KEYS }; }
}

// Paliers de vitesse de lecture (J recule dans la liste, L avance). Les valeurs négatives sont une
// lecture ARRIÈRE : `<video>` ne sait pas le faire nativement, le lecteur la simule (cf. ScenePlayer).
export const RATE_LADDER = [-8, -4, -2, -1, 1, 2, 4, 8] as const;
