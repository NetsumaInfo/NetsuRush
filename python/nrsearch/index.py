"""Indexation : 1 vecteur représentatif par plan, ou image fixe (1 frame). Le nombre d'images est un
RÉGLAGE (1 à 3) ; où les prendre et quand en ajouter une est décidé par `sampling`. Décodage ffmpeg
parallèle + embedding GPU par gros batches. Marqueur de complétion écrit seulement en fin de clip
(distingue un clip interrompu d'un clip fait)."""
import sys
import time

import numpy as np

from detect import file_mtime

from . import media, model
from . import sampling
from .config import (DECODE_WORKERS, DEFAULT_SAMPLING_FRAMES, FORCE_TIMEOUT, GRAB_MAX_EDGE,
                     INDEX_CHUNK, MODEL_TAG, SHOT_DECODE, STATIC_THR, is_image, sampling_current,
                     sampling_format, sampling_frames, sampling_tag)
from .db import db_emb


def _index_image(path, mt, force=False):
    """Image fixe = 1 plan (l'image entière). Aucune détection de plans : on embed directement
    (sinon TransNetV2 tournerait sur 1 image = long pour rien)."""
    from PIL import Image
    con = db_emb()
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
                "error": "image illisible: %s" % exc}
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
    if not force and n > 0 and done and done[1] == n and done[0] is not None and abs(done[0] - mt) <= 1.0 and current_fmt:
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

    from concurrent.futures import ThreadPoolExecutor, as_completed

    def scene_meta(sc):
        sf = int(sc.get("startFrame", 0)); ef = int(sc.get("endFrame", sf))
        mid = (sf + ef) // 2
        ss = sc.get("start", sf / fps if fps else 0.0)
        es = sc.get("end", (ef + 1) / fps if fps else 0.0)
        return sf, ef, mid, ss, es

    def grab(sec):
        return media.grab_ffmpeg(path, sec, max_edge=GRAB_MAX_EDGE)

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

    def decode_shot(ci_sc):
        """Toutes les images d'un plan en UN passage : leur nombre ne dépend que de sa durée, donc
        rien ne reste à décider après coup. Échec + FORCER = seek précis (centre puis début)."""
        ci, sc = ci_sc
        sf, ef, mid, ss, es = scene_meta(sc)
        times = sampling.shot_times(ss, es, sampling.frame_count(max(0.0, es - ss), asked_frames))
        if SHOT_DECODE and len(times) > 1:
            frames = media.grab_shot(path, times, max_edge=GRAB_MAX_EDGE)
            # `grab_shot` saute silencieusement un timestamp illisible : une liste plus courte ne dit
            # pas LEQUEL manque, donc on ne peut plus apparier images et instants — on renonce à la
            # reprise des aplats plutôt que de retenter au mauvais endroit.
            if len(frames) == len(times):
                frames = replace_flat(list(frames), times, ss, es)
        else:
            frames = replace_flat([grab(t) for t in times], times, ss, es)
            frames = [im for im in frames if im is not None]
        if not frames and force:
            im = (media.grab_ffmpeg(path, times[len(times) // 2], accurate=True, timeout=FORCE_TIMEOUT, max_edge=GRAB_MAX_EDGE)
                  or media.grab_ffmpeg(path, ss, accurate=True, timeout=FORCE_TIMEOUT, max_edge=GRAB_MAX_EDGE))
            if im is not None:
                frames = [im]
        return ci, (sf, ef, mid, ss, es), frames

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

    def embed_batched(frames):
        """1 gros batch GPU (sature le GPU). VRAM saturée → libère et reprend en plus petits batches."""
        if not frames:
            return np.zeros((0, 0), dtype=np.float32)
        try:
            return model.embed_images(frames)
        except RuntimeError:
            model.free_memory()
            return model.embed_images(frames, batch=8)

    proc = 0  # plans décodés (progression : le décodage domine le temps)
    with ThreadPoolExecutor(max_workers=DECODE_WORKERS) as pool:
        for cstart in range(0, n, INDEX_CHUNK):
            chunk = scenes[cstart:cstart + INDEX_CHUNK]
            shots = [None] * len(chunk)   # shots[ci] = (meta, images décodées)
            futs = {pool.submit(decode_shot, (idx, sc)): idx for idx, sc in enumerate(chunk)}
            for fut in as_completed(futs):  # progression fluide au fil des décodages parallèles
                ci, meta, frames = fut.result()
                shots[ci] = (meta, frames)
                proc += 1
                sys.stderr.write("STAGE:prog:%d/%d\n" % (proc, n)); sys.stderr.flush()
            flat = []; owner = []  # owner[k] = index (dans chunk) du plan de la frame flat[k]
            for ci, (meta, frames) in enumerate(shots):
                for im in frames:
                    flat.append(im); owner.append(ci)
            eb = embed_batched(flat)
            per = [[] for _ in chunk]  # per[ci] = embeddings du plan
            for k, ci in enumerate(owner):
                per[ci].append(eb[k])
            for ci, (meta, frames) in enumerate(shots):
                if not frames:
                    skipped += 1  # aucune frame lisible → plan sauté (le clip continue)
                    continue
                sf, ef, mid, ss, es = meta
                vec = pool_scene(np.stack(per[ci]))
                row_buf.append(
                    (path, mt, MODEL_TAG, cstart + ci, sf, ef, mid, ss, es, fps, src_frames,
                     vec.astype(np.float32).tobytes(), int(vec.shape[0]), time.time())
                )
                if len(row_buf) >= 16:
                    flush_rows()
            shots = None  # libère les frames décodées du lot (mémoire bornée)

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
    con.close()
    return {"ok": True, "file": path, "indexed": indexed, "skipped": skipped,
            "total": n, "cached": False, "error": None}
