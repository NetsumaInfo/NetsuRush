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
(load 2..5, puis 5..98 ; transnetv2 décode et infère en un seul passage, les autres moteurs
extraient de 5 à 55 puis infèrent de 55 à 98). Les marqueurs STAGE:* ne portent que la phase
(libellé), jamais un pourcentage.

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

import nrident
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


# Part du travail supposée faite à l'échéance prévue. Le reste de la course est ASYMPTOTIQUE :
# une estimation temps-based qui saturerait à son plafond rendrait la barre IMMOBILE dès que le
# travail dépasse la durée prévue — ce qui arrive à chaque découpe en lot, où N détections se
# partagent le même GPU et durent donc N fois plus longtemps que l'estimation d'un job seul.
# Une barre figée à 99 % se lit comme une application plantée ; mieux vaut ralentir sans fin.
_ESTIMATE_KNEE = 0.85


def _estimate_ratio(elapsed, expected):
    """Avancement estimé dans [0, 1[ — linéaire jusqu'à l'échéance, asymptotique ensuite.

    Continu au genou (`elapsed == expected` → `_ESTIMATE_KNEE`), strictement croissant, et
    n'atteint JAMAIS 1 : il reste toujours de quoi avancer, si tard soit-il."""
    expected = max(1.0, expected)
    elapsed = max(0.0, elapsed)
    if elapsed <= expected:
        return _ESTIMATE_KNEE * elapsed / expected
    return 1.0 - (1.0 - _ESTIMATE_KNEE) * expected / elapsed


@contextlib.contextmanager
def _heartbeat(interval=20.0, estimate=None):
    """Bat sur stderr toutes les `interval` s. OmniShotCut lit TOUTE la vidéo en RAM (decord) AVANT
    d'émettre sa 1re progression → ~70 s muets sur 24 min, plus sous contention. Le core a un watchdog
    d'INACTIVITÉ (tue un process sans sortie) → sans ce battement, plusieurs détections EN PARALLÈLE
    (dont les lectures se chevauchent et s'allongent) déclenchaient « délai dépassé ». Le battement
    nourrit le watchdog pendant la phase muette ; un process réellement bloqué cesse TOUT (thread
    compris) → le watchdog le rattrape quand même.

    `estimate=(base, span, expected_s)` : en plus du battement, émet une progression
    ESTIMÉE temps-based (base..base+span) — OmniShotCut n'émet aucune progression pendant
    `inference`, sans ça la barre reste figée plusieurs minutes."""
    stop = threading.Event()
    t0 = time.time()

    def beat():
        while not stop.wait(interval):
            try:
                if estimate:
                    base, span, expected = estimate
                    ratio = _estimate_ratio(time.time() - t0, expected)
                    # Le ratio ne sature jamais, mais _progress est MONOTONE À L'ENTIER : deux
                    # tics rapprochés peuvent retomber sur la même valeur. On garde alors le
                    # marqueur de vie, sinon une inférence GPU lente passe pour un process mort
                    # aux yeux du watchdog du core.
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
    min_frames = max(1, min(300, int(raw.get("minSceneFrames", 6) if raw.get("minSceneFrames") is not None else 6)))
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
    # Witness of what was cut: the copy of this rush living on another drive inherits this work
    # instead of paying for it again (cf. python/nrident.py).
    nrident.remember(con, path)
    con.close()


def _select_scene_row(con, path, model, threshold, options_key):
    """Cached cut for this exact path, v4 first then the legacy v3 table. None if there is none."""
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
    if row:
        return row
    legacy = con.execute(
        "SELECT mtime, threshold, fps, duration, frames, scenes_json FROM scene_cache_v3 "
        "WHERE file_path=? AND model=?" + ("" if threshold is None else " AND threshold=?")
        + " ORDER BY created_at DESC LIMIT 1",
        (path, model) if threshold is None else (path, model, float(threshold)),
    ).fetchone()
    if not legacy:
        return None
    mtime, old_threshold, fps, duration, frames, scenes_json = legacy
    return (mtime, None, old_threshold, fps, duration, frames, scenes_json, None)


# Tables carrying a cut, in transfer order: the same bytes always produce the same shot boundaries,
# so a cut found under another path is valid here without any GPU work.
SCENE_TABLES = ["scene_cache_v4", "scene_cache_v3"]


