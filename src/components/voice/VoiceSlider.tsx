// Briques partagées des panneaux voix : ligne de curseur (label + valeur + slider), bloc repliable
// (réglages cachables pour gagner de la place), et bascule on/off compacte. Réutilisés par
// VoiceControls et la modale d'aide ThresholdHelpDialog.
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

export function SliderRow({ label, hint, value, min, max, step, fmt, disabled, onChange }: {
  label: string; hint?: string; value: number; min: number; max: number; step: number;
  fmt: (v: number) => string; disabled?: boolean; onChange: (v: number) => void;
}) {
  const content = (
    <>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground/80">{fmt(value)}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} disabled={disabled}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)} />
    </>
  );
  if (!hint) return <div>{content}</div>;
  return (
    <Tooltip>
      <TooltipTrigger render={<div />}>{content}</TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

// Bloc de réglages repliable : en-tête cliquable (chevron) + contenu masquable. État persisté.
export function Disclosure({ title, right, storageKey, defaultOpen, children }: {
  title: string; right?: React.ReactNode; storageKey?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    try { const v = storageKey ? localStorage.getItem(storageKey) : null; return v == null ? !!defaultOpen : v === "1"; }
    catch { return !!defaultOpen; }
  });
  function toggle() {
    setOpen((o) => !o);
  }
  useEffect(() => {
    try { if (storageKey) localStorage.setItem(storageKey, open ? "1" : "0"); } catch { /* noop */ }
  }, [open, storageKey]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <button type="button" onClick={toggle} className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">
          <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} /> {title}
        </button>
        {right}
      </div>
      {open && <div className="space-y-2">{children}</div>}
    </div>
  );
}

// Bascule compacte (méthode de détection on/off) : pastille colorée + label.
export function MiniToggle({ label, on, color, onClick, disabled }: {
  label: string; on: boolean; color: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors disabled:opacity-50",
        on ? "border-border bg-muted text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/50",
      )}
    >
      <span className={cn("size-2 rounded-full", on ? color : "bg-muted-foreground/40")} />
      {label}
    </button>
  );
}
