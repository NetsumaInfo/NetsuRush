"""Dispatch ASR : choisit le backend selon le modèle, renvoie des mots horodatés.

Contrat de retour (secondes) :
  {"words": [{"start", "end", "word", "conf"}], "text": str, "lang": str, "duration": float}

Modèles :
  whisper-turbo (défaut) / whisper-large-v3  -> faster-whisper (CTranslate2, GPU)
  parakeet-v3                                -> NVIDIA Parakeet TDT 0.6b v3 via onnx-asr
"""


def transcribe(audio_path, model="whisper-turbo", lang="fr", verbatim=False, model_dir=None):
    # `verbatim` (Whisper seulement) : amorce les hésitations pour qu'elles soient transcrites.
    # Les autres backends n'ont pas d'équivalent → ignoré.
    # `model_dir` : dossier local du modèle demandé, résolu par le core (le daemon est partagé entre
    # variantes, donc le chemin voyage PAR JOB et non par variable d'environnement).
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
