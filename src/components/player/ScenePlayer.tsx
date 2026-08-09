import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { Play, Maximize2, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { PlayIcon, PauseIcon } from "@/components/ui/animated-icons";
import { VolumeSlider } from "@/components/player/VolumeSlider";
import { useVideoScrubber, useVolumeState } from "@/components/player/usePlayer";
import { useApp } from "@/store";
import { isTyping } from "@/lib/shortcuts";
import { fmtTime } from "@/lib/utils";
import { useNativePlayerSurface } from "@/components/player/useNativePlayerSurface";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
  ContextMenuCheckboxItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useTranslation } from "react-i18next";

const fmt = (t: number) => fmtTime(t, { centis: true });

// Poignée impérative optionnelle : permet à un parent (éditeur de transcript / waveform) de piloter
// la lecture (seek sur un mot) et de lire le temps courant (surlignage du mot lu). `time`/`paused`
// donnent un accès direct par frame (rAF) — timeupdate ne tire qu'à ~4 Hz, trop grossier pour la
// lecture « skipping cuts » (on entendait le début de chaque coupe avant le saut).
export interface ScenePlayerApi {
  seek: (t: number) => void;
  play: () => void;
  pause: () => void;
  time: () => number;
  paused: () => boolean;
  // Vitesse de lecture. Négative = lecture ARRIÈRE (simulée : `<video>` refuse un playbackRate < 0).
  setRate: (r: number) => void;
  rate: () => number;
}

export function ScenePlayer({
  src,
  loop = false,
  autoPlay = true,
  onEnded,
  onTime,
  apiRef,
  defaultVolume = 0.2,
  fit = "contain",
  shortcuts = true,
  nativePath,
}: {
  src: string | null;
  loop?: boolean;
  autoPlay?: boolean;
  onEnded?: () => void;
  onTime?: (t: number) => void;
  apiRef?: React.MutableRefObject<ScenePlayerApi | null>;
  defaultVolume?: number;
  fit?: "contain" | "cover";
  /** Chemin disque de la source directe ; active mpv natif dans Tauri. */
  nativePath?: string;
  // Raccourcis clavier propres au lecteur (Espace, ←/→, F, M). À couper quand le module hôte pilote
  // lui-même le clavier et donne un autre sens à ces touches (NetsuCut : ←/→ = plan préc/suiv).
  shortcuts?: boolean;
}) {
  // Le volume est GLOBAL (store) : réglé une fois, valable dans toute l'app et conservé au changement
  // d'onglet. `defaultVolume` reste un filet de sécurité ; le défaut global est 20 % et le volume 0
  // est un muet persistant partagé par tous les lecteurs.
  const storedVolume = useApp((s) => s.playerVolume);
  const setStoredVolume = useApp((s) => s.setPlayerVolume);
  const volume = storedVolume ?? defaultVolume;

  if (!src) {
    return (
      <div className="group relative h-full w-full bg-black">
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <Play className="h-8 w-8 opacity-40" />
        </div>
      </div>
    );
  }

  // La key sur src remonte la surface : time/dur/playing repartent à zéro sans effet de reset.
  return (
    <PlayerSurface
      key={src}
      src={src}
      loop={loop}
      autoPlay={autoPlay}
      onEnded={onEnded}
      onTime={onTime}
      apiRef={apiRef}
      volume={volume}
      setVolume={setStoredVolume}
      fit={fit}
      shortcuts={shortcuts}
      nativePath={nativePath}
    />
  );
}

