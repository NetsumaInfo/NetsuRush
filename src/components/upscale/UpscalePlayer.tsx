import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight, ArrowDownToLine, Repeat } from "lucide-react";
import { nr } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { VolumeSlider } from "@/components/player/VolumeSlider";
import { useVolumeState } from "@/components/player/usePlayer";
import { useApp } from "@/store";
import { fmtTime } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { isTauriRuntime, nativePlayer } from "@/lib/nativePlayer";
import { useNativePlayerGeometry } from "@/components/player/useNativePlayerSurface";

const fmt = (s: number) => fmtTime(s, { centis: true, padMinutes: false });

// Boucle in↔out : réglage de confort qui doit survivre au changement d'onglet (chaque onglet est
// démonté au changement → un état local repartirait à zéro).
const LOOP_KEY = "nr.up.loop";
const readLoop = (): boolean => (typeof localStorage === "undefined" ? true : localStorage.getItem(LOOP_KEY) !== "0");
const saveLoop = (v: boolean) => { if (typeof localStorage !== "undefined") localStorage.setItem(LOOP_KEY, v ? "1" : "0"); };

// Champ d'image éditable : tape un numéro d'image exact (commit sur Entrée/blur).
function FrameField({ frame, onCommit }: { frame: number; onCommit: (f: number) => void }) {
  const { t } = useTranslation("upscale");
  const [v, setV] = useState(String(frame));
  useEffect(() => { setV(String(frame)); }, [frame]);
  const commit = () => { const f = parseInt(v, 10); if (Number.isFinite(f)) onCommit(f); else setV(String(frame)); };
  const fieldWidth = Math.min(16, Math.max(6, v.length + 3));
  return (
    <Input
      type="text"
      value={v}
      inputMode="numeric"
      onChange={(e) => setV(e.target.value.replace(/[^\d]/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); } }}
      className="h-7 min-w-[5rem] max-w-full text-center text-xs tabular-nums"
      style={{ width: `${fieldWidth}ch` }}
      aria-label={t("player.frameNumber")}
    />
  );
}

interface Props {
  path: string;
  mediaKey: string;      // identité STABLE de la source aperçue (uid du bac) — deux plans du même
                         // fichier = clés distinctes → le lecteur recharge bien au changement de plan
  duration: number;
  native: boolean;       // codec décodable nativement par WebView2 (h264 / hevc 8-bit)
  fps: number;           // images/s exact → plage frame-accurate
  rangeMode: boolean;
  rangeEditable?: boolean;
  rangeIn: number;
  rangeOut: number;
  onRange: (inS: number, outS: number) => void;
  onTime?: (t: number) => void;
  goto?: { t: number; n: number } | null;   // saut externe (clic sur un plan) ; n = nonce
  playSignal?: number;   // nonce d'intention de lecture (clic bac/chevrons) → lecture en boucle ;
                         // sans signal, un changement de source charge EN PAUSE au point d'entrée
  visible?: boolean;
}

// Conteneurs démuxés directement par WebView2 (Chromium) → lecture par /media (Range, seek natif).
const MP4_FAMILY = /\.(mp4|m4v|mov|webm)$/i;

