"""Indexation : 1 vecteur représentatif par plan, ou image fixe (1 frame). Le nombre d'images est un
RÉGLAGE (1 à 3) ; où les prendre et quand en ajouter une est décidé par `sampling`. Décodage ffmpeg
parallèle + embedding GPU par gros batches. Marqueur de complétion écrit seulement en fin de clip
(distingue un clip interrompu d'un clip fait)."""
import sys
import time

import numpy as np

import nrident
from detect import file_mtime
from nri18n import t

from . import media, model
from . import sampling
from .config import (DECODE_WORKERS, DEFAULT_SAMPLING_FRAMES, FORCE_TIMEOUT, GPU_BATCH,
                     GRAB_MAX_EDGE, INDEX_CHUNK, MODEL_TAG, SEGMENT_GAP_SEC, SEGMENT_SHOTS,
                     SEGMENT_THREADS, SHOT_DECODE, STATIC_THR, is_image, sampling_current, sampling_format,
                     sampling_frames, sampling_tag)
from .db import db_emb


# Index d'un fichier, dans l'ordre de transfert : les vecteurs d'abord, le marqueur de complétion
# ensuite — un marqueur sans ses vecteurs annoncerait un travail qui n'existe pas.
INDEX_TABLES = ["frame_embeddings_v1", "index_runs_v1"]


def _index_image(path, mt, force=False):
    """Image fixe = 1 plan (l'image entière). Aucune détection de plans : on embed directement
    (sinon TransNetV2 tournerait sur 1 image = long pour rien)."""
    from PIL import Image
    con = db_emb()
    done = con.execute(
        "SELECT mtime FROM index_runs_v1 WHERE file_path=? AND model=?", (path, MODEL_TAG),
    ).fetchone()
    if not force and not (done and done[0] is not None and abs(done[0] - mt) <= 1.0):
        if done and done[0] is not None:
            nrident.realign(con, path, INDEX_TABLES, done[0])
        else:
            nrident.rescue(con, path, INDEX_TABLES)
        done = con.execute(
            "SELECT mtime FROM index_runs_v1 WHERE file_path=? AND model=?", (path, MODEL_TAG),
        ).fetchone()
    if not force and done and done[0] is not None and abs(done[0] - mt) <= 1.0:
        con.close()
        return {"ok": True, "file": path, "indexed": 0, "total": 1, "cached": True, "error": None}
    try:  # l'index existant n'est effacé que si la nouvelle lecture aboutit (ligne écrasée plus bas)
        img = Image.open(path).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        con.close()
        return {"ok": False, "file": path, "indexed": 0, "total": 1, "cached": False,
                "error": t("image_unreadable_error", error=exc)}
    con.execute("DELETE FROM frame_embeddings_v1 WHERE file_path=? AND model=? AND scene_index>0",
                (path, MODEL_TAG))
    model.free_memory()
    model.load()
    sys.stderr.write("PHASE:embed\nSTAGE:infer\n"); sys.stderr.flush()
    emb = model.embed_images([img])[0]
    con.execute(
        "INSERT OR REPLACE INTO frame_embeddings_v1 "
        "(file_path,mtime,model,scene_index,start_frame,end_frame,mid_frame,"
        "start_sec,end_sec,fps,src_frames,embedding,dim,created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (path, mt, MODEL_TAG, 0, 0, 0, 0, 0.0, 0.0, 0.0, 1,
         emb.tobytes(), int(emb.shape[0]), time.time()),
    )
    con.execute(
        "INSERT OR REPLACE INTO index_runs_v1 (file_path,model,mtime,total,indexed,created_at,sampling) "
        "VALUES (?,?,?,?,?,?,?)", (path, MODEL_TAG, mt, 1, 1, time.time(), "image"),
    )
    con.commit()
    nrident.remember(con, path)  # témoin d'identité (cf. python/nrident.py)
    con.close()
    sys.stderr.write("STAGE:prog:1/1\n"); sys.stderr.flush()
    return {"ok": True, "file": path, "indexed": 1, "total": 1, "cached": False, "error": None}


