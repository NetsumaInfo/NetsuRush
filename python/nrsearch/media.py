"""Extraction de frames (ffmpeg, seek keyframe rapide ou précis), vignettes JPEG, et plans
(réutilise la détection TransNetV2 de detect.py en précision MAX, via le cache SQLite)."""
import io
import hashlib
import json
import sqlite3
import sys

from detect import _canonical_options, cmd_detect, db_path, file_mtime
from ffbin import ffmpeg_bin

from .config import GRAB_TIMEOUT, INDEX_MODEL, INDEX_THRESHOLD


def detection_key(model=None, options=None):
    """Identité des RÉGLAGES de découpe demandés. Ne subsiste que pour relire les marqueurs
    d'indexation écrits avant `cut_identity` — un marqueur ne doit pas périmer sur un changement
    de schéma. Toute écriture neuve passe par `cut_identity`."""
    payload = {
        "model": (model or INDEX_MODEL).strip() or INDEX_MODEL,
        "options": options or {},
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]


def cut_identity(scenes):
    """Identité de la découpe RÉELLEMENT posée : ses frontières de plans, rien d'autre.

    Deux réglages qui rendent les mêmes plans donnent la même identité. C'est ce qui autorise
    `get_scenes` à réutiliser une découpe déjà en cache sans prétendre qu'elle vient des réglages
    demandés : l'index n'est refait que si les frontières ont VRAIMENT bougé."""
    payload = ";".join("%d-%d" % (int(s.get("startFrame", 0)), int(s.get("endFrame", 0)))
                       for s in scenes)
    return hashlib.sha256(payload.encode("ascii")).hexdigest()[:16]


def _scale_args(max_edge):
    if not max_edge:
        return []
    return ["-vf", "scale='min(%d,iw)':'min(%d,ih)':force_original_aspect_ratio=decrease"
            % (max_edge, max_edge)]


def grab_ffmpeg(path, sec, accurate=False, timeout=GRAB_TIMEOUT, max_edge=0):
    """Extrait 1 frame à t=sec via ffmpeg → PIL. Par défaut seek KEYFRAME (rapide). `accurate=True`
    (mode Forcer) = seek précis (décode jusqu'au timestamp exact, plus lent mais récupère des frames
    que le keyframe rate). Bornée par `timeout`. `max_edge>0` downscale la frame (bord long ≤ max_edge,
    jamais d'upscale) → pipe + décode + RAM réduits, embedding identique (le modèle redimensionne)."""
    import subprocess

    from PIL import Image
    cmd = [ffmpeg_bin(), "-nostdin"]
    if not accurate:
        cmd.append("-noaccurate_seek")
    cmd += ["-ss", "%.3f" % max(0.0, sec), "-i", path, "-frames:v", "1"]
    cmd += _scale_args(max_edge)
    cmd += ["-f", "image2pipe", "-vcodec", "mjpeg", "-"]
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout)
    except Exception:  # noqa: BLE001  (TimeoutExpired tue le process, ou ffmpeg absent)
        return None
    if p.returncode != 0 or not p.stdout:
        return None
    try:
        return Image.open(io.BytesIO(p.stdout)).convert("RGB")
    except Exception:  # noqa: BLE001
        return None


def grab_shot(path, secs, max_edge=0, accurate=False, timeout=GRAB_TIMEOUT):
    """Extrait plusieurs timestamps avec un seul process ffmpeg.

    Chaque timestamp reste une entrée indépendante avec les mêmes options que ``grab_ffmpeg`` : les
    JPEG produits sont donc identiques au chemin historique. Des sorties nommées gardent leur ordre
    et permettent de sauter proprement un timestamp illisible.
    """
    import os
    import subprocess
    import tempfile

    from PIL import Image

    timestamps = list(secs)
    if not timestamps:
        return []
    try:
        with tempfile.TemporaryDirectory(prefix="nr-shot-") as tmp:
            cmd = [ffmpeg_bin(), "-nostdin"]
            for sec in timestamps:
                if not accurate:
                    cmd.append("-noaccurate_seek")
                cmd += ["-ss", "%.3f" % max(0.0, sec), "-i", path]
            outputs = []
            for index in range(len(timestamps)):
                output = os.path.join(tmp, "frame-%d.jpg" % index)
                outputs.append(output)
                cmd += ["-map", "%d:v:0" % index, "-frames:v", "1"]
                cmd += _scale_args(max_edge)
                cmd += ["-f", "image2", "-vcodec", "mjpeg", output]
            try:
                subprocess.run(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=timeout * len(timestamps),
                )
            except Exception:  # noqa: BLE001  (les sorties déjà produites restent récupérables)
                pass
            frames = []
            for output in outputs:
                if not os.path.isfile(output):
                    continue
                try:
                    with Image.open(output) as image:
                        frames.append(image.convert("RGB").copy())
                except Exception:  # noqa: BLE001
                    continue
            return frames
    except Exception:  # noqa: BLE001  (temp indisponible ou ffmpeg absent → plan sauté)
        return []


