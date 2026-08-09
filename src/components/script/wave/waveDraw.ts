// Dessin et mesure de la waveform — fonctions PURES (aucun React, aucun DOM hors ctx canvas).
// Séparé du composant pour que la géométrie et l'échelle soient relisibles sans runtime.

export interface WaveWindow { start: number; end: number; peaks: number[] }

export interface WavePalette { bar: string; barSel: string; sel: string; dim: string; tick: string; head: string }

// Le core renvoie des pics en PLEINE ÉCHELLE (|PCM| / 32768). Un rush dialogué culmine vers 0.1 :
// dessiné brut, il s'affiche à 10 % de hauteur, c'est-à-dire un trait plat. On normalise donc sur le
// pic le plus fort de la portion VISIBLE. Le plancher évite qu'une fenêtre de pur silence soit
// amplifiée jusqu'à faire passer le bruit de fond pour du signal.
const MIN_REFERENCE_PEAK = 0.08;
const MAX_GAIN = 14;

// Amplitude max d'une plage temporelle dans une enveloppe (échantillonnage par colonne de pixels).
export function sampleMax(src: number[], srcStart: number, srcEnd: number, t0: number, t1: number): number {
  const n = src.length;
  const span = srcEnd - srcStart;
  if (n === 0 || span <= 0) return 0;
  let i0 = Math.floor(((t0 - srcStart) / span) * n);
  let i1 = Math.ceil(((t1 - srcStart) / span) * n);
  i0 = Math.max(0, Math.min(n - 1, i0));
  i1 = Math.max(i0 + 1, Math.min(n, i1));
  let m = 0;
  for (let i = i0; i < i1; i++) if (src[i] > m) m = src[i];
  return m;
}

export function normalizeGain(src: number[], srcStart: number, srcEnd: number, viewStart: number, viewEnd: number): number {
  const peak = sampleMax(src, srcStart, srcEnd, viewStart, viewEnd);
  return Math.min(MAX_GAIN, 1 / Math.max(MIN_REFERENCE_PEAK, peak));
}

