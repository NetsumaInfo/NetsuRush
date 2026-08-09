// Sortie du module voix → Timeline Resolve native (réutilise nr.buildTimeline, frame-accurate).
// Source des segments conservés : « silence » (segments parlés Silero) ou « words » (mots non
// retirés = montage par texte). La conversion secondes → frames + les 3 invariants vivent dans
// core/timeline (buildTimeline). Calque de useCutExport côté derush.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import { nr, type SubtitleFormat } from "@/lib/bridge";
import { useApp } from "@/store";
import { hostBuildTimeline } from "@/lib/host";
import { enabledSpeechSegments, keptWordSegments, subtractSpans, totalKept, guardWords, buildColorPartition, CUT_RESOLVE_COLOR, type CutSegment } from "./voiceCut";
import { repetitionSpans, combineFillerSpans } from "./voiceFillers";

export function useVoiceExport() {
  const { t } = useTranslation("voice");
  const { voiceClip, words, speech, silence, offIntervals, removedWords, voiceFillerSpans, offFillers, offRepeats, hesitationParams, voiceDuration, timelineName, clipMeta, setVoiceNotice, setVoiceError } = useApp(
    useShallow((s) => ({
      voiceClip: s.voiceClip, words: s.words, speech: s.speech, silence: s.silence, offIntervals: s.offIntervals, removedWords: s.removedWords,
      voiceFillerSpans: s.voiceFillerSpans, offFillers: s.offFillers, offRepeats: s.offRepeats, hesitationParams: s.hesitationParams,
      voiceDuration: s.voiceDuration, timelineName: s.timelineName, clipMeta: s.clipMeta,
      setVoiceNotice: s.setVoiceNotice, setVoiceError: s.setVoiceError,
    })),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const repeats = useMemo(() => repetitionSpans(words), [words]);
  const allFillers = useMemo(() => combineFillerSpans(voiceFillerSpans, words, hesitationParams, silence), [voiceFillerSpans, words, hesitationParams, silence]);

  // Plages à RETIRER : hésitations (acoustique + lexical) + répétitions SÉLECTIONNÉES.
  function removalSpans(): { start: number; end: number }[] {
    return [
      ...allFillers.filter((_, i) => !offFillers.has(i)),
      ...repeats.filter((_, i) => !offRepeats.has(i)),
    ];
  }

  // Segments conservés : montage texte ou silences, AMPUTÉS des hésitations + répétitions, puis
  // recalés sur les mots — le VAD ne connaît que l'énergie, une frontière au milieu d'un mot
  // s'entend (attaque rabotée, « t » final avalé).
  function cutSegments(source: "silence" | "words"): CutSegment[] {
    const base = source === "words" ? keptWordSegments(words, removedWords) : enabledSpeechSegments(speech, offIntervals);
    return guardWords(subtractSpans(base, removalSpans()), words);
  }

  async function cutToTimeline(opts: { mode: "new" | "append"; source: "silence" | "words" }) {
    if (!voiceClip) return;
    const segments = cutSegments(opts.source);
    if (!segments.length) {
      setVoiceError(t("export.errNothingToBuild"));
      return;
    }
    const suffix = opts.source === "words" ? t("export.timelineSuffixEdit") : t("export.timelineSuffixNoSilences");
    const name = timelineName.trim() || `${voiceClip.name.replace(/\.[^.]+$/, "")} — ${suffix}`;
    setBusy(opts.mode === "append" ? t("export.sendingToTimeline") : t("export.creatingTimeline"));
    setVoiceError(null);
    setVoiceNotice(null);
    const r = await hostBuildTimeline(useApp.getState().activeHost, {
      name, input: voiceClip.path, srcFrames: voiceClip.srcFrames, mode: opts.mode, fps: clipMeta?.fps, segments,
    });
    setBusy(null);
    if (r.ok) {
      const removed = Math.max(0, voiceDuration - totalKept(segments));
      setVoiceNotice(
        t("export.timelineBase", { name: r.timeline, count: r.count ?? segments.length }) +
        (removed > 0.05 ? t("export.removedSuffix", { sec: removed.toFixed(1) }) : "") +
        (r.created ? t("export.createdSuffix") : "") +
        (r.fpsMismatch ? t("export.fpsMismatchSuffix") : ""),
      );
    } else {
      setVoiceError(r.error || t("export.errTimeline"));
    }
  }

  // Timeline TOUT EN COULEURS : monte le clip ENTIER découpé par type, chaque clip coloré dans Resolve
  // (🟢 parole · 🔵 silence · 🟠 hésitation · 🟦 répétition) → on relit/édite les coupes à l'œil dans
  // DaVinci (supprimer les colorées qu'on veut). Rien n'est retiré : c'est une revue, pas un montage.
  async function cutToTimelineColored() {
    if (!voiceClip) return;
    const dur = voiceDuration;
    if (!dur) { setVoiceError(t("export.errNoDuration")); return; }
    const activeFillers = allFillers.filter((_, i) => !offFillers.has(i));
    const activeRepeats = repeats.filter((_, i) => !offRepeats.has(i));
    const part = buildColorPartition(dur, silence, activeFillers, activeRepeats);
    if (!part.length) { setVoiceError(t("export.errNothingToBuildColored")); return; }
    const segments = part.map((p) => ({ in: p.in, out: p.out }));
    const colors = part.map((p) => CUT_RESOLVE_COLOR[p.type]);
    const name = timelineName.trim() || `${voiceClip.name.replace(/\.[^.]+$/, "")} — ${t("export.timelineSuffixColors")}`;
    setBusy(t("export.creatingColorTimeline"));
    setVoiceError(null); setVoiceNotice(null);
    const r = await hostBuildTimeline(useApp.getState().activeHost, { name, input: voiceClip.path, srcFrames: voiceClip.srcFrames, mode: "new", fps: clipMeta?.fps, segments, colors });
    setBusy(null);
    if (r.ok) {
      const nCut = part.filter((p) => p.type !== "speech").length;
      const colored = r.colored ?? 0;
      setVoiceNotice(
        t("export.timelineColoredBase", { name: r.timeline, count: r.count ?? segments.length, cuts: nCut, colored }) +
        (colored === 0 ? t("export.coloredRefused") : t("export.coloredLegend")) +
        (r.created ? t("export.createdSuffix") : ""),
      );
    } else {
      setVoiceError(r.error || t("export.errTimelineColored"));
    }
  }

  // Export fichier : MP4 (réencodé ffmpeg, silences coupés) ou FCPXML (préserve le timecode source
  // pour DaVinci/Premiere). Source = montage texte si des mots sont retirés, sinon les intervalles.
  async function exportFile(format: "mp4" | "fcpxml") {
    if (!voiceClip) return;
    const segments = cutSegments(removedWords.size ? "words" : "silence");
    if (!segments.length) { setVoiceError(t("export.errNothingToExport")); return; }
    const destPath = voiceClip.path.replace(/\.[^.]+$/, ` — ${t("export.fileSuffixNoSilences")}.${format}`);
    setBusy(t("export.exportingFormat", { format: format.toUpperCase() }));
    setVoiceError(null);
    setVoiceNotice(null);
    const r = await nr.exportCut({ input: voiceClip.path, segments, format, destPath, fps: clipMeta?.fps });
    setBusy(null);
    if (r.ok) setVoiceNotice(t("export.fileExported", { format: format.toUpperCase(), count: segments.length, path: r.path }));
    else setVoiceError(r.error || t("export.errExportFile", { format: format.toUpperCase() }));
  }

  // Cut list courante pour les sous-titres (recalage) : montage texte, sinon silences, sinon brut,
  // toujours amputée des hésitations acoustiques.
  function currentSegments(): CutSegment[] | undefined {
    const rm = removalSpans();
    if (removedWords.size) return subtractSpans(keptWordSegments(words, removedWords), rm);
    if (speech.length) return subtractSpans(enabledSpeechSegments(speech, offIntervals), rm);
    if (rm.length && voiceDuration) return subtractSpans([{ in: 0, out: voiceDuration }], rm);
    return undefined; // pas d'édition → sous-titres bruts (temps d'origine)
  }

  // Export SRT/VTT écrit à côté de la source. Les timestamps suivent le montage courant (recalage).
  async function exportSubtitles(format: SubtitleFormat) {
    if (!voiceClip || !words.length) { setVoiceError(t("export.errNoWords")); return; }
    const destPath = voiceClip.path.replace(/\.[^.]+$/, `.${format}`);
    setBusy(t("export.exportingFormat", { format: format.toUpperCase() }));
    setVoiceError(null);
    setVoiceNotice(null);
    const r = await nr.exportSubtitles({ words, segments: currentSegments(), format, destPath });
    setBusy(null);
    if (r.ok) setVoiceNotice(t("export.subtitlesExported", { format: format.toUpperCase(), count: r.lines ?? 0, path: r.path }));
    else setVoiceError(r.error || t("export.errSubtitles"));
  }

  // Cut list finale courante (source par défaut : montage texte si mots retirés, sinon silences) —
  // pour les stats « conservé / % » affichées dans les contrôles.
  function currentCut(): CutSegment[] {
    return cutSegments(removedWords.size ? "words" : "silence");
  }

  return { busy, cutToTimeline, cutToTimelineColored, exportSubtitles, exportFile, currentCut };
}
