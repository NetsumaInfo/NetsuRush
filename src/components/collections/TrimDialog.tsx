// Rognage PRÉCIS d'un plan, sur le RUSH ENTIER — lecteur SOURCE directe (aucun proxy, aucune
// attente d'encode), compatible tous codecs comme l'UpscalePlayer :
//  - conteneur mp4/mov/webm → /media (Range) : seek natif instantané n'importe où ;
//  - autre (mkv, ts…) → /stream relancé à la position (?t=), copy si codec natif sinon transcode.
// Deux pistes : VUE D'ENSEMBLE (filmstrip du rush entier, bornes posables partout) + DÉTAIL
// (fenêtre zoomable, purement visuelle : vignettes/waveform). Frame-accurate au save (inchangé).
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Crop, FlagTriangleRight, ChevronFirst, ChevronLast, SkipBack, SkipForward, AudioLines, Images, Ban, ZoomIn, ZoomOut, Focus, Expand, Play, Pause, SquarePlay, Undo2 } from "lucide-react";
import { nr, type CollectionShot } from "@/lib/bridge";
import { useApp } from "@/store";
import { useVolumeState } from "@/components/player/usePlayer";
import { fmtTime, thumbTime } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { VolumeSlider } from "@/components/player/VolumeSlider";
import { useNativePlayerSurface } from "@/components/player/useNativePlayerSurface";

const PAD = 6;            // marge (s) de la fenêtre initiale autour du plan
const MIN_WIN = 1;        // largeur minimale de la fenêtre de détail (s)
const OVER_FRAMES = 20;   // vignettes de la vue d'ensemble
const DETAIL_FRAMES = 16; // vignettes de la piste de détail
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const t = (s: number) => fmtTime(s, { hours: true });

// Conteneurs démuxés directement par WebView2 → /media (Range, seek natif). Comme UpscalePlayer.
const MP4_FAMILY = /\.(mp4|m4v|mov|webm)$/i;

type Win = { s: number; e: number };
type DragKind = "in" | "out" | "seek";

