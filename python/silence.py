#!/usr/bin/env python3
"""NetsuRush — sidecar VAD (détection de silences → suppression / découpe de la parole).

Silero VAD est léger (ONNX, ~50 Mo) → exécution one-shot (pas de daemon), avec cache SQLite indexé
sur la VIDÉO SOURCE (mtime). Le core extrait l'audio (WAV 16 kHz mono) en amont.

Commandes :
  python silence.py process <source> <audio_wav> [params_json]   -> silences/parole JSON

Sortie stdout = 1 ligne JSON :
  {"ok": bool, "speech": [{"start","end"}], "silence": [{"start","end"}], "duration": float,
   "model": str, "cached": bool, "error": null}
Progression sur stderr : STAGE:load / STAGE:infer
"""
import contextlib
import json
import sys
from nri18n import t


def _process(source, audio, params):
    from nrvoice import db
    from nrvoice.vad_silero import detect_silences, _complement, _emit

    model = "silero"
    # nova_confirm / nova_min_conf font partie de `params` → params_hash les couvre : le cache est
    # séparé automatiquement entre « Silero seul » et « Silero + confirmation NOVA ».
    phash = db.params_hash(params)
    cached = db.cache_get("silence", source, phash, model)
    if cached is not None:
        cached["cached"] = True
        cached["error"] = None
        return cached

    res = detect_silences(audio, params)
    speech = res.get("speech", [])
    duration = res.get("duration", 0.0)
    silence = res.get("silence", [])
    nova_status = None
    nova_dropped = 0
    # Passe de CONFIRMATION anti-bruit : Silero a posé les frontières, NOVA écarte les régions
    # parlées qui sont en réalité du bruit (toux/clavier) sur rush bruyant. Silence recalculé ensuite.
    if params.get("nova_confirm"):
        _emit("STAGE:nova")
        from nrvoice.vad_nova import confirm_regions
        nres = confirm_regions(audio, speech, min_conf=float(params.get("nova_min_conf", 0.6)))
        if nres.get("available"):
            speech = nres.get("speech", speech)
            silence = _complement(speech, duration)
            nova_status = "ok"
            nova_dropped = int(nres.get("dropped", 0))
        else:
            nova_status = "unavailable"

    out = {
        "ok": True,
        "speech": speech,
        "silence": silence,
        "duration": duration,
        "model": model,
        "nova": nova_status,
        "nova_dropped": nova_dropped,
        "cached": False,
        "error": None,
    }
    try:
        db.cache_store("silence", source, phash, model, out)
    except Exception:  # noqa: BLE001
        pass
    return out


def cmd_process(source, audio, params):
    try:
        return _process(source, audio, params)
    except ImportError as exc:
        return {"ok": False, "speech": [], "silence": [],
                "error": t("silero_missing", error=exc)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "speech": [], "silence": [], "error": str(exc)}


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "process"
    if cmd != "process":
        print(json.dumps({"ok": False, "error": t("unknown_command", detail="")}))
        return
    source = sys.argv[2] if len(sys.argv) > 2 else ""
    audio = sys.argv[3] if len(sys.argv) > 3 else source
    try:
        params = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
    except Exception:  # noqa: BLE001
        params = {}
    with contextlib.redirect_stdout(sys.stderr):  # aucun print parasite dans le JSON final
        res = cmd_process(source, audio, params)
    print(json.dumps(res))


if __name__ == "__main__":
    main()