function PlayerSurface({
  src,
  loop,
  autoPlay,
  onEnded,
  onTime,
  apiRef,
  volume,
  setVolume,
  fit,
  shortcuts,
  nativePath,
}: {
  src: string;
  loop: boolean;
  autoPlay: boolean;
  onEnded?: () => void;
  onTime?: (t: number) => void;
  apiRef?: React.MutableRefObject<ScenePlayerApi | null>;
  volume: number;
  setVolume: (v: number) => void;
  fit: "contain" | "cover";
  shortcuts: boolean;
  nativePath?: string;
}) {
  const { t } = useTranslation("common");
  const ref = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [volOpen, setVolOpen] = useState(false);   // volume déplié (panneau étroit → repliable)
  // Chromium refuse la lecture auto AVEC son tant que la page n'a pas été interagie. Le volume étant
  // persisté, un lecteur peut monter à volume > 0 sur une page fraîche → play() rejeté, vidéo figée.
  // On retombe alors en muet pour que l'image tourne quand même, SANS toucher au volume enregistré :
  // le réglage de l'utilisateur survit, et la première action sur le son le rétablit.
  const [forcedMute, setForcedMute] = useState(false);

  const native = useNativePlayerSurface({
    path: nativePath,
    autoPlay,
    loop,
    volume,
    onTime: (next) => { setTime(next); onTime?.(next); },
    onDuration: setDur,
    onPlayingChange: setPlaying,
    onEnded,
  });
  const usingNative = native.mode === true;

  // Applique le volume courant à la surface (remontée à chaque src).
  useEffect(() => { if (ref.current) ref.current.volume = volume; }, [volume]);

  const setVolumeAudible = useCallback((v: number) => { setForcedMute(false); setVolume(v); }, [setVolume]);
  const { toggleMute, onVolumeChange } = useVolumeState(volume, setVolumeAudible);

  // Lecture ARRIÈRE : `<video>` n'accepte pas de playbackRate négatif (Chromium). On recule donc
  // `currentTime` à la main dans une boucle rAF, l'élément en pause. Viable ici parce que les proxies
  // sont courts et basse résolution → les seeks arrière sont bon marché.
  const rateRef = useRef(1);
  const revRef = useRef<number | null>(null);
  const stopReverse = useCallback(() => {
    if (revRef.current != null) { cancelAnimationFrame(revRef.current); revRef.current = null; }
  }, []);
  const setRate = useCallback((r: number) => {
    if (usingNative) {
      rateRef.current = r;
      if (r > 0) native.player.setSpeed(r).catch(() => {});
      return;
    }
    const v = ref.current;
    if (!v) return;
    rateRef.current = r;
    stopReverse();
    if (r > 0) { v.playbackRate = r; v.play().catch(() => {}); return; }
    v.pause();
    let last = performance.now();
    const tick = (now: number) => {
      const el = ref.current;
      if (!el) return;
      const dt = (now - last) / 1000;
      last = now;
      const next = el.currentTime + r * dt;   // r < 0 → on recule
      if (next <= 0) { el.currentTime = 0; rateRef.current = 1; revRef.current = null; return; }
      el.currentTime = next;
      revRef.current = requestAnimationFrame(tick);
    };
    revRef.current = requestAnimationFrame(tick);
  }, [native.player, stopReverse, usingNative]);
  useEffect(() => stopReverse, [stopReverse]);

  const toggle = useCallback(() => {
    if (usingNative) {
      native.player.toggle().catch(() => {});
      return;
    }
    const v = ref.current;
    if (!v) return;
    stopReverse();   // relancer/mettre en pause sort de la marche arrière
    rateRef.current = 1;
    v.playbackRate = 1;
    v.paused ? v.play().catch(() => {}) : v.pause();
  }, [native.player, stopReverse, usingNative]);

  const step = useCallback((d: number) => {
    if (usingNative) {
      (d >= 0 ? native.player.frameStep() : native.player.frameBackStep()).catch(() => {});
      return;
    }
    const v = ref.current;
    if (v) v.currentTime = Math.max(0, Math.min(v.currentTime + d, v.duration || 0));
  }, [native.player, usingNative]);

  // Scrub par ratio 0..1 : applique au currentTime et met à jour le temps affiché.
  const seekToRatio = useCallback((r: number) => {
    if (usingNative) {
      if (dur) native.player.seek(r * dur).catch(() => {});
      setTime(r * dur);
      return;
    }
    const v = ref.current;
    if (!v || !dur) return;
    v.currentTime = r * dur;
    setTime(r * dur);
  }, [dur, native.player, usingNative]);

  // Expose la poignée impérative (seek/play/pause) au parent — pilotage depuis le transcript/waveform.
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      seek: (t: number) => {
        if (usingNative) { native.player.seek(t).then(() => native.player.play()).catch(() => {}); return; }
        const v = ref.current; if (v) { v.currentTime = Math.max(0, t); v.play().catch(() => {}); }
      },
      play: () => usingNative ? native.player.play().catch(() => {}) : ref.current?.play().catch(() => {}),
      pause: () => usingNative ? native.player.pause().catch(() => {}) : ref.current?.pause(),
      time: () => time,
      paused: () => !playing,
      setRate,
      rate: () => rateRef.current,
    };
    return () => { if (apiRef) apiRef.current = null; };
  }, [apiRef, native.player, playing, setRate, time, usingNative]);

  const { onScrubDown, onScrubMove, onScrubUp } = useVideoScrubber({
    barRef,
    seekToRatio,
    isPlaying: () => usingNative ? playing : !!ref.current && !ref.current.paused,
    onPause: () => usingNative ? native.player.pause().catch(() => {}) : ref.current?.pause(),
    onResume: () => usingNative ? native.player.play().catch(() => {}) : ref.current?.play().catch(() => {}),
    onActiveChange: setScrubbing,
  });

  function fullscreen() {
    wrapRef.current?.requestFullscreen?.();
  }

  const onShortcut = useEffectEvent((e: KeyboardEvent) => {
    if (e.code === "Space") { e.preventDefault(); toggle(); }
    else if (e.code === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -1 : -1 / 24); }
    else if (e.code === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 1 : 1 / 24); }
    else if (e.code === "KeyF") { e.preventDefault(); fullscreen(); }
    else if (e.code === "KeyM") { e.preventDefault(); toggleMute(); }
  });

  useEffect(() => {
    if (!shortcuts) return;   // le module hôte pilote le clavier (cf. prop `shortcuts`)
    function onKey(e: KeyboardEvent) {
      if (isTyping(document.activeElement)) return;
      onShortcut(e);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts]);

  const pct = dur ? (time / dur) * 100 : 0;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div ref={wrapRef} className="group relative h-full w-full bg-black" />}>
      {usingNative ? (
        <div
          ref={native.surfaceRef}
          className="h-full w-full bg-black"
          aria-label={t("player.scenePreview")}
          role="button"
          tabIndex={0}
          onClick={toggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
          }}
        />
      ) : native.mode === false ? (
        <video
          ref={ref}
          src={src}
          autoPlay={autoPlay}
          loop={loop}
          muted={volume === 0 || forcedMute}
          aria-label={t("player.scenePreview")}
          className={`h-full w-full object-${fit}`}
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => { setTime(e.currentTarget.currentTime); onTime?.(e.currentTarget.currentTime); }}
          onLoadedMetadata={(e) => {
            setDur(e.currentTarget.duration);
            e.currentTarget.volume = volume;
            // Toujours relancer explicitement la lecture : WebView2 peut ignorer l'attribut
            // `autoPlay`, notamment quand le volume global vaut 0. Si la lecture sonore est
            // refusée avant la première interaction, basculer la surface en muet ET la relancer
            // immédiatement (l'ancien code ne faisait que changer l'état React, laissant le
            // lecteur latéral noir jusqu'à un clic).
            if (autoPlay) {
              const video = e.currentTarget;
              video.play().catch(() => {
                video.muted = true;
                setForcedMute(true);
                video.play().catch(() => {});
              });
            }
          }}
          onEnded={onEnded}
        >
          <track kind="captions" />
        </video>
      ) : (
        <div className="h-full w-full bg-black" aria-label={t("player.loading")} />
      )}

      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-6 transition-all ${
          scrubbing ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0 group-hover:translate-y-0 group-hover:opacity-100"
        }`}
      >
        {/* barre de progression : large zone de drag pour scrubber vite (clic + glissé) */}
        <div
          ref={barRef}
          className="group/bar pointer-events-auto -my-2 cursor-pointer touch-none py-2"
          role="slider"
          tabIndex={0}
          aria-label={t("player.progress")}
          aria-valuemin={0}
          aria-valuemax={dur || 0}
          aria-valuenow={time}
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubUp}
          onKeyDown={(e) => {
            // stopPropagation : évite le double-step (le handler clavier global capte aussi les flèches).
            if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); step(e.shiftKey ? -1 : -1 / 24); }
            else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); step(e.shiftKey ? 1 : 1 / 24); }
          }}
        >
          <div className={`rounded-full bg-white/20 transition-[height] ${scrubbing ? "h-2.5" : "h-1.5 group-hover/bar:h-2.5"}`}>
            <div className="relative h-full rounded-full bg-primary" style={{ width: `${pct}%` }}>
              <span className={`absolute -right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow transition-opacity ${scrubbing ? "opacity-100" : "opacity-0 group-hover/bar:opacity-100"}`} />
            </div>
          </div>
        </div>

        <div className="pointer-events-auto mt-2 flex items-center gap-2 text-white">
          <button type="button" onClick={toggle} aria-label={playing ? t("player.pause") : t("player.play")} className="shrink-0 hover:text-primary">{playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}</button>
          <Tooltip>
            <TooltipTrigger render={<button type="button" onClick={() => step(-1 / 24)} className="shrink-0 hover:text-primary" aria-label={t("player.prevFrame")} />}><SkipBack className="h-4 w-4" /></TooltipTrigger>
            <TooltipContent>{t("player.prevFrameShortcut")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<button type="button" onClick={() => step(1 / 24)} className="shrink-0 hover:text-primary" aria-label={t("player.nextFrame")} />}><SkipForward className="h-4 w-4" /></TooltipTrigger>
            <TooltipContent>{t("player.nextFrameShortcut")}</TooltipContent>
          </Tooltip>
          <span className="shrink-0 whitespace-nowrap tabular-nums text-xs text-white/80">{fmt(time)} / {fmt(dur)}</span>
          <div className="flex-1" />
          {/* volume repliable : le bouton muet du curseur reste visible, la piste se déplie au survol */}
          <div
            className={`flex shrink-0 items-center overflow-hidden transition-[width] duration-200 ${volOpen ? "w-24" : "w-5"}`}
            onMouseEnter={() => setVolOpen(true)}
            onMouseLeave={() => setVolOpen(false)}
            onFocusCapture={() => setVolOpen(true)}
            onBlurCapture={() => setVolOpen(false)}
          >
            <VolumeSlider value={volume} onChange={onVolumeChange} onToggleMute={toggleMute} label={t("player.volume")} />
          </div>
          <button type="button" onClick={fullscreen} aria-label={t("player.fullscreen")} className="shrink-0 hover:text-primary"><Maximize2 className="h-4 w-4" /></button>
        </div>
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onClick={toggle}>
          {playing ? <PauseIcon /> : <PlayIcon />} {playing ? t("player.pause") : t("player.play")}
        </ContextMenuItem>
        <ContextMenuCheckboxItem checked={volume === 0} onClick={toggleMute}>
          {volume === 0 ? <VolumeX /> : <Volume2 />} {t("player.muted")}
        </ContextMenuCheckboxItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => step(-1 / 24)}><SkipBack /> {t("player.prevFrame")}</ContextMenuItem>
        <ContextMenuItem onClick={() => step(1 / 24)}><SkipForward /> {t("player.nextFrame")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={fullscreen}><Maximize2 /> {t("player.fullscreen")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
