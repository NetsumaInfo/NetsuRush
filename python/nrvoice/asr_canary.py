"""NVIDIA Canary-1B-v2 (25 langues EU, CC-BY-4.0). SCAFFOLD non testé : import paresseux via NeMo.
Canary n'expose PAS de timestamps mot natifs → `words` vide + `text` rempli. Pour des sous-titres mot
il faut passer par WhisperX (alignement forcé). Utile pour la transcription multilingue brute."""


def transcribe_canary(audio_path, lang="fr"):
    try:
        from nemo.collections.asr.models import EncDecMultiTaskModel  # type: ignore
    except Exception as exc:  # noqa: BLE001
        return {"words": [], "text": "", "lang": lang, "duration": 0.0, "error": "canary/nemo indisponible : %s" % exc}
    try:
        model = EncDecMultiTaskModel.from_pretrained("nvidia/canary-1b-v2")
        out = model.transcribe([audio_path], source_lang=lang, target_lang=lang)
        first = out[0] if out else ""
        text = getattr(first, "text", first) if first is not None else ""
        return {"words": [], "text": str(text), "lang": lang, "duration": 0.0,
                "note": "Canary : transcription sans timestamps mot (utiliser WhisperX pour l'alignement)"}
    except Exception as exc:  # noqa: BLE001
        return {"words": [], "text": "", "lang": lang, "duration": 0.0, "error": "canary échec : %s" % exc}
