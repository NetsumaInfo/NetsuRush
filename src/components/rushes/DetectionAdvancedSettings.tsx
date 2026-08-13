import { useState } from "react";
import { ChevronDown, ChevronUp, CircleHelp, RotateCcw, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import type { DetectModel, DetectOptions, OmniInterLabel, OmniIntraLabel } from "@/lib/bridge";
import { OMNI_INTER_LABELS, OMNI_INTRA_LABELS } from "@/lib/detection";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MODELS } from "./cutStudioShared";

const OMNI_INTRA_LABEL_KEYS: Record<OmniIntraLabel, string> = {
  General: "advanced.intraGeneral",
  Dissolve: "advanced.intraDissolve",
  Wipes: "advanced.intraWipes",
  Push: "advanced.intraPush",
  Slide: "advanced.intraSlide",
  Zoom: "advanced.intraZoom",
  Fade: "advanced.intraFade",
  Doorway: "advanced.intraDoorway",
};

const OMNI_INTER_LABEL_KEYS: Record<OmniInterLabel, string> = {
  New_Start: "advanced.interNewStart",
  Hard_Cut: "advanced.interHardCut",
  Transition_Source: "advanced.interTransitionSource",
  Transition: "advanced.interTransition",
  Sudden_Jump: "advanced.interSuddenJump",
};

