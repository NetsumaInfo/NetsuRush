// Waveform : pics colorés — VERT parole, ROUGE silence — + bandes de silence,
// hésitations (ambre) / répétitions (bleu), tête de lecture, clic = seek. ZOOM : quand zoom > 1, on
// n'affiche qu'une fenêtre (durée/zoom) CENTRÉE sur la tête de lecture → on navigue en seekant. Le
// Canvas n'est redessiné que sur changement des pics/segments/fenêtre (pas par frame).
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { VoiceSpan } from "@/lib/bridge";
import { cn } from "@/lib/utils";

function inSpans(spans: VoiceSpan[], t: number): boolean {
  for (const s of spans) if (t >= s.start && t < s.end) return true;
  return false;
}

export function Waveform({
  peaks, duration, speech, silence, off, fillers, repeats, playhead, onSeek, tall, zoom = 1,
}: {
  peaks: number[];
  duration: number;
  speech: VoiceSpan[];
  silence: VoiceSpan[];
  off?: Set<number>;
  fillers?: { start: number; end: number }[];
  repeats?: { start: number; end: number }[];
  playhead: number;
  onSeek: (t: number) => void;
  tall?: boolean;
  zoom?: number;
}) {
  const { t } = useTranslation("voice");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const offRanges = (off && off.size) ? speech.filter((_, i) => off.has(i)) : [];

  // Fenêtre visible : tout le clip si zoom 1, sinon durée/zoom centrée sur la tête de lecture.
  const z = Math.max(1, zoom || 1);
  const winDur = duration > 0 ? duration / z : 0;
  const maxStart = Math.max(0, duration - winDur);
  const winStart = winDur > 0 ? Math.min(maxStart, Math.max(0, playhead - winDur / 2)) : 0;
  const span = winDur || duration || 1;
  // Position (0..100 %) d'un instant t dans la fenêtre. Hors fenêtre → clampé (clippé par overflow).
  const posPct = (t: number) => ((t - winStart) / span) * 100;
  // Clé quantifiée de la fenêtre → borne les redraw du canvas (pas un par frame au zoom).
  const winKey = z > 1 ? Math.round(winStart * 40) : 0;

  useEffect(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const draw = () => {
      const w = wrap.clientWidth || 600;
      const h = wrap.clientHeight || 80;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = w * dpr; cv.height = h * dpr;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const style = getComputedStyle(document.documentElement);
      const green = (style.getPropertyValue("--color-ok") || "#22c55e").trim();
      const purple = (style.getPropertyValue("--color-primary") || "#8b7cf6").trim();
      const mid = h / 2;
      const n = peaks.length || 1;
      const hasSpeech = speech.length > 0;
      // Indices de pics visibles dans la fenêtre.
      const i0 = Math.max(0, Math.floor((winStart / (duration || 1)) * n));
      const i1 = Math.min(n, Math.ceil(((winStart + span) / (duration || 1)) * n));
      const bw = w / Math.max(1, i1 - i0);
      for (let i = i0; i < i1; i++) {
        const t = duration ? (i / n) * duration : 0;
        const isOff = offRanges.length > 0 && inSpans(offRanges, t);
        const isSpeech = !hasSpeech || inSpans(speech, t);
        ctx.fillStyle = !hasSpeech
          ? "rgba(148,163,184,0.55)"
          : isOff ? purple : isSpeech ? green : "rgba(239,68,68,0.45)";
        const amp = Math.max(0.03, peaks[i]) * (h * 0.46);
        const x = ((t - winStart) / span) * w;
        ctx.fillRect(x, mid - amp, Math.max(1, bw - 0.5), amp * 2);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [peaks, speech, silence, off, duration, z, winKey]); // eslint-disable-line react-hooks/exhaustive-deps, react-doctor/exhaustive-deps

  const pct = Math.min(100, Math.max(0, posPct(playhead)));

  function seekFromEvent(e: React.MouseEvent) {
    const wrap = wrapRef.current;
    if (!wrap || !duration) return;
    const r = wrap.getBoundingClientRect();
    onSeek(winStart + ((e.clientX - r.left) / r.width) * span);
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onSeek(Math.max(0, playhead - (e.shiftKey ? 1 : 0.1)));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onSeek(Math.min(duration, playhead + (e.shiftKey ? 1 : 0.1)));
    }
  };

  return (
    <div
      ref={wrapRef}
      onClick={seekFromEvent}
      onKeyDown={handleKeyDown}
      role="slider"
      tabIndex={0}
      aria-label={t("waveform.scrubberAria")}
      aria-valuenow={playhead}
      aria-valuemin={0}
      aria-valuemax={duration}
      className={cn("relative w-full cursor-pointer overflow-hidden rounded-lg border border-border bg-black/30 transition-[height] outline-none focus-visible:ring-1 focus-visible:ring-ring", tall ? "h-48" : "h-20")}
    >
      {/* bandes de silence en fond (rouge très léger) */}
      {duration > 0 && silence.map((s, i) => (
        <div key={i} className="absolute top-0 h-full bg-destructive/10"
          style={{ left: `${posPct(s.start)}%`, width: `${((s.end - s.start) / span) * 100}%` }} />
      ))}
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* hésitations (ambre) + répétitions (bleu) */}
      {duration > 0 && (fillers || []).map((f, i) => (
        <div key={`f${i}`} className="absolute top-0 h-full border-x border-amber-400/60 bg-amber-400/25"
          style={{ left: `${posPct(f.start)}%`, width: `${Math.max(0.4, ((f.end - f.start) / span) * 100)}%` }} />
      ))}
      {duration > 0 && (repeats || []).map((r, i) => (
        <div key={`r${i}`} className="absolute top-0 h-full border-x border-sky-400/60 bg-sky-400/20"
          style={{ left: `${posPct(r.start)}%`, width: `${Math.max(0.4, ((r.end - r.start) / span) * 100)}%` }} />
      ))}
      {/* tête de lecture — transition courte : interpole entre deux ticks (~15 Hz) → glisse fluide */}
      <div className="pointer-events-none absolute top-0 h-full w-0.5 bg-white shadow-[0_0_6px_rgba(255,255,255,0.7)] transition-[left] duration-100 ease-linear motion-reduce:transition-none" style={{ left: `${pct}%` }} />
    </div>
  );
}
