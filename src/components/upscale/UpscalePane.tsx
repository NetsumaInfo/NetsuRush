// Volet d'upscale repliable, partagé par les écrans qui produisent des fichiers (archivage d'une
// collection, transfert NetsuBridge). Les réglages sont ceux de NetsuLab, sans copie : c'est le
// MÊME `UpscaleModelSettings`. Ce fichier n'ajoute que l'emballage — interrupteur, résumé du volet
// fermé, pliage — parce que la dizaine de réglages dépliés noierait le reste du panneau.
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Toggle } from "@/components/ui/toggle";
import { UpscaleModelSettings } from "./UpscaleModelSettings";
import { DEFAULT_SETTINGS, RESTORE_MODELS, SHADER_MODELS, UP_MODELS, type UpSettings } from "./upscaleShared";

/** Réglages d'upscale d'un écran hôte : ceux de NetsuLab, plus l'état de l'option. */
export type PaneUpscale = Partial<UpSettings> & { enabled?: boolean };

/**
 * En-tête d'un volet repliable de réglages. Le résumé à droite dit ce que porte le volet FERMÉ —
 * sans lui, replier reviendrait à cacher.
 */
export function SettingsPane({
  label, summary, open, onToggle, control, children,
}: {
  label: React.ReactNode;
  summary?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  control?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-muted/20">
      <div className="flex items-center gap-2 pr-2">
        <button type="button" aria-expanded={open} onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-xs font-medium transition-colors hover:bg-accent/40">
          <span className="shrink-0">{label}</span>
          {summary && <span className="min-w-0 flex-1 truncate text-right text-[11px] font-normal text-muted-foreground">{summary}</span>}
        </button>
        {control}
        <button type="button" aria-hidden tabIndex={-1} onClick={onToggle} className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {open && <div className="space-y-2.5 border-t border-border/70 px-2.5 py-2.5">{children}</div>}
    </div>
  );
}

/** Réglages effectifs : les défauts de NetsuLab, écrasés par ce que l'écran hôte a retenu. */
export const paneUpSettings = (value: PaneUpscale | undefined): UpSettings => ({ ...DEFAULT_SETTINGS, ...value });

/** Résumé du volet fermé : traitement retenu + échelle. */
export function UpscaleSummary({ value }: { value: PaneUpscale | undefined }) {
  if (!value?.enabled) return null;
  const s = paneUpSettings(value);
  const turbo = s.mode !== "restore" && s.engine === "turbo";
  const id = turbo ? s.shader : s.model;
  const label = (turbo ? SHADER_MODELS.find((m) => m.id === s.shader)?.label : UP_MODELS.find((m) => m.id === s.model)?.label)
    ?? RESTORE_MODELS.find((m) => m.id === s.model)?.label ?? id;
  return <>{`${label} · ${s.mode === "restore" ? 1 : s.scale}×`}</>;
}

/**
 * Volet complet, prêt à poser dans un panneau : interrupteur dans l'en-tête, réglages de modèle
 * dedans. Les libellés viennent de l'écran hôte — chacun a son espace de traduction.
 */
export function UpscalePane({
  value, onChange, label, onLabel, offLabel, disabled,
}: {
  value: PaneUpscale | undefined;
  onChange: (patch: PaneUpscale) => void;
  label: React.ReactNode;
  onLabel: string;
  offLabel: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const enabled = !!value?.enabled;
  return (
    <SettingsPane
      label={label}
      summary={open ? null : <UpscaleSummary value={value} />}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      control={
        <Toggle size="sm" variant="outline" pressed={enabled} disabled={disabled}
          onPressedChange={(on) => onChange({ enabled: on })}
          className="shrink-0 text-xs text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary">
          {enabled ? onLabel : offLabel}
        </Toggle>
      }
    >
      <UpscaleModelSettings settings={paneUpSettings(value)} patch={onChange} />
    </SettingsPane>
  );
}