function FieldHint({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
      <span className="truncate">{label}</span>
      {hint && (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex shrink-0 text-muted-foreground" tabIndex={0} aria-label={hint} />}>
            <CircleHelp className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="right" align="center" className="max-w-56">
            <p className="font-medium">{label}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

function NumberSetting({ label, hint, value, min, max, step = 1, onChange }: {
  label: string; hint?: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void;
}) {
  const setClampedValue = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(max, Math.max(min, parsed));
    onChange(step >= 1 ? Math.round(clamped) : clamped);
  };
  return (
    <label className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-3">
      <FieldHint label={label} hint={hint} />
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => setClampedValue(event.currentTarget.value)}
        className="h-8 text-right text-xs [&::-webkit-inner-spin-button]:ml-2"
      />
    </label>
  );
}

function Labels<T extends string>({ label, hint, values, all, labelFor, onChange }: {
  label: string; hint: string; values: T[]; all: T[]; labelFor: (value: T) => string; onChange: (values: T[]) => void;
}) {
  const { t } = useTranslation("derush");
  const allSelected = all.every((value) => values.includes(value));
  return (
    <section className="flex flex-col gap-2">
      <FieldHint label={label} hint={hint} />
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" variant="outline" size="sm" disabled={allSelected} onClick={() => onChange([...all])} className="h-7 px-2 text-[11px]">
          {t("advanced.selectAllTypes")}
        </Button>
        {all.map((value) => (
          <Toggle
            key={value}
            size="sm"
            variant="outline"
            pressed={values.includes(value)}
            onPressedChange={(pressed) => {
              const next = pressed ? [...new Set([...values, value])] : values.filter((entry) => entry !== value);
              if (next.length) onChange(next);
            }}
            className="h-7 px-2 text-[11px] aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary"
          >
            {labelFor(value)}
          </Toggle>
        ))}
      </div>
    </section>
  );
}

export function DetectionAdvancedSettings({ model, disabled = false, compact = false }: {
  model: DetectModel; disabled?: boolean; compact?: boolean;
}) {
  const { t } = useTranslation("derush");
  const [expanded, setExpanded] = useState(false);
  const options = useApp((state) => state.detectionOptions);
  const setOptions = useApp((state) => state.setDetectionOptions);
  const resetOptions = useApp((state) => state.resetDetectionOptions);
  const patch = (next: DetectOptions) => setOptions({ ...options, ...next });
  const omni = options.omnishotcut;
  const meta = MODELS.find((entry) => entry.id === model) ?? MODELS[0];
  const hasMore = model !== "transnetv2";

  return (
    <Dialog onOpenChange={(open) => { if (!open) setExpanded(false); }}>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
          <DialogTrigger
            render={<Button variant="outline" size={compact ? "icon-sm" : "sm"} disabled={disabled} aria-label={t("advanced.open")} />}
          >
            <Settings2 className="size-4" />
            {!compact && t("advanced.open")}
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("advanced.open")}</TooltipContent>
      </Tooltip>

      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-1.5">
            <DialogTitle>{t("advanced.title", { model: meta.label })}</DialogTitle>
            <Tooltip>
              <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="size-6 text-muted-foreground" aria-label={t("advanced.description")} />}>
                <CircleHelp className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-60">{t("advanced.description")}</TooltipContent>
            </Tooltip>
          </div>
          <DialogDescription>{t(meta.hintKey)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {model === "transnetv2" && (
            <NumberSetting label={t("advanced.minSceneFrames")} hint={t("advanced.minSceneFramesHint")} value={options.minSceneFrames} min={1} max={300} onChange={(minSceneFrames) => patch({ minSceneFrames })} />
          )}

          {model === "omnishotcut" && (
            <div className="flex flex-col gap-4">
              <label className="grid grid-cols-[minmax(0,1fr)_17rem] items-center gap-3">
                <FieldHint label={t("advanced.omniMode")} hint={t("advanced.omniModeHint")} />
                <Select
                  value={omni.mode}
                  items={[
                    { value: "clean_shot", label: t("advanced.omniClean") },
                    { value: "default", label: t("advanced.omniTransitions") },
                  ]}
                  onValueChange={(mode) => patch({ omnishotcut: { ...omni, mode: mode === "default" ? "default" : "clean_shot" } })}
                >
                  <SelectTrigger size="sm" className="[&>span]:!line-clamp-none [&>span]:whitespace-nowrap"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="clean_shot">{t("advanced.omniClean")}</SelectItem>
                    <SelectItem value="default">{t("advanced.omniTransitions")}</SelectItem>
                  </SelectContent>
                </Select>
              </label>

              {omni.mode === "default" && (<>
                <Labels<OmniIntraLabel> label={t("advanced.intraLabels")} hint={t("advanced.labelsHint")} values={omni.intraLabels} all={OMNI_INTRA_LABELS} labelFor={(value) => t(OMNI_INTRA_LABEL_KEYS[value])} onChange={(intraLabels) => patch({ omnishotcut: { ...omni, intraLabels } })} />
                <Labels<OmniInterLabel> label={t("advanced.interLabels")} hint={t("advanced.labelsHint")} values={omni.interLabels} all={OMNI_INTER_LABELS} labelFor={(value) => t(OMNI_INTER_LABEL_KEYS[value])} onChange={(interLabels) => patch({ omnishotcut: { ...omni, interLabels } })} />
              </>)}
            </div>
          )}

          {model === "autoshot" && (
            <NumberSetting label={t("advanced.autoShotThreshold")} hint={t("advanced.autoShotThresholdHint")} value={options.autoshot.threshold} min={0.01} max={0.99} step={0.001} onChange={(threshold) => patch({ autoshot: { threshold } })} />
          )}

          {hasMore && (
            <Button type="button" variant="ghost" size="sm" className="self-start px-2 text-muted-foreground" onClick={() => setExpanded((value) => !value)}>
              {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              {t(expanded ? "advanced.showLess" : "advanced.showMore")}
            </Button>
          )}

          {expanded && (<div className="flex flex-col gap-4 border-t border-border pt-4">
            <NumberSetting label={t("advanced.minSceneFrames")} hint={t("advanced.minSceneFramesHint")} value={options.minSceneFrames} min={1} max={300} onChange={(minSceneFrames) => patch({ minSceneFrames })} />

            {model === "omnishotcut" && (<>
              <NumberSetting label={t("advanced.overlapWindow")} hint={t("advanced.overlapHint")} value={omni.overlapWindowLength} min={0} max={239} onChange={(overlapWindowLength) => patch({ omnishotcut: { ...omni, overlapWindowLength } })} />
            </>)}

          </div>)}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={resetOptions}>
            <RotateCcw className="size-4" /> {t("advanced.reset")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
