import { useCallback, useEffect, useMemo, useState } from "react";
import { nr } from "@/lib/bridge";
import { swrRead } from "@/lib/swr";
import type { AeVideoMode, AeAudioMode, AeVideoContainer, AeAudioContainer, AePrecompNaming, AePrecompTarget, AeTransformMode, AeNestedMode, AeAudioRenderFmt, UpscaleCodec, AeExportOpts, AeExportResult, AeProgress, TransferUpscale } from "@/lib/bridge";
import { aeOutputReasons, audioContainersFor, videoContainersFor } from "./aeShared";
import i18n from "@/i18n";

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
  // Défaut aligné sur le core : `render` ferait rendre chaque timeline imbriquée par Resolve, donc
  // exigerait un dossier de sortie sans que rien d'autre n'écrive.
  const [nestedMode, setNestedMode] = useState<AeNestedMode>("flatten");
  const [audioRenderFmt, setAudioRenderFmt] = useState<AeAudioRenderFmt>("wav");
  const [videoContainer, setVideoContainer] = useState<AeVideoContainer>("mov");
  const [audioContainer, setAudioContainer] = useState<AeAudioContainer>("m4a");
  const [outDir, setOutDir] = useState<string | null>(null);
  const [upscale, setUpscale] = useState<TransferUpscale>({});

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

  // Les conteneurs SUIVENT le codec et le traitement audio : un choix fait dans un mode ne doit pas
  // rester appliqué dans un autre, où il donnerait un couple que ffmpeg refuse (ProRes en .mp4,
  // PCM en .m4a).
  useEffect(() => {
    const allowed = videoContainersFor(codec, videoMode);
    setVideoContainer((prev) => (allowed.includes(prev) ? prev : allowed[0]));
  }, [codec, videoMode]);

  useEffect(() => {
    setAudioContainer((prev) => (audioContainersFor(audio).includes(prev) ? prev : audioContainersFor(audio)[0]));
  }, [audio]);

  const chooseOut = useCallback(async () => {
    const dir = await nr.chooseDir();
    if (dir) setOutDir(dir);
    return dir;
  }, []);

  // L'upscale REMPLACE les pixels : ni la copie ni le réencapsulage ne savent le faire. L'option
  // impose donc le réencodage — le core applique la même règle, l'UI ne fait que la montrer.
  const growing = !!upscale.enabled;
  const effectiveVideoMode: AeVideoMode = growing ? "reencode" : videoMode;

  // Options prêtes à envoyer — partagées avec NetsuBridge, qui déclenche le même pipeline depuis la
  // page de transfert sans dupliquer la construction du payload.
  const options = useMemo<AeExportOpts>(() => ({
    timelineName,
    compName: compName.trim() || undefined,
    videoMode: effectiveVideoMode,
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
    videoContainer,
    audioContainer,
    outDir: outDir || undefined,
    upscale: upscale.enabled ? upscale : undefined,
  }), [timelineName, compName, effectiveVideoMode, codec, audio, abr, handleSec, precomp, precompNaming, precompTarget, folders, transformMode, nestedMode, audioRenderFmt, videoContainer, audioContainer, outDir, upscale]);

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

  // Ce qui écrit sur le disque, et POURQUOI : le panneau le dit au lieu de réclamer un dossier sans
  // motif. Table unique partagée avec NetsuBridge (aeShared).
  const outputReasons = aeOutputReasons({ videoMode: effectiveVideoMode, transformMode, nestedMode, audio });
  const producesFiles = outputReasons.length > 0;
  const needsDir = producesFiles && !outDir;

  return {
    timelines, timelinesError, timelineName, setTimelineName, loadTimelines,
    compName, setCompName,
    videoMode: effectiveVideoMode, setVideoMode, codec, setCodec, audio, setAudio, abr, setAbr,
    upscale, setUpscale, growing,
    handleSec, setHandleSec, precomp, setPrecomp,
    precompNaming, setPrecompNaming, precompTarget, setPrecompTarget, folders, setFolders,
    transformMode, setTransformMode,
    nestedMode, setNestedMode,
    audioRenderFmt, setAudioRenderFmt,
    videoContainer, setVideoContainer, audioContainer, setAudioContainer,
    outDir, chooseOut, producesFiles, outputReasons, needsDir, options,
    busy, progress, result, run,
  };
}

export type AeCtl = ReturnType<typeof useAeExport>;
