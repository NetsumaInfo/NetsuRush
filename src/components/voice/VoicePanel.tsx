// Onglet « Voix » — 3 colonnes : contrôles (gauche) · scène player+waveform
// (centre) · panneau CUTS (droite). Le lecteur ScenePlayer lit TOUS les formats (/media ou /stream).
// Lecture « skipping cuts » : saute les passages retirés. Waveform vert (parole) / rouge (silence) /
// violet (intervalle désactivé) + transcript éditable.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import { AudioLines, ArrowLeft, Maximize2, Minimize2, ZoomIn, ZoomOut } from "lucide-react";
import { nr, type PreviewMode } from "@/lib/bridge";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ScenePlayer, type ScenePlayerApi } from "@/components/player/ScenePlayer";
import { useVoiceAnalysis } from "./useVoiceAnalysis";
import { fmtTime } from "./voiceShared";
import { enabledSpeechSegments, subtractSpans } from "./voiceCut";
import { repetitionSpans, combineFillerSpans } from "./voiceFillers";
import { TranscriptEditor } from "./TranscriptEditor";
import { VoiceControls } from "./VoiceControls";
import { VoiceHome } from "./VoiceHome";
import { CutsPanel } from "./CutsPanel";
import { Waveform } from "./Waveform";

function wordAt(words: { start: number; end: number }[], t: number): number {
  let lo = 0, hi = words.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) { res = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (res >= 0 && t > words[res].end + 0.4) return -1;
  return res;
}

