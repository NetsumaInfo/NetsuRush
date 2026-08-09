// @ts-check
// Dictée vocale (push-to-talk) : le renderer capture un court extrait micro (MediaRecorder), l'envoie
// en base64, le core l'écrit en fichier temporaire et le transcrit en RÉUTILISANT le daemon whisper
// chaud (core/voice.transcribe → sidecars.transcribeAudio). Renvoie le texte à insérer.
//
// SCAFFOLD v1 = PTT (parler puis relâcher → transcrire). Le vrai STREAMING faible latence (Kyutai
// en_fr / sherpa-onnx zipformer / Nemotron) est une amélioration future : garder le contrat {text}
// stable pour brancher un moteur streaming sans toucher au renderer.

const os = require('os');
const path = require('path');
const { fsp } = require('./config');
const voice = require('./voice');
const models = require('./models');
const asrCpp = require('./asrCpp');
const { t } = require('./i18n');

const NOOP_EVENT = { sender: { send: () => {} } };

// Whisper HALLUCINE sur du silence / un extrait vide (surtout le 1er clip) : il crache des artefacts de
// sous-titres YouTube (« Sous-titrage FR 2021 », « Merci d'avoir regardé », « ♪ »…). On les jette →
// texte vide (rien inséré) au lieu de polluer le champ.
const HALLUCINATIONS = [
  /sous-?titr(age|es)/i,
  /soustitreur\.com/i,
  /amara\.org/i,
  /réalis[ée]s? par/i,
  /merci d'avoir regardé/i,
  /abonnez-vous/i,
  /thanks? for watching/i,
  /^thank you\.?$/i,
];
function stripHallucination(text) {
  const t = (text || '').trim();
  if (!t) return '';
  if (/^[\s\p{P}\p{S}]+$/u.test(t)) return ''; // uniquement ponctuation/symboles (♪ ❤ …)
  return HALLUCINATIONS.some((re) => re.test(t)) ? '' : t;
}

/** @param {{ audioB64?: string, mime?: string, model?: string, lang?: string, idleMs?: number }} opts */
async function transcribeClip(opts) {
  const { audioB64, mime = 'audio/webm', model = 'whisper-turbo', lang = 'fr', idleMs } = opts || {};
  if (!audioB64) return { ok: false, error: t('audioMissing') };
  const ext = mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
  const dir = path.join(os.tmpdir(), 'netsurush-dictate');
  try { await fsp.mkdir(dir, { recursive: true }); } catch (_) {}
  const tmp = path.join(dir, `dic_${Date.now()}.${ext}`);
  try {
    await fsp.writeFile(tmp, Buffer.from(audioB64, 'base64'));
    // Moteur natif GGUF (transcribe.cpp) pour les modèles concernés ; sinon daemon whisper/parakeet.
    const engine = models.MANIFEST[model] && models.MANIFEST[model].engine;
    const r = engine === 'transcribe-cpp'
      ? await asrCpp.transcribe({ input: tmp, modelId: model, lang })
      : await voice.transcribe(NOOP_EVENT, { input: tmp, model, lang, idleMs });
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'transcription vide' };
    // r.text = transcript propre (espaces + ponctuation). Repli sur les mots joints par ESPACE (jamais
    // '' → sinon « motscollés »). Les tokens portant déjà une espace de tête sont normalisés ensuite.
    const fromWords = (r.words || []).map((/** @type {any} */ w) => w.word).join(' ');
    const text = stripHallucination((r.text || fromWords || '').replace(/\s+/g, ' ').trim());
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    try { await fsp.rm(tmp, { force: true }); } catch (_) {}
  }
}

// Statut du moteur natif transcribe.cpp (binaire présent ? backend ?) → carte UI des paramètres.
function cppStatus() { return asrCpp.status(); }

module.exports = { transcribeClip, cppStatus };
