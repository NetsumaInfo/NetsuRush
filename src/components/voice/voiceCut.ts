// Calcul de la « cut list » (segments à CONSERVER) pour le montage final, en secondes. Ces segments
// passent à nr.buildTimeline qui les convertit en frames (round(in*fps) / round(out*fps)-1 inclusif,
// les 3 invariants timeline). Source unique des 3 features de découpe : silences, montage par texte,
// et leur combinaison.
import type { VoiceWord, VoiceSpan, FillerSpan, HesitationParams } from "@/lib/bridge";
import { combineFillerSpans, repetitionSpans } from "./voiceFillers";

export interface CutSegment { in: number; out: number }

// Fusionne les plages triées qui se touchent ou se chevauchent (gap ≤ epsilon).
function mergeSpans(spans: { in: number; out: number }[], epsilon = 0.04): CutSegment[] {
  const sorted = [...spans].filter((s) => s.out > s.in).sort((a, b) => a.in - b.in);
  const out: CutSegment[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.in - last.out <= epsilon) last.out = Math.max(last.out, s.out);
    else out.push({ in: s.in, out: s.out });
  }
  return out;
}

// Suppression des silences : on conserve les segments PARLÉS (Silero).
function speechSegments(speech: VoiceSpan[]): CutSegment[] {
  return mergeSpans(speech.map((s) => ({ in: s.start, out: s.end })));
}

// Panneau CUTS : segments de parole CONSERVÉS = intervalles non désactivés (off).
export function enabledSpeechSegments(speech: VoiceSpan[], off: Set<number>): CutSegment[] {
  return mergeSpans(speech.filter((_, i) => !off.has(i)).map((s) => ({ in: s.start, out: s.end })));
}

// Montage par texte : on conserve les suites de mots NON retirés, fusionnées en segments contigus.
// Le trou laissé par un mot retiré coupe le segment (la vidéo saute ce passage).
export function keptWordSegments(words: VoiceWord[], removed: Set<number>): CutSegment[] {
  const spans: { in: number; out: number }[] = [];
  let cur: { in: number; out: number } | null = null;
  for (let i = 0; i < words.length; i++) {
    if (removed.has(i)) { if (cur) { spans.push(cur); cur = null; } continue; }
    const w = words[i];
    if (cur) cur.out = w.end;
    else cur = { in: w.start, out: w.end };
  }
  if (cur) spans.push(cur);
  // epsilon 0 : on ne fusionne QUE les chevauchements. Chaque trou ici = un mot retiré VOLONTAIREMENT
  // (« euh », répétition) — l'epsilon de speechSegments le re-souderait et le mot resterait au montage.
  return mergeSpans(spans, 0);
}

// Retire des plages (hésitations acoustiques dans les trous) de la cut list — découpe les segments
// conservés autour de chaque span. Sert à soustraire les fillers acoustiques avant le montage.
export function subtractSpans(segments: CutSegment[], spans: { start: number; end: number }[]): CutSegment[] {
  if (!spans.length) return segments;
  const cuts = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: CutSegment[] = [];
  for (const seg of segments) {
    let curIn = seg.in;
    for (const c of cuts) {
      if (c.end <= curIn || c.start >= seg.out) continue;
      if (c.start > curIn) out.push({ in: curIn, out: Math.min(c.start, seg.out) });
      curIn = Math.max(curIn, c.end);
      if (curIn >= seg.out) break;
    }
    if (curIn < seg.out) out.push({ in: curIn, out: seg.out });
  }
  return out.filter((s) => s.out - s.in > 0.02);
}

// Durée totale conservée (pour l'aperçu « -X s de silences retirés »).
export function totalKept(segments: CutSegment[]): number {
  return segments.reduce((a, s) => a + (s.out - s.in), 0);
}

// Part d'un mot qui doit rester dans le segment pour qu'on le garde ENTIER (sinon on l'écarte).
const WORD_KEEP_RATIO = 0.5;

