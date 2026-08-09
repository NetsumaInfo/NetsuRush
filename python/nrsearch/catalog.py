"""Commandes de catalogue (lecture SQLite seule, aucun modèle) : statistiques globales, état
d'indexation par clip (périmé / mode) et liste des plans d'un clip. Servent à griser/colorer le
picker et l'affichage paresseux des plans.

Les VIGNETTES ne passent plus par ici : elles viennent du cache partagé de l'application
(`core/thumbs.js`), le même qu'affiche le découpage, adressé par (fichier, instant)."""
from detect import file_mtime

from .config import MODEL_TAG, SAMPLING_RANK, sampling_mode
from .db import db_emb


# SQLite plafonne le nombre de paramètres liés d'une requête : une portée de plusieurs milliers de
# rushs se compte par tranches, agrégées en Python (chemins distincts → sommes valides).
PATH_CHUNK = 400


def path_chunks(file_paths):
    """Tranches de chemins uniques, ou [None] quand aucune portée n'est demandée (index entier)."""
    if file_paths is None:
        return [None]
    unique = list(dict.fromkeys(str(p) for p in file_paths if p))
    return [unique[i:i + PATH_CHUNK] for i in range(0, len(unique), PATH_CHUNK)] or [[]]


def cmd_status(file_paths=None):
    con = db_emb()
    clips = frames = 0
    try:
        for chunk in path_chunks(file_paths):
            sql = "SELECT COUNT(DISTINCT file_path), COUNT(*) FROM frame_embeddings_v1 WHERE model=?"
            args = [MODEL_TAG]
            if chunk is not None:
                if not chunk:
                    continue
                sql += " AND file_path IN (%s)" % ",".join("?" * len(chunk))
                args += chunk
            row = con.execute(sql, args).fetchone()
            clips += row[0] or 0
            frames += row[1] or 0
    finally:
        con.close()
    return {"clips": clips, "frames": frames, "model": MODEL_TAG, "error": None}


def cmd_indexed():
    """État d'indexation par clip : nb de plans et périmé (mtime fichier ≠ mtime indexé).
    Pour griser/colorer le picker."""
    con = db_emb()
    rows = con.execute(
        "SELECT file_path, COUNT(*), MAX(mtime) "
        "FROM frame_embeddings_v1 WHERE model=? GROUP BY file_path", (MODEL_TAG,),
    ).fetchall()
    runs = {r[0]: (r[1], r[2], r[3], r[4]) for r in con.execute(
        "SELECT file_path, mtime, total, indexed, sampling FROM index_runs_v1 WHERE model=?", (MODEL_TAG,))}
    con.close()
    out = {}
    for path, cnt, mt in rows:
        fmt = file_mtime(path)
        stale = abs((mt or 0) - fmt) > 1.0
        # complet = un marqueur de complétion existe et correspond au fichier actuel ; sinon le clip
        # a été interrompu (app fermée en plein traitement) → à re-traiter, pas "fait".
        run = runs.get(path)
        complete = run is not None and abs((run[0] or 0) - fmt) <= 1.0
        # failed = plans tentés mais non embeddés (frames illisibles sautées) → réessai possible.
        failed = max(0, (run[1] or 0) - (run[2] or 0)) if complete else 0
        # mode = format d'indexation (cf. config.SAMPLING_RANK, plus 'image' | None). Permet à l'UI
        # de proposer un passage vers un format plus riche. Le marqueur porte aussi la clé de découpe
        # ('adaptive:<cut_key>') : on ne renvoie que le format, sinon aucune comparaison ne matche.
        mode = sampling_mode(run[3]) if run else None
        # legacy = format inconnu, donc antérieur au marqueur → ré-index possible pour la précision.
        legacy = complete and mode not in SAMPLING_RANK and mode != "image"
        out[path] = {"frames": cnt, "stale": stale,
                     "complete": complete, "failed": failed, "legacy": legacy, "mode": mode}
    return {"indexed": out, "error": None}


def cmd_shots(file_path):
    """Liste les plans indexés d'un clip — MÉTADONNÉES SEULES, qui suffisent : les bornes du plan
    désignent sa vignette dans le cache partagé, que le renderer résout par lot."""
    if not file_path:
        return {"shots": [], "error": None}
    con = db_emb()
    try:  # métadonnées seules (PAS le blob embedding) → requête légère et rapide
        rows = con.execute(
            "SELECT scene_index, start_frame, end_frame, mid_frame, start_sec, end_sec, fps, src_frames "
            "FROM frame_embeddings_v1 WHERE file_path=? AND model=? ORDER BY scene_index",
            (file_path, MODEL_TAG)).fetchall()
    finally:
        con.close()
    shots = [{"file_path": file_path, "scene_index": r[0], "start_frame": r[1], "end_frame": r[2],
              "mid_frame": r[3], "start_sec": r[4], "end_sec": r[5], "fps": r[6], "src_frames": r[7],
              "score": None} for r in rows]
    return {"shots": shots, "error": None}