export function VoicePanel() {
  const { t } = useTranslation("voice");
  const {
    voiceClip, words, speech, silence, offIntervals, voiceFillerSpans, offFillers, offRepeats, hesitationParams, voiceBusy, voiceProgress, voiceError, voiceNotice,
    voiceDuration, clipMeta, setClipMeta, setVoicePeaks, previewMode, setPreviewMode, setVoiceClip, resetVoice,
  } = useApp(useShallow((s) => ({
    voiceClip: s.voiceClip, words: s.words, speech: s.speech, silence: s.silence, offIntervals: s.offIntervals,
    voiceFillerSpans: s.voiceFillerSpans, offFillers: s.offFillers, offRepeats: s.offRepeats, hesitationParams: s.hesitationParams,
    voiceBusy: s.voiceBusy, voiceProgress: s.voiceProgress, voiceError: s.voiceError, voiceNotice: s.voiceNotice,
    voiceDuration: s.voiceDuration, clipMeta: s.clipMeta, setClipMeta: s.setClipMeta, setVoicePeaks: s.setVoicePeaks,
    previewMode: s.previewMode, setPreviewMode: s.setPreviewMode,
    setVoiceClip: s.setVoiceClip, resetVoice: s.resetVoice,
  })));
  const { clips, loadingClips, connected, clipError, loadMediaPool, pickLocal, selectClip } = useVoiceAnalysis();

  useEffect(() => () => {
    void nr.cache?.sessionEvent({ trigger: "page", kinds: ["voice"] }).catch(() => {});
  }, []);

  const playerApi = useRef<ScenePlayerApi | null>(null);
  const lastIdx = useRef(-1);
  const [src, setSrc] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [wfDur, setWfDur] = useState(0);
  const [wfTall, setWfTall] = useState(false);
  const [wfZoom, setWfZoom] = useState(1);

  useEffect(() => { loadMediaPool(); }, [loadMediaPool]);

  useEffect(() => {
    setSrc(null); setPeaks([]); setWfDur(0); setPlayhead(0); setCurrentIndex(-1); lastIdx.current = -1;
    if (!voiceClip) return;
    let alive = true;
    (async () => {
      const info = await nr.playInfo(voiceClip.path).catch(() => null);
      if (!alive) return;
      setSrc(info?.native ? nr.mediaUrl(voiceClip.path) : nr.streamUrl(voiceClip.path, 0, "enc"));
      const probe = await nr.probe(voiceClip.path).catch(() => null);
      if (alive) setClipMeta({ fps: info?.fps, width: probe?.width, height: probe?.height });
      const wf = await nr.waveform({ input: voiceClip.path, buckets: 1600 }).catch(() => null);
      if (alive && wf?.ok) { setPeaks(wf.peaks || []); setWfDur(wf.duration || 0); setVoicePeaks(wf.peaks || []); }
    })();
    return () => { alive = false; };
  }, [voiceClip, setClipMeta, setVoicePeaks]);

  // Hésitations UNIFIÉES (acoustique + lexical) puis plages actives (non désélectionnées) + répétitions.
  const allFillers = useMemo(() => combineFillerSpans(voiceFillerSpans, words, hesitationParams, silence), [voiceFillerSpans, words, hesitationParams, silence]);
  const repeats = useMemo(() => repetitionSpans(words), [words]);
  const cutFillers = useMemo(() => allFillers.filter((_, i) => !offFillers.has(i)), [allFillers, offFillers]);
  const cutRepeats = useMemo(() => repeats.filter((_, i) => !offRepeats.has(i)), [repeats, offRepeats]);
  // Mode d'écoute → segments GARDÉS pour la lecture. « none » = brut (rien sauté) ; sinon on saute UN
  // type (ou tout) → on entend le rendu à la carte. Un seul bouton (choix unique).
  const skipping = previewMode !== "none";
  const keepSegs = useMemo(() => {
    if (previewMode === "none") return [];
    const skipSil = previewMode === "all" || previewMode === "silences";
    const skipFil = previewMode === "all" || previewMode === "fillers";
    const skipRep = previewMode === "all" || previewMode === "repeats";
    const base = skipSil
      ? enabledSpeechSegments(speech, offIntervals)
      : (voiceDuration > 0 ? [{ in: 0, out: voiceDuration }] : []);
    const subtract = [...(skipFil ? cutFillers : []), ...(skipRep ? cutRepeats : [])];
    return subtractSpans(base, subtract);
  }, [previewMode, speech, offIntervals, cutFillers, cutRepeats, voiceDuration]);

  const onTime = useCallback((t: number) => {
    setPlayhead(t);
    const idx = wordAt(words, t);
    if (idx !== lastIdx.current) { lastIdx.current = idx; setCurrentIndex(idx); }
  }, [words]);

  // Lecture « skipping cuts » FLUIDE : boucle rAF (~60 Hz) au lieu de timeupdate (~4 Hz, on entendait
  // le début de chaque coupe avant le saut). Saut ANTICIPÉ ~40 ms avant la frontière du segment gardé
  // → transition inaudible. La tête de lecture est rafraîchie à ~15 Hz (fluide sans re-render 60 Hz de
  // la colonne CUTS). Segments lus via ref (pas de re-abonnement rAF à chaque recalcul).
  const keepRef = useRef(keepSegs);
  useEffect(() => { keepRef.current = keepSegs; }, [keepSegs]);
  useEffect(() => {
    let raf = 0;
    let lastUi = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const api = playerApi.current;
      if (!api || api.paused()) return;
      const t = api.time();
      if (now - lastUi > 66) { lastUi = now; onTime(t); } // tête + mot lu ~15 Hz
      const segs = keepRef.current;
      if (!skipping || !segs.length) return;
      let cur: (typeof segs)[number] | null = null;
      let next: (typeof segs)[number] | null = null;
      for (const s of segs) {
        if (t >= s.in - 0.02 && t < s.out) { cur = s; break; }
        if (s.in >= t) { next = s; break; }
      }
      if (cur) {
        if (t >= cur.out - 0.04) { // frontière imminente → saute maintenant
          const after = segs.find((s) => s.in > cur!.out - 0.01);
          if (after) api.seek(after.in);
          else api.pause();
        }
      } else if (next) api.seek(next.in);
      else api.pause();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [skipping, onTime]);

  // Seek = positionne lecture + recale tête + ACTIVE le mot (transcript suit direct, même clip en pause)
  // → cliquer un cut/silence montre tout de suite OÙ ça se trouve dans le texte et la forme d'onde.
  const onSeek = useCallback((t: number) => {
    playerApi.current?.seek(t);
    setPlayhead(t);
    const idx = wordAt(words, t);
    if (idx !== lastIdx.current) { lastIdx.current = idx; setCurrentIndex(idx); }
  }, [words]);

  const dur = wfDur || voiceDuration;

  if (!voiceClip) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="min-h-0 flex-1 overflow-auto">
          <VoiceHome
            clips={clips} loadingClips={loadingClips} connected={connected} clipError={clipError}
            onReload={loadMediaPool} onPickLocal={pickLocal} onSelect={selectClip}
          />
        </div>
      </div>
    );
  }

  const meta = [
    clipMeta?.width && clipMeta?.height ? `${clipMeta.width}×${clipMeta.height}` : null,
    clipMeta?.fps ? `${clipMeta.fps.toFixed(3)} fps` : null,
    dur ? fmtTime(dur) : null,
    words.length ? t("panel.wordsCount", { count: words.length }) : null,
  ].filter(Boolean).join(" · ");

  // Ratio EXACT de la vidéo → la boîte du player épouse l'image (jamais de bande noire). Défaut 16:9.
  const ar = clipMeta?.width && clipMeta?.height ? clipMeta.width / clipMeta.height : 16 / 9;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header
        clipName={voiceClip.name}
        sub={`${voiceClip.source === "local" ? t("panel.sourceLocal") : t("home.mediaPool")} · ${meta}`}
        onBack={() => { resetVoice(); setVoiceClip(null); }}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-4 lg:grid-cols-[300px_minmax(0,1fr)_300px] lg:overflow-hidden">
        <div className="min-h-0 lg:overflow-y-auto lg:pr-1">
          <VoiceControls />
        </div>

        {/* Colonne centre : player + forme d'onde ÉPINGLÉS en haut (shrink-0), transcript = seul à
            scroller dessous (flex-1 min-h-0) → il suit la tête de lecture (karaoke) sans tout pousser. */}
        <div className="flex min-w-0 flex-col gap-3 min-h-0">
          {/* Player PLEINE LARGEUR + aspect EXACT de la vidéo (clipMeta) + object-contain → image
              ENTIÈRE, aucun rognage, et zéro espace perdu sur les côtés. Hauteur = largeur / ratio
              (le transcript scrolle dessous). Pas de plafond : on voit toute la frame. */}
          <div
            className="w-full shrink-0 overflow-hidden rounded-xl border border-border bg-black"
            style={{ aspectRatio: String(ar) }}
          >
            <ScenePlayer
              src={src}
              nativePath={voiceClip?.path}
              autoPlay={false}
              onTime={onTime}
              apiRef={playerApi}
              defaultVolume={0.85}
            />
          </div>

          {/* barre forme d'onde : stat gardé + zoom + agrandir */}
          <div className="flex shrink-0 items-center justify-between text-[11px]">
            <span className="text-muted-foreground">{skipping && keepSegs.length ? t("panel.keptOfDuration", { kept: fmtTime(keepSegs.reduce((a, s) => a + (s.out - s.in), 0)), total: fmtTime(dur) }) : t("panel.waveformLabel")}</span>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger render={
                  <button type="button" onClick={() => setWfZoom((z) => Math.max(1, z / 2))} disabled={wfZoom <= 1} aria-label={t("panel.zoomOutAria")}
                    className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40">
                    <ZoomOut className="size-3.5" />
                  </button>
                } />
                <TooltipContent>{t("panel.zoomOutTooltip")}</TooltipContent>
              </Tooltip>
              {wfZoom > 1 && <span className="tabular-nums text-[11px] text-muted-foreground">×{wfZoom}</span>}
              <Tooltip>
                <TooltipTrigger render={
                  <button type="button" onClick={() => setWfZoom((z) => Math.min(16, z * 2))} disabled={wfZoom >= 16} aria-label={t("panel.zoomInAria")}
                    className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40">
                    <ZoomIn className="size-3.5" />
                  </button>
                } />
                <TooltipContent>{t("panel.zoomInTooltip")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={
                  <button type="button" onClick={() => setWfTall((v) => !v)} aria-label={wfTall ? t("panel.collapseAria") : t("panel.expandAria")}
                    className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground">
                    {wfTall ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                  </button>
                } />
                <TooltipContent>{wfTall ? t("panel.collapseTooltip") : t("panel.expandTooltip")}</TooltipContent>
              </Tooltip>
            </div>
          </div>
          {/* Écouter à la carte : un seul bouton, on choisit quel type de coupe la lecture saute. */}
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[11px] text-muted-foreground">{t("panel.listen")}</span>
            <ToggleGroup className="flex-1" value={[previewMode]} onValueChange={(v) => v[0] && setPreviewMode(v[0] as PreviewMode)}>
              <Tooltip>
                <TooltipTrigger render={<ToggleGroupItem className="flex-1 px-1 text-[11px]" value="none">{t("panel.modeRaw")}</ToggleGroupItem>} />
                <TooltipContent>{t("panel.modeRawTooltip")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={<ToggleGroupItem className="flex-1 px-1 text-[11px]" value="silences">{t("panel.modeSilences")}</ToggleGroupItem>} />
                <TooltipContent>{t("panel.modeSilencesTooltip")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={<ToggleGroupItem className="flex-1 px-1 text-[11px]" value="fillers">{t("panel.modeFillers")}</ToggleGroupItem>} />
                <TooltipContent>{t("panel.modeFillersTooltip")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={<ToggleGroupItem className="flex-1 px-1 text-[11px]" value="repeats">{t("panel.modeRepeats")}</ToggleGroupItem>} />
                <TooltipContent>{t("panel.modeRepeatsTooltip")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={<ToggleGroupItem className="flex-1 px-1 text-[11px]" value="all">{t("panel.modeAll")}</ToggleGroupItem>} />
                <TooltipContent>{t("panel.modeAllTooltip")}</TooltipContent>
              </Tooltip>
            </ToggleGroup>
          </div>
          <div className="shrink-0">
            <Waveform peaks={peaks} duration={dur} speech={speech} silence={silence} off={offIntervals} fillers={cutFillers} repeats={cutRepeats} playhead={playhead} onSeek={onSeek} tall={wfTall} zoom={wfZoom} />
          </div>

          {voiceBusy && (
            <div className="flex shrink-0 items-center gap-3">
              <Spinner className="size-4" />
              <div className="flex-1">
                <div className="mb-1 text-[11px] text-muted-foreground">{voiceBusy}</div>
                <Progress value={voiceProgress} />
              </div>
            </div>
          )}
          {voiceError && <p className="shrink-0 text-xs text-destructive">{voiceError}</p>}
          {voiceNotice && !voiceError && <p className="shrink-0 text-xs text-muted-foreground">{voiceNotice}</p>}

          {words.length > 0
            ? <div className="min-h-0 flex-1"><TranscriptEditor currentIndex={currentIndex} onSeek={onSeek} /></div>
            : <Card className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">{t("panel.noTranscriptYet")}</Card>}
        </div>

        <div className="min-h-0 lg:overflow-hidden">
          <CutsPanel playhead={playhead} onSeek={onSeek} />
        </div>
      </div>
    </div>
  );
}

function Header({ clipName, sub, onBack }: { clipName?: string; sub?: string; onBack?: () => void }) {
  const { t } = useTranslation(["voice", "common"]);
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
      {onBack
        ? <Button variant="ghost" size="icon" className="size-7" onClick={onBack} aria-label={t("common:action.back")}><ArrowLeft className="size-4" /></Button>
        : <AudioLines className="size-4 text-primary" />}
      <div className="min-w-0">
        <h1 className="truncate text-sm font-semibold leading-none">{clipName || t("header.title")}</h1>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub || t("header.subtitle")}</p>
      </div>
    </header>
  );
}
