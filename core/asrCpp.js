// @ts-check
// Moteur ASR natif transcribe.cpp (binaire `transcribe-cli`, modèles GGUF — Nemotron streaming, etc.).
// Le binaire est FOURNI par l'utilisateur (prébuild GitHub) — jamais compilé ici. Usage BATCH one-shot :
// résout le .gguf du modèle, convertit l'entrée en WAV 16 kHz mono (extractAudio), puis lance
//   transcribe-cli -m <gguf> -l <lang> -q --backend <cuda|vulkan|cpu> --batch <liste> --batch-jsonl
// et lit le JSONL ({file, text, segments?}). Un modèle « streaming » tourne ici en batch (chunking
// interne au modèle) → parfait pour la dictée push-to-talk (on transcrit le clip fini).

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { fsp, transcribeCli, TRANSCRIBE_BACKEND } = require('./config');
const ffmpeg = require('./ffmpeg');
const models = require('./models');
const { t } = require('./i18n');

/** Spawn simple qui collecte stdout/stderr. @returns {Promise<{code:number,out:string,err:string}>} */
function spawnText(bin, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, proc;
    const finish = (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }); } };
    try { proc = spawn(bin, args); }
    catch (e) { return resolve({ code: -1, out: '', err: String(e) }); }
    const t = setTimeout(() => { try { proc.kill(); } catch (_) {} }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { err += String(e); finish(-1); });
    proc.on('close', (code) => finish(code == null ? -1 : code));
  });
}

// Binaire disponible ? (spawn --help). @returns {Promise<{ok:boolean,bin:string,backend:string,error:string|null}>}
async function status() {
  const bin = transcribeCli();
  const r = await spawnText(bin, ['--help'], 8000);
  const ok = r.code === 0 || /usage|transcribe-cli|--model|--batch/i.test(r.out + r.err);
  return { ok, bin, backend: TRANSCRIBE_BACKEND, error: ok ? null : (r.err.trim().slice(-300) || 'binaire transcribe-cli introuvable') };
}

/** Transcrit un fichier audio via un modèle GGUF géré. @returns {Promise<{ok:boolean,text?:string,words?:any[],error?:string}>} */
async function transcribe({ input, modelId, lang = 'fr' }) {
  const gguf = models.findModelFile(modelId, '.gguf');
  if (!gguf) return { ok: false, error: `modèle GGUF introuvable pour ${modelId} — télécharge-le d'abord` };
  let wav;
  try { wav = await ffmpeg.extractAudio({ input }); } // WAV 16 kHz mono (exigence transcribe-cli)
  catch (e) { return { ok: false, error: 'conversion WAV : ' + String((e && e.stderr) || e) }; }
  const bin = transcribeCli();
  // Liste batch = un WAV par ligne → sortie JSONL structurée (pas de mode JSON mono-fichier).
  const listFile = path.join(os.tmpdir(), `nr-tcpp-${wav.length}-${gguf.length}.txt`);
  try { await fsp.writeFile(listFile, wav + '\n', 'utf8'); } catch (e) { return { ok: false, error: String(e) }; }
  const argsFor = (backend) => ['-m', gguf, '-l', lang, '-q', '--backend', backend, '--batch', listFile, '--batch-jsonl'];
  let r = await spawnText(bin, argsFor(TRANSCRIBE_BACKEND));
  // Un prébuild peut ne pas embarquer CUDA/Vulkan, ou le pilote peut refuser l'initialisation. La
  // transcription reste disponible : on retente le même modèle en CPU avant de remonter l'erreur.
  if (TRANSCRIBE_BACKEND !== 'cpu' && r.code !== 0) r = await spawnText(bin, argsFor('cpu'));
  try { await fsp.rm(listFile, { force: true }); } catch (_) {}
  if (r.code !== 0 && !r.out.trim()) {
    return { ok: false, error: `transcribe-cli a échoué : ${(r.err || '').trim().slice(-400) || 'code ' + r.code}` };
  }
  // Parse JSONL : garde la ligne portant `text` (ignore l'entête `batch_header`).
  let text = '';
  const words = [];
  for (const line of r.out.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let o; try { o = JSON.parse(s); } catch (_) { continue; }
    if (o.batch_header) continue;
    if (o.error) return { ok: false, error: String(o.error) };
    if (typeof o.text === 'string') {
      text = o.text.trim();
      for (const seg of (o.segments || [])) {
        for (const w of (seg.words || [])) {
          if (w && typeof w.word === 'string') words.push({ start: +w.start || 0, end: +w.end || 0, word: w.word, conf: +w.conf || 0 });
        }
      }
      break;
    }
  }
  if (!text) return { ok: false, error: t('asrEmpty') };
  return { ok: true, text, words };
}

module.exports = { transcribe, status };
