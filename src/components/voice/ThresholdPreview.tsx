// Aperçu INSTANTANÉ des réglages de silence sur la VRAIE forme d'onde du clip (pics réels), recoloré
// en PUR JS quand on bouge un curseur → précis (c'est ton audio) + intuitif (ça ressemble au clip) +
// zéro recalcul (pas de sidecar). Vert = gardé (parole), rouge = coupé (blanc). Si pas encore de pics
// (waveform pas chargée), retombe sur un exemple synthétique pour montrer le principe.
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { SilenceParams } from "@/lib/bridge";
import { cn } from "@/lib/utils";

const SYNTH: number[] = (() => {
  const N = 240;
  const segs: [number, number, number][] = [
    [0, 1.4, 0.85], [1.4, 2.2, 0.05], [2.2, 2.45, 0.72], [2.45, 2.75, 0.06],
    [2.75, 4.4, 0.8], [4.4, 4.7, 0.35], [4.7, 6.2, 0.82], [6.2, 7.7, 0.04], [7.7, 10, 0.8],
  ];
  const a = new Array(N).fill(0.05);
  for (let i = 0; i < N; i++) {
    const t = (i / N) * 10;
    const seg = segs.find(([s0, s1]) => t >= s0 && t < s1);
    const base = seg ? seg[2] : 0.05;
    a[i] = Math.max(0, Math.min(1, base + (base > 0.2 ? 0.1 * Math.sin(i * 1.7) : 0.02 * Math.sin(i))));
  }
  return a;
})();

// Normalise les pics 0..1 (par le max) pour que le SEUIL balaie toute la dynamique du clip.
function normalize(peaks: number[]): number[] {
  let max = 0;
  for (const p of peaks) if (p > max) max = p;
  if (max <= 0) return peaks.map(() => 0);
  return peaks.map((p) => p / max);
}

function flipShortRuns(arr: boolean[], value: boolean, minLen: number): boolean[] {
  if (minLen <= 1) return arr.slice();
  const out = arr.slice();
  let i = 0;
  while (i < out.length) {
    if (out[i] !== value) { i++; continue; }
    let j = i;
    while (j < out.length && out[j] === value) j++;
    if (j - i < minLen) for (let k = i; k < j; k++) out[k] = !value;
    i = j;
  }
  return out;
}

function dilate(arr: boolean[], pad: number): boolean[] {
  if (pad <= 0) return arr.slice();
  const out = arr.slice();
  for (let i = 0; i < arr.length; i++) {
    if (!arr[i]) continue;
    for (let k = Math.max(0, i - pad); k <= Math.min(arr.length - 1, i + pad); k++) out[k] = true;
  }
  return out;
}

// Classe chaque échantillon en appliquant les 4 paramètres comme Silero. Deux étages exposés :
// `base` = parole détectée (étapes 1-3), `kept` = base + marge (étape 4) → l'aperçu peut colorer la
// MARGE différemment (vert translucide) et rendre le curseur « Marge » visible.
function classifyStages(env: number[], p: SilenceParams, totalSec: number): { base: boolean[]; kept: boolean[] } {
  const N = env.length;
  const dt = totalSec / N || 1;
  const thr = p.threshold ?? 0.5;
  const minSil = Math.round((p.min_silence_ms ?? 500) / 1000 / dt);
  const minSpeech = Math.round((p.min_speech_ms ?? 100) / 1000 / dt);
  const pad = Math.round((p.pad_ms ?? 100) / 1000 / dt);
  let v = env.map((a) => a >= thr);          // 1. parole = au-dessus du seuil
  v = flipShortRuns(v, false, minSil);        // 2. blancs trop courts → recollés en parole
  v = flipShortRuns(v, true, minSpeech);      // 3. paroles trop courtes → ignorées (blanc)
  return { base: v, kept: dilate(v, pad) };   // 4. marge autour de la parole
}

// Résumé chiffré des réglages courants (pour l'aide) : % conservé, nb de coupes, durée retirée.
// Même moteur que l'aperçu → les chiffres bougent avec les curseurs. `real` = vrais pics du clip.
export function silencePreviewStats(peaks: number[] | undefined, p: SilenceParams, duration?: number) {
  const real = !!peaks && peaks.length > 8;
  const env = real ? normalize(peaks!) : SYNTH;
  const totalSec = real ? (duration || env.length / 24) : 10;
  const { kept } = classifyStages(env, p, totalSec);
  const n = kept.length || 1;
  let keptCount = 0, cuts = 0;
  for (let i = 0; i < n; i++) {
    if (kept[i]) keptCount++;
    else if (i === 0 || kept[i - 1]) cuts++;
  }
  return { real, keptPct: Math.round((keptCount / n) * 100), cuts, cutSec: ((n - keptCount) / n) * totalSec };
}

export function ThresholdPreview({ params, peaks, duration, className, showThreshold }: { params: SilenceParams; peaks?: number[]; duration?: number; className?: string; showThreshold?: boolean }) {
  const { t } = useTranslation("voice");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const thresholdLabel = t("thresholdPreview.thresholdLabel");

  useEffect(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const real = peaks && peaks.length > 8;
    const env = real ? normalize(peaks) : SYNTH;
    const totalSec = real ? (duration || env.length / 24) : 10;
    const draw = () => {
      const w = wrap.clientWidth || 260;
      const h = wrap.clientHeight || 44;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = w * dpr; cv.height = h * dpr;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const style = getComputedStyle(document.documentElement);
      const green = (style.getPropertyValue("--color-ok") || "#22c55e").trim();
      const { base, kept } = classifyStages(env, params, totalSec);
      const mid = h / 2;
      const n = env.length;
      const bw = w / n;
      for (let i = 0; i < n; i++) {
        // 3 états lisibles : parole (vert), MARGE ajoutée par pad_ms (vert translucide), coupé (rouge).
        ctx.globalAlpha = kept[i] && !base[i] ? 0.4 : 1;
        ctx.fillStyle = kept[i] ? green : "rgba(239,68,68,0.55)";
        const amp = Math.max(0.04, env[i]) * (h * 0.42);
        ctx.fillRect(i * bw, mid - amp, Math.max(0.7, bw - 0.3), amp * 2);
      }
      ctx.globalAlpha = 1;
      if (showThreshold) {
        // Le curseur « Seuil » matérialisé : lignes pointillées miroir à la hauteur exacte du seuil —
        // tout pic qui les dépasse = parole, en dessous = blanc.
        const thr = params.threshold ?? 0.5;
        const off = Math.max(1.5, thr * h * 0.42);
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        for (const y of [mid - off, mid + off]) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.font = "9px Inter, system-ui, sans-serif";
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.textAlign = "right";
        ctx.fillText(thresholdLabel, w - 5, Math.max(9, mid - off - 3));
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [params, peaks, duration, showThreshold, thresholdLabel]);

  return (
    <div ref={wrapRef} className={cn("relative w-full overflow-hidden rounded-md border border-border bg-black/30", className || "h-11")}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
