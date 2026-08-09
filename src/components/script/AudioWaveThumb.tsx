import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play } from "lucide-react";
import { nr } from "@/lib/bridge";
import { cn } from "@/lib/utils";

const waveCache = new Map<string, number[]>();

export function AudioWaveThumb({ path, compact = false }: { path: string; compact?: boolean }) {
  const { t } = useTranslation("common");
  const [peaks, setPeaks] = useState<number[]>(() => waveCache.get(path) ?? []);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!path || peaks.length) return;
    let alive = true;
    void nr.waveform({ input: path, buckets: compact ? 18 : 30 }).then((r) => {
      if (!alive || !r?.ok || !r.peaks?.length) return;
      const next = r.peaks.map((v) => Math.max(0.08, Math.min(1, Math.abs(v))));
      waveCache.set(path, next);
      setPeaks(next);
    }).catch(() => {});
    return () => { alive = false; };
  }, [compact, path, peaks.length]);

  const bars = useMemo(() => peaks.length ? peaks : Array.from({ length: compact ? 14 : 24 }, (_, i) => 0.18 + ((i * 7) % 6) / 12), [compact, peaks]);

  const toggle = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => {}); else audio.pause();
  };

  return (
    <button type="button" className={cn("audio-wave-thumb", compact && "is-compact", playing && "is-playing")} onClick={toggle} aria-label={playing ? t("player.pause") : t("player.play")}>
      <audio ref={audioRef} src={nr.mediaUrl(path)} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      <span className="audio-wave-bars" aria-hidden>
        {bars.map((height, i) => <span key={i} style={{ height: `${Math.round(height * 100)}%` }} />)}
      </span>
      <span className="audio-wave-play" aria-hidden>{playing ? <Pause /> : <Play />}</span>
    </button>
  );
}
