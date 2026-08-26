// État et actions de NetsuBridge : couple source → cible, timelines des deux hôtes, aperçu, exécution.
// Le montage vit côté core (core/transfer/) ; ce hook ne fait que choisir, montrer et déclencher.
import { useCallback, useEffect, useState } from "react";
import { nr } from "@/lib/bridge";
import type {
  AeExportOpts, TransferHost, TransferMediaMode, TransferPreview, TransferProgress, TransferResult,
  TransferUpscale,
} from "@/lib/bridge";
import type {
  ExportAudioMode, ExportCodec, ExportContainer, ExportEncoderMode, ExportSpeed,
} from "@/features/export/profiles";
import { readPersistedObject, writePersistedObject } from "@/lib/persistedJson";
import { aeProducesFiles } from "@/components/ae/aeShared";
import { canSwap, defaultTarget, hasRichAeOptions, isSupportedPair, loadPair, savePair } from "./transferShared";

interface HostTimelines {
  entries: { name: string; current: boolean }[];
  current: string | null;
  error: string | null;
}

const EMPTY: HostTimelines = { entries: [], current: null, error: null };

/**
 * Réglages de travail de la page, MÉMORISÉS. Le panneau est démonté dès qu'on change d'onglet :
 * sans cette mémoire, un aller-retour rendait tout aux défauts. Ce qui dépend du projet ouvert
 * (timeline source, nom, timeline de destination) n'y est PAS : ces valeurs ne survivent pas au
 * projet suivant.
 */
const SETTINGS_KEY = "nr.transfer.settings";

interface TransferSettings {
  mode: "new" | "append";
  videoOnly: boolean;
  richAe: boolean;
  mediaMode: TransferMediaMode;
  codec: ExportCodec;
  audioMode: ExportAudioMode;
  container: ExportContainer;
  encoderMode: ExportEncoderMode;
  speed: ExportSpeed;
  outDir: string | null;
  upscale: TransferUpscale;
}

