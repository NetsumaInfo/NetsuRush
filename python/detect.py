#!/usr/bin/env python3
"""NetsuRush — détection de plans multi-moteur + cache SQLite.

Modèles au choix :
  - transnetv2  (défaut) : rapide, poids inclus (package transnetv2-pytorch).
  - omnishotcut          : transitions et labels détaillés, GPU (UVA Computer Vision Lab).
  - autoshot             : architecture officielle AutoShot, checkpoint téléchargeable dans l’app.

Commandes :
  python detect.py detect <video> [threshold] [model] [options_json] -> détecte et met en cache
  python detect.py get    <video> [model] [threshold] [options_json] -> lit le cache SQLite
  python detect.py serve                                 -> daemon JSON ligne-à-ligne (stdin → stdout),
                                                            modèles gardés chauds entre les jobs

Progression (stderr) : PROGRESS:<pct> sur une échelle ABSOLUE MONOTONE 0..100 par job
(load 2..5, extraction 5..55, inférence 55..98). Les marqueurs STAGE:* ne portent que la
phase (libellé), jamais un pourcentage.

Sortie stdout = 1 ligne JSON :
  {"scenes":[{"start":s,"end":s,"startFrame":f,"endFrame":f(inclusif)}],
   "fps":f,"duration":s,"frames":n,"threshold":t,"model":m,"cached":bool,"error":null}
"""
import contextlib
import hashlib
import json
import os
import sqlite3
import sys
import threading
import time

from ffbin import ffmpeg_bin, ffprobe_bin


_last_pct = -1


def _reset_progress():
    global _last_pct
    _last_pct = -1


def _progress(pct):
    """Émet PROGRESS:<pct> sur stderr, MONOTONE par job (jamais de retour en arrière)."""
    global _last_pct
    pct = int(pct)
    if pct <= _last_pct:
        return False
    _last_pct = pct
    sys.stderr.write("PROGRESS:%d\n" % pct); sys.stderr.flush()
    return True


@contextlib.contextmanager
def _heartbeat(interval=20.0, estimate=None):
    """Bat sur stderr toutes les `interval` s. OmniShotCut lit TOUTE la vidéo en RAM (decord) AVANT
    d'émettre sa 1re progression → ~70 s muets sur 24 min, plus sous contention. Le core a un watchdog
    d'INACTIVITÉ (tue un process sans sortie) → sans ce battement, plusieurs détections EN PARALLÈLE
    (dont les lectures se chevauchent et s'allongent) déclenchaient « délai dépassé ». Le battement
    nourrit le watchdog pendant la phase muette ; un process réellement bloqué cesse TOUT (thread
    compris) → le watchdog le rattrape quand même.

    `estimate=(base, span, expected_s)` : en plus du battement, émet une progression
    ESTIMÉE temps-based (base..base+span, plafonnée) — OmniShotCut n'émet aucune
    progression pendant `inference`, sans ça la barre reste figée plusieurs minutes."""
    stop = threading.Event()
    t0 = time.time()

    def beat():
        while not stop.wait(interval):
            try:
                if estimate:
                    base, span, expected = estimate
                    ratio = min(1.0, (time.time() - t0) / max(1.0, expected))
                    # Once the estimate reaches its cap (95%), _progress() quite
                    # deliberately stops emitting monotone values. Keep emitting a
                    # liveness marker nevertheless: a slow GPU inference must not
                    # look like a dead process to the core watchdog.
                    if not _progress(base + span * ratio):
                        sys.stderr.write("HEARTBEAT\n"); sys.stderr.flush()
                else:
                    sys.stderr.write("HEARTBEAT\n"); sys.stderr.flush()
            except Exception:  # noqa: BLE001
                break

    t = threading.Thread(target=beat, daemon=True)
    t.start()
    try:
        yield
    finally:
        stop.set()


def db_path():
    d = os.path.join(os.path.expanduser("~"), ".netsurush")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "netsurush.db")


