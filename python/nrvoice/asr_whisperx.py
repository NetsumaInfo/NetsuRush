"""WhisperX : Whisper + alignement forcé wav2vec2 → timestamps mot FRAME-ACCURATE (idéal SRT/VTT).
SCAFFOLD non testé : import paresseux ; renvoie le contrat mot standard {words,text,lang,duration}.
Licence whisperx = BSD-2 ; la diarisation pyannote est gated (non utilisée ici)."""
import os


def transcribe_whisperx(audio_path, lang="fr"):
    try:
        import torch
        import whisperx  # type: ignore
    except Exception as exc:  # noqa: BLE001
        return {"words": [], "text": "", "lang": lang, "duration": 0.0, "error": "whisperx indisponible : %s" % exc}
    device = "cuda" if os.environ.get("NETSURUSH_ML_BACKEND", "cpu").lower() == "cuda" and torch.cuda.is_available() else "cpu"
    compute = "float16" if device == "cuda" else "int8"
    try:
        model = whisperx.load_model("large-v3", device, language=lang, compute_type=compute)
        audio = whisperx.load_audio(audio_path)
        result = model.transcribe(audio, language=lang)
        align_model, meta = whisperx.load_align_model(language_code=lang, device=device)
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
        text = " ".join(x["word"] for x in words).strip()
        return {"words": words, "text": text, "lang": lang, "duration": float(len(audio)) / 16000.0}
    except Exception as exc:  # noqa: BLE001
        return {"words": [], "text": "", "lang": lang, "duration": 0.0, "error": "whisperx échec : %s" % exc}
