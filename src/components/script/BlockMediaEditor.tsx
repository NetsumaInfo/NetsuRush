// Éditeur in/out d'un plan attaché : lecteur <video> (média natif via /media, Range seek) + waveform
// zoomable + transcript. Deux vues (Lecteur / Ondes) + plein écran. Les conteneurs non natifs (mkv)
// peuvent ne pas se lire dans la WebView → message ; la majorité des rushes (mp4/mov/HEVC) marchent.
// Raccourcis (pas de rappel affiché — l'UI porte les mêmes actions) : Espace lecture, I/O bornes,
// ←/→ frame (⇧ = 1 s), molette sur les ondes = zoom.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Play, Pause, ChevronLeft, ChevronRight, AudioLines, AudioWaveform, Loader2, TextQuote,
  Clapperboard, Maximize2, Minimize2, Fullscreen, SquareDashedMousePointer, Repeat,
  ChevronsLeftRight, MoreHorizontal, RotateCcw, ArrowRightToLine, ArrowLeftToLine,
} from "lucide-react";
import { nr, type VoiceWord } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { basename, cn } from "@/lib/utils";
import { fmtFrames, fmtTimecode, frameToSec, parseFrames, type ScriptBlockMedia } from "./scriptShared";
import { WaveTrim, type WaveTrimHandle, type WaveWindow } from "./WaveTrim";
import { useNativePlayerSurface } from "@/components/player/useNativePlayerSurface";

// Timecode ÉDITABLE : l'affichage seul obligeait à viser une borne à la souris pour un réglage que
// l'on connaît déjà au chiffre près. La frappe n'est validée qu'à Entrée / sortie de champ (une
// saisie intermédiaire comme « 1: » ne doit pas déplacer la borne).
function TimecodeField({ sec, fps, label, onCommit, onSeek }: {
  sec: number; fps: number; label: string; onCommit: (sec: number) => void; onSeek: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? fmtFrames(Math.round(sec * fps), fps);
  const commit = () => {
    if (draft === null) return;
    const frames = parseFrames(draft, fps);
    setDraft(null);
    if (frames != null) onCommit(frames / fps);
  };
  return (
    <input
      value={text}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={onSeek}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); }
        else if (e.key === "Escape") { e.preventDefault(); setDraft(null); (e.target as HTMLInputElement).blur(); }
      }}
      className="w-20 rounded-md border border-transparent bg-muted/50 px-1.5 py-0.5 text-center text-xs tabular-nums text-muted-foreground outline-none transition-colors hover:border-border focus:border-ring focus:text-foreground"
    />
  );
}

interface Props {
  media: ScriptBlockMedia;
  onClose: () => void;
  onCommit: (inFrame: number, outFrame: number | null) => void;
  // Insertion de la sélection avec le texte des mots [in,out] dans le bloc.
  onInsertTranscript?: (text: string) => void;
}

// Mots cliquables, mémoïsés : la tête de lecture se met à jour en rAF pendant la lecture — sans
// memo, des centaines de <button> se réconcilieraient 60 fois par seconde.
const TranscriptWords = memo(function TranscriptWords({
  words, inSec, outSec, fps, onWord,
}: { words: VoiceWord[]; inSec: number; outSec: number; fps: number; onWord: (t: number) => void }) {
  const { t } = useTranslation("script");
  if (words.length === 0) return <span className="text-xs text-muted-foreground">{t("mediaEditor.noSpeech")}</span>;
  return (
    <>
      {words.map((w, i) => (
        <Tooltip key={i}>
          <TooltipTrigger render={
            <button
              type="button"
              className={`transcript-word ${w.start >= inSec - 0.05 && w.end <= outSec + 0.05 ? "in-range" : ""}`}
              onClick={() => onWord(w.start)}
            >
              {w.word}{" "}
            </button>
          } />
          <TooltipContent>{fmtTimecode(Math.round(w.start * fps), fps)}</TooltipContent>
        </Tooltip>
      ))}
    </>
  );
});