def db():
    con = sqlite3.connect(db_path(), timeout=30.0)
    # Même base que les embeddings → WAL + busy_timeout pour l'indexation parallèle (plusieurs daemons
    # qui détectent/écrivent le cache de scènes en même temps ne s'échouent plus sur « database is locked »).
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA busy_timeout=30000")
        con.execute("PRAGMA synchronous=NORMAL")
    except Exception:  # noqa: BLE001
        pass
    con.execute(
        """CREATE TABLE IF NOT EXISTS scene_cache_v3(
            file_path TEXT, mtime REAL, threshold REAL, fps REAL, duration REAL,
            frames INTEGER, scenes_json TEXT, model TEXT, created_at REAL,
            PRIMARY KEY(file_path, threshold, model))"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS scene_cache_v4(
            file_path TEXT, mtime REAL, options_key TEXT, threshold REAL, fps REAL,
            duration REAL, frames INTEGER, scenes_json TEXT, model TEXT, options_json TEXT,
            created_at REAL, PRIMARY KEY(file_path, model, options_key))"""
    )
    return con


def file_mtime(p):
    try:
        return os.path.getmtime(p)
    except OSError:
        return 0.0


def _canonical_options(model, threshold, options=None):
    raw = options if isinstance(options, dict) else {}
    min_frames = max(1, min(300, int(raw.get("minSceneFrames", 2) if raw.get("minSceneFrames") is not None else 2)))
    out = {"minSceneFrames": min_frames}
    if model == "omnishotcut":
        omni = raw.get("omnishotcut") if isinstance(raw.get("omnishotcut"), dict) else {}
        all_intra = ["General", "Dissolve", "Wipes", "Push", "Slide", "Zoom", "Fade", "Doorway"]
        all_inter = ["New_Start", "Hard_Cut", "Transition_Source", "Transition", "Sudden_Jump"]
        selected_intra = sorted({str(x) for x in (omni.get("intraLabels") or all_intra) if str(x) in all_intra})
        selected_inter = sorted({str(x) for x in (omni.get("interLabels") or all_inter) if str(x) in all_inter})
        out["omnishotcut"] = {
            "mode": "default" if omni.get("mode") == "default" else "clean_shot",
            "overlapWindowLength": max(0, min(239, int(omni.get("overlapWindowLength", 20) or 0))),
            "intraLabels": selected_intra or all_intra,
            "interLabels": selected_inter or all_inter,
        }
    elif model == "autoshot":
        auto = raw.get("autoshot") if isinstance(raw.get("autoshot"), dict) else {}
        out["autoshot"] = {"threshold": max(0.01, min(0.99, float(auto.get("threshold", 0.296))))}
    payload = {"model": model, "threshold": float(threshold), "options": out}
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return out, hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:24]


def _store(path, threshold, fps, duration, nframes, scenes, model, options, options_key):
    con = db()
    con.execute(
        "INSERT OR REPLACE INTO scene_cache_v4 VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (path, file_mtime(path), options_key, float(threshold), fps, duration,
         nframes, json.dumps(scenes), model, json.dumps(options, sort_keys=True), time.time()),
    )
    con.commit()
    con.close()


