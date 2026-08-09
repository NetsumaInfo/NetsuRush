// Palette de LIAISON média ↔ texte — SOURCE UNIQUE côté TS. Le pendant CSS est le bloc
// `.nr-mc-*{--mc:…}` (notebookProse.css) : garder les deux listes alignées (mêmes hex).

import type { MediaColor } from "@/lib/bridge";

export const MEDIA_COLORS: MediaColor[] = ["blue", "green", "purple", "orange", "pink", "cyan"];

export const COLOR_HEX: Record<MediaColor, string> = {
  blue: "#4f86f7",
  green: "#10b981",
  purple: "#a855f7",
  orange: "#f59e0b",
  pink: "#ec4899",
  cyan: "#06b6d4",
};

// Classe CSS portant la variable `--mc` (consommée par toutes les règles couleur du module).
export const mcClass = (c: MediaColor) => `nr-mc-${c}`;
