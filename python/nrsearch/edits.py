"""Corrections of the search database, for the user or an agent fixing bad data.

- `forget`: drop a file from the shot index, the face index and/or the scene cache, so it can be
  re-indexed cleanly (or disappear from results).
- `set-scenes`: impose corrected shot boundaries on a file. They are stored as a scene cache row of
  model "manual", which `media._cached_cut` prefers over any detection; the next `index` sees the
  boundaries moved (`cut_identity`) and re-embeds only that file.
- `face-label`: assign one indexed face to a character, or mark it as nobody. Overrides live in
  their own table and are re-applied after every automatic labelling, which purges and rebuilds
  `face_labels_v1` — a correction must not be erased by the next "label faces" run.
"""
import json
import time

from detect import db as scene_db
from detect import file_mtime

from .db import db_emb

MANUAL_MODEL = "manual"

_INDEX_TABLES = ["frame_embeddings_v1", "index_runs_v1", "shot_motion_v1", "motion_runs_v1"]
_FACE_TABLES = ["face_embeddings_v2", "face_index_runs_v1", "face_labels_v1", "face_label_overrides_v1"]
_SCENE_TABLES = ["scene_cache_v4", "scene_cache_v3"]


def _overrides_table(con):
    con.execute(
        """CREATE TABLE IF NOT EXISTS face_label_overrides_v1(
            file_path TEXT, scene_index INTEGER, face_index INTEGER, domain TEXT,
            char_id INTEGER, created_at REAL,
            PRIMARY KEY(file_path, scene_index, face_index, domain))"""
    )


def apply_label_overrides(con):
    """Re-applies the manual face labels on top of `face_labels_v1` (char_id NULL = nobody)."""
    _overrides_table(con)
    rows = con.execute(
        "SELECT file_path, scene_index, face_index, domain, char_id FROM face_label_overrides_v1"
    ).fetchall()
    for fp, si, fi, dom, cid in rows:
        con.execute(
            "DELETE FROM face_labels_v1 WHERE file_path=? AND scene_index=? AND face_index=? AND domain=?",
            (fp, si, fi, dom),
        )
        if cid is not None:
            con.execute(
                "INSERT INTO face_labels_v1(file_path, scene_index, face_index, domain, char_id, score) "
                "VALUES (?,?,?,?,?,?)", (fp, si, fi, dom, int(cid), 1.0),
            )
    return len(rows)


def _delete(con, tables, paths):
    removed = {}
    for table in tables:
        try:
            cur = con.execute(
                "DELETE FROM %s WHERE file_path IN (%s)" % (table, ",".join("?" * len(paths))), paths,
            )
            removed[table] = cur.rowcount
        except Exception:  # noqa: BLE001 — table absent from an older database
            removed[table] = 0
    return removed


def cmd_forget(req):
    paths = [str(p) for p in (req.get("file_paths") or []) if p]
    kinds = set(req.get("kinds") or ["search", "faces"])
    if not paths:
        return {"ok": False, "error": "file_paths is empty"}
    con = db_emb()
    try:
        _overrides_table(con)
        removed = {}
        if "search" in kinds:
            removed.update(_delete(con, _INDEX_TABLES, paths))
        if "faces" in kinds:
            removed.update(_delete(con, _FACE_TABLES, paths))
        if "scenes" in kinds:
            removed.update(_delete(con, _SCENE_TABLES, paths))
        con.commit()
        return {"ok": True, "removed": removed}
    finally:
        con.close()


def cmd_set_scenes(req):
    path = str(req.get("path") or "")
    raw = req.get("scenes")
    if not path or not isinstance(raw, list) or not raw:
        return {"ok": False, "error": "path and a non-empty scenes list are required"}
    con = scene_db()   # creates the scene cache tables on a fresh database
    try:
        fps = float(req.get("fps") or 0)
        nframes = int(req.get("frames") or 0)
        if not fps or not nframes:
            # Borrow fps and frame count from the detection already cached for this file.
            for table in _SCENE_TABLES:
                try:
                    row = con.execute(
                        "SELECT fps, frames FROM %s WHERE file_path=? AND model<>? ORDER BY created_at DESC LIMIT 1"
                        % table, (path, MANUAL_MODEL),
                    ).fetchone()
                except Exception:  # noqa: BLE001
                    row = None
                if row and row[0]:
                    fps = fps or float(row[0])
                    nframes = nframes or int(row[1] or 0)
                    break
        if not fps:
            return {"ok": False, "error": "unknown fps: pass fps (and frames), or detect the file's shots first"}
        scenes = []
        for s in sorted(raw, key=lambda x: int(x.get("startFrame", x.get("inFrame", 0)))):
            start = int(s.get("startFrame", s.get("inFrame", 0)))
            end = int(s.get("endFrame", s.get("outFrame", start)))
            if end < start:
                return {"ok": False, "error": "scene ends before it starts: %d-%d" % (start, end)}
            scenes.append({"startFrame": start, "endFrame": end, "start": start / fps, "end": (end + 1) / fps})
        for prev, cur in zip(scenes, scenes[1:]):
            if cur["startFrame"] <= prev["endFrame"]:
                return {"ok": False, "error": "scenes overlap at frame %d" % cur["startFrame"]}
        nframes = nframes or scenes[-1]["endFrame"] + 1
        con.execute(
            "INSERT OR REPLACE INTO scene_cache_v4 VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (path, file_mtime(path), MANUAL_MODEL, 0.0, fps, nframes / fps, nframes,
             json.dumps(scenes), MANUAL_MODEL, json.dumps({"manual": True}), time.time()),
        )
        con.commit()
        return {"ok": True, "scenes": len(scenes), "fps": fps, "frames": nframes,
                "note": "Run index on this file to re-embed it with these shots."}
    finally:
        con.close()


def cmd_clear_scenes(req):
    """Drops the manual boundaries of a file: the next index falls back to detection."""
    path = str(req.get("path") or "")
    con = db_emb()
    try:
        cur = con.execute("DELETE FROM scene_cache_v4 WHERE file_path=? AND model=?", (path, MANUAL_MODEL))
        con.commit()
        return {"ok": True, "removed": cur.rowcount}
    finally:
        con.close()


def cmd_face_label(req):
    path = str(req.get("file_path") or "")
    if not path or req.get("scene_index") is None or req.get("face_index") is None:
        return {"ok": False, "error": "file_path, scene_index and face_index are required"}
    domain = str(req.get("domain") or "anime")
    cid = req.get("char_id")
    con = db_emb()
    try:
        _overrides_table(con)
        if req.get("reset"):
            con.execute(
                "DELETE FROM face_label_overrides_v1 WHERE file_path=? AND scene_index=? AND face_index=? AND domain=?",
                (path, int(req["scene_index"]), int(req["face_index"]), domain),
            )
            con.commit()
            return {"ok": True, "reset": True, "note": "Re-run character label_index to recompute this face."}
        con.execute(
            "INSERT OR REPLACE INTO face_label_overrides_v1 VALUES (?,?,?,?,?,?)",
            (path, int(req["scene_index"]), int(req["face_index"]), domain,
             None if cid is None else int(cid), time.time()),
        )
        apply_label_overrides(con)
        con.commit()
        return {"ok": True, "char_id": cid}
    finally:
        con.close()