def cmd_get(path, model, threshold=None, options=None):
    con = db()
    options_key = None
    if threshold is not None and options is not None:
        _, options_key = _canonical_options(model, threshold, options)
    if options_key is not None:
        row = con.execute(
            "SELECT mtime, options_key, threshold, fps, duration, frames, scenes_json, options_json "
            "FROM scene_cache_v4 WHERE file_path=? AND model=? AND options_key=? LIMIT 1",
            (path, model, options_key),
        ).fetchone()
    elif threshold is None:  # dernière découpe quel que soit le réglage (réouverture rapide)
        row = con.execute(
            "SELECT mtime, options_key, threshold, fps, duration, frames, scenes_json, options_json FROM scene_cache_v4 "
            "WHERE file_path=? AND model=? ORDER BY created_at DESC LIMIT 1",
            (path, model),
        ).fetchone()
    else:
        row = con.execute(
            "SELECT mtime, options_key, threshold, fps, duration, frames, scenes_json, options_json FROM scene_cache_v4 "
            "WHERE file_path=? AND model=? AND threshold=? ORDER BY created_at DESC LIMIT 1",
            (path, model, float(threshold)),
        ).fetchone()
    if not row:
        legacy = con.execute(
            "SELECT mtime, threshold, fps, duration, frames, scenes_json FROM scene_cache_v3 "
            "WHERE file_path=? AND model=?" + ("" if threshold is None else " AND threshold=?")
            + " ORDER BY created_at DESC LIMIT 1",
            (path, model) if threshold is None else (path, model, float(threshold)),
        ).fetchone()
        if legacy:
            mtime, old_threshold, fps, duration, frames, scenes_json = legacy
            row = (mtime, None, old_threshold, fps, duration, frames, scenes_json, None)
    con.close()
    if not row:
        return {"scenes": [], "cached": False, "model": model, "error": None}
    mtime, options_key, threshold, fps, duration, frames, scenes_json, options_json = row
    if abs(mtime - file_mtime(path)) > 1.0:  # fichier modifié → cache périmé
        return {"scenes": [], "cached": False, "stale": True, "model": model, "error": None}
    return {"scenes": json.loads(scenes_json), "fps": fps, "duration": duration,
            "frames": frames, "threshold": threshold, "model": model,
            "options": json.loads(options_json) if options_json else None,
            "optionsKey": options_key,
            "cached": True, "error": None}


class _ProgressTqdm:
    """Shim de tqdm : émet PROGRESS:<pct> sur stderr → barre de progression réelle."""
    def __init__(self, *a, total=0, **k):
        self.total = total or 0
        self.n = 0
        self._last = -1

    def update(self, delta=1):
        self.n += delta
        if self.total:
            _progress(55 + 43 * min(self.n, self.total) / self.total)  # prédiction = 55..98 % (extraction = 5..55)

    def close(self):
        pass

    def set_description(self, *a, **k):
        pass


