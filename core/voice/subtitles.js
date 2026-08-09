// @ts-check
// Génération de sous-titres SRT/VTT depuis les mots horodatés. Groupage en lignes (≤ N caractères,
// ≤ durée, coupé sur les grands silences) et RECALAGE temporel optionnel : si une cut list est
// fournie (silences/mots retirés), les timestamps sont remis dans le temps du montage FINAL
// (new_t = cumul des segments conservés avant t ; mot tombant dans un trou retiré → supprimé).

const path = require('path');
const os = require('os');
const { fsp } = require('../config');
const { t } = require('../i18n');

// Map temps source → temps de sortie selon les segments CONSERVÉS (triés, secondes).
// Renvoie null pour `t` situé dans un trou (passage retiré) → le mot est ignoré.
function makeMapper(segments) {
  if (!segments || !segments.length) return (t) => t; // pas de coupe → identité
  const sorted = [...segments].filter((s) => s.out > s.in).sort((a, b) => a.in - b.in);
  let acc = 0;
  const ranges = sorted.map((s) => { const r = { in: s.in, out: s.out, off: acc }; acc += s.out - s.in; return r; });
  return (t) => {
    for (const r of ranges) {
      if (t >= r.in && t <= r.out) return r.off + (t - r.in);
    }
    return null; // dans un trou (silence/mot retiré)
  };
}

// Regroupe les mots (déjà dans le temps de sortie) en lignes lisibles.
function groupLines(words, { maxChars = 42, maxDur = 6, maxGap = 0.8 } = {}) {
  const lines = [];
  let cur = null;
  for (const w of words) {
    if (!cur) { cur = { start: w.start, end: w.end, text: w.word }; continue; }
    const next = `${cur.text} ${w.word}`;
    const tooLong = next.length > maxChars;
    const tooLongDur = w.end - cur.start > maxDur;
    const bigGap = w.start - cur.end > maxGap;
    if (tooLong || tooLongDur || bigGap) { lines.push(cur); cur = { start: w.start, end: w.end, text: w.word }; }
    else { cur.text = next; cur.end = w.end; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function stamp(t, sep) {
  if (t < 0) t = 0;
  // Arrondi en millisecondes ENTIÈRES puis report : 999,6 ms ne doit pas donner « ,1000 » (cue invalide).
  let total = Math.round(t * 1000);
  const ms = total % 1000;
  total = (total - ms) / 1000;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

function toSrt(lines) {
  return lines.map((l, i) =>
    `${i + 1}\n${stamp(l.start, ',')} --> ${stamp(l.end, ',')}\n${l.text}\n`).join('\n');
}
function toVtt(lines) {
  return `WEBVTT\n\n${lines.map((l) =>
    `${stamp(l.start, '.')} --> ${stamp(l.end, '.')}\n${l.text}`).join('\n\n')}\n`;
}

// Construit la chaîne de sous-titres. `segments` (optionnel) = cut list conservée → recalage.
function buildSubtitles(words, segments, format = 'srt', opts = {}) {
  const map = makeMapper(segments);
  const mapped = [];
  for (const w of (words || [])) {
    if (w.filler && opts.dropFillers) continue;
    const s = map(w.start);
    const e = map(w.end);
    if (s == null || e == null || e <= s) continue; // mot dans un trou retiré
    const word = String(w.word || '').trim();
    if (word) mapped.push({ start: s, end: e, word });
  }
  const lines = groupLines(mapped, opts);
  // Garde-fou anti-chevauchement : une ligne ne démarre jamais avant la fin de la précédente.
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].start < lines[i - 1].end) lines[i].start = lines[i - 1].end;
    if (lines[i].end < lines[i].start) lines[i].end = lines[i].start + 0.3;
  }
  return (format === 'vtt' ? toVtt : toSrt)(lines);
}

// Écrit le fichier de sous-titres. destPath optionnel : sinon un tmp horodaté.
/** @param {{ words?: any[], segments?: {in:number,out:number}[], format?: string, destPath?: string, maxChars?: number, maxDur?: number, dropFillers?: boolean, baseName?: string }} opts */
async function exportSubtitles(opts = {}) {
  const { words = [], segments, format = 'srt', destPath, maxChars, maxDur, dropFillers, baseName } = opts || {};
  if (!words.length) return { ok: false, error: t('noSubtitleWords') };
  const text = buildSubtitles(words, segments, format, { maxChars, maxDur, dropFillers });
  const out = destPath || path.join(os.tmpdir(), `${(baseName || 'netsurush')}-${format}.${format}`);
  try {
    await fsp.writeFile(out, text, 'utf8');
    // Nb de cues = occurrences de « --> » (exact pour SRT comme VTT, dont l'en-tête WEBVTT n'en a pas).
    return { ok: true, path: out, lines: (text.match(/-->/g) || []).length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { buildSubtitles, exportSubtitles, makeMapper, groupLines };
