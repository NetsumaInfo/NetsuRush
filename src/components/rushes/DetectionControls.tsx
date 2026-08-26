import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DetectModel } from "@/lib/bridge";
import { nr } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { modelUsesPreset } from "@/lib/detection";
import { MODELS, PRESETS } from "./cutStudioShared";

export function DetectionModelSelect({
  model,
  onChange,
  disabled = false,
  className,
  isModelDisabled,
  detail,
}: {
  model: DetectModel;
  onChange: (model: DetectModel) => void;
  disabled?: boolean;
  className?: string;
  isModelDisabled?: (model: DetectModel) => boolean;
  detail?: (model: DetectModel) => string;
}) {
  const { t } = useTranslation("derush");
  // Tant que le registre backend n'est pas disponible, seul le moteur socle bundlé est sûr.
  // Ne jamais exposer Omni/Auto par simple défaut d'UI.
  const [available, setAvailable] = useState<typeof MODELS>(MODELS.filter((entry) => entry.id === "transnetv2"));
  useEffect(() => {
    let live = true;
    void nr.modelsList().then((result) => {
      if (!live || !result.ok || result.models.length === 0) return;
      const installed = new Set(result.models.filter((entry) => entry.installed && entry.available !== false).map((entry) => entry.id));
      const next = MODELS.filter((entry) => installed.has(entry.id));
      if (next.length) {
        setAvailable(next);
        if (!next.some((entry) => entry.id === model)) onChange(next[0].id);
      }
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  const active = available.find((entry) => entry.id === model) ?? available[0] ?? MODELS[0];
  const activeDetail = detail?.(active.id) || t(active.hintKey);

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <Select
          value={available.some((entry) => entry.id === model) ? model : active.id}
          items={available.map((entry) => ({ value: entry.id, label: entry.label }))}
          onValueChange={(value) => {
            const next = available.find((entry) => entry.id === value)?.id;
            if (next && !isModelDisabled?.(next)) onChange(next);
          }}
          disabled={disabled}
        >
          <SelectTrigger
            size="sm"
            className={cn("w-36 shrink-0", className)}
            aria-label={t("shared.detectModel")}
          >
            <SelectValue>{active.label}</SelectValue>
          </SelectTrigger>
          {/* w-72 + 2 lignes : la description dit à quoi sert le modèle (fondus, seuil, GPU) —
              tronquée sur une ligne elle ne portait plus que l'adjectif. */}
          <SelectContent className="w-72">
            {available.map((entry) => (
              <SelectItem key={entry.id} value={entry.id} disabled={isModelDisabled?.(entry.id)} className="py-2">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs font-medium text-foreground">{entry.label}</span>
                  <span className="line-clamp-2 text-[10px] font-normal leading-snug text-muted-foreground">
                    {detail?.(entry.id) || t(entry.hintKey)}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TooltipTrigger>
      {/* Le nom du modèle est déjà sur le déclencheur : le tooltip ne porte que ce qu'il fait. */}
      <TooltipContent side="bottom" align="end" className="max-w-60">{activeDetail}</TooltipContent>
    </Tooltip>
  );
}

export function DetectionPresetSelect({
  model,
  preset,
  onChange,
  disabled = false,
  className,
}: {
  model: DetectModel;
  preset: number;
  onChange: (preset: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("derush");
  if (!modelUsesPreset(model)) return null;

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <Select
          value={String(preset)}
          items={PRESETS.map((entry, index) => ({ value: String(index), label: t(entry.labelKey) }))}
          onValueChange={(value) => onChange(Number(value))}
          disabled={disabled}
        >
          <SelectTrigger
            size="sm"
            className={cn("w-28 shrink-0", className)}
            aria-label={t("shared.precision")}
          >
            <SelectValue>{t(PRESETS[preset]?.labelKey ?? PRESETS[1].labelKey)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PRESETS.map((entry, index) => (
              <SelectItem key={entry.labelKey} value={String(index)}>{t(entry.labelKey)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-60">
        <p className="font-medium">{t("shared.precision")}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t("settings.defaultPresetHint")}</p>
      </TooltipContent>
    </Tooltip>
  );
}