// Lecteur `<video>` standalone (remplace l'overlay mpv natif de l'ancien plugin).
//  - conteneur mp4/mov/webm → /media (Range) : seek = currentTime (image-proche, fps-précise).
//  - autre conteneur (mkv, ts, avi…) → /stream remux : copy si codec natif, sinon transcode 8-bit ;
//    le flux n'est pas seekable → un seek RELANCE le flux à la position (?t=) comme l'ancien <video>.
export function UpscalePlayer({ path, mediaKey, duration, native, fps, rangeMode, rangeEditable = true, rangeIn, rangeOut, onRange, onTime, goto, playSignal, visible = true }: Props) {
  const { t } = useTranslation("upscale");
  const videoRef = useRef<HTMLVideoElement>(null);
  const nativeSurfaceRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<"in" | "out" | "seek" | null>(null);
  const pendingSeek = useRef<number | null>(null);   // mp4 : position à appliquer dès les métadonnées prêtes
  const wantPlay = useRef(false);                    // lancer la lecture dès que le média est prêt
  const prevPath = useRef("");                       // détecte un changement de plan SANS changement de fichier

  const mp4 = MP4_FAMILY.test(path);
  const [streamBase, setStreamBase] = useState(0);     // position d'origine du flux remux (seek = relance)
  const [cur, setCur] = useState(0);                   // temps GLOBAL
  const [playing, setPlaying] = useState(false);
  // Volume GLOBAL (store) : partagé avec les autres lecteurs et conservé au changement d'onglet.
  // Défaut 0 tant que l'utilisateur n'y a jamais touché → muet, donc lecture auto autorisée.
  const storedVolume = useApp((s) => s.playerVolume);
  const setStoredVolume = useApp((s) => s.setPlayerVolume);
  const volume = storedVolume ?? 0;
  const [forcedMute, setForcedMute] = useState(false);  // repli si Chromium refuse la lecture auto sonore
  const [loop, setLoop] = useState(readLoop);          // boucle in↔out (plage/plan) ou fichier entier
  const [loading, setLoading] = useState(true);
  const [durState, setDurState] = useState(0);
  const [err, setErr] = useState(false);
  const [nativeMode, setNativeMode] = useState<boolean | null>(isTauriRuntime ? null : false);
  const onTimeRef = useRef(onTime);
  useEffect(() => { onTimeRef.current = onTime; }, [onTime]);
  const nativeLoadingSince = useRef<number | null>(null);

  const dur = duration || durState || 0;
  // URL de lecture. Flux remux relancé depuis streamBase quand le conteneur n'est pas lu nativement.
  const src = mp4 ? nr.mediaUrl(path) : nr.streamUrl(path, streamBase, native ? "copy" : "enc");
  const pct = (t: number) => (dur > 0 ? (t / dur) * 100 : 0);
  const step = fps > 0 ? 1 / fps : 0.04;               // 1 frame en secondes
  const frameOf = (s: number) => (fps > 0 ? Math.round(s * fps) : 0);
  const snap = (s: number) => (fps > 0 ? Math.round(s * fps) / fps : s);

  useEffect(() => {
    if (!isTauriRuntime) return;
    let active = true;
    nativePlayer.available()
      .then((available) => { if (active) setNativeMode(available); })
      .catch(() => { if (active) setNativeMode(false); });
    return () => { active = false; };
  }, []);

  useNativePlayerGeometry(nativeSurfaceRef, nativeMode === true && visible);

  // Masquer le lecteur (comparaison, désélection, changement de vue) coupe réellement la lecture.
  // Le conteneur `hidden` seul ne pause pas un <video> et pouvait laisser mpv jouer derrière l'UI.
  useEffect(() => {
    if (visible) return;
    wantPlay.current = false;
    setPlaying(false);
    // La surface mpv est arrêtée par useNativePlayerGeometry, qui vérifie son propriétaire avant
    // d'agir. Ici on ne pilote que le fallback HTML afin de ne jamais masquer une autre surface mpv.
    if (nativeMode !== true) videoRef.current?.pause();
  }, [visible, nativeMode]);

  // Le statut mpv remplace les événements HTMLMediaElement, absents de la surface native.
  useEffect(() => {
    if (nativeMode !== true) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const status = await nativePlayer.status();
        if (!active) return;
        const time = Number.isFinite(status.current_time) ? Math.max(0, status.current_time) : 0;
        const nextDuration = Number.isFinite(status.duration) ? Math.max(0, status.duration) : 0;
        if (nextDuration > 0 || time > 0) nativeLoadingSince.current = null;
        else if (nativeLoadingSince.current != null && performance.now() - nativeLoadingSince.current > 20_000) {
          nativeLoadingSince.current = null;
          setNativeMode(false);
          return;
        }
        setCur(time);
        if (nextDuration > 0) setDurState(nextDuration);
        setPlaying(status.is_playing);
        if (nextDuration > 0 || time > 0) setLoading(false);
        onTimeRef.current?.(time);
        if (loop && rangeMode && rangeOut > rangeIn && time >= rangeOut - 0.02) {
          nativePlayer.seek(rangeIn).then(() => nativePlayer.play()).catch(() => {});
          setCur(rangeIn);
          onTimeRef.current?.(rangeIn);
        }
      } catch {
        if (active) setErr(true);
      }
      if (active) timer = setTimeout(poll, 100);
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [nativeMode, loop, rangeMode, rangeIn, rangeOut]);

  // (Re)charge à chaque changement de source (keyé sur mediaKey : deux plans du même fichier =
  // rechargements distincts). Plage/plan actif → on démarre DIRECTEMENT au point d'entrée (le rogne),
  // pas au début du fichier. mp4 : seek appliqué aux métadonnées ; flux (mkv) : le flux démarre à
  // `in` (streamBase). Charge EN PAUSE : cocher une source ne relance jamais la lecture (le nonce
  // playSignal, traité après, porte l'intention de lecture d'un clic bac/chevron).
  useEffect(() => {
    const startAt = rangeMode ? rangeIn : 0;
    wantPlay.current = false;
    if (nativeMode === true) {
      setErr(false); setLoading(true); setPlaying(false); setCur(startAt); onTime?.(startAt);
      nativeLoadingSince.current = performance.now();
      nativePlayer.pause().catch(() => {});
      nativePlayer.load(path)
        .then(() => nativePlayer.seek(startAt))
        .then(() => { setLoading(false); })
        .catch(() => { setNativeMode(false); setLoading(false); });
      return;
    }
    const v = videoRef.current;
    v?.pause();   // même src (plan jumeau du même fichier) → pas de reload navigateur, on fige quand même
    setErr(false); setPlaying(false); setCur(startAt); onTime?.(startAt);
    if (mp4 && v && prevPath.current === path && v.readyState >= 1) {
      // Autre plan du MÊME fichier mp4 : aucun rechargement → seek direct au point d'entrée.
      v.currentTime = startAt;
      pendingSeek.current = null;
    } else {
      setLoading(true); setDurState(0);
      setStreamBase(mp4 ? 0 : startAt);
      pendingSeek.current = mp4 && startAt > 0 ? startAt : null;
    }
    prevPath.current = path;
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [mediaKey, nativeMode]);

  // Intention de lecture (clic bac / chevrons) : repart du point d'entrée et joue en boucle.
  // Si le média recharge au même moment (source changée), wantPlay est consommé aux métadonnées.
  useEffect(() => {
    if (!playSignal || !visible) return;
    let alive = true;
    wantPlay.current = true;
    if (nativeMode === true) {
      const startAt = rangeMode ? rangeIn : 0;
      nativePlayer.seek(startAt)
        .then(() => { if (alive) return nativePlayer.play(); })
        .catch(() => { if (alive) setErr(true); });
      setCur(startAt); onTime?.(startAt);
      return () => { alive = false; };
    }
    const v = videoRef.current;
    const startAt = rangeMode ? rangeIn : 0;
    if (mp4) {
      if (v && v.readyState >= 1) {
        v.currentTime = startAt;
        setCur(startAt); onTime?.(startAt);
        v.play().catch(() => {});
      }
    } else if (Math.abs(streamBase - startAt) < 0.05) {
      // Flux déjà positionné au point d'entrée → rejoue sans relancer le flux.
      if (v) { v.currentTime = 0; v.play().catch(() => {}); }
      setCur(startAt); onTime?.(startAt);
    } else {
      setStreamBase(startAt);   // relance le flux au point d'entrée ; wantPlay consommé aux métadonnées
      setCur(startAt); onTime?.(startAt);
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [playSignal, nativeMode, visible]);

  // Applique volume/mute à l'élément.
  useEffect(() => {
    if (nativeMode === true) nativePlayer.setVolume(volume * 100).catch(() => {});
    else {
      const v = videoRef.current;
      if (v) v.volume = volume;
    }
  }, [volume, nativeMode]);
  useEffect(() => {
    if (nativeMode === true) nativePlayer.setLoopFile(loop && !rangeMode).catch(() => {});
  }, [loop, rangeMode, nativeMode]);
  const setVolumeAudible = useCallback((v: number) => { setForcedMute(false); setStoredVolume(v); }, [setStoredVolume]);
  const { toggleMute, onVolumeChange } = useVolumeState(volume, setVolumeAudible);

  // Position GLOBALE : currentTime direct (mp4) ou streamBase + currentTime (flux relancé).
  const globalTime = useCallback((v: HTMLVideoElement) => (mp4 ? v.currentTime : streamBase + v.currentTime), [mp4, streamBase]);

  const seek = useCallback((t: number) => {
    const s = Math.max(0, Math.min(dur > 0 ? dur : t, t));
    setCur(s); onTime?.(s);
    if (nativeMode === true) nativePlayer.seek(s).catch(() => {});
    else {
      const v = videoRef.current;
      if (mp4) { if (v) v.currentTime = s; }
      else {
        // Le changement de src relance le flux à s ; la lecture reprend si elle était en cours.
        wantPlay.current = !!v && !v.paused;
        setStreamBase(s);
      }
    }
  }, [dur, mp4, nativeMode, onTime]);

  // Retour au point d'entrée pour la boucle. mp4 : currentTime = in (instantané). Flux (mkv) : le flux
  // démarre DÉJÀ à `in` (streamBase) → currentTime = 0 reboucle SANS relancer le flux (pas de rechargement) ;
  // si l'utilisateur a seeké ailleurs (streamBase ≠ in), on relance proprement le flux à `in`.
  const loopBack = useCallback(() => {
    if (nativeMode === true) {
      nativePlayer.seek(rangeIn).then(() => nativePlayer.play()).catch(() => {});
      setCur(rangeIn); onTime?.(rangeIn);
      return;
    }
    const v = videoRef.current;
    if (mp4) { if (v) { v.currentTime = rangeIn; v.play().catch(() => {}); } setCur(rangeIn); onTime?.(rangeIn); return; }
    if (v && Math.abs(streamBase - rangeIn) < 0.05) { v.currentTime = 0; v.play().catch(() => {}); setCur(rangeIn); onTime?.(rangeIn); }
    else seek(rangeIn);
  }, [mp4, nativeMode, rangeIn, streamBase, seek, onTime]);

  // Saut externe (clic sur un plan).
  useEffect(() => { if (goto) seek(goto.t); /* eslint-disable-next-line */ }, [goto?.n]);

  const toggle = () => {
    if (nativeMode === true) { nativePlayer.togglePause().catch(() => {}); return; }
    const v = videoRef.current; if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };

  const frameStep = (df: number) => {
    if (nativeMode === true) {
      (df > 0 ? nativePlayer.frameStep() : nativePlayer.frameBackStep()).catch(() => {});
    } else seek(snap(cur) + df * step);
  };

  const timeFromX = useCallback((clientX: number) => {
    const el = trackRef.current; if (!el || !dur) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(dur, ((clientX - r.left) / r.width) * dur));
  }, [dur]);

  const applyHandle = (which: "in" | "out", t: number) => {
    if (which === "in") { const ni = Math.min(t, rangeOut - step); onRange(Math.max(0, ni), rangeOut); seek(ni); }
    else { const no = Math.max(t, rangeIn + step); onRange(rangeIn, no); seek(no); }
  };

  const onPointerDown = (e: React.PointerEvent, which: "in" | "out" | "seek") => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = which;
    const t = timeFromX(e.clientX);
    if (which === "seek") seek(t); else applyHandle(which, t);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const t = timeFromX(e.clientX);
    if (drag.current === "seek") seek(t); else applyHandle(drag.current, t);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag.current === "seek") seek(timeFromX(e.clientX));
    drag.current = null;
  };

  return (
    <div className="space-y-2">
      <div
        className="relative aspect-video cursor-pointer overflow-hidden rounded-lg bg-black"
        role="button"
        tabIndex={0}
        aria-label={t("player.scenePreview")}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        }}
      >
        {nativeMode === true ? (
          <div ref={nativeSurfaceRef} className="h-full w-full bg-black" aria-label={t("player.scenePreview")} />
        ) : nativeMode === false ? (
        <video
          ref={videoRef}
          src={src}
          className="h-full w-full"
          playsInline
          muted={volume === 0 || forcedMute}
          loop={loop && !rangeMode}
          onLoadedMetadata={(e) => {
            setLoading(false);
            if (mp4) {
              const d = e.currentTarget.duration;
              if (d && Number.isFinite(d)) setDurState(d);
              // Démarre au point d'entrée de la plage (le rogne) dès que le média est prêt.
              if (pendingSeek.current != null) { e.currentTarget.currentTime = pendingSeek.current; pendingSeek.current = null; }
            }
            // Lecture différée (clic bac/chevron ou seek d'un flux en cours de lecture) ; sinon le
            // média reste EN PAUSE sur sa première frame utile.
            if (wantPlay.current) { wantPlay.current = false; e.currentTarget.play().catch(() => {}); }
          }}
          onTimeUpdate={(e) => {
            const t = globalTime(e.currentTarget);
            // Boucle sur [in, out] quand une plage/plan est active (sauf pendant l'ajustement d'une poignée).
            if (loop && rangeMode && !drag.current && rangeOut > rangeIn && t >= rangeOut - 0.02) { loopBack(); return; }
            setCur(t); onTime?.(t);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onPlaying={() => { setLoading(false); setErr(false); }}
          onCanPlay={() => setLoading(false)}
          onSeeked={() => setLoading(false)}
          onWaiting={() => setLoading(true)}
          onEnded={() => setPlaying(false)}
          onError={() => { setErr(true); setLoading(false); }}
        />
        ) : (
          <div className="h-full w-full bg-black" />
        )}
        {loading && !err && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 text-xs text-white">
            <Spinner className="mr-2 h-4 w-4" /> {t("player.loading")}
          </div>
        )}
        {err && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 px-4 text-center text-xs text-white">
            {t("player.playbackError")}
          </div>
        )}
      </div>

      {/* Barre de scrub globale + sélection de plage */}
      <div
        ref={trackRef}
        className="relative h-8 cursor-pointer touch-none select-none rounded-md bg-muted"
        onPointerDown={(e) => onPointerDown(e, "seek")}
        onPointerMove={onMove}
        onPointerUp={onPointerUp}
      >
        {rangeMode ? (
          <>
            <div className="absolute inset-y-0 bg-primary/25"
              style={{ left: `${pct(rangeIn)}%`, width: `${Math.max(0, pct(rangeOut) - pct(rangeIn))}%` }} />
            {rangeEditable && (["in", "out"] as const).map((h) => (
              <div key={h}
                onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, h); }}
                onPointerMove={onMove}
                onPointerUp={onPointerUp}
                className="absolute inset-y-0 z-10 -ml-1.5 w-3 cursor-ew-resize rounded bg-primary"
                style={{ left: `${pct(h === "in" ? rangeIn : rangeOut)}%` }}
              />
            ))}
          </>
        ) : (
          <div className="absolute inset-y-0 left-0 rounded-md bg-primary/30" style={{ width: `${pct(cur)}%` }} />
        )}
        <div className="absolute inset-y-0 z-20 w-0.5 -ml-px bg-foreground" style={{ left: `${pct(cur)}%` }} />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={() => seek(cur - 5)} aria-label={t("player.back5")}><SkipBack className="h-4 w-4" /></Button>} />
          <TooltipContent>{t("player.back5")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={toggle} aria-label={t("player.playPause")}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>} />
          <TooltipContent>{playing ? t("player.pause") : t("player.play")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={() => seek(cur + 5)} aria-label={t("player.forward5")}><SkipForward className="h-4 w-4" /></Button>} />
          <TooltipContent>{t("player.forward5")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant={loop ? "default" : "outline"} size="icon-sm" onClick={() => { const next = !loop; saveLoop(next); setLoop(next); }} aria-label={t("player.loop")} aria-pressed={loop}>
            <Repeat className="h-4 w-4" />
          </Button>} />
          <TooltipContent>{loop ? (rangeMode ? t("player.loopInOutActive") : t("player.loopActive")) : t("player.loopOff")}</TooltipContent>
        </Tooltip>

        <div className="w-28">
          <VolumeSlider value={volume} onChange={onVolumeChange} onToggleMute={toggleMute} />
        </div>

        {/* pas image par image (seek fps-précis) */}
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={() => frameStep(-1)} aria-label={t("player.minus1Frame")}><ChevronLeft className="h-4 w-4" /></Button>} />
          <TooltipContent>{t("player.prevFrame")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={() => frameStep(1)} aria-label={t("player.plus1Frame")}><ChevronRight className="h-4 w-4" /></Button>} />
          <TooltipContent>{t("player.nextFrame")}</TooltipContent>
        </Tooltip>
        <span className="tabular-nums text-muted-foreground">{fmt(cur)} / {fmt(dur)}{fps > 0 && <> · f{frameOf(cur)}</>}</span>
      </div>

      {/* Plage à upscaler — précise à l'image (in/out posés à la tête de lecture, ajustés ±1 image) */}
      {rangeMode && rangeEditable && (
        <div className="space-y-1.5 rounded-md border border-border bg-card/40 p-2.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <span className="font-medium text-foreground">{t("player.rangeToUpscale")}</span>
            <span className="tabular-nums text-muted-foreground">
              {fps > 0 ? t("player.durationImg", { count: Math.max(0, frameOf(rangeOut) - frameOf(rangeIn)) }) : fmt(rangeOut - rangeIn)}
            </span>
          </div>
          {(["in", "out"] as const).map((h) => {
            const val = h === "in" ? rangeIn : rangeOut;
            const setT = (t: number) => {
              if (h === "in") { const ni = Math.max(0, Math.min(rangeOut - step, t)); onRange(ni, rangeOut); seek(ni); }
              else { const no = Math.max(rangeIn + step, Math.min(dur, t)); onRange(rangeIn, no); seek(no); }
            };
            const nudge = (df: number) => setT(snap(val) + df * step);
            const setFrame = (f: number) => setT(fps > 0 ? f / fps : val);
            const setHead = () => setT(snap(cur));
            return (
              <div key={h} className="flex flex-wrap items-center gap-2">
                <span className="w-12 shrink-0 text-muted-foreground">{h === "in" ? t("player.in") : t("player.out")}</span>
                <Tooltip>
                  <TooltipTrigger render={<Button variant="outline" size="sm" onClick={setHead} className="gap-1.5">
                    <ArrowDownToLine className="h-3.5 w-3.5" /> {t("player.mark")}
                  </Button>} />
                  <TooltipContent>{t("player.markAtHead")}</TooltipContent>
                </Tooltip>
                <span className="tabular-nums text-muted-foreground">{fmt(val)}</span>
                <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
                  <Button variant="ghost" size="icon-sm" onClick={() => nudge(-1)} aria-label={t("player.minus1Frame")}><ChevronLeft className="h-4 w-4" /></Button>
                  <FrameField frame={frameOf(val)} onCommit={setFrame} />
                  <span className="text-muted-foreground">{t("player.img")}</span>
                  <Button variant="ghost" size="icon-sm" onClick={() => nudge(1)} aria-label={t("player.plus1Frame")}><ChevronRight className="h-4 w-4" /></Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
