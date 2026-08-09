"""Backend ASR : NVIDIA Parakeet TDT 0.6b v3 via onnx-asr (ONNX, GPU, multilingue dont FR).

onnx-asr (MIT, Windows/CUDA) charge la version ONNX du modèle (istupakov/parakeet-tdt-0.6b-v3-onnx)
sans NeMo ni torch. `.with_timestamps()` ajoute des horodatages.

⚠️ Le format exact de TimestampedResult n'est pas figé entre versions d'onnx-asr → l'extraction
des mots est DÉFENSIVE (plusieurs formes gérées) et doit être validée au runtime sur GPU. Le
backend Whisper (asr_whisper) reste le défaut éprouvé ; Parakeet est l'option « rapide ».
"""
import os
import sys
from nrdevice import onnx_providers, onnx_session_options

_MODELS = {}
_REPO = "nemo-parakeet-tdt-0.6b-v3"


def _emit(tag):
    sys.stderr.write(tag + "\n")
    sys.stderr.flush()


def _providers():
    try:
        import onnxruntime as ort
        return onnx_providers(ort)
    except Exception:  # noqa: BLE001
        return ["CPUExecutionProvider"]


def _load(model_dir=None):
    if "parakeet-v3" in _MODELS:
        return _MODELS["parakeet-v3"]
    _emit("STAGE:load")
    import onnx_asr
    kwargs = {}
    prov = _providers()
    kwargs["providers"] = prov
    try:
        import onnxruntime as ort
        kwargs["sess_options"] = onnx_session_options(ort)
    except Exception:  # noqa: BLE001
        pass
    # Dossier fourni par le core (copie gérée par Paramètres › Modèles) puis chemin provisionné à
    # l'installation ; sinon onnx-asr télécharge le dépôt dans son propre cache.
    model_dir = model_dir or os.environ.get("NETSURUSH_PARAKEET_DIR")
    if model_dir:
        m = onnx_asr.load_model(_REPO, model_dir, **kwargs)
    else:
        m = onnx_asr.load_model(_REPO, **kwargs)
    m = m.with_timestamps()
    _MODELS["parakeet-v3"] = m
    return m


def _num(x):
    try:
        return float(x)
    except Exception:  # noqa: BLE001
        return None


def _group_subwords(tokens, starts):
    """Regroupe des sous-mots en mots. onnx-asr/Parakeet marque le DÉBUT d'un mot par un espace en
    tête (' B', ' ceci'…) ; SentencePiece utilise '▁'. La ponctuation et les sous-mots sans marqueur
    (« on », « jo », « ur » après « B ») s'attachent au mot courant. `starts` = début par token (s)."""
    words = []
    cur = None
    for tok, st in zip(tokens, starts):
        st = _num(st) or 0.0
        s = tok if isinstance(tok, str) else str(tok)
        boundary = cur is None or s.startswith(" ") or s.startswith("▁")
        piece = s.replace("▁", " ")
        if boundary:
            if cur and cur["word"].strip():
                words.append(cur)
            cur = {"start": st, "end": st, "word": piece.strip(), "conf": 1.0}
        else:
            cur["word"] += piece  # continuation de sous-mot / ponctuation collée
            cur["end"] = st
    if cur and cur["word"].strip():
        words.append(cur)
    for i in range(len(words) - 1):  # fin d'un mot ≈ début du suivant
        words[i]["end"] = words[i + 1]["start"]
    if words:
        words[-1]["end"] = max(words[-1]["end"], words[-1]["start"] + 0.3)
    for w in words:
        w["word"] = w["word"].strip()
    return [w for w in words if w["word"]]


def _extract_words(res):
    """Extraction tolérante : couvre les formes connues de TimestampedResult d'onnx-asr."""
    # Forme A : objet avec .tokens (list[str]) + .timestamps (list[float] début par token).
    tokens = getattr(res, "tokens", None)
    tss = getattr(res, "timestamps", None)
    if tokens is not None and tss is not None:
        first = tss[0] if len(tss) else None
        if isinstance(first, (list, tuple)):  # (start, end) par token → mots directs
            out = []
            for tok, pair in zip(tokens, tss):
                w = (tok if isinstance(tok, str) else str(tok)).replace("▁", " ").strip()
                if not w:
                    continue
                out.append({"start": _num(pair[0]) or 0.0, "end": _num(pair[-1]) or 0.0,
                            "word": w, "conf": 1.0})
            return out
        return _group_subwords(list(tokens), list(tss))
    # Forme B : itérable de dicts {word|token, start, end}.
    try:
        seq = list(res)
    except Exception:  # noqa: BLE001
        seq = []
    out = []
    for it in seq:
        if isinstance(it, dict):
            w = str(it.get("word") or it.get("token") or "").replace("▁", " ").strip()
            if not w:
                continue
            out.append({"start": _num(it.get("start")) or 0.0,
                        "end": _num(it.get("end") or it.get("start")) or 0.0,
                        "word": w, "conf": _num(it.get("conf")) or 1.0})
    return out


def _result_text(res, words):
    txt = getattr(res, "text", None)
    if isinstance(txt, str) and txt.strip():
        return txt.strip()
    if isinstance(res, str):
        return res.strip()
    return " ".join(w["word"] for w in words).strip()


def transcribe_parakeet(audio_path, lang="fr", model_dir=None):
    m = _load(model_dir)
    _emit("STAGE:infer")
    res = m.recognize(audio_path)
    words = _extract_words(res)
    return {
        "words": words,
        "text": _result_text(res, words),
        "lang": lang,
        "duration": (words[-1]["end"] if words else 0.0),
    }
