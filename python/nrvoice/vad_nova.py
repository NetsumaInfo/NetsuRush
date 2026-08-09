"""Backend VAD : NOVA-VAD (classifieur sklearn RandomForest + GradientBoosting, robuste au bruit).

NOVA-VAD (https://github.com/monishmal3375/nova-vad, MIT) N'EST PAS un segmenteur : c'est un
classifieur binaire parole/bruit sur fenêtre ~1 s (117 features acoustiques librosa). Inutilisable
pour poser des frontières fines. On l'emploie donc en COUCHE DE CONFIRMATION anti-bruit PAR-DESSUS
Silero : Silero segmente (frontières), NOVA re-classe chaque région parlée COURTE et écarte celles
que le modèle juge « pas de la voix » (toux, clavier, claquement) avec assez de confiance.

Modèles vendorés (git-ignorés, régénérables via setup.ps1) :
  NETSURUSH_NOVA_DIR/models/nova_vad_rf.pkl      RandomForest (obligatoire)
  NETSURUSH_NOVA_DIR/models/nova_vad_gbt.pkl     GradientBoosting (optionnel → ensemble si présent)
  NETSURUSH_NOVA_DIR/models/nova_vad_scaler.pkl  StandardScaler (obligatoire)
  NETSURUSH_NOVA_DIR/src/classifier.py           extract_features (features = modèle entraîné)

`src/` du dépôt n'a pas de vrai __init__.py (le fichier livré est `_init_.py`, typo amont) → `src`
est un NAMESPACE package Python 3 : `from src.classifier import extract_features` marche sans rien
importer d'autre (ni denoiser/torch, ni pyannote). extract_features prend un CHEMIN .wav (librosa
16 kHz interne) → on écrit chaque région dans un WAV temp avant de la classer.

Défaut hors config : <repo>/vendor/nova-vad. Si absent → available=False, régions inchangées
(Silero seul continue de marcher, comme OmniShotCut offline).

Le modèle est entraîné en 16 kHz (librosa.load(sr=16000)) → même SR que le WAV extrait par le core,
aucun rééchantillonnage.
"""
import os
import sys
import tempfile

_STATE = None  # {"scaler","rf","gbt","extract","speech_idx"} chargé paresseusement, ou False si indispo


def _emit(tag):
    sys.stderr.write(tag + "\n")
    sys.stderr.flush()


def _nova_dir():
    d = (os.environ.get("NETSURUSH_NOVA_DIR") or "").strip()
    if d:
        return d
    here = os.path.dirname(os.path.abspath(__file__))          # python/nrvoice
    repo = os.path.dirname(os.path.dirname(here))              # racine du dépôt
    return os.path.join(repo, "vendor", "nova-vad")


def _first_existing(base, names):
    for n in names:
        p = os.path.join(base, n)
        if os.path.exists(p):
            return p
    return None


def _load():
    """Charge une fois (scaler + rf [+ gbt] + fonction de features vendorée). False si indisponible."""
    global _STATE
    if _STATE is not None:
        return _STATE
    try:
        import joblib
        nova = _nova_dir()
        models = os.path.join(nova, "models")
        rf_path = _first_existing(models, ("nova_vad_rf.pkl", "rf.pkl"))
        sc_path = _first_existing(models, ("nova_vad_scaler.pkl", "scaler.pkl"))
        if not rf_path or not sc_path:
            raise FileNotFoundError("poids NOVA-VAD absents dans %s" % models)
        # Le dépôt vendoré fournit l'extraction EXACTE ayant servi à l'entraînement — la réimplémenter
        # décalerait les features et rendrait les prédictions fausses. On l'importe donc telle quelle.
        if nova not in sys.path:
            sys.path.insert(0, nova)
        from src.classifier import extract_features  # type: ignore  # noqa: E402
        rf = joblib.load(rf_path)
        scaler = joblib.load(sc_path)
        gbt_path = _first_existing(models, ("nova_vad_gbt.pkl", "gbt.pkl"))
        gbt = joblib.load(gbt_path) if gbt_path else None
        classes = list(getattr(rf, "classes_", [0, 1]))
        speech_idx = classes.index(1) if 1 in classes else (len(classes) - 1)
        _STATE = {"scaler": scaler, "rf": rf, "gbt": gbt, "extract": extract_features,
                  "speech_idx": speech_idx}
    except Exception as exc:  # noqa: BLE001 — indispo = dégradation gracieuse, jamais une erreur dure
        _emit("STAGE:nova-unavailable")
        sys.stderr.write("NOVA-VAD indisponible : %s\n" % exc)
        _STATE = False
    return _STATE


def _p_speech(state, feats):
    """Proba de parole (ensemble RF+GBT si dispo) pour un vecteur de features déjà extrait."""
    x = state["scaler"].transform([feats])
    idx = state["speech_idx"]
    proba = state["rf"].predict_proba(x)[0]
    if state["gbt"] is not None:
        proba = (proba + state["gbt"].predict_proba(x)[0]) / 2.0
    return float(proba[idx])


def confirm_regions(audio_path, speech, min_conf=0.6, long_keep_s=1.5, win_s=1.0):
    """Écarte les régions parlées que NOVA classe « pas de voix » avec confiance >= min_conf.

    speech = [{"start","end"}, ...] (secondes, sortie Silero). Renvoie :
      {"speech": régions conservées, "dropped": int, "available": bool, "error": str|None}

    Règles : région >= long_keep_s gardée d'office (parole triviale, on épargne le coût NOVA) ;
    fenêtre trop courte pour juger → gardée (rater de la vraie parole est pire que garder du bruit).
    """
    state = _load()
    if not state:
        return {"speech": speech, "dropped": 0, "available": False,
                "error": "NOVA-VAD indisponible (poids/deps manquants)"}
    try:
        import numpy as np
        import soundfile as sf
        data, sr = sf.read(audio_path, dtype="float32")
        if getattr(data, "ndim", 1) > 1:
            data = data[:, 0]
        if sr != 16000:
            idx = (np.arange(int(len(data) * 16000 / sr)) * sr / 16000).astype(np.int64)
            data = data[idx[idx < len(data)]]
        duration = float(len(data)) / 16000.0
        min_samples = int(0.2 * 16000)   # < 200 ms : trop court pour un verdict fiable → on garde
        half = win_s / 2.0
        kept = []
        dropped = 0
        # extract_features prend un CHEMIN .wav → on réécrit un WAV temp unique par région (écrasé).
        tmp_wav = os.path.join(tempfile.gettempdir(), "nr_nova_%d.wav" % os.getpid())
        try:
            for sp in speech:
                start = float(sp["start"])
                end = float(sp["end"])
                if end - start >= long_keep_s:
                    kept.append(sp)
                    continue
                center = (start + end) / 2.0
                a = max(0.0, center - half)
                b = min(duration, center + half)
                seg = data[int(a * 16000):int(b * 16000)]
                if len(seg) < min_samples:
                    kept.append(sp)
                    continue
                sf.write(tmp_wav, np.ascontiguousarray(seg), 16000, subtype="PCM_16")
                feats = state["extract"](tmp_wav)
                p_speech = _p_speech(state, feats)
                if (1.0 - p_speech) >= float(min_conf):
                    dropped += 1      # NOVA : « pas de voix » assez sûr → région écartée (silence)
                else:
                    kept.append(sp)
        finally:
            try:
                os.remove(tmp_wav)
            except OSError:
                pass
        return {"speech": kept, "dropped": dropped, "available": True, "error": None}
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("NOVA-VAD : passe échouée : %s\n" % exc)
        return {"speech": speech, "dropped": 0, "available": False, "error": str(exc)}