def cmd_get(path, model, threshold=None, options=None, link=True):
    """Cached cut for `path`.

    `link` (default) lets an identical file already cut under another name — a copy on another
    drive, a rush renamed, a project moved — hand its cut over instead of forcing a new detection.
    Set it to False for a pure read (no hashing, no writing).
    """
    con = db()
    options_key = None
    if threshold is not None and options is not None:
        _, options_key = _canonical_options(model, threshold, options)
    row = _select_scene_row(con, path, model, threshold, options_key)
    linked = None
    if row is None and link:
        linked = nrident.rescue(con, path, SCENE_TABLES)
        if linked:
            row = _select_scene_row(con, path, model, threshold, options_key)
    stale = False
    if row is not None:
        mtime = row[0]
        if abs(mtime - file_mtime(path)) > 1.0:  # fichier modifié → cache périmé…
            # …sauf si seul l'horodatage a bougé (copie, restauration, synchro) : les octets sont
            # les mêmes, la découpe reste juste. On réaligne le cache au lieu de le jeter.
            if not (link and nrident.realign(con, path, SCENE_TABLES, mtime)):
                row, stale = None, True
    con.close()
    if row is None:
        out = {"scenes": [], "cached": False, "model": model, "error": None}
        if stale:
            out["stale"] = True
        return out
    mtime, options_key, threshold, fps, duration, frames, scenes_json, options_json = row
    result = {"scenes": json.loads(scenes_json), "fps": fps, "duration": duration,
              "frames": frames, "threshold": threshold, "model": model,
              "options": json.loads(options_json) if options_json else None,
              "optionsKey": options_key,
              "cached": True, "error": None}
    if linked:
        result["linkedFrom"] = linked["from"]
    return result


def _frame_count_estimate(path):
    """Nombre de frames estimé (durée × fps) — sans lire tout le fichier."""
    import subprocess
    try:
        meta = subprocess.run(
            [ffprobe_bin(), "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=avg_frame_rate:format=duration", "-of", "json", path],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30).stdout.decode()
        j = json.loads(meta)
        dur = float((j.get("format") or {}).get("duration") or 0)
        fr = ((j.get("streams") or [{}])[0]).get("avg_frame_rate", "0/1") or "0/1"
        num, den = (fr.split("/") + ["1"])[:2]
        fps_est = (float(num) / float(den)) if float(den or 0) else 0.0
        return int(dur * fps_est) if dur and fps_est else 0
    except Exception:  # noqa: BLE001
        return 0