// Aucune frontière de coupe ne tombe AU MILIEU d'un mot : le VAD travaille sur l'énergie, il ignore
// les mots — un « t » final ou une attaque coupée s'entend tout de suite. Chaque frontière est donc
// poussée à la limite du mot qu'elle traverse : vers l'extérieur si le mot est majoritairement gardé,
// vers l'intérieur sinon. Les mots viennent de l'ASR (secondes) → fonction PURE, testable sans runtime.
export function guardWords(segments: CutSegment[], words: VoiceWord[]): CutSegment[] {
  if (!segments.length || !words.length) return segments;
  const snapped = segments.map((seg) => {
    let { in: start, out: end } = seg;
    for (const w of words) {
      if (w.end <= start || w.start >= end) continue;      // hors segment
      if (w.start >= start && w.end <= end) continue;      // entièrement dedans
      const inside = Math.min(w.end, end) - Math.max(w.start, start);
      const keep = inside >= (w.end - w.start) * WORD_KEEP_RATIO;
      if (w.start < start) start = keep ? Math.min(w.start, start) : Math.max(w.end, start);
      else end = keep ? Math.max(w.end, end) : Math.min(w.start, end);
    }
    return { in: start, out: end };
  });
  return mergeSpans(snapped.filter((s) => s.out - s.in > 0.02), 0);
}

// Cut list finale d'un clip ANALYSÉ (accueil : rendu en lot, aucun état d'éditeur). Même chaîne que
// l'éditeur — parole Silero, moins les hésitations et les répétitions — pour que le rendu d'un lot
// donne exactement ce que l'éditeur montrerait. Rien n'est désélectionné ici (pas d'UI de tri).
export function analysisCutList(
  data: { words?: VoiceWord[]; speech?: VoiceSpan[]; silence?: VoiceSpan[]; fillers?: FillerSpan[]; duration?: number },
  hesitation: HesitationParams,
): CutSegment[] {
  const words = data.words || [];
  const base = data.speech?.length
    ? speechSegments(data.speech)
    : (data.duration ? [{ in: 0, out: data.duration }] : []);
  if (!base.length) return [];
  const removal = [
    ...combineFillerSpans(data.fillers || [], words, hesitation, data.silence || []),
    ...repetitionSpans(words),
  ];
  return guardWords(subtractSpans(base, removal), words);
}

export type CutType = "speech" | "silence" | "filler" | "repeat";
// Couleur de clip Resolve par type (palette officielle DaVinci) → relire/éditer les coupes à l'œil.
export const CUT_RESOLVE_COLOR: Record<CutType, string> = {
  speech: "Green", silence: "Navy", filler: "Orange", repeat: "Teal",
};
// Partitionne [0,dur] en segments NON CHEVAUCHANTS typés (priorité repeat>filler>silence>speech) →
// timeline DaVinci où chaque clip porte la couleur de son type. On garde TOUT le clip, juste découpé
// et coloré : on supprime/édite ensuite dans Resolve à l'œil.
export function buildColorPartition(
  dur: number,
  silences: { start: number; end: number }[],
  fillers: { start: number; end: number }[],
  repeats: { start: number; end: number }[],
): { in: number; out: number; type: CutType }[] {
  const typed = [
    ...silences.map((s) => ({ s: s.start, e: s.end, t: "silence" as CutType, p: 1 })),
    ...repeats.map((s) => ({ s: s.start, e: s.end, t: "repeat" as CutType, p: 2 })),
    ...fillers.map((s) => ({ s: s.start, e: s.end, t: "filler" as CutType, p: 3 })),
  ].filter((x) => x.e > x.s && x.s < dur);
  const bounds = new Set<number>([0, dur]);
  for (const x of typed) { bounds.add(Math.max(0, x.s)); bounds.add(Math.min(dur, x.e)); }
  const sorted = [...bounds].filter((b) => b >= 0 && b <= dur).sort((a, b) => a - b);
  const out: { in: number; out: number; type: CutType }[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (b - a < 0.02) continue;
    const mid = (a + b) / 2;
    let best: { t: CutType; p: number } | null = null;
    for (const x of typed) if (mid >= x.s && mid < x.e && (!best || x.p > best.p)) best = { t: x.t, p: x.p };
    const type: CutType = best ? best.t : "speech";
    const last = out[out.length - 1];
    if (last && last.type === type && Math.abs(last.out - a) < 0.001) last.out = b;
    else out.push({ in: a, out: b, type });
  }
  return out;
}
