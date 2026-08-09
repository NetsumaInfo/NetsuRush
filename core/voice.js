// @ts-check
// Orchestrateur du module voix (façon aeExport) : extrait l'audio puis lance les sidecars
// (transcription ASR, détection de silences). Le décodage audio reste côté ffmpeg (jamais en JS) ;
// la frame-math (sec → frames) vit dans core/wordTimeline + core/timeline. Progression en SSE
// `voice:progress` émise par les sidecars.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ffmpeg = require('./ffmpeg');
const sidecars = require('./sidecars');
const subtitles = require('./voice/subtitles');
const { buildFcpxml, fpsRational } = require('./fcpxml');
const { fsp } = require('./config');
const { t } = require('./i18n');

// Transcription d'un clip (Media Pool ou fichier local). `input` = chemin vidéo source.
// model = whisper-turbo (défaut, précis) | parakeet-v3 (rapide). lang = langue ASR (défaut fr).
// verbatim = amorce Whisper pour ÉMETTRE les hésitations (euh/hum) au lieu de les gommer.
/** @param {any} event @param {{ input?: string, model?: string, lang?: string, track?: number, idleMs?: number, verbatim?: boolean }} [opts] */
async function transcribe(event, opts = {}) {
  const { input, model = 'whisper-turbo', lang = 'fr', track = 0, idleMs, verbatim = false } = opts || {};
  if (!input) return { ok: false, words: [], error: t('sourceMissing') };
  let audio;
  try {
    audio = await ffmpeg.extractAudio({ input, track });
  } catch (e) {
    return { ok: false, words: [], error: t('audioExtractFailed') + ' : ' + String((e && e.stderr) || e) };
  }
  const res = await sidecars.transcribeAudio(event, { source: input, audio, model, lang, idleMs, verbatim });
  return res || { ok: false, words: [], error: t('transcriptEmpty') };
}

// Détection de silences (Silero VAD). `input` = vidéo source ; `params` = { threshold, min_silence_ms,
// min_speech_ms, pad_ms }. Renvoie { ok, speech[], silence[], duration }.
/** @param {any} event @param {{ input?: string, params?: object, track?: number }} [opts] */
async function detectSilences(event, opts = {}) {
  const { input, params = {}, track = 0 } = opts || {};
  if (!input) return { ok: false, speech: [], silence: [], error: t('sourceMissing') };
  let audio;
  try {
    audio = await ffmpeg.extractAudio({ input, track });
  } catch (e) {
    return { ok: false, speech: [], silence: [], error: t('audioExtractFailed') + ' : ' + String((e && e.stderr) || e) };
  }
  const res = await sidecars.runSilence(event, input, audio, params);
  return res || { ok: false, speech: [], silence: [], error: t('silenceEmpty') };
}

// Détection ACOUSTIQUE des hésitations (librosa) sur les trous inter-mots + mots low-conf.
// `words`/`silences` viennent de l'ASR + Silero (le renderer les a déjà) → analyse ciblée.
/** @param {any} event @param {{ input?: string, words?: any[], silences?: any[], params?: object, track?: number }} [opts] */
async function detectFillers(event, opts = {}) {
  const { input, words = [], silences = [], params = {}, track = 0 } = opts || {};
  if (!input) return { ok: false, fillers: [], error: t('sourceMissing') };
  let audio;
  try {
    audio = await ffmpeg.extractAudio({ input, track });
  } catch (e) {
    return { ok: false, fillers: [], error: t('audioExtractFailed') + ' : ' + String((e && e.stderr) || e) };
  }
  const res = await sidecars.runFiller(event, input, audio, { words, silences, params });
  return res || { ok: false, fillers: [], error: t('fillerEmpty') };
}