export function TrimDialog({ shot, onSave, onClose }: {
  shot: CollectionShot;
  onSave: (patch: { in: number; out: number; inFrame?: number; outFrame?: number }) => void;
  onClose: () => void;
}) {
  const { t: tr } = useTranslation(["collections", "common"]);
  const fps = shot.fps && shot.fps > 0 ? shot.fps : 24;
  const mp4 = MP4_FAMILY.test(shot.path);
  // Longueur minimale de la sélection = UNE image de la source. La constante de 0,04 s valait une
  // image à 25 i/s seulement : à 120 i/s elle en bloquait cinq, à 12 i/s elle en autorisait une
  // demie, que `save()` arrondissait ensuite en plan vide.
  const minLen = 1 / fps;

  const [dur, setDur] = useState<number | null>(null);            // durée totale du rush (playInfo)
  const [native, setNative] = useState(false);                    // codec lisible sans transcode (flux copy)
  const [ready, setReady] = useState(mp4);                        // flux : attend playInfo pour choisir copy/enc
  const maxEnd = Math.max(dur ?? 0, shot.out + PAD);              // borne de fin utilisable partout
  const [win, setWin] = useState<Win>({ s: Math.max(0, shot.in - PAD), e: shot.out + PAD });
  const [debWin, setDebWin] = useState<Win>(win);                 // fenêtre debouncée → vignettes de détail

  const [poster, setPoster] = useState<string | null>(null);      // vignette du plan = image instantanée
  const [streamBase, setStreamBase] = useState(shot.in);          // origine du flux /stream (seek = relance)
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [videoUp, setVideoUp] = useState(false);                  // 1res métadonnées reçues → masque le poster
  // Volume GLOBAL (store), partagé avec les autres lecteurs. Défaut 0 tant qu'il n'a jamais été
  // réglé → muet, donc lecture auto autorisée par Chromium.
  const storedVolume = useApp((s) => s.playerVolume);
  const setStoredVolume = useApp((s) => s.setPlayerVolume);
  const volume = storedVolume ?? 0;
  const [forcedMute, setForcedMute] = useState(false);            // repli si la lecture auto sonore est refusée
  const setVolumeAudible = useCallback((v: number) => { setForcedMute(false); setStoredVolume(v); }, [setStoredVolume]);
  const { toggleMute, onVolumeChange } = useVolumeState(volume, setVolumeAudible);
  const [overThumbs, setOverThumbs] = useState<(string | null)[]>(() => Array(OVER_FRAMES).fill(null));
  const [thumbs, setThumbs] = useState<(string | null)[]>(() => Array(DETAIL_FRAMES).fill(null));
  const [inSec, setInSec] = useState(shot.in);
  const [outSec, setOutSec] = useState(shot.out);
  const [cur, setCur] = useState(shot.in);
  // Affichage de la piste de détail : séquence d'images, waveform, ou rien.
  const [stripMode, setStripMode] = useState<"images" | "wave" | "off">("images");
  const [peaks, setPeaks] = useState<number[] | null>(null);      // enveloppe du FICHIER ENTIER (découpée par fenêtre)

  const videoRef = useRef<HTMLVideoElement>(null);
  const overRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<null | { track: "over" | "detail"; kind: DragKind }>(null);
  const wantPlay = useRef(false);                                 // intention après (re)chargement du média
  const pendingSeek = useRef<number | null>(shot.in);             // mp4 : position à appliquer aux métadonnées
  const stopAt = useRef<number | null>(null);                     // « Lire la sélection » : pause à la borne de fin

  const nativeSurface = useNativePlayerSurface({
    path: shot.path,
    autoPlay: true,
    volume,
    startAt: shot.in,
    onTime: setCur,
    onDuration: (duration) => {
      setDur(duration);
      setVideoUp(true);
      setLoading(false);
    },
    onPlayingChange: setPlaying,
    onEnded: () => setPlaying(false),
    onError: () => setLoading(false),
  });

  useEffect(() => {
    if (nativeSurface.mode !== true || stopAt.current == null || cur < stopAt.current) return;
    stopAt.current = null;
    nativeSurface.player.pause().catch(() => {});
  }, [cur, nativeSurface.mode, nativeSurface.player]);

  // URL de lecture : source DIRECTE. Flux relancé depuis streamBase quand le conteneur n'est pas natif.
  const src = mp4 ? nr.mediaUrl(shot.path) : ready ? nr.streamUrl(shot.path, streamBase, native ? "copy" : "enc") : null;
  const globalTime = (v: HTMLVideoElement) => (mp4 ? v.currentTime : streamBase + v.currentTime);

  // Infos de lecture : durée totale (vue d'ensemble) + codec natif (mode du flux).
  useEffect(() => {
    let alive = true;
    nr.playInfo(shot.path).then((info) => {
      if (!alive) return;
      if (info.duration > 0) setDur(info.duration);
      setNative(!!info.native);
      setReady(true);
    }).catch(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [shot.path]);

  // Vignette du plan (déjà en cache depuis la grille) → image IMMÉDIATE avant les métadonnées vidéo.
  useEffect(() => {
    let alive = true;
    nr.thumbnail(shot.path, thumbTime(shot.in, shot.out)).then((r) => {
      if (alive && typeof r === "string") setPoster(nr.mediaUrl(r));
    }).catch(() => {});
    return () => { alive = false; };
  }, [shot.path, shot.in, shot.out]);

  // Fenêtre debouncée : les vignettes de détail ne suivent pas chaque cran de zoom/déplacement.
  useEffect(() => {
    const id = setTimeout(() => setDebWin(win), 250);
    return () => clearTimeout(id);
  }, [win]);

  // Vue d'ensemble : vignettes réparties sur TOUT le rush (une fois la durée connue).
  useEffect(() => {
    if (!dur) return;
    let alive = true;
    for (let i = 0; i < OVER_FRAMES; i++) {
      const time = ((i + 0.5) / OVER_FRAMES) * dur;
      nr.thumbnail(shot.path, time).then((r) => {
        if (!alive || typeof r !== "string") return;
        const u = nr.mediaUrl(r);
        setOverThumbs((prev) => { const n = [...prev]; n[i] = u; return n; });
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [shot.path, dur]);

  // Piste de détail : une vignette au centre de chaque tranche de la fenêtre (cache disque → revisites gratuites).
  useEffect(() => {
    let alive = true;
    setThumbs(Array(DETAIL_FRAMES).fill(null));
    const len = Math.max(0.001, debWin.e - debWin.s);
    for (let i = 0; i < DETAIL_FRAMES; i++) {
      const time = debWin.s + ((i + 0.5) / DETAIL_FRAMES) * len;
      nr.thumbnail(shot.path, time).then((r) => {
        if (!alive || typeof r !== "string") return;
        const u = nr.mediaUrl(r);
        setThumbs((prev) => { const n = [...prev]; n[i] = u; return n; });
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [shot.path, debWin.s, debWin.e]);

  // Waveform : enveloppe du FICHIER ENTIER, calculée UNE fois à la demande, redessinée par fenêtre.
  useEffect(() => {
    if (stripMode !== "wave" || peaks) return;
    let alive = true;
    nr.waveform({ input: shot.path, buckets: 2000 }).then((r) => { if (alive && r.ok && r.peaks) setPeaks(r.peaks); }).catch(() => {});
    return () => { alive = false; };
  }, [stripMode, peaks, shot.path]);

  // Dessine la TRANCHE [fenêtre] de la waveform. Lisibilité des SILENCES :
  //  - normalisation sur le pic max du fichier + échelle √ (perceptuelle) → la parole faible
  //    reste visible sans écraser les crêtes ;
  //  - sous le seuil de silence, la barre devient un TRAIT PLAT GRIS sur fond assombri → les
  //    trous se repèrent d'un coup d'œil (au lieu de barres bleues quasi identiques partout).
  useEffect(() => {
    if (stripMode !== "wave" || !peaks || !dur) return;
    const cv = waveRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.width = cv.clientWidth * dpr;
    const h = cv.height = cv.clientHeight * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const n = peaks.length;
    const i0 = Math.max(0, Math.floor((debWin.s / dur) * n));
    const i1 = Math.min(n, Math.ceil((debWin.e / dur) * n));
    const count = Math.max(1, i1 - i0);
    const bw = Math.max(1, w / count - dpr);
    const max = Math.max(0.05, ...peaks);        // pic du FICHIER (pas de la tranche : silences comparables entre fenêtres)
    const SILENCE = 0.06;                        // seuil (relatif au pic) sous lequel un bucket est « silence »
    // 1) fond assombri sous les plages de silence (rectangles fusionnés)
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    let runStart = -1;
    for (let i = i0; i <= i1; i++) {
      const silent = i < i1 && (peaks[i] / max) < SILENCE;
      if (silent && runStart < 0) runStart = i;
      else if (!silent && runStart >= 0) {
        const x0 = ((runStart - i0) / count) * w;
        const x1 = ((i - i0) / count) * w;
        ctx.fillRect(x0, 0, x1 - x0, h);
        runStart = -1;
      }
    }
    // 2) barres : bleu (parole, échelle √) / trait plat gris (silence)
    for (let i = i0; i < i1; i++) {
      const v = peaks[i] / max;
      const x = ((i - i0) / count) * w;
      if (v < SILENCE) {
        ctx.fillStyle = "rgba(148,163,184,0.45)";
        ctx.fillRect(x, (h - dpr) / 2, bw, dpr);                       // trait plat = rien à entendre
      } else {
        ctx.fillStyle = "rgba(96,165,250,0.9)";
        const bar = Math.max(3 * dpr, Math.sqrt(v) * (h - 4 * dpr));   // √ : la voix faible reste lisible
        ctx.fillRect(x, (h - bar) / 2, bw, bar);
      }
    }
  }, [stripMode, peaks, dur, debWin.s, debWin.e]);

  // Positions en % : détail = fenêtre courante ; vue d'ensemble = rush entier.
  const winLen = Math.max(0.001, win.e - win.s);
  const pctWin = (sec: number) => clamp(((sec - win.s) / winLen) * 100, 0, 100);
  const pctAll = (sec: number) => clamp((sec / maxEnd) * 100, 0, 100);
  const frameOf = (sec: number) => Math.round(sec * fps);

  // Déplace/redimensionne la fenêtre de détail (bornée au rush, largeur ≥ MIN_WIN). Purement visuel.
  function moveWindow(s: number, e: number) {
    const len = clamp(e - s, MIN_WIN, maxEnd);
    const ns = clamp(s, 0, maxEnd - len);
    setWin({ s: ns, e: ns + len });
  }
  const zoom = (f: number) => {
    const len = clamp(winLen * f, MIN_WIN, maxEnd);
    moveWindow(cur - len / 2, cur + len / 2);
  };
  const fitSelection = () => {
    const pad = Math.max(1, (outSec - inSec) * 0.15);
    moveWindow(inSec - pad, outSec + pad);
  };
  const fitAll = () => moveWindow(0, maxEnd);

  // Seek SOURCE. mp4 : currentTime direct (instantané). Flux : relance à la position (src change) —
  // pendant un glissé on ne relance PAS à chaque move (commit au pointerup, cf. onTrackUp).
  function seekTo(sec: number, play: boolean) {
    const v = clamp(sec, 0, maxEnd);
    setCur(v);
    wantPlay.current = play;
    if (nativeSurface.mode === true) {
      nativeSurface.player.seek(v)
        .then(() => play ? nativeSurface.player.play() : nativeSurface.player.pause())
        .catch(() => {});
      return;
    }
    const el = videoRef.current;
    if (mp4) {
      if (!el) return;
      if (el.readyState < 1) { pendingSeek.current = v; return; }   // métadonnées pas prêtes → différé
      el.currentTime = v;
      if (play) el.play().catch(() => {}); else el.pause();
    } else {
      // même origine et position atteignable → seek relatif sans relancer le flux
      if (el && el.readyState >= 1 && v >= streamBase && v <= streamBase + (el.duration || 0)) {
        el.currentTime = v - streamBase;
        if (play) el.play().catch(() => {}); else el.pause();
      } else {
        setStreamBase(v);   // relance le flux à v (autoplay ; pause à loadedmetadata si !wantPlay)
      }
    }
  }

  // Déplace la tête de lecture (en PAUSE — on regarde l'image exacte).
  function goto(sec: number) {
    stopAt.current = null;
    seekTo(sec, false);
    // Hors de la fenêtre de détail → la recentrer là (largeur conservée).
    const v = clamp(sec, 0, maxEnd);
    if (v < win.s || v > win.e) moveWindow(v - winLen / 2, v + winLen / 2);
  }
  const stepFrame = (d: number) => goto(cur + d / fps);
  const markIn = () => { const v = clamp(cur, 0, outSec - minLen); setInSec(v); };
  const markOut = () => { const v = clamp(cur, inSec + minLen, maxEnd); setOutSec(v); };

  const togglePlay = () => {
    if (nativeSurface.mode === true) {
      nativeSurface.player.toggle().catch(() => {});
      return;
    }
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) { wantPlay.current = true; el.play().catch(() => {}); }
    else { wantPlay.current = false; el.pause(); }
  };
  // Lit la sélection [début → fin] puis s'arrête sur la borne de fin.
  function playSelection() {
    stopAt.current = outSec;
    if (inSec < win.s || outSec > win.e) fitSelection();   // recadre la vue (visuel seulement)
    seekTo(inSec, true);
  }

  // Pointeur sur une piste : glisser une poignée (aperçu live) OU scrubber la tête de lecture.
  // Sur un FLUX (non-mp4), le scrub ne relance pas le flux à chaque move : la tête suit visuellement,
  // le seek réel part au relâchement.
  function onTrackDown(track: "over" | "detail") {
    return (e: React.PointerEvent) => {
      const kind = ((e.target as HTMLElement).dataset.handle as "in" | "out" | undefined) ?? "seek";
      drag.current = { track, kind };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
      applyPointer(e.clientX);
    };
  }
  function onTrackMove(e: React.PointerEvent) { if (drag.current) applyPointer(e.clientX); }
  function onTrackUp(e: React.PointerEvent) {
    if (drag.current) applyPointer(e.clientX, true);
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  }
  function applyPointer(clientX: number, commit = false) {
    const d = drag.current;
    if (!d) return;
    const el = d.track === "over" ? overRef.current : trackRef.current;
    const r = el?.getBoundingClientRect();
    if (!r) return;
    const [lo, hi] = d.track === "over" ? [0, maxEnd] : [win.s, win.e];
    const sec = clamp(lo + ((clientX - r.left) / r.width) * (hi - lo), lo, hi);
    const live = mp4 || commit;   // mp4 : aperçu live ; flux : position visuelle, seek au relâchement
    if (d.kind === "in") { const v = clamp(sec, 0, outSec - minLen); setInSec(v); live ? goto(v) : previewHead(v); }
    else if (d.kind === "out") { const v = clamp(sec, inSec + minLen, maxEnd); setOutSec(v); live ? goto(v) : previewHead(v); }
    else live ? goto(sec) : previewHead(sec);
  }
  // Tête visuelle seule (pendant le glissé sur un flux) — pas de seek réseau.
  function previewHead(sec: number) {
    stopAt.current = null;
    setCur(clamp(sec, 0, maxEnd));
  }

  // Clavier : Espace lecture/pause, I/O bornes, ←/→ ±1 image (Maj = ±1 s). En CAPTURE (aucun autre
  // handler global ne doit doubler le pas), hors saisie de champ.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.code === "Space") { e.preventDefault(); e.stopPropagation(); togglePlay(); }
      else if (e.code === "KeyI") { e.preventDefault(); e.stopPropagation(); markIn(); }
      else if (e.code === "KeyO") { e.preventDefault(); e.stopPropagation(); markOut(); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); e.shiftKey ? goto(cur - 1) : stepFrame(-1); }
      else if (e.code === "ArrowRight") { e.preventDefault(); e.stopPropagation(); e.shiftKey ? goto(cur + 1) : stepFrame(1); }
      // Entrée = appliquer : après I et O au clavier, il fallait reprendre la souris pour valider.
      else if (e.code === "Enter" && dirty) { e.preventDefault(); e.stopPropagation(); save(); onClose(); }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, inSec, outSec, win.s, win.e, maxEnd]);

  // Bornes modifiées ? Comparé EN IMAGES, la seule unité qu'on enregistre : un écart de quelques
  // microsecondes hérité d'un scrub n'est pas une modification et ne doit pas activer « Appliquer ».
  const dirty = frameOf(inSec) !== frameOf(shot.in) || frameOf(outSec) !== frameOf(shot.out);
  function reset() {
    setInSec(shot.in);
    setOutSec(shot.out);
    goto(shot.in);
  }

  function save() {
    const patch: { in: number; out: number; inFrame?: number; outFrame?: number } = { in: inSec, out: outSec };
    if (shot.fps && shot.fps > 0) {
      patch.inFrame = Math.round(inSec * shot.fps);
      patch.outFrame = Math.max(patch.inFrame, Math.round(outSec * shot.fps) - 1);   // endFrame INCLUSIF
    }
    onSave(patch);
  }

  const durF = Math.max(0, frameOf(outSec) - frameOf(inSec));

  // Poignée début/fin (partagée par les deux pistes).
  const Handle = ({ kind, left }: { kind: "in" | "out"; left: number }) => (
    <div data-handle={kind} className="absolute inset-y-0 z-20 -ml-2 flex w-4 cursor-ew-resize items-center justify-center" style={{ left: `${left}%` }}>
      <span data-handle={kind} className="h-full w-1.5 rounded bg-primary shadow" />
    </div>
  );

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Crop className="size-4" /> {tr("trim.title", { name: shot.name || tr("trim.theShot") })}</DialogTitle></DialogHeader>

        {/* Lecteur SOURCE directe (clic = lecture/pause) */}
        <div className="relative aspect-video max-h-[46vh] w-full overflow-hidden rounded-lg bg-black" role="button" tabIndex={0}
          aria-label={tr("trim.togglePlayback")} onClick={togglePlay}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePlay(); } }}>
          {nativeSurface.mode === true ? (
            <div ref={nativeSurface.surfaceRef} className="h-full w-full bg-black" />
          ) : nativeSurface.mode === false && src ? (
            <video
              ref={videoRef}
              src={src}
              playsInline
              autoPlay
              muted={volume === 0 || forcedMute}
              className="h-full w-full object-contain"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                setVideoUp(true); setLoading(false);
                v.volume = volume;
                if (mp4 && !dur && Number.isFinite(v.duration) && v.duration > 0) setDur(v.duration);
                if (mp4 && pendingSeek.current != null) { v.currentTime = pendingSeek.current; pendingSeek.current = null; }
                if (!wantPlay.current) v.pause();   // flux relancé en autoplay → repasse en pause si on scrubbe
              }}
              onTimeUpdate={(e) => {
                if (drag.current) return;   // pendant un glissé, la tête suit le pointeur, pas la vidéo
                const abs = globalTime(e.currentTarget);
                setCur(abs);
                if (stopAt.current != null && abs >= stopAt.current) {
                  stopAt.current = null;
                  wantPlay.current = false;
                  e.currentTarget.pause();
                }
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onPlaying={() => setLoading(false)}
              onWaiting={() => setLoading(true)}
            />
          ) : null}
          {/* poster instantané tant que la vidéo n'a pas ses métadonnées */}
          {!videoUp && poster && <img src={poster} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-contain" />}
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/35">
              <div className="rounded-md bg-black/60 p-1.5"><Spinner className="size-4" /></div>
            </div>
          )}
        </div>

        {/* VUE D'ENSEMBLE = rush entier : sélection ombrée, fenêtre de détail encadrée, tête de lecture. */}
        {dur ? (
          <div
            ref={overRef}
            className="relative h-10 cursor-pointer touch-none select-none overflow-hidden rounded-md bg-muted"
            onPointerDown={onTrackDown("over")} onPointerMove={onTrackMove} onPointerUp={onTrackUp}
          >
            <div className="pointer-events-none absolute inset-0 flex">
              {overThumbs.map((th, i) => (
                <div key={i} className="h-full flex-1 border-r border-black/20 bg-cover bg-center last:border-r-0" style={th ? { backgroundImage: `url(${th})` } : undefined} />
              ))}
            </div>
            {/* masques hors sélection */}
            <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/55" style={{ width: `${pctAll(inSec)}%` }} />
            <div className="pointer-events-none absolute inset-y-0 right-0 bg-black/55" style={{ width: `${100 - pctAll(outSec)}%` }} />
            {/* fenêtre de détail */}
            <div className="pointer-events-none absolute inset-y-0 z-10 rounded-sm border border-white/60" style={{ left: `${pctAll(win.s)}%`, width: `${Math.max(0.5, pctAll(win.e) - pctAll(win.s))}%` }} />
            {/* tête de lecture */}
            <div className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-white shadow" style={{ left: `${pctAll(cur)}%` }} />
            <Handle kind="in" left={pctAll(inSec)} />
            <Handle kind="out" left={pctAll(outSec)} />
          </div>
        ) : (
          <Skeleton className="h-10 rounded-md" />
        )}

        {/* DÉTAIL = fenêtre zoomable. Clic/glissé = tête de lecture ; poignées = bornes fines. */}
        <div
          ref={trackRef}
          className="relative h-16 cursor-pointer touch-none select-none overflow-hidden rounded-md bg-muted"
          onPointerDown={onTrackDown("detail")} onPointerMove={onTrackMove} onPointerUp={onTrackUp}
        >
          {stripMode === "images" && (
            <div className="pointer-events-none absolute inset-0 flex">
              {thumbs.map((th, i) => (
                <div key={i} className="h-full flex-1 border-r border-black/20 bg-cover bg-center last:border-r-0" style={th ? { backgroundImage: `url(${th})` } : undefined} />
              ))}
            </div>
          )}
          {stripMode === "wave" && <canvas ref={waveRef} className="pointer-events-none absolute inset-0 h-full w-full" />}
          {/* masques hors [début,fin] */}
          <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/55" style={{ width: `${pctWin(inSec)}%` }} />
          <div className="pointer-events-none absolute inset-y-0 right-0 bg-black/55" style={{ width: `${100 - pctWin(outSec)}%` }} />
          <div className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-white shadow" style={{ left: `${pctWin(cur)}%` }} />
          <Handle kind="in" left={pctWin(inSec)} />
          <Handle kind="out" left={pctWin(outSec)} />
        </div>

        {/* Transport + marquage + zoom */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={togglePlay} disabled={!src} aria-label={playing ? tr("trim.pause") : tr("trim.play")} />}>{playing ? <Pause className="size-4" /> : <Play className="size-4" />}</TooltipTrigger><TooltipContent>{playing ? tr("trim.pauseKey") : tr("trim.playKey")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={playSelection} disabled={!src} aria-label={tr("trim.playSelection")} />}><SquarePlay className="size-4" /></TooltipTrigger><TooltipContent>{tr("trim.playSelectionHint")}</TooltipContent></Tooltip>
          <span className="mx-1 h-5 w-px bg-border" />
          <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={() => goto(inSec)} aria-label={tr("trim.gotoStart")} />}><ChevronFirst className="size-4" /></TooltipTrigger><TooltipContent>{tr("trim.gotoStart")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={() => stepFrame(-1)} aria-label={tr("trim.prevFrame")} />}><SkipBack className="size-4" /></TooltipTrigger><TooltipContent>{tr("trim.prevFrameHint")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={() => stepFrame(1)} aria-label={tr("trim.nextFrame")} />}><SkipForward className="size-4" /></TooltipTrigger><TooltipContent>{tr("trim.nextFrameHint")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={() => goto(outSec)} aria-label={tr("trim.gotoEnd")} />}><ChevronLast className="size-4" /></TooltipTrigger><TooltipContent>{tr("trim.gotoEnd")}</TooltipContent></Tooltip>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="outline" size="sm" onClick={markIn}><FlagTriangleRight className="size-3.5" /> {tr("trim.markIn")} <span className="ml-1 text-[10px] text-muted-foreground">I</span></Button>
          <Button variant="outline" size="sm" onClick={markOut}><FlagTriangleRight className="size-3.5 -scale-x-100" /> {tr("trim.markOut")} <span className="ml-1 text-[10px] text-muted-foreground">O</span></Button>
          <span className="mx-1 h-5 w-px bg-border" />
          {/* Zoom de la fenêtre de détail */}
          <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={() => zoom(2)} aria-label={tr("trim.zoomOut")} />}><ZoomOut className="size-4" /></TooltipTrigger><TooltipContent>{tr("trim.zoomOutHint")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={() => zoom(0.5)} aria-label={tr("trim.zoomIn")} />}><ZoomIn className="size-4" /></TooltipTrigger><TooltipContent>{tr("trim.zoomInHint")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={fitSelection} aria-label={tr("trim.fitSelection")} />}><Focus className="size-4" /></TooltipTrigger><TooltipContent>{tr("trim.fitSelection")}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger render={<Button variant="outline" size="icon-sm" onClick={fitAll} disabled={!dur} aria-label={tr("trim.fitAll")} />}><Expand className="size-4" /></TooltipTrigger><TooltipContent>{tr("trim.fitAll")}</TooltipContent></Tooltip>
          {/* Affichage de la piste : images / waveform / rien */}
          <ToggleGroup value={[stripMode]} onValueChange={(v) => { const m = v[0]; if (m === "images" || m === "wave" || m === "off") setStripMode(m); }} spacing={0} variant="outline" size="sm">
            <Tooltip><TooltipTrigger render={<ToggleGroupItem value="images" aria-label={tr("trim.images")} className="px-2 aria-pressed:bg-primary aria-pressed:text-primary-foreground" />}><Images className="size-3.5" /></TooltipTrigger><TooltipContent>{tr("trim.images")}</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger render={<ToggleGroupItem value="wave" aria-label={tr("trim.wave")} className="px-2 aria-pressed:bg-primary aria-pressed:text-primary-foreground" />}><AudioLines className="size-3.5" /></TooltipTrigger><TooltipContent>{tr("trim.waveHint")}</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger render={<ToggleGroupItem value="off" aria-label={tr("trim.none")} className="px-2 aria-pressed:bg-primary aria-pressed:text-primary-foreground" />}><Ban className="size-3.5" /></TooltipTrigger><TooltipContent>{tr("trim.none")}</TooltipContent></Tooltip>
          </ToggleGroup>
          {/* Son */}
          <div className="ml-1 w-24">
            <VolumeSlider
              value={volume}
              onChange={(v) => { onVolumeChange(v); const el = videoRef.current; if (el) el.volume = v; }}
              onToggleMute={toggleMute}
            />
          </div>
          <div className="flex-1" />
          <span className="text-[11px] tabular-nums text-muted-foreground">{t(cur)} · {tr("trim.image", { n: frameOf(cur) })}{dur ? ` / ${t(dur)}` : ""}</span>
        </div>

        {/* Bornes précises en frames (source) */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-[11px] text-muted-foreground">
          <label className="flex items-center gap-1.5">{tr("trim.startLabel")}
            <Input type="number" value={frameOf(inSec)} onChange={(e) => { const f = Number(e.target.value); if (Number.isFinite(f)) setInSec(clamp(f / fps, 0, outSec - minLen)); }} className="h-7 w-24 text-xs tabular-nums" />
            <span className="tabular-nums">{t(inSec)}</span>
          </label>
          <label className="flex items-center gap-1.5">{tr("trim.endLabel")}
            <Input type="number" value={frameOf(outSec)} onChange={(e) => { const f = Number(e.target.value); if (Number.isFinite(f)) setOutSec(clamp(f / fps, inSec + minLen, maxEnd)); }} className="h-7 w-24 text-xs tabular-nums" />
            <span className="tabular-nums">{t(outSec)}</span>
          </label>
          <span className="tabular-nums">{tr("trim.duration")} <span className="text-foreground">{(outSec - inSec).toFixed(2)}s</span> · {tr("trim.framesShort", { n: durF })}</span>
        </div>

        <DialogFooter>
          {/* Revenir aux bornes d'origine sans fermer : les retrouver à la main après un mauvais
              glissé demandait de tout annuler puis de rouvrir le plan. */}
          <Button variant="ghost" onClick={reset} disabled={!dirty} className="mr-auto text-muted-foreground">
            <Undo2 className="size-4" /> {tr("trim.reset")}
          </Button>
          <Button variant="outline" onClick={onClose}>{tr("common:action.cancel")}</Button>
          <Button onClick={() => { save(); onClose(); }} disabled={!dirty}>{tr("trim.apply")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
