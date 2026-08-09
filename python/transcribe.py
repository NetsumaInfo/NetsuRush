#!/usr/bin/env python3
"""NetsuRush — sidecar ASR (transcription → sous-titres + montage par texte).

Le modèle (Whisper turbo ou Parakeet v3) reste chargé en VRAM entre les appels (daemon
`serve`, jobs sérialisés car GPU bloquant). Le core extrait l'audio (WAV 16 kHz mono) en
amont ; on transcrit ce WAV mais on indexe le cache sur la VIDÉO SOURCE (son mtime) pour
qu'il survive à la régénération du WAV temporaire.

Commandes :
  python transcribe.py process <source> <audio_wav> [model] [lang] [verbatim]  -> transcript JSON
  python transcribe.py serve                                          -> daemon JSON ligne-à-ligne

Sortie stdout = 1 ligne JSON :
  {"ok": bool, "words": [{"start","end","word","conf"}], "text": str, "lang": str,
   "duration": float, "model": str, "cached": bool, "error": null}
Progression sur stderr : STAGE:load / STAGE:infer / STAGE:prog:i/n
"""
import contextlib
import json
import sys
from nri18n import t


def _process(source, audio, model="whisper-turbo", lang="fr", verbatim=False, model_dir=None):
    from nrvoice import db
    from nrvoice.asr import transcribe

    model = model or "whisper-turbo"
    lang = lang or "fr"
    verbatim = bool(verbatim)
    # verbatim dans la clé de cache SEULEMENT si actif → les caches existants (non-verbatim) survivent.
    key = {"lang": lang, "verbatim": True} if verbatim else {"lang": lang}
    phash = db.params_hash(key)
    cached = db.cache_get("transcript", source, phash, model)
    if cached is not None:
        cached["cached"] = True
        cached["error"] = None
        return cached

    res = transcribe(audio, model, lang, verbatim=verbatim, model_dir=model_dir)
    out = {
        "ok": True,
        "words": res.get("words", []),
        "text": res.get("text", ""),
        "lang": res.get("lang", lang),
        "duration": res.get("duration", 0.0),
        "model": model,
        "cached": False,
        "error": None,
    }
    try:
        db.cache_store("transcript", source, phash, model, out)
    except Exception:  # noqa: BLE001 — cache best-effort, ne casse pas la transcription
        pass
    return out


def cmd_process(source, audio, model="whisper-turbo", lang="fr", verbatim=False, model_dir=None):
    try:
        return _process(source, audio, model, lang, verbatim, model_dir)
    except ImportError as exc:
        key = "parakeet_missing" if str(model).startswith("parakeet") else "whisper_missing"
        return {"ok": False, "words": [], "error": t(key, error=exc)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "words": [], "error": str(exc)}


def cmd_langid(source, audio, model="whisper-turbo", model_dir=None):
    """Identification de langue d'un extrait (repli ML du sélecteur de piste audio). Toujours whisper
    (Parakeet ne fait pas de language-id) ; source ignorée ici (pas de cache — extrait court, rare)."""
    try:
        from nrvoice.asr_whisper import detect_language_whisper

        m = model if str(model).startswith("whisper") else "whisper-turbo"
        r = detect_language_whisper(audio, m, model_dir=(model_dir if m == model else None))
        return {"ok": True, "lang": r.get("lang"), "prob": r.get("prob", 0.0), "error": None}
    except ImportError as exc:
        return {"ok": False, "lang": None, "error": t("whisper_missing", error=exc)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "lang": None, "error": str(exc)}


def serve():
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    real_out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        rid = req.get("id")
        with contextlib.redirect_stdout(sys.stderr):  # aucun print parasite dans le JSON
            if req.get("cmd") == "langid":
                res = cmd_langid(req.get("source", ""), req.get("audio", ""),
                                 req.get("model", "whisper-turbo"), req.get("model_dir") or None)
            else:
                res = cmd_process(req.get("source", ""), req.get("audio", ""),
                                  req.get("model", "whisper-turbo"), req.get("lang", "fr"),
                                  req.get("verbatim", False), req.get("model_dir") or None)
        real_out.write(json.dumps({"id": rid, "result": res}) + "\n")
        real_out.flush()


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "process"
    if cmd == "serve":
        serve()
        return
    if cmd == "langid":
        source = sys.argv[2] if len(sys.argv) > 2 else ""
        audio = sys.argv[3] if len(sys.argv) > 3 else source
        model = sys.argv[4] if len(sys.argv) > 4 else "whisper-turbo"
        with contextlib.redirect_stdout(sys.stderr):
            res = cmd_langid(source, audio, model)
        print(json.dumps(res))
        return
    source = sys.argv[2] if len(sys.argv) > 2 else ""
    audio = sys.argv[3] if len(sys.argv) > 3 else source
    model = sys.argv[4] if len(sys.argv) > 4 else "whisper-turbo"
    lang = sys.argv[5] if len(sys.argv) > 5 else "fr"
    verbatim = (sys.argv[6] if len(sys.argv) > 6 else "") in ("1", "true", "verbatim")
    with contextlib.redirect_stdout(sys.stderr):
        res = cmd_process(source, audio, model, lang, verbatim)
    print(json.dumps(res))


if __name__ == "__main__":
    main()
