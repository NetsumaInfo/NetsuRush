import { useCallback, useEffect, useMemo, useState } from "react";
import { nr } from "@/lib/bridge";
import { swrRead } from "@/lib/swr";
import type { AeVideoMode, AeAudioMode, AeVideoContainer, AeAudioContainer, AePrecompNaming, AePrecompTarget, AeTransformMode, AeNestedMode, AeAudioRenderFmt, UpscaleCodec, AeExportOpts, AeExportResult, AeProgress } from "@/lib/bridge";
import i18n from "@/i18n";

// Modes audio qui produisent un fichier (sinon = lien du fichier source).
const AUDIO_PRODUCES = new Set<AeAudioMode>(["remux", "aac", "pcm"]);

interface TimelineEntry {
  name: string;
  current: boolean;
}

// État + actions de l'export After Effects (sépare la logique du composant de vue).
export function useAeExport() {
  const [timelines, setTimelines] = useState<TimelineEntry[]>([]);
  const [timelinesError, setTimelinesError] = useState<string | null>(null);
  const [timelineName, setTimelineName] = useState<string | null>(null);
  const [compName, setCompName] = useState("");

  const [videoMode, setVideoMode] = useState<AeVideoMode>("copy");
  const [codec, setCodec] = useState<UpscaleCodec>("prores_422");
  const [audio, setAudio] = useState<AeAudioMode>("copy");
  const [abr, setAbr] = useState(192);
  const [handleSec, setHandleSec] = useState(0);
  const [precomp, setPrecomp] = useState(false);
  const [precompNaming, setPrecompNaming] = useState<AePrecompNaming>("file");
  const [precompTarget, setPrecompTarget] = useState<AePrecompTarget>("video");
  const [folders, setFolders] = useState(false);
  const [transformMode, setTransformMode] = useState<AeTransformMode>("none");
  const [nestedMode, setNestedMode] = useState<AeNestedMode>("render");
  const [audioRenderFmt, setAudioRenderFmt] = useState<AeAudioRenderFmt>("wav");
  const [individualRender, setIndividualRender] = useState(false);
  const [videoContainer, setVideoContainer] = useState<AeVideoContainer>("mov");
  const [audioContainer, setAudioContainer] = useState<AeAudioContainer>("m4a");
  const [outDir, setOutDir] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<AeProgress | null>(null);
  const [result, setResult] = useState<AeExportResult | null>(null);

  const loadTimelines = useCallback(async () => {
    // SWR : liste cachée peinte d'abord (instantané), scan Resolve la remplace ensuite.
    await swrRead(
      nr.snapshot?.peek("timelines"),
      () => nr.listTimelines(),
      (r) => {
        if (!r.ok) { setTimelinesError(r.error || i18n.t("ae:errors.timelinesUnavailable")); setTimelines([]); return; }
        setTimelinesError(null);
        setTimelines(r.timelines);
        // Sélectionne la timeline ouverte par défaut (sinon la première).
        setTimelineName((prev) => prev ?? r.current ?? r.timelines[0]?.name ?? null);
      },
    );
  }, []);

  useEffect(() => { loadTimelines(); }, [loadTimelines]);

  useEffect(() => nr.onAeProgress((p) => setProgress(p)), []);

  const chooseOut = useCallback(async () => {
    const dir = await nr.chooseDir();
    if (dir) setOutDir(dir);
    return dir;
  }, []);

  // Options prêtes à envoyer — partagées avec NetsuBridge, qui déclenche le même pipeline depuis la
  // page de transfert sans dupliquer la construction du payload.
  const options = useMemo<AeExportOpts>(() => ({
    timelineName,
    compName: compName.trim() || undefined,
    videoMode,
    codec,
    audio,
    abr,
    handleSec,
    precomp,
    precompNaming,
    precompTarget,
    folders,
    transformMode,
    nestedMode,
    audioRenderFmt,
    individualRender,
    videoContainer,
    audioContainer,
    outDir: outDir || undefined,
  }), [timelineName, compName, videoMode, codec, audio, abr, handleSec, precomp, precompNaming, precompTarget, folders, transformMode, nestedMode, audioRenderFmt, individualRender, videoContainer, audioContainer, outDir]);

  const run = useCallback(async () => {
    setBusy(true);
    setResult(null);
    setProgress(null);
    try {
      setResult(await nr.aeExport(options));
    } catch (e) {
      setResult({ ok: false, error: String(e) });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [options]);

  // Vidéo réencodée/remuxée/rendue, timeline imbriquée rendue, OU audio produit → fichiers sur disque.
  const audioProduces = AUDIO_PRODUCES.has(audio);
  const producesFiles = videoMode !== "copy" || nestedMode === "render" || individualRender || audioProduces;

  return {
    timelines, timelinesError, timelineName, setTimelineName, loadTimelines,
    compName, setCompName,
    videoMode, setVideoMode, codec, setCodec, audio, setAudio, abr, setAbr,
    handleSec, setHandleSec, precomp, setPrecomp,
    precompNaming, setPrecompNaming, precompTarget, setPrecompTarget, folders, setFolders,
    transformMode, setTransformMode,
    nestedMode, setNestedMode,
    audioRenderFmt, setAudioRenderFmt,
    individualRender, setIndividualRender,
    videoContainer, setVideoContainer, audioContainer, setAudioContainer,
    outDir, chooseOut, producesFiles, options,
    busy, progress, result, run,
  };
}

export type AeCtl = ReturnType<typeof useAeExport>;