def cmd_index(path, force=False, frames=None, cut_model=None, detect_options=None):
    # NB : `cut_model` (modèle de DÉCOUPE) ≠ le module `model` (SigLIP) importé en tête — surtout ne
    # pas nommer ce paramètre `model`, ça masquerait le module (model.free_memory/load plus bas).
    asked_frames = sampling_frames(frames if frames in (1, 2, 3) else DEFAULT_SAMPLING_FRAMES)
    fmt = sampling_format(asked_frames)
    mt = file_mtime(path)
    if is_image(path):
        return _index_image(path, mt, force)  # image fixe → pas de détection de plans (1 frame quoi qu'il arrive)
    fps, src_frames, scenes = media.get_scenes(path, cut_model, detect_options)  # cache, sinon détection
    # Le marqueur porte l'identité des FRONTIÈRES posées, pas celle des réglages demandés : une
    # découpe reprise du cache doit pouvoir être reconnue au passage suivant, sinon chaque « Indexer »
    # ré-embedderait un index déjà juste.
    cut_key = media.cut_identity(scenes)
    legacy_key = media.detection_key(cut_model, detect_options)
    n = len(scenes)
    con = db_emb()
    # "fait" = un marqueur de complétion existe pour CE total de plans et ce mtime (≠ embeddings
    # partiels d'un clip interrompu, qui n'ont pas de marqueur → on re-traite). En mode FORCER, on
    # ignore le cache et on retraite tout (pour récupérer les frames sautées).
    done = con.execute(
        "SELECT mtime, total, sampling FROM index_runs_v1 WHERE file_path=? AND model=?",
        (path, MODEL_TAG),
    ).fetchone()
    # "à jour" = traité jusqu'au bout, même total/mtime ET au format demandé (cf. sampling_current).
    # Legacy (1-frame, sampling NULL) jamais à jour → ré-indexé sans Forcer.
    cur = done[2] if done else None
    current_fmt = sampling_current(cur, fmt, cut_key, legacy_key)

    def usable(run, fmt_ok):
        return bool(n > 0 and run and run[1] == n and run[0] is not None
                    and abs(run[0] - mt) <= 1.0 and fmt_ok)

    if not force and not usable(done, current_fmt):
        # Rien d'utilisable sous ce chemin. Deux rattrapages avant de rembobiner le GPU : l'index
        # écrit pour ce fichier sous un horodatage périmé (copie, restauration) et celui d'un
        # fichier IDENTIQUE déjà indexé sous un autre nom (cf. python/nrident.py).
        if done and done[0] is not None and abs(done[0] - mt) > 1.0:
            nrident.realign(con, path, INDEX_TABLES, done[0])
        elif not done:
            nrident.rescue(con, path, INDEX_TABLES)
        done = con.execute(
            "SELECT mtime, total, sampling FROM index_runs_v1 WHERE file_path=? AND model=?",
            (path, MODEL_TAG),
        ).fetchone()
        cur = done[2] if done else None
        current_fmt = sampling_current(cur, fmt, cut_key, legacy_key)
    if not force and usable(done, current_fmt):
        con.close()
        return {"ok": True, "file": path, "indexed": 0, "total": n, "cached": True, "error": None}
    if n == 0:  # aucun plan détecté (fichier illisible, audio) → l'index existant reste intact
        con.close()
        return {"ok": True, "file": path, "indexed": 0, "total": 0, "cached": False, "error": None}
    # L'ancien index n'est PAS effacé ici : les lignes sont écrasées plan par plan (PK file+model+
    # scene_index) et le reliquat est purgé À LA FIN. Effacer d'abord détruisait un index valide dès
    # qu'un job était interrompu — et « Arrêter » tue le daemon en plein vol.

    model.free_memory()  # vire la détection (TransNetV2) de la VRAM/RAM avant de charger SigLIP
    model.load()
    sys.stderr.write("PHASE:embed\nSTAGE:infer\n"); sys.stderr.flush()  # indexation (embeddings)
    indexed = 0
    skipped = 0  # plans dont aucune frame n'a pu être lue → sautés (le clip continue)
    row_buf = []  # lignes bufferisées (embedding ~4,6 Ko) → commit par lots, mémoire bornée

    def flush_rows():
        nonlocal indexed
        if not row_buf:
            return
        con.executemany(
            "INSERT OR REPLACE INTO frame_embeddings_v1 "
            "(file_path,mtime,model,scene_index,start_frame,end_frame,mid_frame,"
            "start_sec,end_sec,fps,src_frames,embedding,dim,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row_buf,
        )
        con.commit()
        indexed += len(row_buf)
        row_buf.clear()

    from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

    def scene_meta(sc):
        sf = int(sc.get("startFrame", 0)); ef = int(sc.get("endFrame", sf))
        mid = (sf + ef) // 2
        ss = sc.get("start", sf / fps if fps else 0.0)
        es = sc.get("end", (ef + 1) / fps if fps else 0.0)
        return sf, ef, mid, ss, es

    def grab(sec):
        # Precise seek: a keyframe seek returns the keyframe BEFORE `sec`, seconds away on long-GOP
        # sources, so a retry meant to skip a black opening could land in the previous shot.
        return media.grab_ffmpeg(path, sec, accurate=True, max_edge=GRAB_MAX_EDGE)

    def replace_flat(images, times, start, end):
        """Reprend un peu plus loin les images qui n'ont aucun contenu. Un plan peut s'ouvrir sur
        plusieurs secondes de noir : la marge des bords ne suffit pas toujours, et un aplat embeddé
        rapproche le plan de tous les autres noirs de l'index."""
        for index, image in enumerate(images):
            if image is None or not sampling.is_flat(image):
                continue
            retry = sampling.retry_time(times[index], start, end)
            if retry is None:
                continue
            again = grab(retry)
            if again is not None and not sampling.is_flat(again):
                images[index] = again
        return images

    def to_frame(sec, ss, es):
        """Frame of the decoded stream shown at `sec`, kept inside the shot [ss, es)."""
        lo = int(round(ss * fps))
        hi = max(lo, int(round(es * fps)) - 1)
        return max(lo, min(hi, int(round(sec * fps))))

    def decode_shot(ci, meta, times):
        """Fallback, one shot at a time, when its segment could not be read in one pass. Precise
        seek: a keyframe seek returned the keyframe before the instant, often from the previous
        shot. Failure + FORCE = longer timeout (centre, then start)."""
        ss = meta[3]
        frames = media.grab_shot(path, times, max_edge=GRAB_MAX_EDGE, accurate=True)
        # `grab_shot` saute silencieusement un timestamp illisible : une liste plus courte ne dit
        # pas LEQUEL manque, donc on renonce à la reprise des aplats plutôt que de retenter au
        # mauvais endroit.
        if len(frames) == len(times):
            frames = replace_flat(list(frames), times, ss, meta[4])
        if not frames and force:
            im = (media.grab_ffmpeg(path, times[len(times) // 2], accurate=True, timeout=FORCE_TIMEOUT, max_edge=GRAB_MAX_EDGE)
                  or media.grab_ffmpeg(path, ss, accurate=True, timeout=FORCE_TIMEOUT, max_edge=GRAB_MAX_EDGE))
            if im is not None:
                frames = [im]
        return ci, meta, frames

    # Reading plan: each shot gives its instants (see `sampling`); consecutive shots are grouped
    # into SEGMENTS read by one exact sequential decode. A long gap between two instants ends the
    # segment: decoding every frame across it would cost more than a fresh seek.
    plans = []
    for ci, sc in enumerate(scenes):
        meta = scene_meta(sc)
        times = sampling.shot_times(meta[3], meta[4], sampling.frame_count(max(0.0, meta[4] - meta[3]), asked_frames))
        plans.append((ci, meta, times, [to_frame(x, meta[3], meta[4]) for x in times] if fps else []))
    segments = []
    gap = SEGMENT_GAP_SEC * fps
    for plan in plans:
        cur = segments[-1] if segments else None
        if (cur is not None and SHOT_DECODE and plan[3] and cur[-1][3] and len(cur) < SEGMENT_SHOTS
                and plan[3][0] - cur[-1][3][-1] <= gap):
            cur.append(plan)
        else:
            segments.append([plan])

    def decode_segment(seg):
        wanted = [f for plan in seg for f in plan[3]]
        images = media.grab_segment(path, fps, wanted, max_edge=GRAB_MAX_EDGE,
                                    threads=SEGMENT_THREADS) if wanted else None
        if images is None:
            return [decode_shot(ci, meta, times) for ci, meta, times, _ in seg]
        out, k = [], 0
        for ci, meta, times, frames in seg:
            shot = list(images[k:k + len(frames)]); k += len(frames)
            if any(im is None for im in shot):  # segment cut short: only these shots fall back
                out.append(decode_shot(ci, meta, times))
            else:
                out.append((ci, meta, replace_flat(shot, times, meta[3], meta[4])))
        return out

    def pool_scene(embs):
        """Plusieurs frames → 1 vecteur. spread (mouvement en espace embedding) < STATIC_THR →
        frame centrale ; sinon mean-pool re-normalisé L2."""
        if embs.shape[0] == 1:
            return embs[0]
        sims = embs @ embs.T
        iu = np.triu_indices(embs.shape[0], k=1)
        spread = 1.0 - float(sims[iu].min())
        if spread < STATIC_THR:
            return embs[embs.shape[0] // 2]
        m = embs.mean(axis=0)
        nrm = float(np.linalg.norm(m))
        return (m / nrm).astype(np.float32) if nrm > 0 else embs[embs.shape[0] // 2]

    # Progress = decode + embedding, each over n shots. Embedding a batch takes seconds: without a
    # beat during it, the UI declared the indexing stalled in the middle of normal work.
    work = {"decoded": 0, "embedded": 0.0}

    def report():
        done = work["decoded"] + work["embedded"]
        sys.stderr.write("STAGE:prog:%d/%d\n" % (int(done * 1000), 2 * n * 1000)); sys.stderr.flush()

    def embed_batched(frames, shots_count):
        """GPU sub-batches, one progress beat each. VRAM saturated → free and redo the sub-batch
        smaller."""
        out = []
        step = shots_count / max(1, len(frames))
        for i in range(0, len(frames), GPU_BATCH):
            sub = frames[i:i + GPU_BATCH]
            try:
                out.append(model.embed_images(sub))
            except RuntimeError:
                model.free_memory()
                out.append(model.embed_images(sub, batch=8))
            work["embedded"] += step * len(sub)
            report()
        return np.concatenate(out, axis=0)

    def embed_shots(shots):
        nonlocal skipped
        flat = []; owner = []  # owner[k] = position (dans shots) du plan de la frame flat[k]
        for pos, (_, _, frames) in enumerate(shots):
            for im in frames:
                flat.append(im); owner.append(pos)
        empty = sum(1 for _, _, frames in shots if not frames)
        work["embedded"] += empty
        eb = embed_batched(flat, len(shots) - empty) if flat else None
        per = [[] for _ in shots]
        for k, pos in enumerate(owner):
            per[pos].append(eb[k])
        for pos, (ci, meta, frames) in enumerate(shots):
            if not frames:
                skipped += 1  # aucune frame lisible → plan sauté (le clip continue)
                continue
            sf, ef, mid, ss, es = meta
            vec = pool_scene(np.stack(per[pos]))
            row_buf.append(
                (path, mt, MODEL_TAG, ci, sf, ef, mid, ss, es, fps, src_frames,
                 vec.astype(np.float32).tobytes(), int(vec.shape[0]), time.time())
            )
            if len(row_buf) >= 16:
                flush_rows()

    # Decode and GPU overlap: the next segments decode (ffmpeg processes, GIL released) while the
    # current batch embeds. Segments in flight are capped, so memory stays bounded.
    ready = []
    with ThreadPoolExecutor(max_workers=DECODE_WORKERS) as pool:
        queue = iter(segments)
        inflight = set()

        def fill():
            while len(inflight) < DECODE_WORKERS + 2:
                seg = next(queue, None)
                if seg is None:
                    return
                inflight.add(pool.submit(decode_segment, seg))

        fill()
        while inflight or ready:
            if inflight:
                finished, _ = wait(inflight, return_when=FIRST_COMPLETED)
                for fut in finished:
                    inflight.discard(fut)
                    shots = fut.result()
                    ready.extend(shots)
                    work["decoded"] += len(shots)
                fill()
                report()
            if ready and (len(ready) >= INDEX_CHUNK or not inflight):
                batch, ready = ready, []
                embed_shots(batch)

    flush_rows()
    # Reliquat du passage précédent : plans en trop d'une découpe plus courte, ou embeddings d'une
    # version antérieure du fichier (mtime ≠). Les plans sautés faute de frame lisible gardent leur
    # ancienne ligne quand le fichier n'a pas changé — mieux qu'un trou.
    con.execute(
        "DELETE FROM frame_embeddings_v1 WHERE file_path=? AND model=? AND (scene_index>=? OR mtime<>?)",
        (path, MODEL_TAG, n, mt),
    )
    # boucle terminée jusqu'au bout → marqueur de complétion (précis/rapide), même si quelques plans sautés
    con.execute(
        "INSERT OR REPLACE INTO index_runs_v1 (file_path,model,mtime,total,indexed,created_at,sampling) "
        "VALUES (?,?,?,?,?,?,?)", (path, MODEL_TAG, mt, n, indexed, time.time(),
                                   sampling_tag(fmt, cut_key)),
    )
    con.commit()
    nrident.remember(con, path)  # témoin d'identité (cf. python/nrident.py)
    con.close()
    return {"ok": True, "file": path, "indexed": indexed, "skipped": skipped,
            "total": n, "cached": False, "error": None}
