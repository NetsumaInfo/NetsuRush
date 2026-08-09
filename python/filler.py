#!/usr/bin/env python3
"""NetsuRush — sidecar détection ACOUSTIQUE des hésitations (librosa, one-shot, même patron que silence.py).

Le core extrait l'audio (WAV 16 kHz mono) et fournit les mots ASR + silences Silero (les fenêtres
analysées dépendent d'eux). Cache indexé sur la vidéo SOURCE + (seuils + bornes des mots).

Commande :
  python filler.py process <source> <audio_wav> <payload_json>
  payload_json = {"words":[{start,end,word,conf}], "silences":[{start,end}], "params":{...}}

Sortie stdout = 1 ligne JSON : {"ok", "fillers":[{start,end,conf}], "duration", "cached", "error"}
Progression stderr : STAGE:load / STAGE:infer
"""
import contextlib
import json
import sys
from nri18n import t


def _process(source, audio, payload):
    from nrvoice import db
    from nrvoice.acoustic_filler import detect_fillers

    words = payload.get("words") or []
    silences = payload.get("silences") or []
    params = payload.get("params") or {}
    model = "acoustic"
    # clé de cache : seuils + bornes des mots (les gaps en dépendent → re-transcribe invalide le cache)
    wb = [(round(w.get("start", 0.0), 2), round(w.get("end", 0.0), 2)) for w in words]
    phash = db.params_hash({"params": params, "wb": wb})
    cached = db.cache_get("filler", source, phash, model)
    if cached is not None:
        cached["cached"] = True
        cached["error"] = None
        return cached

    res = detect_fillers(audio, words, silences, params)
    out = {
        "ok": True,
        "fillers": res.get("fillers", []),
        "duration": res.get("duration", 0.0),
        "cached": False,
        "error": None,
    }
    try:
        db.cache_store("filler", source, phash, model, out)
    except Exception:  # noqa: BLE001
        pass
    return out


def cmd_process(source, audio, payload):
    try:
        return _process(source, audio, payload)
    except ImportError as exc:
        return {"ok": False, "fillers": [], "error": t("librosa_missing", error=exc)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "fillers": [], "error": str(exc)}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "process"
    if cmd != "process":
        print(json.dumps({"ok": False, "error": t("unknown_command", detail="")}))
        return
    source = sys.argv[2] if len(sys.argv) > 2 else ""
    audio = sys.argv[3] if len(sys.argv) > 3 else source
    try:
        payload = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
    except Exception:  # noqa: BLE001
        payload = {}
    with contextlib.redirect_stdout(sys.stderr):  # aucun print parasite dans le JSON
        res = cmd_process(source, audio, payload)
    print(json.dumps(res))


if __name__ == "__main__":
    main()
