// Rangées de réglage partagées par les panneaux des Paramètres : libellé + explication à gauche,
// contrôle de largeur fixe à droite. Extraites de PlaybackSettings, où elles étaient locales, pour
// que deux pages de réglages ne divergent pas d'un pixel.
import type { ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-5 px-4 py-3">
      <div className="min-w-0">
        <p className="text-[0.8125rem] font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="w-52 shrink-0">{children}</div>
    </div>
  );
}

export type Choice<T extends string | number> = { value: T; label: string };

export function CompactSelect<T extends string | number>({ value, choices, onChange, disabled }: {
  value: T;
  choices: Choice<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <Select items={choices} value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
      <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
      <SelectContent>
        {choices.map((choice) => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
