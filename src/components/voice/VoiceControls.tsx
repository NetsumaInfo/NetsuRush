// Colonne de contrôles (gauche) : moteur ASR, détection des silences + curseurs,
// nom de la timeline, puis sorties (Timeline / sous-titres / hésitations).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import { Scissors, SendHorizonal, Search, Type, Captions, Eraser, Wand2, FileCode, RotateCcw, AudioWaveform, Palette, Sparkles, BookmarkPlus, X } from "lucide-react";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import type { AsrModel, VadModel } from "@/lib/bridge";
import { useVoiceExport } from "./useVoiceExport";
import { ASR_MODELS, SUBTITLE_FORMATS, VAD_MODELS, fmtTime } from "./voiceShared";
import { fillerIndices, FILLER_CATS, FILLER_CAT_LABELS } from "./voiceFillers";
import { VOICE_PRESETS, matchVoicePreset } from "./voicePresets";
import { totalKept } from "./voiceCut";
import { ThresholdPreview } from "./ThresholdPreview";
import { ThresholdHelpDialog } from "./ThresholdHelpDialog";
import { SliderRow, Disclosure, MiniToggle } from "./VoiceSlider";
import { ModelsCta, useInstalledModels, useRequireModel } from "@/components/upscale/ModelPicker";
import { ExportButton } from "@/components/export/ExportButton";

const PARAM_DEFAULTS = { threshold: 0.5, min_silence_ms: 500, min_speech_ms: 100, pad_ms: 100, pad_end_ms: 100, snap_ms: 40, noise_gate: 0.25 };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-foreground/70">{title}</h3>
      {children}
    </div>
  );
}

// En-tête de groupe (Analyse / Sorties) : hiérarchie au-dessus des Sections, trait de continuation.
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-0.5">
      <span className="text-[11px] font-semibold tracking-wide text-foreground/80">{children}</span>
      <Separator className="flex-1" />
    </div>
  );
}

