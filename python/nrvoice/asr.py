"""ASR dispatch: picks the backend for the model, returns timestamped words.

Return contract (seconds):
  {"words": [{"start", "end", "word", "conf"}], "text": str, "lang": str|None, "duration": float}
  plus "error" when the backend could not run, and "note" for a limitation worth showing.

Models:
  whisper-turbo (default) / whisper-large-v3  -> faster-whisper (CTranslate2, GPU)
  parakeet-v3                                -> NVIDIA Parakeet TDT 0.6b v3 through onnx-asr
  whisperx                                   -> Whisper + wav2vec2 forced alignment
  canary-1b-v2                               -> NVIDIA Canary through NeMo

`lang` is the spoken language as an ISO 639-1 code, or None / "auto" to let the engine detect it.
Whisper and WhisperX detect it, Parakeet always detects it and ignores the code, Canary cannot.
"""


def normalize_lang(lang):
    """ISO 639-1 code ("zh-CN" -> "zh"), or None for auto-detection ("", "auto", None)."""
    code = str(lang or "").strip().lower().replace("_", "-").split("-", 1)[0]
    return None if code in ("", "auto") else code


def transcribe(audio_path, model="whisper-turbo", lang=None, verbatim=False, model_dir=None):
    # `verbatim` (Whisper only): primes the model so it writes hesitations out. The other backends
    # have no equivalent and ignore it.
    # `model_dir`: local folder of the requested model, resolved by the core (the daemon is shared
    # between variants, so the path travels PER JOB, not through an environment variable).
    lang = normalize_lang(lang)
    m = str(model)
    if m.startswith("parakeet"):
        from .asr_parakeet import transcribe_parakeet
        return transcribe_parakeet(audio_path, lang, model_dir=model_dir)
    if m == "whisperx":
        from .asr_whisperx import transcribe_whisperx
        return transcribe_whisperx(audio_path, lang)
    if m == "canary-1b-v2":
        from .asr_canary import transcribe_canary
        return transcribe_canary(audio_path, lang)
    from .asr_whisper import transcribe_whisper
    return transcribe_whisper(audio_path, m, lang, verbatim=verbatim, model_dir=model_dir)
