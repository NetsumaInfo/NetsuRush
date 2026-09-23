"""WhisperX: Whisper + wav2vec2 forced alignment -> FRAME-ACCURATE word timestamps (SRT/VTT).
Untested scaffold, lazy import; returns the standard word contract {words,text,lang,duration}.
whisperx is BSD-2; pyannote diarization is gated and not used here. `lang=None` lets Whisper
detect the language, and the alignment model follows the detected one."""
import os

from nri18n import t

# Scripts written without spaces between words: the aligner splits them into characters, and a
# space join would print "こ ん に ち は".
UNSPACED_LANGS = frozenset(("ja", "zh", "th", "lo", "my", "km"))


def join_words(words, lang):
    """Transcript text from aligned word tokens, spaced only for languages that use spaces."""
    sep = "" if (lang or "").lower() in UNSPACED_LANGS else " "
    return sep.join(words).strip()


def transcribe_whisperx(audio_path, lang=None):
    try:
        import torch
        import whisperx  # type: ignore
    except Exception as exc:  # noqa: BLE001
        return {"words": [], "text": "", "lang": lang, "duration": 0.0,
                "error": t("whisperx_missing", error=exc)}
    device = "cuda" if os.environ.get("NETSURUSH_ML_BACKEND", "cpu").lower() == "cuda" and torch.cuda.is_available() else "cpu"
    compute = "float16" if device == "cuda" else "int8"
    try:
        model = whisperx.load_model("large-v3", device, language=lang, compute_type=compute)
        audio = whisperx.load_audio(audio_path)
        result = model.transcribe(audio, language=lang)
        spoken = result.get("language") or lang
        align_model, meta = whisperx.load_align_model(language_code=spoken, device=device)
        aligned = whisperx.align(result["segments"], align_model, meta, audio, device, return_char_alignments=False)
        words = []
        for seg in aligned.get("segments", []):
            for w in seg.get("words", []):
                words.append({
                    "start": float(w.get("start", 0.0) or 0.0),
                    "end": float(w.get("end", 0.0) or 0.0),
                    "word": w.get("word", ""),
                    "conf": float(w.get("score", 0.0) or 0.0),
                })
        text = join_words((x["word"] for x in words), spoken)
        return {"words": words, "text": text, "lang": spoken, "duration": float(len(audio)) / 16000.0}
    except Exception as exc:  # noqa: BLE001
        return {"words": [], "text": "", "lang": lang, "duration": 0.0,
                "error": t("engine_failed", engine="WhisperX", error=exc)}
