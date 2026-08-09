// Modale « ? » des réglages de silence : gros aperçu (vraie waveform recolorée en direct, ligne de
// seuil visible, marge en vert translucide) + résumé chiffré LIVE (% conservé, nb de coupes, durée
// retirée) + chaque curseur collé à sa mini-explication → on bouge, on VOIT et on CHIFFRE l'effet.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircle, RotateCcw, Gauge, Timer, Mic, MoveHorizontal, type LucideIcon } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { useApp } from "@/store";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Slider } from "@/components/ui/slider";
import { ThresholdPreview, silencePreviewStats } from "./ThresholdPreview";
import { fmtTime } from "./voiceShared";

const DEFAULTS = { threshold: 0.5, min_silence_ms: 500, min_speech_ms: 100, pad_ms: 100 };

// Un bloc par curseur : icône + slider + phrase d'effet JUSTE en dessous (pas de liste détachée).
// labelKey/explainKey = clés i18n (namespace "voice"), résolues au rendu via t().
const PARAMS: {
  key: keyof typeof DEFAULTS; icon: LucideIcon; labelKey: string; explainKey: string;
  min: number; max: number; step: number; fmt: (v: number) => string;
}[] = [
  { key: "threshold", icon: Gauge, labelKey: "params.threshold", explainKey: "thresholdHelp.explains.threshold",
    min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: "min_silence_ms", icon: Timer, labelKey: "params.minSilence", explainKey: "thresholdHelp.explains.minSilence",
    min: 100, max: 2000, step: 50, fmt: (v) => `${v} ms` },
  { key: "min_speech_ms", icon: Mic, labelKey: "params.minSpeech", explainKey: "thresholdHelp.explains.minSpeech",
    min: 0, max: 1000, step: 25, fmt: (v) => `${v} ms` },
  { key: "pad_ms", icon: MoveHorizontal, labelKey: "params.pad", explainKey: "thresholdHelp.explains.pad",
    min: 0, max: 500, step: 10, fmt: (v) => `${v} ms` },
];

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className={`size-2.5 rounded-[3px] ${className}`} />
      {label}
    </span>
  );
}

export function ThresholdHelpDialog() {
  const { t } = useTranslation("voice");
  const [open, setOpen] = useState(false);
  const { p, setSilenceParams, voicePeaks, voiceDuration } = useApp(useShallow((s) => ({
    p: s.silenceParams, setSilenceParams: s.setSilenceParams, voicePeaks: s.voicePeaks, voiceDuration: s.voiceDuration,
  })));

  // Résumé chiffré recalculé à chaque mouvement de curseur (même moteur JS que l'aperçu).
  const stats = useMemo(() => silencePreviewStats(voicePeaks, p, voiceDuration), [voicePeaks, p, voiceDuration]);

  return (
    <>
      <Tooltip>
        <TooltipTrigger render={
          <button type="button" onClick={() => setOpen(true)} aria-label={t("thresholdHelp.helpAria")}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground">
            <HelpCircle className="size-3.5" />
          </button>
        } />
        <TooltipContent>{t("thresholdHelp.helpTooltip")}</TooltipContent>
      </Tooltip>
      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent className="w-[680px] max-w-[calc(100%-2rem)] gap-4 p-6">
            <DialogTitle className="text-base">{t("thresholdHelp.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("thresholdHelp.description")}{stats.real ? "" : t("thresholdHelp.descriptionExampleSuffix")}.
            </DialogDescription>

            <ThresholdPreview params={p} peaks={voicePeaks} duration={voiceDuration} className="h-32" showThreshold />

            {/* Légende + effet chiffré : le résultat des réglages, mesuré sur l'audio affiché. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <LegendDot className="bg-[color:var(--color-ok)]" label={t("thresholdHelp.legendKept")} />
              <LegendDot className="bg-[color:var(--color-ok)] opacity-40" label={t("thresholdHelp.legendPad")} />
              <LegendDot className="bg-destructive/60" label={t("thresholdHelp.legendCut")} />
              <span className="ml-auto text-[11px] tabular-nums">
                <span className="text-[color:var(--color-ok)]">{t("thresholdHelp.statsKeptPct", { pct: stats.keptPct })}</span>
                <span className="text-muted-foreground"> · {t("thresholdHelp.statsCuts", { count: stats.cuts })} · −{stats.cutSec >= 60 ? fmtTime(stats.cutSec) : `${stats.cutSec.toFixed(1).replace(".", ",")} s`}</span>
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {PARAMS.map(({ key, icon: Icon, labelKey, explainKey, min, max, step, fmt }) => (
                <div key={key} className="space-y-2 rounded-lg bg-muted/40 p-3">
                  <div className="flex items-center gap-1.5">
                    <Icon className="size-3.5 text-primary" />
                    <span className="text-xs font-medium">{t(labelKey)}</span>
                    <span className="ml-auto text-[11px] tabular-nums text-foreground/80">{fmt(p[key] ?? DEFAULTS[key])}</span>
                  </div>
                  <Slider value={[p[key] ?? DEFAULTS[key]]} min={min} max={max} step={step}
                    onValueChange={(v) => setSilenceParams({ [key]: Array.isArray(v) ? v[0] : v })} />
                  <p className="text-[11px] leading-snug text-muted-foreground">{t(explainKey)}</p>
                </div>
              ))}
            </div>

            <button type="button" onClick={() => setSilenceParams(DEFAULTS)} className="flex items-center gap-1 self-start text-[11px] text-muted-foreground transition-colors hover:text-foreground">
              <RotateCcw className="size-3" /> {t("thresholdHelp.resetDefaults")}
            </button>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
