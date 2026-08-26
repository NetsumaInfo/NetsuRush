import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { nr } from "@/lib/bridge";
import { swrRead } from "@/lib/swr";
import { readPersistedObject, writePersistedObject } from "@/lib/persistedJson";
import type { AeVideoMode, AeAudioMode, AeVideoContainer, AeAudioContainer, AePrecompNaming, AePrecompTarget, AeTransformMode, AeNestedMode, AeAudioRenderFmt, UpscaleCodec, AeExportOpts, AeExportResult, AeProgress, TransferUpscale } from "@/lib/bridge";
import { aeOutputReasons, audioContainersFor, videoContainersFor } from "./aeShared";
import i18n from "@/i18n";

interface TimelineEntry {
  name: string;
  current: boolean;
}

/**
 * Réglages du formulaire, MÉMORISÉS. Le panneau est démonté dès qu'on quitte l'onglet — et, dans
 * NetsuBridge, dès qu'on referme les options avancées. Sans cette mémoire, chaque aller-retour
 * rendait les réglages aux défauts et jetait ce que l'utilisateur venait de poser.
 */
const SETTINGS_KEY = "nr.ae.settings";

interface AeFormSettings {
  videoMode: AeVideoMode;
  codec: UpscaleCodec;
  audio: AeAudioMode;
  abr: number;
  handleSec: number;
  precomp: boolean;
  precompNaming: AePrecompNaming;
  precompTarget: AePrecompTarget;
  folders: boolean;
  transformMode: AeTransformMode;
  nestedMode: AeNestedMode;
  audioRenderFmt: AeAudioRenderFmt;
  videoContainer: AeVideoContainer;
  audioContainer: AeAudioContainer;
}

// `nestedMode` par défaut aligné sur le core : `render` ferait rendre chaque timeline imbriquée par
// Resolve, donc exigerait un dossier de sortie sans que rien d'autre n'écrive.
const DEFAULT_FORM: AeFormSettings = {
  videoMode: "copy",
  codec: "prores_422",
  audio: "copy",
  abr: 192,
  handleSec: 0,
  precomp: false,
  precompNaming: "file",
  precompTarget: "video",
  folders: false,
  transformMode: "none",
  nestedMode: "flatten",
  audioRenderFmt: "wav",
  videoContainer: "mov",
  audioContainer: "m4a",
};

/**
 * Réglages qu'un écran hôte porte LUI-MÊME. NetsuBridge propose l'upscale et le dossier de sortie
 * avant même qu'on ouvre les options avancées : garder ici un second exemplaire posait deux fois la
 * même question, et ouvrir le panneau jetait la réponse déjà donnée.
 */
export interface AeHostState {
  upscale: TransferUpscale;
  setUpscale: Dispatch<SetStateAction<TransferUpscale>>;
  outDir: string | null;
  setOutDir: Dispatch<SetStateAction<string | null>>;
}

// État + actions de l'export After Effects (sépare la logique du composant de vue).
export function useAeExport(host?: AeHostState) {
  const [timelines, setTimelines] = useState<TimelineEntry[]>([]);
  const [timelinesError, setTimelinesError] = useState<string | null>(null);
  const [timelineName, setTimelineName] = useState<string | null>(null);
  const [compName, setCompName] = useState("");

  const [saved] = useState(() => readPersistedObject(SETTINGS_KEY, DEFAULT_FORM));
  const [videoMode, setVideoMode] = useState<AeVideoMode>(saved.videoMode);
  const [codec, setCodec] = useState<UpscaleCodec>(saved.codec);
  const [audio, setAudio] = useState<AeAudioMode>(saved.audio);
  const [abr, setAbr] = useState(saved.abr);
  const [handleSec, setHandleSec] = useState(saved.handleSec);
  const [precomp, setPrecomp] = useState(saved.precomp);
  const [precompNaming, setPrecompNaming] = useState<AePrecompNaming>(saved.precompNaming);
  const [precompTarget, setPrecompTarget] = useState<AePrecompTarget>(saved.precompTarget);
  const [folders, setFolders] = useState(saved.folders);
  const [transformMode, setTransformMode] = useState<AeTransformMode>(saved.transformMode);
  const [nestedMode, setNestedMode] = useState<AeNestedMode>(saved.nestedMode);
  const [audioRenderFmt, setAudioRenderFmt] = useState<AeAudioRenderFmt>(saved.audioRenderFmt);
  const [videoContainer, setVideoContainer] = useState<AeVideoContainer>(saved.videoContainer);
  const [audioContainer, setAudioContainer] = useState<AeAudioContainer>(saved.audioContainer);

  // Dossier de sortie et upscale : ceux de l'écran hôte quand il en porte, les nôtres sinon.
  const ownOutDir = useState<string | null>(null);
  const ownUpscale = useState<TransferUpscale>({});
  const hosted = !!host;
  const [outDir, setOutDir]: [string | null, Dispatch<SetStateAction<string | null>>] =
    host ? [host.outDir, host.setOutDir] : ownOutDir;
  const [upscale, setUpscale]: [TransferUpscale, Dispatch<SetStateAction<TransferUpscale>>] =
    host ? [host.upscale, host.setUpscale] : ownUpscale;

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<AeProgress | null>(null);
  const [result, setResult] = useState<AeExportResult | null>(null);

  useEffect(() => {
    writePersistedObject<AeFormSettings>(SETTINGS_KEY, {
      videoMode, codec, audio, abr, handleSec, precomp, precompNaming, precompTarget, folders,
      transformMode, nestedMode, audioRenderFmt, videoContainer, audioContainer,
    });
  }, [videoMode, codec, audio, abr, handleSec, precomp, precompNaming, precompTarget, folders,
    transformMode, nestedMode, audioRenderFmt, videoContainer, audioContainer]);

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

  // Quand un écran hôte conduit, c'est LUI qui choisit la timeline source : refaire le scan ici
  // relancerait Resolve pour une liste que ce panneau n'affiche même pas.
  useEffect(() => { if (!hosted) void loadTimelines(); }, [hosted, loadTimelines]);

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
  }, [setOutDir]);

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