def _iter_frame_chunks(path, on_frames=None):
    """Décode la vidéo en 48×27 via un pipe ffmpeg STREAMÉ et rend des LOTS de frames.

    Décodage logiciel volontaire : `-hwaccel cuda` décode plus vite mais doit redescendre chaque
    frame en pleine résolution sur le PCIe avant le downscale (mesuré 2,3× PLUS LENT ici), et le
    chemin tout-GPU `scale_cuda` change les pixels donc les détections.

    `on_frames(count)` est appelé après chaque lot (progression)."""
    import subprocess

    import numpy as np
    FRAME = 48 * 27 * 3
    p = subprocess.Popen(
        [ffmpeg_bin(), "-nostdin", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "48x27", "pipe:"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    got = 0
    try:
        while True:
            buf = p.stdout.read(FRAME * 256)  # ~256 frames par lecture
            if not buf:
                break
            chunk = np.frombuffer(buf, np.uint8).reshape([-1, 27, 48, 3])
            got += len(chunk)
            if on_frames:
                on_frames(got)
            yield chunk
    finally:
        try: p.stdout.close()
        except Exception: pass
        p.wait()


def _prefetch(chunks, depth=8):
    """Décode en avance sur un thread. Le tube ffmpeg ne fait que 64 Kio : sans ce thread, le
    décodeur se bloque dès la première inférence et l'entrelacement ne sert plus à rien."""
    import queue
    done = object()
    q = queue.Queue(maxsize=depth)

    def pump():
        try:
            for chunk in chunks:
                q.put(chunk)
        except BaseException as exc:  # noqa: BLE001 - relayée telle quelle au consommateur
            q.put(exc)
        else:
            q.put(done)

    threading.Thread(target=pump, daemon=True).start()
    while True:
        item = q.get()
        if item is done:
            return
        if isinstance(item, BaseException):
            raise item
        yield item


def _transnet_frames(path):
    """Toutes les frames 48×27 en RAM (moteurs qui ne savent pas consommer un flux)."""
    import numpy as np
    nb = _frame_count_estimate(path)
    chunks = list(_iter_frame_chunks(
        path,
        on_frames=(lambda got: _progress(5 + 50 * min(got, nb) / nb)) if nb else None,
    ))  # extraction = 5..55 %
    if not chunks:
        return np.zeros((0, 27, 48, 3), np.uint8)
    return np.concatenate(chunks) if len(chunks) > 1 else chunks[0]


_MODELS = {}  # modèles gardés chauds entre les jobs (mode serve)


def _get_transnet():
    if "transnetv2" not in _MODELS:
        from transnetv2_pytorch import TransNetV2

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


_WINDOW, _STRIDE, _HEAD = 100, 50, 25  # fenêtrage EXACT de TransNetV2.predict_frames


def _transnet_windows(chunks):
    """Rend les fenêtres de 100 frames (pas de 50) du flux padé, au fil du décodage.

    Reproduit à l'identique le fenêtrage de `predict_frames` (25 copies de la 1re frame en tête,
    queue complétée par la dernière), mais SANS matérialiser la vidéo entière : sur un film de 2 h
    le tableau complet pèse ~670 Mo, et surtout il forçait à attendre la fin du décodage avant la
    moindre inférence. Ici le GPU travaille pendant que ffmpeg décode."""
    import numpy as np
    buf = None
    total = 0
    last = None
    for chunk in chunks:
        if not len(chunk):
            continue
        if buf is None:
            buf = np.repeat(chunk[:1], _HEAD, axis=0)
        last = chunk[-1:]
        total += len(chunk)
        buf = np.concatenate((buf, chunk))
        while len(buf) >= _WINDOW:
            yield buf[:_WINDOW]
            buf = buf[_STRIDE:]
    if buf is None:
        return
    tail = _HEAD + _STRIDE - (total % _STRIDE or _STRIDE)
    buf = np.concatenate((buf, np.repeat(last, tail, axis=0)))
    while len(buf) >= _WINDOW:
        yield buf[:_WINDOW]
        buf = buf[_STRIDE:]


def _infer_batch_size(dev, torch):
    """Fenêtres groupées par appel. Le modèle tourne sur des tenseurs 100×27×48 : à une fenêtre par
    appel le GPU est à l'arrêt entre deux lancements de noyaux. Mesuré (RTX 3070 Ti, 6000 frames) :
    1 → 4,62 s, 4 → 2,46 s, 8 → 2,62 s, 16 → 2,74 s. 4 = ~650 Mo de VRAM, le palier utile.

    Le groupe retombe à 1 si la VRAM libre est courte : Resolve, un modèle de recherche chargé ou
    deux détections lancées en parallèle partagent la même carte."""
    forced = os.environ.get("NETSURUSH_TRANSNET_BATCH", "").strip()
    if forced.isdigit() and int(forced) > 0:
        return int(forced)
    if dev == "cpu":
        return 1
    try:
        free, _total = torch.cuda.mem_get_info()
        if free < 1_500_000_000:
            return 1
    except Exception:  # noqa: BLE001 - xpu ou API absente : le repli OOM couvre le cas
        pass
    return 4


def _transnet_predict(model, windows, dev, nframes_hint):
    """Scores par frame, fenêtres groupées. Chaque fenêtre reste indépendante dans le modèle
    (FrameSimilarity et ColorHistograms travaillent par élément de batch) : grouper ne change que
    l'ordre des réductions flottantes — écart mesuré 7e-07, sans effet sur un seuil à 0,296."""
    import numpy as np
    import torch
    from nrdevice import empty_torch_cache
    size = _infer_batch_size(dev, torch)
    scores = []
    group = []
    done = 0

    def flush(batch_windows):
        batch = torch.from_numpy(np.stack(batch_windows)).to(dev)
        with torch.inference_mode():
            single, _all = model.predict_raw(batch)
        return single[:, _HEAD:_HEAD + _STRIDE, 0].reshape(-1).cpu().numpy()

    def run(batch_windows):
        nonlocal size
        try:
            return [flush(batch_windows)]
        except torch.cuda.OutOfMemoryError:  # repli fenêtre par fenêtre plutôt qu'un job perdu
            empty_torch_cache(torch)
            size = 1
            return [flush([window]) for window in batch_windows]

    for window in windows:
        group.append(window)
        if len(group) < size:
            continue
        for part in run(group):
            scores.append(part)
            done += len(part)
        group = []
        if nframes_hint:
            _progress(5 + 90 * min(done, nframes_hint) / nframes_hint)
    if group:
        scores.extend(run(group))
    if not scores:
        return np.zeros((0,), np.float32)
    return np.concatenate(scores)


def _detect_transnet(path, threshold):
    from transnetv2_pytorch import TransNetV2

    import torch
    from nrdevice import torch_device
    dev = torch_device(torch)
    sys.stderr.write("STAGE:load\n"); sys.stderr.flush()
    _progress(2)
    model = _get_transnet()  # chaud dès le 2e job (mode serve)
    _progress(5)
    sys.stderr.write("STAGE:infer\n"); sys.stderr.flush()
    nb = _frame_count_estimate(path)
    counted = [0]

    def seen(got):
        counted[0] = got

    # Décodage et inférence dans le MÊME passage : on paie max(décodage, inférence), pas la somme.
    chunks = _prefetch(_iter_frame_chunks(path, on_frames=seen))
    arr = _transnet_predict(model, _transnet_windows(chunks), dev, nb)
    nframes = counted[0]
    if not nframes:  # fichier illisible : sans ça la sortie contient un plan fantôme [0, -1]
        raise ValueError("aucune frame décodée")
    arr = arr[:nframes]
    _progress(96)
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


def _detect_omnishot(path, options, concurrency=1):
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
    # (nourrit aussi le watchdog), calée sur ~12 % de la durée du média.
    #
    # L'estimation PLAFONNE À 90 (5 + 85), et jamais plus haut : la barre du renderer s'autorise
    # 8 points d'avance au-dessus de la dernière mesure et bute sur 99 (cf. `lib/smoothProgress`).
    # Une estimation qui monterait à 95 collerait donc l'affichage à 99 % — figé — pendant tout ce
    # que l'inférence prend au-delà du prévu. Sous 90, il reste toujours de la marge pour avancer.
    #
    # `concurrency` = nombre de détections qui se partagent le GPU en ce moment (le core le sait, il
    # tient le pool). Une découpe en lot en lance plusieurs : chacune dure alors à peu près autant de
    # fois plus longtemps, et une estimation calée sur un job seul se ferait dépasser à tous les coups.
    expected = max(30.0, duration * 0.12) * max(1, int(concurrency or 1))
    overlap = int(options.get("overlapWindowLength", 20))
    with contextlib.redirect_stdout(sys.stderr), _heartbeat(interval=2.0, estimate=(5, 85, expected)):
        ranges, intra_labels, inter_labels = model.inference(path, mode="default", overlap=overlap)
    # L'inférence est finie pour de bon : on quitte l'estimation et on le dit. Ce qui suit (filtrage
    # des labels, normalisation des bornes) est une poignée de boucles sur quelques milliers de plans.
    _progress(96)

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


def _link_existing_cut(path, model, threshold, options):
    """Cut of an identical file already known under another path, or None.

    Only when NOTHING is cached under this path: a re-detection asked on a rush the cache already
    knows must still recompute (that is what the button is for). What this catches is the copy on
    another drive, the renamed rush, the project moved to another folder — cases where a fresh
    detection would spend minutes rebuilding boundaries that are already known to be identical.
    """
    con = db()
    try:
        if _select_scene_row(con, path, model, None, None) is not None:
            return None
        linked = nrident.rescue(con, path, SCENE_TABLES)
    except sqlite3.Error:
        return None
    finally:
        con.close()
    if not linked:
        return None
    got = cmd_get(path, model, threshold, options, link=False)
    return got if got.get("cached") else None


# `concurrency` n'entre NI dans les options NI dans la clé de cache : c'est une donnée de charge du
# moment, pas un réglage de découpe. L'y mettre ferait rater le cache d'un rush selon qu'il a été
# découpé seul ou en lot.
def cmd_detect(path, threshold, model, options=None, concurrency=1):
    _reset_progress()  # échelle 0..100 par job (mode serve : jobs successifs)
    model = model if model in ("omnishotcut", "autoshot") else "transnetv2"
    linked = _link_existing_cut(path, model, 0.0 if model == "omnishotcut" else threshold, options)
    if linked:
        return linked
    try:
        if model == "omnishotcut":
            threshold = 0.0  # OmniShotCut n'a pas de seuil (mode auto) → clé de cache stable
            normalized, options_key = _canonical_options(model, threshold, options)
            fps, nframes, scenes = _detect_omnishot(path, normalized["omnishotcut"], concurrency)
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

    min_frames = int(normalized.get("minSceneFrames", 6))
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
                    res = cmd_detect(path, float(req.get("threshold", 0.5)), model, req.get("options"),
                                     req.get("concurrency") or 1)
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
        concurrency = int(sys.argv[6]) if len(sys.argv) > 6 else 1
        print(json.dumps(cmd_detect(path, threshold, model, options, concurrency)))


if __name__ == "__main__":
    main()
