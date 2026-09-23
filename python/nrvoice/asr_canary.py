"""NVIDIA Canary-1B-v2 (25 European languages, CC-BY-4.0). Untested scaffold, lazy NeMo import.
Canary has NO native word timestamps: `words` stays empty and `text` is filled. Word-level
subtitles go through WhisperX (forced alignment). Canary needs the spoken language: it has no
language detection."""
from nri18n import t


def transcribe_canary(audio_path, lang=None):
    empty = {"words": [], "text": "", "lang": lang, "duration": 0.0}
    if not lang:
        return dict(empty, error=t("asr_lang_required", engine="Canary"))
    try:
        from nemo.collections.asr.models import EncDecMultiTaskModel  # type: ignore
    except Exception as exc:  # noqa: BLE001
        return dict(empty, error=t("canary_missing", error=exc))
    try:
        model = EncDecMultiTaskModel.from_pretrained("nvidia/canary-1b-v2")
        out = model.transcribe([audio_path], source_lang=lang, target_lang=lang)
        first = out[0] if out else ""
        text = getattr(first, "text", first) if first is not None else ""
        return dict(empty, text=str(text), note=t("canary_no_word_timestamps"))
    except Exception as exc:  # noqa: BLE001
        return dict(empty, error=t("engine_failed", engine="Canary", error=exc))