export function BlockMediaEditor({ media, onClose, onCommit, onInsertTranscript }: Props) {
  const { t } = useTranslation("script");
  const fps = media.fps || 24;
  const ref = useRef<HTMLVideoElement>(null);
  const waveRef = useRef<WaveTrimHandle>(null);
  const [dur, setDur] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(false);
  const [inSec, setInSec] = useState(frameToSec(media.inFrame, fps));
  const [outSec, setOutSec] = useState<number | null>(media.outFrame == null ? null : frameToSec(media.outFrame, fps));
  const [words, setWords] = useState<VoiceWord[] | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [waveDur, setWaveDur] = useState(0);
  const [waveState, setWaveState] = useState<"loading" | "ready" | "failed">("loading");
  const [full, setFull] = useState(false);
  const isAudio = media.kind === "audio";
  // Vue : « player » = grande image, ondes compactes ; « wave » = grandes ondes (montage à l'oreille).
  const [focus, setFocus] = useState<"player" | "wave">(isAudio ? "wave" : "player");
  const [zoomed, setZoomed] = useState(false);

  const src = nr.mediaUrl(media.filePath);
  const outEff = outSec ?? dur;
  const nativeSurface = useNativePlayerSurface({
    path: isAudio ? undefined : media.filePath,
    autoPlay: false,
    volume: 1,
    startAt: frameToSec(media.inFrame, fps),
    onTime: setTime,
    onDuration: (duration) => {
      setDur(duration);
      if (outSec == null) setOutSec(duration);
    },
    onPlayingChange: setPlaying,
    onError: () => setError(true),
  });

  // Enveloppe d'amplitude pleine durée (mini-carte + repli du zoom). L'extraction audio peut durer
  // plusieurs secondes sur un long rush : l'état est exposé, sinon l'onde apparaît d'un coup et son
  // absence passe pour un bug.
  useEffect(() => {
    let alive = true;
    setWaveState("loading");
    void nr.waveform({ input: media.filePath, buckets: 2000 }).then((r) => {
      if (!alive) return;
      if (r?.ok && r.peaks?.length) {
        setPeaks(r.peaks);
        if (r.duration) setWaveDur(r.duration);
        setWaveState("ready");
      } else {
        setWaveState("failed");
      }
    }).catch(() => { if (alive) setWaveState("failed"); });
    return () => { alive = false; };
  }, [media.filePath]);

  const waveTotal = dur || waveDur;

  // Pics haute résolution sur la fenêtre visible (zoom). L'audio est déjà extrait/caché côté core.
  const loadWindow = async (start: number, end: number, buckets: number): Promise<WaveWindow | null> => {
    const r = await nr.waveform({ input: media.filePath, buckets, startSec: start, endSec: end }).catch(() => null);
    if (!r?.ok || !r.peaks) return null;
    return { start: r.start ?? start, end: r.end ?? end, peaks: r.peaks };
  };

  async function transcribe() {
    setTranscribing(true);
    setTranscriptError(null);
    try {
      const r = await nr.transcribe({ input: media.filePath });
      if (r?.ok) setWords(r.words);
      else setTranscriptError(r?.error || t("mediaEditor.transcriptionFailed"));
    } catch (e) {
      setTranscriptError(String(e));
    } finally {
      setTranscribing(false);
    }
  }

  function insertSelection() {
    if (!words || !onInsertTranscript) return;
    const text = words
      .filter((w) => w.start >= inSec - 0.05 && w.end <= outEff + 0.05)
      .map((w) => w.word)
      .join(" ")
      .trim();
    if (text) onInsertTranscript(text);
  }

  // Tête de lecture fluide (rAF pendant la lecture) + boucle dans [in, out].
  useEffect(() => {
    if (!playing || nativeSurface.mode === true) return;
    let raf = 0;
    const loop = () => {
      const v = ref.current;
      if (v) {
        if (outSec != null && v.currentTime >= outSec) v.currentTime = inSec;
        setTime(v.currentTime);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, inSec, outSec, nativeSurface.mode]);

  useEffect(() => {
    if (nativeSurface.mode !== true || !playing || outSec == null || time < outSec) return;
    nativeSurface.player.seek(inSec).then(() => nativeSurface.player.play()).catch(() => {});
  }, [inSec, nativeSurface.mode, nativeSurface.player, outSec, playing, time]);

  const seek = useCallback((t: number) => {
    if (nativeSurface.mode === true) {
      const next = Math.max(0, Math.min(t, dur || 0));
      nativeSurface.player.seek(next).catch(() => {});
      setTime(next);
      return;
    }
    const v = ref.current;
    if (v) { v.currentTime = Math.max(0, Math.min(t, dur || 0)); setTime(v.currentTime); }
  }, [dur, nativeSurface.mode, nativeSurface.player]);
  const toggle = useCallback(() => {
    if (nativeSurface.mode === true) {
      nativeSurface.player.toggle().catch(() => {});
      return;
    }
    const v = ref.current;
    if (!v) return;
    v.paused ? v.play().catch(() => {}) : v.pause();
  }, [nativeSurface.mode, nativeSurface.player]);

  // Aimantation des bornes sur les frontières de mots : couper au milieu d'un mot est L'erreur
  // classique du montage parole, et c'est invisible à l'œil sur la forme d'onde.
  const snapPoints = useMemo(() => (words ? words.flatMap((w) => [w.start, w.end]) : []), [words]);

  const setRange = useCallback((a: number, b: number) => { setInSec(a); setOutSec(b); }, []);

  const playSelection = useCallback(() => {
    seek(inSec);
    if (nativeSurface.mode === true) { nativeSurface.player.play().catch(() => {}); return; }
    ref.current?.play().catch(() => {});
  }, [inSec, seek, nativeSurface.mode, nativeSurface.player]);

  // Raccourcis I/O / espace / flèches frame / [ ] pour pousser une borne (hors champ de saisie).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      const step = e.shiftKey ? 1 : 1 / fps;
      if (e.key === "i" || e.key === "I") { e.preventDefault(); setInSec(Math.min(time, outEff)); }
      else if (e.key === "o" || e.key === "O") { e.preventDefault(); setOutSec(Math.max(time, inSec)); }
      else if (e.key === "[") { e.preventDefault(); setInSec((v) => Math.max(0, Math.min(v + (e.altKey ? step : -step), outEff))); }
      else if (e.key === "]") { e.preventDefault(); setOutSec((v) => Math.max(inSec, Math.min((v ?? outEff) + (e.altKey ? -step : step), dur || outEff))); }
      else if (e.code === "Space") { e.preventDefault(); toggle(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); seek(time - step); }
      else if (e.key === "ArrowRight") { e.preventDefault(); seek(time + step); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dur, fps, inSec, outEff, seek, time, toggle]);

  function commit() {
    const inFrame = Math.max(0, Math.round(inSec * fps));
    const outFrame = outSec == null ? null : Math.max(inFrame, Math.round(outSec * fps) - 1);
    onCommit(inFrame, outFrame);
  }

  const videoEl = (
    nativeSurface.mode === true ? (
      <div ref={nativeSurface.surfaceRef} className={isAudio ? "hidden" : "h-full max-h-full w-full bg-black"} />
    ) : nativeSurface.mode === false ? (
      <video
        ref={ref}
        src={src}
        className={isAudio ? "hidden" : "h-full max-h-full w-full object-contain"}
        onLoadedMetadata={(e) => { setDur(e.currentTarget.duration); if (outSec == null) setOutSec(e.currentTarget.duration); }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => setError(true)}
        onClick={isAudio ? undefined : toggle}
      >
        <track kind="captions" />
      </video>
    ) : (
      <div className={isAudio ? "hidden" : "h-full max-h-full w-full bg-black"} />
    )
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className={cn(
          "flex flex-col gap-3 overflow-hidden p-4",
          full
            ? "top-0 left-0 h-dvh w-dvw max-w-none translate-x-0 translate-y-0 rounded-none"
            : isAudio
              ? "max-h-[92vh] w-[min(94vw,900px)] sm:max-w-[900px]"
              : "h-[min(92vh,860px)] w-[min(96vw,1080px)] sm:max-w-[1080px]",
        )}
      >
        {/* En-tête : titre + bascule de vue + plein écran (le X du Dialog est à droite). */}
        <div className="flex items-center gap-1 pr-9">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm">{media.label || basename(media.filePath)}</DialogTitle>
          {!isAudio && !error && (
            <Tooltip>
              <TooltipTrigger render={
                <Button variant="ghost" size="icon-sm" onClick={() => setFocus(focus === "player" ? "wave" : "player")} />
              }>
                {focus === "player" ? <AudioWaveform className="size-4" /> : <Clapperboard className="size-4" />}
              </TooltipTrigger>
              <TooltipContent side="left">{focus === "player" ? t("mediaEditor.enlargeWaveform") : t("mediaEditor.enlargePlayer")}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => setFull(!full)} />}>
              {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </TooltipTrigger>
            <TooltipContent side="left">{full ? t("mediaEditor.reduce") : t("mediaEditor.fullscreen")}</TooltipContent>
          </Tooltip>
        </div>

        {/* Image. En vue « ondes », le lecteur se réduit à une bande (le son mène). */}
        {isAudio ? videoEl : error ? (
          <>
            {videoEl}
            <div className="flex min-h-28 w-full items-center justify-center rounded-lg bg-black p-4 text-center text-sm text-muted-foreground">
              {t("mediaEditor.containerUnreadable")}
            </div>
          </>
        ) : (
          <div className={cn(
            "relative flex items-center justify-center overflow-hidden rounded-lg bg-black",
            focus === "player" ? "min-h-0 flex-1" : "h-36 flex-none",
          )}>
            {videoEl}
          </div>
        )}

        {/* Transport : lecture, pas d'image, position, zoom des ondes. */}
        <div className="flex flex-none items-center gap-1.5">
          <Button variant="ghost" size="icon" onClick={toggle} aria-label={playing ? t("mediaEditor.pause") : t("mediaEditor.play")}>
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </Button>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => seek(time - 1 / fps)} />}>
              <ChevronLeft className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t("mediaEditor.previousFrame")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => seek(time + 1 / fps)} />}>
              <ChevronRight className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t("mediaEditor.nextFrame")}</TooltipContent>
          </Tooltip>
          <Slider
            value={[time]}
            min={0}
            max={dur || 0}
            step={1 / fps}
            onValueChange={(v) => seek(Array.isArray(v) ? v[0] : v)}
            className="mx-2 flex-1"
            aria-label={t("mediaEditor.position")}
          />
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {fmtTimecode(Math.round(time * fps), fps)} / {fmtTimecode(Math.round((dur || waveTotal) * fps), fps)}
          </span>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={playSelection} />}>
              <Repeat className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t("mediaEditor.playSelection")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => waveRef.current?.fitSelection()} />}>
              <SquareDashedMousePointer className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t("mediaEditor.zoomSelection")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={
              <Button variant="ghost" size="icon-sm" disabled={!zoomed} onClick={() => waveRef.current?.fitAll()} />
            }>
              <Fullscreen className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t("mediaEditor.overview")}</TooltipContent>
          </Tooltip>
        </div>

        {/* Ondes : glisser les poignées = in/out, glisser dans le vide = tracer une plage, clic =
            seek, molette = zoom. Repli si l'audio n'a pas pu être analysé (mock/mkv). */}
        {waveState === "ready" && waveTotal > 0 && peaks.length > 0 ? (
          <WaveTrim
            ref={waveRef}
            // Audio hors plein écran : le dialog est en hauteur auto → flex-1 s'écraserait au min.
            className={isAudio && !full ? "h-52 flex-none" : focus === "wave" ? "min-h-28 flex-1" : "h-28 flex-none"}
            peaks={peaks}
            duration={waveTotal}
            inSec={inSec}
            outSec={outEff}
            time={time}
            playing={playing}
            onIn={(t) => { setInSec(t); seek(t); }}
            onOut={(t) => setOutSec(t)}
            onRange={setRange}
            onSeek={seek}
            loadWindow={loadWindow}
            snapPoints={snapPoints}
            onZoom={setZoomed}
          />
        ) : (
          <div className="flex h-16 flex-none items-center justify-center gap-2 rounded-lg bg-muted/40 text-xs text-muted-foreground">
            {waveState === "loading"
              ? <><Loader2 className="size-3.5 animate-spin" /> {t("mediaEditor.waveLoading")}</>
              : <><AudioWaveform className="size-3.5" /> {t("mediaEditor.waveUnavailable")}</>}
          </div>
        )}

        {/* Sélection : bornes ÉDITABLES + durée au centre + plages toutes faites dans le menu ⋯. */}
        <div className="flex flex-none items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="sm" onClick={() => setInSec(Math.min(time, outEff))} />}>
              {t("mediaEditor.in")}
            </TooltipTrigger>
            <TooltipContent>{t("mediaEditor.markIn")}</TooltipContent>
          </Tooltip>
          <TimecodeField sec={inSec} fps={fps} label={t("mediaEditor.in")} onSeek={() => seek(inSec)} onCommit={(v) => setInSec(Math.max(0, Math.min(v, outEff)))} />
          <span className="mx-auto text-sm font-medium tabular-nums text-primary">
            {fmtTimecode(Math.max(0, Math.round((outEff - inSec) * fps)), fps)}
          </span>
          <TimecodeField sec={outEff} fps={fps} label={t("mediaEditor.out")} onSeek={() => seek(outEff)} onCommit={(v) => setOutSec(Math.max(inSec, Math.min(v, dur || waveTotal)))} />
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="sm" onClick={() => setOutSec(Math.max(time, inSec))} />}>
              {t("mediaEditor.out")}
            </TooltipTrigger>
            <TooltipContent>{t("mediaEditor.markOut")}</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger render={
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("mediaEditor.rangePresets")} />} />
              }><MoreHorizontal className="size-4" /></TooltipTrigger>
              <TooltipContent>{t("mediaEditor.rangePresets")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => setRange(0, dur || waveTotal)}>
                <ChevronsLeftRight /> {t("mediaEditor.selectAll")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRange(time, Math.max(time, outEff))}>
                <ArrowRightToLine /> {t("mediaEditor.fromPlayhead")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRange(Math.min(inSec, time), time)}>
                <ArrowLeftToLine /> {t("mediaEditor.toPlayhead")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRange(frameToSec(media.inFrame, fps), media.outFrame == null ? (dur || waveTotal) : frameToSec(media.outFrame, fps))}>
                <RotateCcw /> {t("mediaEditor.resetRange")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Transcript compact : mots cliquables (seek), la plage in/out surligne ses mots. */}
        {media.kind === "video" && (words || transcriptError) && (
          <div className="min-h-0 flex-none overflow-y-auto rounded-md border border-border px-2 py-1.5 max-h-28 leading-relaxed">
            {transcriptError && <p className="text-xs text-destructive">{transcriptError}</p>}
            {words && <TranscriptWords words={words} inSec={inSec} outSec={outEff} fps={fps} onWord={seek} />}
          </div>
        )}

        <div className="flex flex-none items-center gap-2">
          {media.kind === "video" && !words && (
            <Button variant="outline" size="sm" disabled={transcribing} onClick={() => void transcribe()}>
              {transcribing ? <Loader2 className="size-3.5 animate-spin" /> : <AudioLines className="size-3.5" />} {t("mediaEditor.transcribe")}
            </Button>
          )}
          {words && onInsertTranscript && (
            <Tooltip>
              <TooltipTrigger render={<Button variant="outline" size="sm" onClick={insertSelection} />}>
                <TextQuote className="size-3.5" /> {t("mediaEditor.insertText")}
              </TooltipTrigger>
              <TooltipContent>{t("mediaEditor.insertTextHint")}</TooltipContent>
            </Tooltip>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
            <Button onClick={commit}>{t("common.confirm")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