def _transnet_frames(path):
    """Décode la vidéo en 48×27 via un pipe ffmpeg STREAMÉ (lecture par lots) → émet PROGRESS pendant
    l'extraction (la barre bouge, le watchdog reste nourri) au lieu du gros decode silencieux et
    bloquant de predict_video (la cause du 'Bloqué · découpe' sur les longs films)."""
    import subprocess

    import numpy as np
    nb = 0
    try:  # estimation rapide du nb de frames (durée × fps) — sans lire tout le fichier
        meta = subprocess.run(
            [ffprobe_bin(), "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=avg_frame_rate:format=duration", "-of", "json", path],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30).stdout.decode()
        j = json.loads(meta)
        dur = float((j.get("format") or {}).get("duration") or 0)
        fr = ((j.get("streams") or [{}])[0]).get("avg_frame_rate", "0/1") or "0/1"
        num, den = (fr.split("/") + ["1"])[:2]
        fps_est = (float(num) / float(den)) if float(den or 0) else 0.0
        nb = int(dur * fps_est) if dur and fps_est else 0
    except Exception:  # noqa: BLE001
        nb = 0
    FRAME = 48 * 27 * 3
    p = subprocess.Popen(
        [ffmpeg_bin(), "-nostdin", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "48x27", "pipe:"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    chunks = []
    got = 0
    try:
        while True:
            buf = p.stdout.read(FRAME * 256)  # ~256 frames par lecture
            if not buf:
                break
            chunks.append(buf)
            got += len(buf) // FRAME
            if nb:
                _progress(5 + 50 * min(got, nb) / nb)  # extraction = 5..55 %
    finally:
        try: p.stdout.close()
        except Exception: pass
        p.wait()
    data = b"".join(chunks)
    return np.frombuffer(data, np.uint8).reshape([-1, 27, 48, 3])


_MODELS = {}  # modèles gardés chauds entre les jobs (mode serve)


def _get_transnet():
    if "transnetv2" not in _MODELS:
        import transnetv2_pytorch.transnetv2_pytorch as _tmod
        from transnetv2_pytorch import TransNetV2
        _tmod.tqdm = _ProgressTqdm  # progression réelle pendant la prédiction

        import torch
        from nrdevice import torch_device
        dev = torch_device(torch)
        _MODELS["transnetv2"] = TransNetV2(device=dev)
    return _MODELS["transnetv2"]


def _get_omnishot():
    if "omnishotcut" not in _MODELS:
        import omnishotcut
        ckpt = os.environ.get("NETSURUSH_OMNISHOT_CKPT", "")
        with contextlib.redirect_stdout(sys.stderr), _heartbeat():
            if ckpt and os.path.exists(ckpt):
                _MODELS["omnishotcut"] = omnishotcut.load(ckpt)  # poids locaux (offline)
            else:
                _MODELS["omnishotcut"] = omnishotcut.load("uva-cv-lab/OmniShotCut", filename="OmniShotCut_ckpt.pth")
    return _MODELS["omnishotcut"]


def _get_autoshot():
    if "autoshot" not in _MODELS:
        import torch
        import nrautoshot
        from nrdevice import torch_device
        ckpt = os.environ.get(
            "NETSURUSH_AUTOSHOT_CKPT",
            os.path.join(os.path.expanduser("~"), ".netsurush", "weights", "AutoShot_ckpt_0_200_0.pth"),
        )
        with contextlib.redirect_stdout(sys.stderr), _heartbeat():
            _MODELS["autoshot"] = nrautoshot.load(ckpt, device=torch_device(torch))
    return _MODELS["autoshot"]


def _detect_transnet(path, threshold):
    from transnetv2_pytorch import TransNetV2

    import torch
    from nrdevice import torch_device
    dev = torch_device(torch)
    sys.stderr.write("STAGE:load\n"); sys.stderr.flush()
    _progress(2)
    model = _get_transnet()  # chaud dès le 2e job (mode serve)
    _progress(5)
    frames = _transnet_frames(path)  # extraction streamée (PROGRESS 5..55), plus de blocage silencieux
    sys.stderr.write("STAGE:infer\n"); sys.stderr.flush()
    nframes = int(frames.shape[0])
    video = torch.from_numpy(frames.copy()).to(dev)
    # redirect stdout→stderr : aucun print du package ne pollue notre JSON.
    with contextlib.redirect_stdout(sys.stderr):
        single, _all = model.predict_frames(video, quiet=False)  # prédiction (PROGRESS 55..98)
    arr = single.detach().cpu().numpy().squeeze()
    fps = float(model.get_video_fps(path))
    if not fps or fps != fps:  # NaN guard
        fps = 24.0
    raw = TransNetV2.predictions_to_scenes(arr, float(threshold))
    scenes = []
    for s, e in raw.tolist():
        s = int(s); e = int(e)  # e = dernière frame du plan (inclusif)
        scenes.append({"startFrame": s, "endFrame": e, "start": s / fps, "end": (e + 1) / fps})
    return fps, nframes, scenes


def _detect_autoshot(path, options):
    sys.stderr.write("STAGE:load\n"); sys.stderr.flush()
    _progress(2)
    model = _get_autoshot()
    _progress(5)
    frames = _transnet_frames(path)
    nframes = int(frames.shape[0])
    sys.stderr.write("STAGE:infer\n"); sys.stderr.flush()

    def on_batch(done, total):
        _progress(55 + 43 * done / max(1, total))

    boundaries = model.predict(frames, threshold=float(options.get("threshold", 0.296)), progress=on_batch)
    try:
        import subprocess
        meta = subprocess.run(
            [ffprobe_bin(), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30,
        ).stdout.decode().strip()
        num, den = (meta.split("/") + ["1"])[:2]
        fps = float(num) / float(den)
    except Exception:  # noqa: BLE001
        fps = 24.0
    if not fps or fps != fps:
        fps = 24.0
    starts = [0] + [idx + 1 for idx, boundary in enumerate(boundaries[:-1]) if bool(boundary)]
    starts = sorted(set(max(0, min(nframes - 1, int(value))) for value in starts)) if nframes else []
    scenes = []
    for index, start in enumerate(starts):
        end = starts[index + 1] - 1 if index + 1 < len(starts) else nframes - 1
        if end >= start:
            scenes.append({"startFrame": start, "endFrame": end,
                           "start": start / fps, "end": (end + 1) / fps})
    return fps, nframes, scenes


def _detect_omnishot(path, options):
    import cv2

    sys.stderr.write("STAGE:load\n"); sys.stderr.flush()
    _progress(2)
    model = _get_omnishot()  # chaud dès le 2e job (mode serve)
    _progress(5)

    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    nframes = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    if not fps or fps != fps:
        fps = 24.0
    duration = (nframes / fps) if fps else 0.0

    sys.stderr.write("STAGE:infer\n"); sys.stderr.flush()
    # redirect stdout→stderr : aucun print du package ne pollue notre JSON. `inference` est
    # entièrement muette (lecture full-vidéo + prédiction) → progression ESTIMÉE temps-based
    # 5..95 % (nourrit aussi le watchdog), calée sur ~12 % de la durée du média.
    expected = max(30.0, duration * 0.12)
    overlap = int(options.get("overlapWindowLength", 20))
    with contextlib.redirect_stdout(sys.stderr), _heartbeat(interval=2.0, estimate=(5, 90, expected)):
        ranges, intra_labels, inter_labels = model.inference(path, mode="default", overlap=overlap)

    allowed_intra = set(options.get("intraLabels") or [])
    allowed_inter = set(options.get("interLabels") or [])
    clean_only = options.get("mode") == "clean_shot"
    tagged = []
    for idx, pair in enumerate(ranges or []):
        intra = str(intra_labels[idx]) if idx < len(intra_labels) else "General"
        inter = str(inter_labels[idx]) if idx < len(inter_labels) else "Hard_Cut"
        if clean_only and intra != "General":
            continue
        if allowed_intra and intra not in allowed_intra:
            continue
        if allowed_inter and inter not in allowed_inter:
            continue
        tagged.append((pair, intra, inter))

    # Normalise en partition contiguë inclusive *par les débuts* : robuste que la fin
    # d'OmniShotCut soit inclusive ou exclusive (endFrame = début du plan suivant − 1).
    pairs = sorted([([int(pair[0]), int(pair[1])], intra, inter)
                    for pair, intra, inter in tagged], key=lambda item: item[0][0])
    if not pairs and nframes > 0:
        pairs = [([0, nframes - 1], "General", "New_Start")]
    starts = [pair[0] for pair, _, _ in pairs]
    scenes = []
    n = len(pairs)
    for i, ((a, b), intra, inter) in enumerate(pairs):
        sf = max(0, a)
        ef = (starts[i + 1] - 1) if i + 1 < n else ((nframes - 1) if nframes > 0 else b)
        if ef < sf:
            ef = sf
        scenes.append({"startFrame": sf, "endFrame": ef, "start": sf / fps, "end": (ef + 1) / fps,
                       "intraLabel": intra, "interLabel": inter})
    return fps, nframes, scenes


def _postprocess_scenes(scenes, fps, min_frames):
    # Nettoyage post-détection (surtout utile sur l'animé) : fusionne les plans
    # ultra-courts (flashs, smears, artefacts de décodage que TransNetV2 prend pour
    # des coupes) dans le plan précédent, et supprime les frontières qui se chevauchent.
    # endFrame reste INCLUSIF (invariant timeline).
    if not scenes:
        return scenes
    out = []
    for sc in scenes:
        sf = int(sc["startFrame"]); ef = int(sc["endFrame"])
        if ef < sf:
            ef = sf
        if out and (ef - sf + 1) < min_frames:
            out[-1]["endFrame"] = ef
            out[-1]["end"] = (ef + 1) / fps if fps else out[-1]["end"]
            continue
        item = {"startFrame": sf, "endFrame": ef,
                "start": sf / fps if fps else 0.0, "end": (ef + 1) / fps if fps else 0.0}
        if sc.get("intraLabel") is not None:
            item["intraLabel"] = sc.get("intraLabel")
        if sc.get("interLabel") is not None:
            item["interLabel"] = sc.get("interLabel")
        out.append(item)
    for i in range(1, len(out)):  # anti-doublon : pas de chevauchement de frontières
        if out[i]["startFrame"] <= out[i - 1]["endFrame"]:
            out[i]["startFrame"] = out[i - 1]["endFrame"] + 1
            if out[i]["endFrame"] < out[i]["startFrame"]:
                out[i]["endFrame"] = out[i]["startFrame"]
            out[i]["start"] = out[i]["startFrame"] / fps if fps else 0.0
    return out


def cmd_detect(path, threshold, model, options=None):
    _reset_progress()  # échelle 0..100 par job (mode serve : jobs successifs)
    try:
        if model == "omnishotcut":
            threshold = 0.0  # OmniShotCut n'a pas de seuil (mode auto) → clé de cache stable
            normalized, options_key = _canonical_options(model, threshold, options)
            fps, nframes, scenes = _detect_omnishot(path, normalized["omnishotcut"])
        elif model == "autoshot":
            normalized, options_key = _canonical_options(model, threshold, options)
            fps, nframes, scenes = _detect_autoshot(path, normalized["autoshot"])
        else:
            model = "transnetv2"
            normalized, options_key = _canonical_options(model, threshold, options)
            fps, nframes, scenes = _detect_transnet(path, threshold)
    except ImportError as exc:
        hints = {
            "omnishotcut": "OmniShotCut absent ou incomplet : ouvrez Paramètres › Modèles et relancez l'installation",
            "autoshot": "AutoShot absent ou incomplet : installez einops et le checkpoint officiel",
            "transnetv2": "TransNetV2 absent: pip install transnetv2-pytorch",
        }
        hint = hints.get(model, hints["transnetv2"])
        return {"scenes": [], "model": model, "error": "%s (%s)" % (hint, exc)}
    except Exception as exc:  # noqa: BLE001
        return {"scenes": [], "model": model, "error": str(exc)}

    min_frames = int(normalized.get("minSceneFrames", 2))
    scenes = _postprocess_scenes(scenes, fps, max(1, min_frames))

    duration = (nframes / fps) if fps else 0.0
    _store(path, threshold, fps, duration, nframes, scenes, model, normalized, options_key)
    return {"scenes": scenes, "fps": fps, "duration": duration, "frames": nframes,
            "threshold": float(threshold), "model": model, "options": normalized,
            "optionsKey": options_key, "cached": False, "error": None}


def serve():
    """Daemon : modèles gardés chauds, commandes JSON {id,cmd,path,threshold,model} sur stdin,
    réponses {id,result} sur stdout (même protocole que search.py serve). stdout protégé :
    tout print parasite part sur stderr pour ne jamais casser le protocole ligne-JSON."""
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
        try:
            cmd = req.get("cmd")
            path = req.get("path", "")
            model = req.get("model") or "transnetv2"
            if cmd == "get":
                thr = req.get("threshold")
                res = cmd_get(path, model, float(thr) if thr is not None else None, req.get("options"))
            else:
                with contextlib.redirect_stdout(sys.stderr):
                    res = cmd_detect(path, float(req.get("threshold", 0.5)), model, req.get("options"))
        except Exception as exc:  # noqa: BLE001
            res = {"scenes": [], "error": str(exc)}
        real_out.write(json.dumps({"id": rid, "result": res}) + "\n")
        real_out.flush()


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "detect"
    if cmd == "serve":
        serve()
        return
    path = sys.argv[2] if len(sys.argv) > 2 else ""
    if cmd == "get":
        model = sys.argv[3] if len(sys.argv) > 3 else "transnetv2"
        threshold = float(sys.argv[4]) if len(sys.argv) > 4 else None
        options = json.loads(sys.argv[5]) if len(sys.argv) > 5 else None
        print(json.dumps(cmd_get(path, model, threshold, options)))
    else:
        threshold = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
        model = sys.argv[4] if len(sys.argv) > 4 else "transnetv2"
        options = json.loads(sys.argv[5]) if len(sys.argv) > 5 else None
        print(json.dumps(cmd_detect(path, threshold, model, options)))


if __name__ == "__main__":
    main()