// Enveloppe d'amplitude (peaks) pour la waveform : extrait l'audio (WAV 16 kHz mono PCM s16le) et
// réduit en `buckets` pics (max |amplitude| par tranche, normalisé 0..1). Lecture du WAV en core
// (jamais de décodage audio en JS : le WAV est déjà du PCM brut, on ne fait que le sous-échantillonner).
// `startSec`/`endSec` = fenêtre optionnelle : le zoom de l'éditeur redemande des pics haute résolution
// sur la plage visible (sinon un rush d'1 h = plusieurs secondes par bucket, zoom inutile).
/** @param {{ input?: string, track?: number, buckets?: number, startSec?: number, endSec?: number }} [opts] */
async function waveform(opts = {}) {
  const { input, track = 0, buckets = 1200, startSec = 0, endSec = 0 } = opts || {};
  if (!input) return { ok: false, error: t('sourceMissing') };
  let audio;
  try {
    audio = await ffmpeg.extractAudio({ input, track });
  } catch (e) {
    return { ok: false, error: t('audioExtractFailed') + ' : ' + String((e && e.stderr) || e) };
  }
  try {
    const buf = await fsp.readFile(audio);
    const di = buf.indexOf('data'); // début du chunk PCM (après l'en-tête RIFF)
    const off = di >= 0 ? di + 8 : 44;
    const samples = Math.max(0, (buf.length - off) >> 1);
    const s0 = Math.max(0, Math.min(samples, Math.floor(startSec * 16000)));
    const s1 = endSec > startSec ? Math.max(s0 + 1, Math.min(samples, Math.ceil(endSec * 16000))) : samples;
    const n = Math.max(1, buckets | 0);
    const per = Math.max(1, Math.floor((s1 - s0) / n));
    const peaks = new Array(n).fill(0);
    for (let b = 0; b < n; b++) {
      let max = 0;
      const start = off + (s0 + b * per) * 2;
      for (let i = 0; i < per; i++) {
        const p = start + i * 2;
        if (p + 1 >= buf.length) break;
        const v = Math.abs(buf.readInt16LE(p));
        if (v > max) max = v;
      }
      peaks[b] = max / 32768;
    }
    return { ok: true, peaks, duration: samples / 16000, start: s0 / 16000, end: s1 / 16000 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Export d'un fichier monté (silences coupés) : MP4 réencodé (ffmpeg trim+concat) ou FCPXML
// (timecode source préservé pour DaVinci/Premiere). `segments` = [{in,out}] (secondes) à CONSERVER.
/** @param {{ input?: string, segments?: {in:number,out:number}[], format?: string, destPath?: string, fps?: number }} opts */
async function exportCut(opts = {}) {
  const { input, segments = [], format = 'mp4', destPath } = opts || {};
  if (!input) return { ok: false, error: t('sourceMissing') };
  if (!segments.length) return { ok: false, error: t('noSegments') };
  const out = destPath || input.replace(/\.[^.]+$/, ` — sans silences.${format}`);

  if (format === 'fcpxml') {
    try {
      let fps = Number(opts.fps) || 0;
      let w = 0, h = 0;
      try { const pi = await ffmpeg.playInfo(input); if (!fps) fps = pi.fps || 0; } catch (_) {}
      try { const pm = await ffmpeg.probeMedia(input); w = pm.width || 0; h = pm.height || 0; } catch (_) {}
      if (!fps) fps = 24;
      let prev = -1;
      const shots = segments.map((s) => {
        let sf = Math.max(0, Math.round(s.in * fps));
        if (sf <= prev) sf = prev + 1;
        const frames = Math.max(1, Math.round((s.out - s.in) * fps));
        prev = sf + frames - 1;
        return { startFrame: sf, frames };
      });
      const totalFrames = shots.reduce((a, c) => Math.max(a, c.startFrame + c.frames), 0);
      const name = require('path').basename(out).replace(/\.[^.]+$/, '');
      const xml = buildFcpxml({
        projectName: name, eventName: 'NetsuRush',
        clips: [{ src: pathToFileURL(input).href, name, fps: fpsRational(fps), totalFrames, w, h, shots }],
      });
      await fsp.writeFile(out, xml, 'utf8');
      return { ok: true, path: out, clips: shots.length };
    } catch (e) {
      return { ok: false, error: 'FCPXML : ' + String((e && e.message) || e) };
    }
  }

  // MP4 : trim+concat réencodé (libx264 + AAC, faststart). Un seul réencodage propre (≠ -c copy qui
  // drift sur les keyframes). Filtre vidéo+audio par segment puis concat.
  try {
    const parts = [];
    const labels = [];
    segments.forEach((s, i) => {
      parts.push(`[0:v]trim=${s.in}:${s.out},setpts=PTS-STARTPTS[v${i}]`);
      parts.push(`[0:a]atrim=${s.in}:${s.out},asetpts=PTS-STARTPTS[a${i}]`);
      labels.push(`[v${i}][a${i}]`);
    });
    const filter = `${parts.join(';')};${labels.join('')}concat=n=${segments.length}:v=1:a=1[outv][outa]`;
    await ffmpeg.run('ffmpeg', [
      '-y', '-i', input, '-filter_complex', filter, '-map', '[outv]', '-map', '[outa]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out,
    ]);
    return { ok: true, path: out, clips: segments.length };
  } catch (e) {
    return { ok: false, error: 'MP4 : ' + String((e && e.stderr) || e) };
  }
}

// --- Recherche dans les transcriptions EN CACHE ---------------------
// Lit la base SQLite du sidecar python (~/.netsurush/netsurush.db, table transcript_cache_v1) en
// lecture seule : aucune transcription n'est lancée ici. Pour chaque fichier déjà transcrit, cherche
// la séquence de mots de la requête et renvoie des hits AU MOT EXACT (start du 1er mot = in-point).
// Repli propre { ok:false } si base/table absente ou node:sqlite indisponible.

function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function normWord(s) {
  return stripAccents(s).replace(/[^a-z0-9]+/g, '');
}

/** @param {{ query?: string, limit?: number, perFile?: number }} [opts] */
async function searchTranscripts(opts = {}) {
  const { query = '', limit = 60, perFile = 8 } = opts || {};
  const qWords = String(query).split(/\s+/).map(normWord).filter(Boolean);
  if (!qWords.length) return { ok: true, hits: [], files: 0 };
  const dbPath = path.join(os.homedir(), '.netsurush', 'netsurush.db');
  if (!fs.existsSync(dbPath)) return { ok: false, hits: [], files: 0, error: t('noTranscriptCache') };
  let rows;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      rows = db
        .prepare('SELECT file_path, model, result_json, created_at FROM transcript_cache_v1 ORDER BY created_at DESC')
        .all();
    } finally {
      try { db.close(); } catch (_) {}
    }
  } catch (e) {
    return { ok: false, hits: [], files: 0, error: String((e && e.message) || e) };
  }
  const seen = new Set(); // dernière transcription par fichier (tous modèles/params confondus)
  const hits = [];
  let files = 0;
  for (const r of rows) {
    const file = String(r.file_path || '');
    if (!file || seen.has(file)) continue;
    seen.add(file);
    let res = null;
    try { res = JSON.parse(String(r.result_json || 'null')); } catch (_) {}
    const words = res && Array.isArray(res.words) ? res.words : [];
    if (!words.length) continue;
    files++;
    let fileHits = 0;
    for (let i = 0; i < words.length && fileHits < perFile && hits.length < limit; i++) {
      let j = 0;
      while (j < qWords.length && i + j < words.length && normWord(words[i + j].word) === qWords[j]) j++;
      if (j < qWords.length) continue;
      const last = words[i + qWords.length - 1];
      const ctxIn = Math.max(0, i - 4);
      const ctxOut = Math.min(words.length, i + qWords.length + 4);
      hits.push({
        file,
        start: Number(words[i].start) || 0,
        end: Number(last.end) || 0,
        snippet: words.slice(ctxIn, ctxOut).map((w) => w.word).join(' ').trim(),
        matchStart: i - ctxIn,
        matchLen: qWords.length,
        duration: Number(res.duration) || 0,
        model: String(r.model || ''),
      });
      fileHits++;
      i += qWords.length - 1;
    }
    if (hits.length >= limit) break;
  }
  return { ok: true, hits, files };
}

module.exports = { transcribe, detectSilences, detectFillers, waveform, exportCut, searchTranscripts, exportSubtitles: subtitles.exportSubtitles };