def thumb_bytes(img):
    """Vignette JPEG 320 px depuis une image déjà décodée.

    Ne sert plus qu'aux RECADRAGES de visages (faces, characters) : eux n'existent nulle part
    ailleurs, un cadre de visage n'étant pas une frame. Les vignettes de PLAN, elles, viennent du
    cache partagé de l'application (`core/thumbs.js`), commun au découpage et à la recherche."""
    im = img.copy()
    im.thumbnail((320, 320))
    buf = io.BytesIO()
    im.convert("RGB").save(buf, format="JPEG", quality=70)
    return buf.getvalue()


def _cached_cut(con, path, model, threshold, options_key):
    """Découpe FRAÎCHE déjà en cache pour ce fichier, la plus proche de la demande — None si rien.

    L'ordre va du plus fidèle au plus tolérant : les réglages demandés, puis le même modèle au même
    seuil, puis le même modèle, puis n'importe quelle découpe. Ce dernier repli n'est pas un
    relâchement : re-détecter un rush déjà découpé coûte des minutes de GPU pour retomber, presque
    toujours, sur les mêmes frontières. MESURÉ sur une base réelle : 56 rushs sur 59 repassaient par
    une détection complète à chaque « Indexer », leur découpe étant rangée sous une autre clé
    d'options (ou dans le cache v3, qui n'en a pas). Ce que la découpe retenue vaut vraiment est
    tranché ensuite par `cut_identity` : l'index n'est refait que si les frontières ont bougé."""
    steps = []
    if options_key:
        steps.append(("scene_cache_v4", "AND model=? AND options_key=?", (model, options_key)))
    steps += [
        ("scene_cache_v4", "AND model=? AND abs(threshold-?)<0.001", (model, float(threshold))),
        ("scene_cache_v3", "AND model=? AND abs(threshold-?)<0.001", (model, float(threshold))),
        ("scene_cache_v4", "AND model=?", (model,)),
        ("scene_cache_v3", "AND model=?", (model,)),
        ("scene_cache_v4", "", ()),
        ("scene_cache_v3", "", ()),
    ]
    mt = file_mtime(path)
    for table, extra, params in steps:
        try:
            row = con.execute(
                "SELECT fps, frames, scenes_json, mtime FROM %s WHERE file_path=? %s "
                "ORDER BY created_at DESC LIMIT 1" % (table, extra), (path, *params),
            ).fetchone()
        except sqlite3.OperationalError:   # table absente : base d'une version antérieure
            continue
        if row and abs((row[3] or 0) - mt) <= 1.0:   # fichier modifié depuis → découpe périmée
            return float(row[0] or 0), int(row[1] or 0), json.loads(row[2])
    return None


def get_scenes(path, model=None, options=None):
    """Plans pour l'indexation, du cache si possible (cf. `_cached_cut`), sinon par détection.
    `model` = modèle de découpe choisi dans les paramètres (défaut INDEX_MODEL)."""
    m = (model or INDEX_MODEL).strip() or INDEX_MODEL
    thr = 0.0 if m == "omnishotcut" else INDEX_THRESHOLD
    options_key = _canonical_options(m, thr, options)[1] if options else None
    con = sqlite3.connect(db_path())
    try:
        cached = _cached_cut(con, path, m, thr, options_key)
    finally:
        con.close()
    if cached:
        return cached
    sys.stderr.write("PHASE:detect\n"); sys.stderr.flush()  # découpe (détection des plans)
    r = cmd_detect(path, thr, m, options or {})
    if r.get("error"):
        return 0.0, 0, []  # non-vidéo / illisible (ex: audio) → aucun plan, on saute proprement
    return r.get("fps") or 0.0, r.get("frames") or 0, r.get("scenes") or []