// Pas de graduation « rond » le plus proche : ~8 repères dans la fenêtre, jamais moins d'une frame.
const TICK_STEPS = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
export function tickStep(span: number): number {
  const target = span / 8;
  return TICK_STEPS.find((s) => s >= target) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

export function tickLabel(sec: number): string {
  const total = Math.max(0, sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (total < 10) return `${s.toFixed(1)}s`;
  return `${m}:${String(Math.floor(s)).padStart(2, "0")}`;
}

interface WaveArgs {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  viewStart: number;
  viewEnd: number;
  src: number[];
  srcStart: number;
  srcEnd: number;
  palette: WavePalette;
  rulerHeight: number;
}

// Couche de FOND : graduations + barres. Ne dépend NI de la sélection NI de la tête de lecture —
// c'est ce qui permet de ne jamais la repeindre pendant un glissé de borne ou pendant la lecture.
export function drawWaveBase({ ctx, width, height, viewStart, viewEnd, src, srcStart, srcEnd, palette, rulerHeight }: WaveArgs) {
  const span = viewEnd - viewStart;
  ctx.clearRect(0, 0, width, height);
  if (span <= 0 || width <= 0) return;

  const step = tickStep(span);
  ctx.fillStyle = palette.tick;
  ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "top";
  for (let t = Math.ceil(viewStart / step) * step; t <= viewEnd; t += step) {
    const x = Math.round(((t - viewStart) / span) * width) + 0.5;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(x, rulerHeight - 4, 1, 4);
    ctx.globalAlpha = 0.85;
    ctx.fillText(tickLabel(t), x + 3, 1);
  }
  ctx.globalAlpha = 1;

  const top = rulerHeight;
  const bodyHeight = height - rulerHeight;
  const mid = top + bodyHeight / 2;
  const gain = normalizeGain(src, srcStart, srcEnd, viewStart, viewEnd);
  const barStep = 2;
  const barWidth = 1.4;
  ctx.fillStyle = palette.bar;
  for (let x = 0; x < width; x += barStep) {
    const t0 = viewStart + (x / width) * span;
    const t1 = viewStart + ((x + barStep) / width) * span;
    const level = Math.min(1, sampleMax(src, srcStart, srcEnd, t0, t1) * gain);
    const amp = Math.max(0.6, level * (bodyHeight * 0.46));
    ctx.fillRect(x, mid - amp, barWidth, amp * 2);
  }

  // Ligne médiane : repère de zéro, indispensable quand le signal est faible.
  ctx.globalAlpha = 0.35;
  ctx.fillRect(0, mid, width, 1);
  ctx.globalAlpha = 1;
}

interface OverlayArgs {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  viewStart: number;
  viewEnd: number;
  inSec: number;
  outSec: number;
  time: number;
  palette: WavePalette;
  rulerHeight: number;
}

// Couche du DESSUS : voile hors sélection, teinte de sélection, tête de lecture. Repeinte à chaque
// frame de lecture et à chaque pixel de glissé — d'où trois rectangles et rien d'autre.
export function drawWaveOverlay({ ctx, width, height, viewStart, viewEnd, inSec, outSec, time, palette, rulerHeight }: OverlayArgs) {
  const span = viewEnd - viewStart;
  ctx.clearRect(0, 0, width, height);
  if (span <= 0 || width <= 0) return;
  const toX = (t: number) => ((t - viewStart) / span) * width;
  const top = rulerHeight;
  const bodyHeight = height - rulerHeight;
  const inX = Math.max(0, Math.min(width, toX(inSec)));
  const outX = Math.max(0, Math.min(width, toX(outSec)));

  ctx.fillStyle = palette.dim;
  if (inX > 0) ctx.fillRect(0, top, inX, bodyHeight);
  if (outX < width) ctx.fillRect(outX, top, width - outX, bodyHeight);

  ctx.fillStyle = palette.sel;
  ctx.fillRect(inX, top, Math.max(1, outX - inX), bodyHeight);

  const tx = toX(time);
  if (tx >= 0 && tx <= width) {
    ctx.fillStyle = palette.head;
    ctx.fillRect(tx - 0.75, 0, 1.5, height);
    ctx.beginPath();
    ctx.moveTo(tx - 4, 0);
    ctx.lineTo(tx + 4, 0);
    ctx.lineTo(tx, 6);
    ctx.closePath();
    ctx.fill();
  }
}

interface MinimapArgs {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  peaks: number[];
  duration: number;
  inSec: number;
  outSec: number;
  viewStart: number;
  viewEnd: number;
  palette: WavePalette;
}

export function drawMinimap({ ctx, width, height, peaks, duration, inSec, outSec, viewStart, viewEnd, palette }: MinimapArgs) {
  ctx.clearRect(0, 0, width, height);
  if (duration <= 0 || width <= 0) return;
  const mid = height / 2;
  const gain = normalizeGain(peaks, 0, duration, 0, duration);
  const n = peaks.length || 1;
  const barWidth = Math.max(1, width / n - 0.3);
  ctx.fillStyle = palette.bar;
  ctx.globalAlpha = 0.6;
  for (let i = 0; i < n; i++) {
    const amp = Math.max(0.5, Math.min(1, peaks[i] * gain) * (height * 0.42));
    ctx.fillRect((i / n) * width, mid - amp, barWidth, amp * 2);
  }
  ctx.globalAlpha = 1;

  const inX = (inSec / duration) * width;
  const outX = (outSec / duration) * width;
  ctx.fillStyle = palette.sel;
  ctx.fillRect(inX, 0, Math.max(1, outX - inX), height);

  const va = (viewStart / duration) * width;
  const vb = (viewEnd / duration) * width;
  ctx.fillStyle = "rgba(255,255,255,.10)";
  ctx.fillRect(va, 0, Math.max(2, vb - va), height);
  ctx.strokeStyle = "rgba(255,255,255,.55)";
  ctx.lineWidth = 1;
  ctx.strokeRect(va + 0.5, 0.5, Math.max(2, vb - va) - 1, height - 1);
}

// Aimantation : renvoie le point le plus proche dans la tolérance, sinon la valeur brute.
export function snapTime(t: number, targets: number[], tolerance: number): number {
  let best = t;
  let bestDelta = tolerance;
  for (const target of targets) {
    const delta = Math.abs(target - t);
    if (delta < bestDelta) { bestDelta = delta; best = target; }
  }
  return best;
}
