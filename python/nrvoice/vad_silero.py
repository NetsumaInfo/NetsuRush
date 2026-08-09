"""Backend VAD : Silero VAD v5 (ONNX, léger, CPU rapide) + affinage énergétique.

get_speech_timestamps renvoie les segments PARLÉS ; on en déduit le complément SILENCE sur
[0, durée]. Les 4 réglages correspondent à des paramètres de détection fine :
  threshold          seuil de détection (0..1)
  min_silence_ms     durée mini d'un silence pour le couper
  min_speech_ms      durée mini d'un segment parlé conservé
  pad_ms             marge ajoutée AVANT la parole conservée (attaques)

Trois affinages viennent APRÈS le modèle (Silero pose les frontières, l'énergie les corrige) :
  pad_end_ms   marge de fin distincte — on garde plus d'air après une phrase qu'avant (défaut = pad_ms)
  noise_gate   0..1 — écarte les COURTES régions dont l'énergie est très sous celle de la parole
               (clavier, clic de bouche, toux). 0 = désactivé. Limité aux régions < NOISE_MAX_SEC :
               une longue région faible reste de la parole douce, jamais du bruit.
  snap_ms      recale chaque frontière sur le creux d'énergie le plus proche (± snap_ms) → la coupe
               tombe dans le vrai silence, plus au milieu d'une attaque de mot (clics à la lecture).

Le modèle est embarqué dans le paquet pip silero-vad (offline) ; NETSURUSH_SILERO_DIR force un
dossier local.
"""
import sys

SR = 16000
FRAME = 160          # 10 ms d'enveloppe RMS : assez fin pour viser un creux, assez gros pour être stable
NOISE_MAX_SEC = 0.8  # au-delà, une région faible est de la parole douce — jamais écartée par le gate

_MODEL = None


def _emit(tag):
    sys.stderr.write(tag + "\n")
    sys.stderr.flush()


def _load():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    _emit("STAGE:load")
    from silero_vad import load_silero_vad
    _MODEL = load_silero_vad(onnx=True)
    return _MODEL


def _complement(speech, duration):
    """Silences = trous entre les segments parlés sur [0, durée]."""
    gaps = []
    cur = 0.0
    for sp in speech:
        if sp["start"] > cur + 1e-3:
            gaps.append({"start": cur, "end": sp["start"]})
        cur = max(cur, sp["end"])
    if duration > cur + 1e-3:
        gaps.append({"start": cur, "end": duration})
    return gaps


def _read_mono16k(audio_path):
    """WAV déjà extrait par le core → PCM float mono 16 kHz (rééchantillonnage de secours)."""
    import numpy as np
    import soundfile as sf
    data, sr = sf.read(audio_path, dtype="float32")
    if getattr(data, "ndim", 1) > 1:
        data = data[:, 0]
    if sr != SR:  # garde-fou : extractAudio sort du 16 kHz
        idx = (np.arange(int(len(data) * SR / sr)) * sr / SR).astype(np.int64)
        data = data[idx[idx < len(data)]]
    return np.ascontiguousarray(data)


def _rms_envelope(data):
    """Enveloppe RMS par trame de 10 ms (numpy vectorisé — jamais de boucle Python sur l'audio)."""
    import numpy as np
    n = len(data) // FRAME
    if n <= 0:
        return np.zeros(0, dtype="float32")
    frames = data[: n * FRAME].reshape(n, FRAME)
    return np.sqrt((frames.astype("float32") ** 2).mean(axis=1))


def _segment_rms(env, start, end):
    """Énergie moyenne d'une région [start,end] (secondes) lue dans l'enveloppe."""
    a = max(0, int(start * SR) // FRAME)
    b = min(len(env), max(a + 1, int(end * SR) // FRAME))
    if a >= len(env):
        return 0.0
    return float(env[a:b].mean())


def _drop_noise(speech, env, gate):
    """Écarte les COURTES régions trop faibles pour être de la voix (référence = médiane parole)."""
    import numpy as np
    if gate <= 0 or not speech:
        return speech
    energies = [_segment_rms(env, s["start"], s["end"]) for s in speech]
    ref = float(np.median([e for e in energies if e > 0] or [0.0]))
    if ref <= 0:
        return speech
    floor = ref * gate
    return [
        s for s, e in zip(speech, energies)
        if e >= floor or (s["end"] - s["start"]) >= NOISE_MAX_SEC
    ]


def _snap(t, env, radius_sec, duration):
    """Recale `t` sur le creux d'énergie le plus proche dans ±radius (frontière de coupe propre)."""
    if radius_sec <= 0 or not len(env):
        return t
    center = int(t * SR) // FRAME
    radius = max(1, int(radius_sec * SR) // FRAME)
    a = max(0, center - radius)
    b = min(len(env), center + radius + 1)
    if b <= a:
        return t
    best = a + int(env[a:b].argmin())
    return min(max(best * FRAME / SR, 0.0), duration)


def _pad_and_merge(speech, pad_start, pad_end, duration):
    """Marge asymétrique puis fusion des régions qui se touchent (l'ordre reste croissant)."""
    out = []
    for s in speech:
        start = max(0.0, s["start"] - pad_start)
        end = min(duration, s["end"] + pad_end)
        if end <= start:
            continue
        if out and start <= out[-1]["end"]:
            out[-1]["end"] = max(out[-1]["end"], end)
        else:
            out.append({"start": start, "end": end})
    return out


def detect_silences(audio_path, params=None):
    p = params or {}
    model = _load()
    from silero_vad import get_speech_timestamps
    import torch
    _emit("STAGE:infer")
    data = _read_mono16k(audio_path)
    duration = float(len(data)) / SR
    pad_start = max(0, int(p.get("pad_ms", 100))) / 1000.0
    pad_end = max(0, int(p.get("pad_end_ms", p.get("pad_ms", 100)))) / 1000.0
    snap_sec = max(0, int(p.get("snap_ms", 0))) / 1000.0
    gate = min(1.0, max(0.0, float(p.get("noise_gate", 0) or 0)))

    # Marge appliquée ICI (speech_pad_ms=0) : elle doit venir APRÈS le gate anti-bruit et le recalage,
    # sinon on padde du bruit puis on recale une frontière déjà noyée dans la marge.
    ts = get_speech_timestamps(
        torch.from_numpy(data), model,
        sampling_rate=SR,
        threshold=float(p.get("threshold", 0.5)),
        min_silence_duration_ms=int(p.get("min_silence_ms", 500)),
        min_speech_duration_ms=int(p.get("min_speech_ms", 100)),
        speech_pad_ms=0,
        return_seconds=True,
    )
    speech = [{"start": float(s["start"]), "end": float(s["end"])} for s in ts]

    if speech and (gate > 0 or snap_sec > 0):
        _emit("STAGE:refine")
        env = _rms_envelope(data)
        speech = _drop_noise(speech, env, gate)
        if snap_sec > 0:
            speech = [
                {"start": _snap(s["start"], env, snap_sec, duration),
                 "end": _snap(s["end"], env, snap_sec, duration)}
                for s in speech
            ]
            speech = [s for s in speech if s["end"] - s["start"] > 0.02]

    speech = _pad_and_merge(speech, pad_start, pad_end, duration)
    return {
        "speech": speech,
        "silence": _complement(speech, duration),
        "duration": duration,
    }
