import { useState } from "react";

import { cn } from "@/lib/utils";
import { clampSteppedNumber } from "./numberSpinValue";

/**
 * Saisie numérique PRÉCISE : champ libre, commit au blur ou à Entrée, bornes min/max, molette ±`step`.
 * Complète un curseur, qui donne le geste rapide mais jamais la valeur exacte.
 *
 * Vit dans la couche UI partagée : le board de référence (taille de police, épaisseur de trait) et
 * les réglages du fond d'écran ont le même besoin, et deux implémentations divergeraient.
 */
export function NumberSpin({
  value, min = 6, max = 400, step = 1, ariaLabel, className, disabled, onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (v: number) => clampSteppedNumber(v, min, max, step);
  const shown = draft ?? String(value);
  return (
    <input
      type="text" inputMode="decimal" role="spinbutton"
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
      aria-label={ariaLabel} value={shown} disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft != null) { const v = parseFloat(draft); onCommit(isNaN(v) ? value : clamp(v)); setDraft(null); } }}
      // `stopPropagation` : la molette pilote ici la valeur, elle ne doit pas aussi faire défiler la
      // page ni zoomer le board sous-jacent.
      onWheel={(e) => { e.stopPropagation(); if (!disabled) onCommit(clamp(value + (e.deltaY < 0 ? step : -step))); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      className={cn(
        "h-7 w-14 rounded-md border border-border bg-foreground/10 px-1.5 text-center text-xs font-semibold tabular-nums text-foreground outline-none transition-colors focus:border-primary focus:bg-foreground/[0.16]",
        "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
        className,
      )}
    />
  );
}