// Réglages d'encodage dans le vocabulaire des PROFILS D'EXPORT. Par défaut les fichiers d'origine
// sont liés tels quels : un transfert de montage n'a aucune raison de transcoder.
const DEFAULT_SETTINGS: TransferSettings = {
  mode: "new",
  videoOnly: false,
  richAe: false,
  mediaMode: "copy",
  codec: "prores_422_hq",
  audioMode: "copy",
  container: "mov",
  encoderMode: "cpu",
  speed: "balanced",
  outDir: null,
  upscale: {},
};

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

  const [saved] = useState(() => readPersistedObject(SETTINGS_KEY, DEFAULT_SETTINGS));
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"new" | "append">(saved.mode);
  const [videoOnly, setVideoOnly] = useState(saved.videoOnly);
  const [richAe, setRichAe] = useState(saved.richAe);
  const [aeOptions, setAeOptions] = useState<AeExportOpts | null>(null);

  const [mediaMode, setMediaMode] = useState<TransferMediaMode>(saved.mediaMode);
  const [codec, setCodec] = useState<ExportCodec>(saved.codec);
  const [audioMode, setAudioMode] = useState<ExportAudioMode>(saved.audioMode);
  const [container, setContainer] = useState<ExportContainer>(saved.container);
  const [encoderMode, setEncoderMode] = useState<ExportEncoderMode>(saved.encoderMode);
  const [speed, setSpeed] = useState<ExportSpeed>(saved.speed);
  const [outDir, setOutDir] = useState<string | null>(saved.outDir);
  const [upscale, setUpscale] = useState<TransferUpscale>(saved.upscale);

  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [result, setResult] = useState<TransferResult | null>(null);

  useEffect(() => savePair(from, to), [from, to]);
  useEffect(() => nr.onTransferProgress(setProgress), []);

  useEffect(() => {
    writePersistedObject<TransferSettings>(SETTINGS_KEY, {
      mode, videoOnly, richAe, mediaMode, codec, audioMode, container, encoderMode, speed, outDir, upscale,
    });
  }, [mode, videoOnly, richAe, mediaMode, codec, audioMode, container, encoderMode, speed, outDir, upscale]);

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

  // Côté Adobe il n'y a PAS de poller : le panneau republie sur événement, et rien d'autre ne
  // rafraîchit la liste. Une séquence supprimée puis rendue par Ctrl+Z laissait donc NetsuBridge sur
  // « aucune timeline » alors qu'elle était revenue. On redemande un scan à l'ouverture et à chaque
  // changement d'hôte, et on recharge dès que le panneau republie.
  useEffect(() => {
    for (const host of new Set([from, to])) {
      if (host === "ppro" || host === "aeft") void nr.adobeScan(host).catch(() => {});
    }
  }, [from, to]);

  useEffect(() => nr.onAdobeUpdate((p) => {
    if (busy) return; // pendant le montage, la liste attend
    if (p.app === from) void loadSources();
    if (p.app === to) void loadTargets();
  }), [from, to, busy, loadSources, loadTargets]);

  // Une timeline renommée/créée/supprimée dans Resolve laissait la liste — et donc le nom envoyé au
  // transfert — sur un état qui n'existe plus. Le poller du core diffuse déjà le changement.
  useEffect(() => nr.onResolveChanged((c) => {
    if (busy || (!c.timelines && !c.status)) return; // pendant le montage, la liste attend
    if (from === "resolve") void loadSources();
    if (to === "resolve") void loadTargets();
  }), [from, to, busy, loadSources, loadTargets]);

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
  /**
   * Le pipeline AE avancé REMPLACE le transfert générique : le core ne lit alors ni le traitement
   * des médias, ni l'encodage, ni le mode de destination de cette page. Ces réglages disparaissent
   * donc de l'écran quand il conduit. L'upscale et le dossier de sortie, eux, sont les MÊMES des
   * deux côtés : ils restent portés par cette page et voyagent avec l'option (`aeHost`).
   */
  const advanced = rich && richAe;

  // Fichiers écrits, et donc dossier obligatoire : par les réglages de CE panneau, ou par ceux du
  // panneau AE quand c'est lui qui conduit. Le second cas gate le bouton Transférer, sinon le refus
  // ne tomberait qu'au fond du core.
  // L'upscale REMPLACE les pixels : ni la copie ni le réencapsulage ne savent le faire. Le mode de
  // média affiché suit donc l'option, comme le core l'impose de son côté.
  const growing = !advanced && !!upscale.enabled;
  const effectiveMediaMode: TransferMediaMode = growing ? "reencode" : mediaMode;

  const producesFiles = advanced
    ? !!aeOptions && aeProducesFiles({
        videoMode: aeOptions.videoMode,
        transformMode: aeOptions.transformMode ?? "none",
        nestedMode: aeOptions.nestedMode ?? "flatten",
        audio: aeOptions.audio,
      })
    : effectiveMediaMode !== "copy" || (audioMode !== "copy" && audioMode !== "none");
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
        // Le pipeline AE avancé crée TOUJOURS une composition : pas de mode ni de cible à envoyer.
        mode: advanced ? "new" : mode,
        target: !advanced && mode === "append" ? target ?? undefined : undefined,
        videoOnly,
        mediaMode: effectiveMediaMode, codec, audio: audioMode, container, encoderMode, speed,
        outDir: outDir ?? undefined,
        upscale: growing ? upscale : undefined,
        // Le champ de destination de la page EST le nom de la composition.
        ae: advanced && aeOptions ? { ...aeOptions, compName: name.trim() || undefined } : undefined,
      }));
    } catch (e) {
      setResult({ ok: false, error: String(e) });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [from, to, timelineName, name, mode, target, videoOnly, effectiveMediaMode, codec, audioMode, container, encoderMode, speed, outDir, advanced, aeOptions, growing, upscale]);

  return {
    from, to, setFrom, setTo, swap, swappable: canSwap(from, to), rich, advanced,
    sources, targets, loadSources, loadTargets,
    timelineName, setTimelineName, target, setTarget,
    name, setName, mode, setMode, videoOnly, setVideoOnly,
    mediaMode: effectiveMediaMode, setMediaMode, codec, audioMode, container, encoderMode, speed, applyEncoding,
    upscale, setUpscale, growing,
    outDir, setOutDir, chooseOut, producesFiles, needsDir,
    richAe, setRichAe, setAeOptions,
    preview, previewBusy, busy, progress, result, run,
  };
}

export type TransferCtl = ReturnType<typeof useTransfer>;