export function VoiceControls() {
  const { t } = useTranslation(["voice", "common"]);
  const {
    words, speech, removedWords, setRemoved, voiceFillerSpans, runDetectFillers,
    silenceParams, setSilenceParams, runDetectSilences, hesitationParams, setHesitationParams, voicePeaks,
    runTranscribe, runAnalyzeAll, asrModel, setAsrModel, vadModel, setVadModel, verbatim, setVerbatim, voiceBusy, voiceDuration, timelineName, setTimelineName,
    customPresets, saveCurrentAsPreset, deleteCustomPreset, voiceClipPath, voiceClipName,
  } = useApp(useShallow((s) => ({
    voiceClipPath: s.voiceClip?.path ?? null, voiceClipName: s.voiceClip?.name ?? null,
    runAnalyzeAll: s.runAnalyzeAll,
    customPresets: s.customPresets, saveCurrentAsPreset: s.saveCurrentAsPreset, deleteCustomPreset: s.deleteCustomPreset,
    words: s.words, speech: s.speech, removedWords: s.removedWords, setRemoved: s.setRemoved,
    voiceFillerSpans: s.voiceFillerSpans, runDetectFillers: s.runDetectFillers,
    silenceParams: s.silenceParams, setSilenceParams: s.setSilenceParams, runDetectSilences: s.runDetectSilences,
    hesitationParams: s.hesitationParams, setHesitationParams: s.setHesitationParams, voicePeaks: s.voicePeaks,
    runTranscribe: s.runTranscribe, asrModel: s.asrModel, setAsrModel: s.setAsrModel,
    vadModel: s.vadModel, setVadModel: s.setVadModel, verbatim: s.verbatim, setVerbatim: s.setVerbatim,
    voiceBusy: s.voiceBusy, voiceDuration: s.voiceDuration,
    timelineName: s.timelineName, setTimelineName: s.setTimelineName,
  })));
  const { busy: exportBusy, cutToTimeline, cutToTimelineColored, exportSubtitles, exportFile, currentCut } = useVoiceExport();
  const { ready: modelsReady, has: hasModel } = useInstalledModels();
  useRequireModel(asrModel);
  const availableAsr = ASR_MODELS.filter((m) => hasModel(m.id));

  const busy = !!voiceBusy || !!exportBusy;
  const hasSpeech = speech.length > 0;
  const hasWords = words.length > 0;
  const removedCount = removedWords.size;
  const p = silenceParams;
  const hp = hesitationParams;

  // Stats du montage : durée conservée / retirée / % (cut list finale, hésitations + répétitions retirées).
  const keptSegments = currentCut();
  const keptSec = totalKept(keptSegments);
  const removedSec = Math.max(0, voiceDuration - keptSec);
  const keptPct = voiceDuration > 0 ? Math.round((keptSec / voiceDuration) * 100) : 0;
  const canExport = keptSegments.length > 0;
  const asrHintKey = ASR_MODELS.find((m) => m.id === asrModel)?.hintKey;
  const asrHint = asrHintKey ? t(asrHintKey) : undefined;

  // Préréglage actif DÉDUIT des curseurs (aucun état stocké) : toucher un curseur → « Perso ».
  // Les presets ENREGISTRÉS participent au match et à l'application, comme les intégrés.
  const activePreset = useMemo(() => matchVoicePreset(p, hp, customPresets), [p, hp, customPresets]);
  const activePresetHintKey = VOICE_PRESETS.find((x) => x.id === activePreset)?.hintKey;
  const presetHint = activePreset
    ? (activePresetHintKey ? t(activePresetHintKey)
      : (customPresets.some((x) => x.id === activePreset) ? t("controls.presetSavedHint") : undefined))
    : t("controls.presetCustomHint");
  function applyPreset(id: string) {
    const preset = VOICE_PRESETS.find((x) => x.id === id) ?? customPresets.find((x) => x.id === id);
    if (!preset) return;
    setSilenceParams(preset.silence);
    setHesitationParams(preset.hesitation); // extraWords absent du preset → mots perso conservés
  }
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [presetName, setPresetName] = useState("");

  const fillers = useMemo(() => fillerIndices(words, hp), [words, hp]);
  const fillersRemoved = fillers.length > 0 && fillers.every((i) => removedWords.has(i));
  function toggleFillers() {
    const next = new Set(removedWords);
    if (fillersRemoved) fillers.forEach((i) => next.delete(i));
    else fillers.forEach((i) => next.add(i));
    setRemoved(next);
  }

  return (
    <div className="flex flex-col gap-3.5 rounded-xl border border-border bg-card p-3">
      <GroupLabel>{t("controls.groupAnalyse")}</GroupLabel>
      <Section title={t("controls.sectionPreset")}>
        <ToggleGroup className="w-full" value={activePreset ? [activePreset] : []} onValueChange={(v) => v[0] && applyPreset(v[0])}>
          {VOICE_PRESETS.map((pr) => (
            <Tooltip key={pr.id}>
              <TooltipTrigger render={
                <ToggleGroupItem className="flex-1 text-[11px]" value={pr.id} disabled={busy}>{t(pr.labelKey)}</ToggleGroupItem>
              } />
              <TooltipContent className="max-w-56">{t(pr.hintKey)}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        {/* Presets enregistrés : chips sélectionnables, croix = supprimer, + Enregistrer sur réglages Perso. */}
        {(customPresets.length > 0 || !activePreset) && (
          <div className="flex flex-wrap gap-1.5">
            {customPresets.map((cp) => (
              <div key={cp.id}
                className={`group/chip flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-50 ${
                  activePreset === cp.id ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}>
                <button type="button" disabled={busy} onClick={() => applyPreset(cp.id)} className="min-w-0 flex-1 truncate text-left">
                  {cp.label}
                </button>
                <button type="button" disabled={busy} aria-label={t("controls.deletePreset", { label: cp.label })} className="rounded p-px opacity-0 transition-opacity hover:text-destructive group-hover/chip:opacity-100"
                  onClick={() => deleteCustomPreset(cp.id)}>
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {!activePreset && (
              <Tooltip>
                <TooltipTrigger render={
                  <button type="button" disabled={busy} onClick={() => { setPresetName(""); setSavePresetOpen(true); }}
                    className="flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50">
                    <BookmarkPlus className="size-3" /> {t("controls.savePreset")}
                  </button>
                } />
                <TooltipContent>{t("controls.savePresetTooltip")}</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
        <p className="text-[11px] leading-snug text-muted-foreground">{presetHint}</p>
        <Tooltip>
          <TooltipTrigger render={
            <Button className="w-full" size="sm" onClick={() => runAnalyzeAll()} disabled={busy}>
              <Sparkles className="size-4" /> {t("controls.analyzeAll")}
            </Button>
          } />
          <TooltipContent>{t("controls.analyzeAllTooltip")}</TooltipContent>
        </Tooltip>
        <Dialog open={savePresetOpen} onOpenChange={setSavePresetOpen}>
          <DialogContent className="max-w-xs">
            <DialogTitle className="text-sm">{t("controls.savePresetDialogTitle")}</DialogTitle>
            <form className="space-y-3" onSubmit={(e) => {
              e.preventDefault();
              if (presetName.trim()) { saveCurrentAsPreset(presetName); setSavePresetOpen(false); }
            }}>
              <Input autoFocus value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder={t("controls.savePresetPlaceholder")} />
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setSavePresetOpen(false)}>{t("common:action.cancel")}</Button>
                <Button type="submit" size="sm" disabled={!presetName.trim()}>{t("common:action.save")}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </Section>

      <Section title={t("controls.sectionTranscription")}>
        <Button className="w-full" size="sm" variant="outline" onClick={() => runTranscribe()} disabled={busy || (modelsReady && !hasModel(asrModel))}>
          <Captions className="size-4" /> {hasWords ? t("controls.retranscribe") : t("controls.transcribe")}
        </Button>
        <Disclosure title={t("controls.engine")} storageKey="nr.voice.open.asr">
          {availableAsr.length ? (
            <ToggleGroup className="w-full" value={[asrModel]} onValueChange={(v) => v[0] && setAsrModel(v[0] as AsrModel)}>
              {availableAsr.map((m) => (
                <ToggleGroupItem key={m.id} className="flex-1" value={m.id} disabled={busy}>{t(m.labelKey)}</ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : <ModelsCta />}
          {asrHint && <p className="text-[11px] leading-snug text-muted-foreground">{asrHint}</p>}
          <Tooltip>
            <TooltipTrigger render={<div className="flex flex-wrap gap-1.5" />}>
              <MiniToggle label={t("controls.verbatim")} on={verbatim} color="bg-amber-400" disabled={busy} onClick={() => setVerbatim(!verbatim)} />
            </TooltipTrigger>
            <TooltipContent className="max-w-56">{t("controls.verbatimTooltip")}</TooltipContent>
          </Tooltip>
        </Disclosure>
      </Section>

      <Section title={t("controls.sectionSilences")}>
        <Button className="w-full" size="sm" variant="outline" onClick={() => runDetectSilences()} disabled={busy}>
          <Search className="size-4" /> {t("controls.detectSilences")}
        </Button>
        {/* Réglages repliables (gagner de la place) + « ? » → gros aperçu interactif avec explications. */}
        <Disclosure title={t("controls.settings")} storageKey="nr.voice.open.sil" right={<ThresholdHelpDialog />}>
          <ToggleGroup className="w-full" value={[vadModel]} onValueChange={(v) => v[0] && setVadModel(v[0] as VadModel)}>
            {VAD_MODELS.map((m) => {
              const item = (
                <ToggleGroupItem key={m.id} className="flex-1" value={m.id} disabled={busy || m.disabled}>
                  {t(m.labelKey)}
                </ToggleGroupItem>
              );
              return m.hintKey ? (
                <Tooltip key={m.id}>
                  <TooltipTrigger render={item} />
                  <TooltipContent>{t(m.hintKey)}</TooltipContent>
                </Tooltip>
              ) : item;
            })}
          </ToggleGroup>
          {/* Couche de CONFIRMATION anti-bruit (NOVA-VAD) : Silero pose les frontières, NOVA écarte
              les régions de parole qui sont en réalité du bruit (toux/clavier) sur rush bruyant. */}
          <Tooltip>
            <TooltipTrigger render={<div className="flex flex-wrap gap-1.5" />}>
              <MiniToggle label={t("controls.novaConfirm")} on={p.nova_confirm === true} color="bg-sky-400" disabled={busy}
                onClick={() => setSilenceParams({ nova_confirm: !p.nova_confirm })} />
            </TooltipTrigger>
            <TooltipContent className="max-w-56">{t("controls.novaConfirmTooltip")}</TooltipContent>
          </Tooltip>
          {p.nova_confirm && (
            <SliderRow label={t("params.novaConfidence")} hint={t("controls.hints.novaConfidence")} value={p.nova_min_conf ?? 0.6} min={0.3} max={0.95} step={0.05}
              fmt={(v) => `${Math.round(v * 100)}%`} disabled={busy} onChange={(v) => setSilenceParams({ nova_min_conf: v })} />
          )}
          <SliderRow label={t("params.threshold")} hint={t("controls.hints.threshold")} value={p.threshold ?? 0.5} min={0} max={1} step={0.05}
            fmt={(v) => v.toFixed(2)} disabled={busy} onChange={(v) => setSilenceParams({ threshold: v })} />
          <SliderRow label={t("params.minSilence")} hint={t("controls.hints.minSilence")} value={p.min_silence_ms ?? 500} min={100} max={2000} step={50}
            fmt={(v) => `${v} ms`} disabled={busy} onChange={(v) => setSilenceParams({ min_silence_ms: v })} />
          <SliderRow label={t("params.minSpeech")} hint={t("controls.hints.minSpeech")} value={p.min_speech_ms ?? 100} min={0} max={1000} step={25}
            fmt={(v) => `${v} ms`} disabled={busy} onChange={(v) => setSilenceParams({ min_speech_ms: v })} />
          <SliderRow label={t("params.pad")} hint={t("controls.hints.pad")} value={p.pad_ms ?? 100} min={0} max={500} step={10}
            fmt={(v) => `${v} ms`} disabled={busy} onChange={(v) => setSilenceParams({ pad_ms: v })} />
          <SliderRow label={t("params.padEnd")} hint={t("controls.hints.padEnd")} value={p.pad_end_ms ?? p.pad_ms ?? 100} min={0} max={800} step={10}
            fmt={(v) => `${v} ms`} disabled={busy} onChange={(v) => setSilenceParams({ pad_end_ms: v })} />
          <SliderRow label={t("params.noiseGate")} hint={t("controls.hints.noiseGate")} value={p.noise_gate ?? 0.25} min={0} max={0.8} step={0.05}
            fmt={(v) => (v <= 0 ? t("controls.off") : `${Math.round(v * 100)}%`)} disabled={busy} onChange={(v) => setSilenceParams({ noise_gate: v })} />
          <div className="flex items-center justify-between pt-0.5 text-[11px] text-muted-foreground">
            <span>{t("controls.previewLabel")} <span className="opacity-60">{voicePeaks.length ? t("controls.previewOwnClip") : t("controls.previewExample")}</span></span>
            <button type="button" onClick={() => setSilenceParams(PARAM_DEFAULTS)} disabled={busy} className="flex items-center gap-1 hover:text-foreground disabled:opacity-50">
              <RotateCcw className="size-3" /> {t("controls.resetDefaults")}
            </button>
          </div>
          <ThresholdPreview params={p} peaks={voicePeaks} duration={voiceDuration} />
        </Disclosure>
      </Section>

      <Section title={t("controls.sectionHesitations")}>
        <Button className="w-full" size="sm" variant="outline" onClick={() => runDetectFillers()} disabled={busy || (!hasSpeech && !hasWords)}>
          <AudioWaveform className="size-4" /> {t("controls.detectFillersAudio")}
          {voiceFillerSpans.length > 0 && <span className="ml-auto rounded bg-amber-400/20 px-1.5 text-[11px] text-amber-500">{voiceFillerSpans.length}</span>}
        </Button>
        {/* Méthodes mélangeables (on/off) + réglages repliables. Lexical/prolongation = instantané ;
            audio = à relancer via « Détecter ». */}
        {/* Méthodes mélangeables. Lexical/traînés/tics = instantané (HMR) ; sons tenus (audio) = relancer
            « Détecter ». Les tics (du coup, en fait, genre…) sont ambigus → OFF par défaut. */}
        <div className="flex flex-wrap gap-1.5">
          <MiniToggle label={t("controls.heldSounds")} on={hp.acoustic !== false} color="bg-amber-400" disabled={busy} onClick={() => setHesitationParams({ acoustic: hp.acoustic === false })} />
          <MiniToggle label={t("controls.hesitationWords")} on={hp.lexical !== false} color="bg-amber-400" disabled={busy} onClick={() => setHesitationParams({ lexical: hp.lexical === false })} />
          <MiniToggle label={t("controls.draggedWords")} on={hp.prolongation !== false} color="bg-amber-400" disabled={busy} onClick={() => setHesitationParams({ prolongation: hp.prolongation === false })} />
          <MiniToggle label={t("controls.tics")} on={hp.markers === true} color="bg-amber-400" disabled={busy} onClick={() => setHesitationParams({ markers: hp.markers !== true })} />
        </div>
        <Disclosure title={t("controls.settings")} storageKey="nr.voice.open.hes">
          <SliderRow label={t("params.sensitivity")} hint={t("controls.hints.sensitivity")} value={hp.sensitivity ?? 0.5} min={0} max={1} step={0.05}
            fmt={(v) => `${Math.round(v * 100)}%`} disabled={busy} onChange={(v) => setHesitationParams({ sensitivity: v })} />
          <SliderRow label={t("params.minDuration")} hint={t("controls.hints.minDuration")} value={hp.min_ms ?? 400} min={200} max={800} step={25}
            fmt={(v) => `${v} ms`} disabled={busy} onChange={(v) => setHesitationParams({ min_ms: v })} />
          <SliderRow label={t("params.maxDuration")} hint={t("controls.hints.maxDuration")} value={hp.max_ms ?? 1500} min={800} max={3000} step={50}
            fmt={(v) => `${(v / 1000).toFixed(1)} s`} disabled={busy} onChange={(v) => setHesitationParams({ max_ms: v })} />
          <SliderRow label={t("params.monotoneTolerance")} hint={t("controls.hints.monotoneTolerance")} value={hp.monotone ?? 0.5} min={0} max={1} step={0.05}
            fmt={(v) => `${Math.round(v * 100)}%`} disabled={busy} onChange={(v) => setHesitationParams({ monotone: v })} />
          <div>
            <div className="mb-1 text-[11px] text-muted-foreground">{t("controls.wordTypes")}</div>
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(FILLER_CATS).map((k) => {
                const on = hp.wordTypes?.[k] !== false;
                return <MiniToggle key={k} label={t(FILLER_CAT_LABELS[k])} on={on} color="bg-amber-400" disabled={busy}
                  onClick={() => setHesitationParams({ wordTypes: { ...hp.wordTypes, [k]: !on } })} />;
              })}
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger render={
              <div>
                <div className="mb-1 text-[11px] text-muted-foreground">{t("controls.customWords")}</div>
                <Input value={hp.extraWords ?? ""} onChange={(e) => setHesitationParams({ extraWords: e.target.value })} placeholder={t("controls.customWordsPlaceholder")} disabled={busy} className="h-7 text-[11px]" />
              </div>
            } />
            <TooltipContent>{t("controls.customWordsTooltip")}</TooltipContent>
          </Tooltip>
        </Disclosure>
      </Section>

      <GroupLabel>{t("controls.groupSorties")}</GroupLabel>
      <Section title={t("controls.sectionTimeline")}>
        <Input
          value={timelineName}
          onChange={(e) => setTimelineName(e.target.value)}
          placeholder={t("controls.timelineNamePlaceholder")}
          disabled={busy}
        />
        <Button className="w-full" size="sm" onClick={() => cutToTimeline({ mode: "new", source: "silence" })} disabled={busy || !hasSpeech}>
          <Scissors className="size-4" /> {t("controls.cutSilences")}
        </Button>
        <Button className="w-full" size="sm" variant="ghost" onClick={() => cutToTimeline({ mode: "append", source: "silence" })} disabled={busy || !hasSpeech}>
          <SendHorizonal className="size-4" /> {t("controls.sendToTimeline")}
        </Button>
        {removedCount > 0 && (
          <Button className="w-full" size="sm" onClick={() => cutToTimeline({ mode: "new", source: "words" })} disabled={busy}>
            <Type className="size-4" /> {t("controls.editText", { count: removedCount })}
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger render={
            <Button className="w-full" size="sm" variant="ghost" onClick={() => cutToTimelineColored()} disabled={busy || (!hasSpeech && !hasWords)}>
              <Palette className="size-4" /> {t("controls.coloredTimeline")}
            </Button>
          } />
          <TooltipContent>{t("controls.coloredTimelineTooltip")}</TooltipContent>
        </Tooltip>
      </Section>

      {hasWords && (
        <Section title={t("controls.sectionSubtitles")}>
          <div className="flex gap-2">
            {SUBTITLE_FORMATS.map((f) => (
              <Button key={f.id} className="flex-1" size="sm" variant="outline" onClick={() => exportSubtitles(f.id)} disabled={busy}>
                <Captions className="size-4" /> {f.label}
              </Button>
            ))}
          </div>
          {fillers.length > 0 && (
            <Button className="w-full" size="sm" variant={fillersRemoved ? "default" : "outline"} onClick={toggleFillers} disabled={busy}>
              {fillersRemoved ? <Wand2 className="size-4" /> : <Eraser className="size-4" />}
              {fillersRemoved ? t("controls.restoreFillers", { count: fillers.length }) : t("controls.removeFillers", { count: fillers.length })}
            </Button>
          )}
        </Section>
      )}

      {canExport && (
        <Section title={t("controls.sectionExportFile")}>
          <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-[11px]">
            <span className="text-muted-foreground">{t("controls.kept")}</span>
            <span className="tabular-nums text-foreground">{fmtTime(keptSec)} <span className="text-muted-foreground">/ {fmtTime(voiceDuration)}</span> · <span className="text-[color:var(--color-ok)]">{keptPct}%</span></span>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("controls.removedOfPlans", { removed: fmtTime(removedSec), count: keptSegments.length })}</p>
          {/* Le rendu passe par le PROFIL d'export actif (codec/conteneur/audio partagés avec le
              Derush et la Recherche) — fusionné : un montage voix = UN fichier. Clic droit = profil. */}
          <ExportButton
            className="w-full"
            merge
            baseName={`${(voiceClipName || "montage").replace(/\.[^.]+$/, "")} — ${t("export.fileSuffixNoSilences")}`}
            clips={() => keptSegments.map((s) => ({ input: voiceClipPath ?? "", start: s.in, end: s.out }))}
            onTimelineImport={() => cutToTimeline({ mode: "new", source: removedCount ? "words" : "silence" })}
            disabled={busy || !voiceClipPath}
          />
          <Button className="w-full" size="sm" variant="ghost" onClick={() => exportFile("fcpxml")} disabled={busy}>
            <FileCode className="size-4" /> {t("controls.exportFcpxml")}
          </Button>
          <p className="text-[11px] text-muted-foreground">{t("controls.exportFormatsHint")}</p>
        </Section>
      )}
    </div>
  );
}
