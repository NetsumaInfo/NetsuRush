// État et actions de NetsuBridge : couple source → cible, timelines des deux hôtes, aperçu, exécution.
// Le montage vit côté core (core/transfer/) ; ce hook ne fait que choisir, montrer et déclencher.
import { useCallback, useEffect, useState } from "react";
import { nr } from "@/lib/bridge";
import type {
  AeExportOpts, TransferHost, TransferMediaMode, TransferPreview, TransferProgress, TransferResult,
} from "@/lib/bridge";
import type {
  ExportAudioMode, ExportCodec, ExportContainer, ExportEncoderMode, ExportSpeed,
} from "@/features/export/profiles";
import { canSwap, defaultTarget, hasRichAeOptions, isSupportedPair, loadPair, savePair } from "./transferShared";

interface HostTimelines {
  entries: { name: string; current: boolean }[];
  current: string | null;
  error: string | null;
}

const EMPTY: HostTimelines = { entries: [], current: null, error: null };

async function fetchTimelines(host: TransferHost): Promise<HostTimelines> {
  try {
    const r = await nr.transferSources({ host });
    if (!r.ok) return { entries: [], current: null, error: r.error ?? null };
    return { entries: r.timelines, current: r.current ?? r.timelines.find((t) => t.current)?.name ?? null, error: null };
  } catch (e) {
    return { entries: [], current: null, error: String(e) };
  }
}

export function useTransfer() {
  const initial = loadPair();
  const [from, setFromHost] = useState<TransferHost>(initial.from);
  const [to, setToHost] = useState<TransferHost>(initial.to);

  const [sources, setSources] = useState<HostTimelines>(EMPTY);
  const [targets, setTargets] = useState<HostTimelines>(EMPTY);
  const [timelineName, setTimelineName] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [mode, setMode] = useState<"new" | "append">("new");
  const [videoOnly, setVideoOnly] = useState(false);
  const [richAe, setRichAe] = useState(false);
  const [aeOptions, setAeOptions] = useState<AeExportOpts | null>(null);

  // Réglages d'encodage dans le vocabulaire des PROFILS D'EXPORT. Par défaut les fichiers d'origine
  // sont liés tels quels : un transfert de montage n'a aucune raison de transcoder.
  const [mediaMode, setMediaMode] = useState<TransferMediaMode>("copy");
  const [codec, setCodec] = useState<ExportCodec>("prores_422_hq");
  const [audioMode, setAudioMode] = useState<ExportAudioMode>("copy");
  const [container, setContainer] = useState<ExportContainer>("mov");
  const [encoderMode, setEncoderMode] = useState<ExportEncoderMode>("cpu");
  const [speed, setSpeed] = useState<ExportSpeed>("balanced");
  const [outDir, setOutDir] = useState<string | null>(null);

  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [result, setResult] = useState<TransferResult | null>(null);

  useEffect(() => savePair(from, to), [from, to]);
  useEffect(() => nr.onTransferProgress(setProgress), []);

  const loadSources = useCallback(async () => {
    const list = await fetchTimelines(from);
    setSources(list);
    setTimelineName(list.current ?? list.entries[0]?.name ?? null);
  }, [from]);

  const loadTargets = useCallback(async () => {
    const list = await fetchTimelines(to);
    setTargets(list);
    setTarget(list.current ?? list.entries[0]?.name ?? null);
  }, [to]);

  useEffect(() => { void loadSources(); }, [loadSources]);
  useEffect(() => { void loadTargets(); }, [loadTargets]);

  // Aperçu : ce que NetsuRush a réellement lu. Sans lui, un transfert qui échoue ne dit pas si le
  // problème vient de la lecture ou du montage.
  useEffect(() => {
    if (!timelineName) { setPreview(null); return; }
    let alive = true;
    setPreviewBusy(true);
    nr.transferRead({ host: from, to, timelineName })
      .then((r) => { if (alive) setPreview(r); })
      .catch((e) => { if (alive) setPreview({ ok: false, error: String(e) }); })
      .finally(() => { if (alive) setPreviewBusy(false); });
    return () => { alive = false; };
  }, [from, to, timelineName]);

  // Changer de source peut rendre la cible invalide (After Effects ne sait que recevoir) → on retombe
  // sur la première destination possible plutôt que de laisser un couple impossible.
  const setFrom = useCallback((host: TransferHost) => {
    setFromHost(host);
    setToHost((prev) => (isSupportedPair(host, prev) ? prev : defaultTarget(host)));
  }, []);

  const setTo = useCallback((host: TransferHost) => {
    setToHost((prev) => (isSupportedPair(from, host) ? host : prev));
  }, [from]);

  const swap = useCallback(() => {
    if (!canSwap(from, to)) return;
    setFromHost(to);
    setToHost(from);
  }, [from, to]);

  // Patch renvoyé par la cascade d'encodage partagée : choisir un codec entraîne le conteneur et le
  // codec audio, qu'on écrit d'un bloc (un rendu intermédiaire incohérent serait visible).
  const applyEncoding = useCallback((patch: {
    codec?: ExportCodec; container?: ExportContainer; audioMode?: ExportAudioMode;
    encoderMode?: ExportEncoderMode; speed?: ExportSpeed;
  }) => {
    if (patch.codec) setCodec(patch.codec);
    if (patch.container) setContainer(patch.container);
    if (patch.audioMode) setAudioMode(patch.audioMode);
    if (patch.encoderMode) setEncoderMode(patch.encoderMode);
    if (patch.speed) setSpeed(patch.speed);
  }, []);

  const rich = hasRichAeOptions(from, to);
  const producesFiles = mediaMode !== "copy" || (audioMode !== "copy" && audioMode !== "none");
  const needsDir = producesFiles && !outDir;

  const chooseOut = useCallback(async () => {
    const dir = await nr.chooseDir();
    if (dir) setOutDir(dir);
    return dir;
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setResult(null);
    setProgress(null);
    try {
      setResult(await nr.transferRun({
        from, to,
        timelineName: timelineName ?? undefined,
        name: name.trim() || undefined,
        mode,
        target: mode === "append" ? target ?? undefined : undefined,
        videoOnly,
        mediaMode, codec, audio: audioMode, container, encoderMode, speed,
        outDir: outDir ?? undefined,
        ae: rich && richAe && aeOptions ? aeOptions : undefined,
      }));
    } catch (e) {
      setResult({ ok: false, error: String(e) });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [from, to, timelineName, name, mode, target, videoOnly, mediaMode, codec, audioMode, container, encoderMode, speed, outDir, rich, richAe, aeOptions]);

  return {
    from, to, setFrom, setTo, swap, swappable: canSwap(from, to), rich,
    sources, targets, loadSources, loadTargets,
    timelineName, setTimelineName, target, setTarget,
    name, setName, mode, setMode, videoOnly, setVideoOnly,
    mediaMode, setMediaMode, codec, audioMode, container, encoderMode, speed, applyEncoding,
    outDir, chooseOut, producesFiles, needsDir,
    richAe, setRichAe, setAeOptions,
    preview, previewBusy, busy, progress, result, run,
  };
}

export type TransferCtl = ReturnType<typeof useTransfer>;
