"""Backend ASR : faster-whisper large-v3-turbo (CTranslate2, GPU CUDA, word timestamps).

API stable et éprouvée : WhisperModel(...).transcribe(audio, word_timestamps=True) →
segments dont chaque .words porte start/end/word/probability. Le modèle reste chargé
en VRAM (singleton) entre les appels du daemon. Offline : NETSURUSH_WHISPER_DIR pointe
un dossier de modèle CTranslate2 local (sinon téléchargé via le nom).
"""
import os
import sys

_MODELS = {}

# Nom NetsuRush → identifiant/répertoire faster-whisper.
_NAME = {
    "whisper-turbo": "large-v3-turbo",
    "whisper": "large-v3-turbo",
    "whisper-small": "small",
    "whisper-medium": "medium",
    "whisper-large-v3": "large-v3",
    "whisper-large-v3-turbo": "large-v3-turbo",
}


def _emit(tag):
    sys.stderr.write(tag + "\n")
    sys.stderr.flush()


def _add_nvidia_dlls():
    """Windows : rend les DLL cuDNN 9 / cuBLAS des paquets pip nvidia trouvables par ctranslate2
    (faster-whisper GPU). Sans ça, ctranslate2 ne charge pas cuDNN → bascule CPU."""
    try:
        import os
        import site
        roots = list(site.getsitepackages()) + [site.getusersitepackages()]
        for base in roots:
            for sub in ("cudnn", "cublas", "cuda_runtime", "cuda_nvrtc"):
                d = os.path.join(base, "nvidia", sub, "bin")
                if os.path.isdir(d):
                    try:
                        os.add_dll_directory(d)
                    except Exception:  # noqa: BLE001
                        pass
    except Exception:  # noqa: BLE001
        pass


def _make(model_path):
    from faster_whisper import WhisperModel
    compute = os.environ.get("NETSURUSH_WHISPER_COMPUTE", "float16")
    # CTranslate2 Windows accélère ce modèle via CUDA NVIDIA. ROCm/XPU/DirectML ne sont pas des
    # backends CTranslate2 interchangeables : ils utilisent donc le repli CPU int8 fiable.
    if os.environ.get("NETSURUSH_ML_BACKEND", "cpu").lower() == "cuda":
        _add_nvidia_dlls()
        try:
            return WhisperModel(model_path, device="cuda", compute_type=compute)
        except Exception:  # noqa: BLE001
            pass
    return WhisperModel(model_path, device="cpu", compute_type="int8")


def _resolve(model, model_dir=None):
    """Dossier local du modèle DEMANDÉ (fourni par le core), sinon nom faster-whisper (DL/cache HF).

    NETSURUSH_WHISPER_DIR ne vaut que pour la variante provisionnée à l'installation
    (NETSURUSH_WHISPER_ID, turbo par défaut) : l'appliquer à toute variante chargeait ce dossier
    en croyant charger « small » ou « large-v3 », donc silencieusement le mauvais modèle."""
    if model_dir:
        return model_dir
    env_dir = os.environ.get("NETSURUSH_WHISPER_DIR")
    provisioned = os.environ.get("NETSURUSH_WHISPER_ID") or "whisper-turbo"
    if env_dir and str(model) in (provisioned, "whisper"):
        return env_dir
    return _NAME.get(model, "large-v3-turbo")


def _load(model, model_dir=None):
    model_path = _resolve(model, model_dir)
    if model_path in _MODELS:
        return _MODELS[model_path]
    _emit("STAGE:load")
    m = _make(model_path)
    _MODELS[model_path] = m
    return m


# Amorces « verbatim » : un initial_prompt truffé d'hésitations conditionne Whisper à les ÉMETTRE au
# lieu de les gommer (entraîné rendu propre). condition_on_previous_text=True (défaut) propage le
# style sur tout le clip. Astuce éprouvée (communauté Whisper), zéro coût.
_VERBATIM_PROMPTS = {
    "fr": "Euh, donc euh... bah en fait, hum, je... je voulais dire euh, voilà quoi. Hmm.",
    "en": "Um, so uh... I mean, hmm, like, you know, uh... yeah. Erm.",
    "es": "Este... eh, o sea, em... pues eh, ¿no? Mmm.",
    "de": "Ähm, also äh... halt, hm, ich... ich meine äh. Tja.",
}


def detect_language_whisper(audio_path, model="whisper-turbo", model_dir=None):
    """Identifie la langue parlée d'un extrait audio (repli quand une piste n'a pas de tag lisible).
    faster-whisper >= 1.0 expose detect_language() (rapide, ne lit qu'un fragment) ; sinon on lance
    transcribe(language=None) qui remplit info.language sans consommer le générateur de segments.
    Renvoie {"lang": code ISO 639-1|None, "prob": float}."""
    m = _load(model, model_dir)
    _emit("STAGE:infer")
    try:
        lang, prob, _all = m.detect_language(audio_path)
        return {"lang": lang, "prob": float(prob or 0.0)}
    except Exception:  # noqa: BLE001 — API absente/ancienne → repli transcribe
        pass
    _segments, info = m.transcribe(audio_path, language=None, beam_size=1, without_timestamps=True)
    return {"lang": getattr(info, "language", None), "prob": float(getattr(info, "language_probability", 0.0) or 0.0)}


def transcribe_whisper(audio_path, model="whisper-turbo", lang="fr", verbatim=False, model_dir=None):
    m = _load(model, model_dir)
    _emit("STAGE:infer")
    prompt = _VERBATIM_PROMPTS.get(lang or "fr", _VERBATIM_PROMPTS["en"]) if verbatim else None
    segments, info = m.transcribe(
        audio_path,
        language=(lang or None),
        word_timestamps=True,
        vad_filter=False,  # le VAD est un module séparé (Silero) — pas de double-VAD ici
        beam_size=5,
        initial_prompt=prompt,
    )
    duration = float(getattr(info, "duration", 0) or 0)
    words = []
    text_parts = []
    last_pct = -1
    for seg in segments:  # générateur paresseux → progression au fil des segments
        text_parts.append(seg.text or "")
        for w in (seg.words or []):
            tok = (w.word or "").strip()
            if not tok:
                continue
            words.append({
                "start": float(w.start),
                "end": float(w.end),
                "word": tok,
                "conf": float(getattr(w, "probability", 0.0) or 0.0),
            })
        if duration:  # STAGE:prog:i/n → barre réelle (18..95 % côté sidecars.js)
            pct = int(min(seg.end, duration))
            if pct != last_pct:
                last_pct = pct
                _emit("STAGE:prog:%d/%d" % (pct, int(duration) or 1))
    return {
        "words": words,
        "text": "".join(text_parts).strip(),
        "lang": getattr(info, "language", lang) or lang,
        "duration": duration,
    }
