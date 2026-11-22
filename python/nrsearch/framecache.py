"""Analysed frames, kept per FRAME instead of per shot.

A shot vector is a pool of a few analysed frames. Stored alone, it dies with the cut: change the
boundaries (a refined cut replacing a fast one, a hand split) and every shot whose edges moved had
to be decoded and embedded again. Kept per frame, the vectors outlive the cut: a new shot that
already holds analysed frames is pooled from them in a fraction of a second, and only shots holding
none are decoded. Measured on real rushes, 85-95 % of the shots of a refined cut already hold an
analysed frame from the fast cut.

Vectors are stored in float16 (half the size, cosine error far below anything a ranking sees) and
are only valid for the file version (mtime) and model they were computed with.
"""
import bisect

import numpy as np

TABLE = "frame_vectors_v1"


def ensure_table(con):
    con.execute(
        """CREATE TABLE IF NOT EXISTS frame_vectors_v1(
            file_path TEXT, model TEXT, frame INTEGER, mtime REAL, embedding BLOB,
            PRIMARY KEY(file_path, model, frame))"""
    )


def load(con, path, model, mtime):
    """{frame: float32 vector} of the analysed frames of this file version."""
    out = {}
    for frame, stored_mtime, blob in con.execute(
            "SELECT frame, mtime, embedding FROM frame_vectors_v1 WHERE file_path=? AND model=?",
            (path, model)):
        if stored_mtime is None or abs(stored_mtime - mtime) > 1.0 or not blob:
            continue
        out[int(frame)] = np.frombuffer(blob, dtype=np.float16).astype(np.float32)
    return out


def store(con, path, model, mtime, items):
    """`items` = [(frame, float32 vector)]. Caller commits."""
    if items:
        con.executemany(
            "INSERT OR REPLACE INTO frame_vectors_v1 VALUES (?,?,?,?,?)",
            [(path, model, int(f), mtime, np.asarray(v, dtype=np.float16).tobytes()) for f, v in items])


def drop_stale(con, path, model, mtime):
    con.execute("DELETE FROM frame_vectors_v1 WHERE file_path=? AND model=? AND ABS(mtime-?)>1.0",
                (path, model, mtime))


def frames_inside(sorted_frames, start_frame, end_frame):
    """Analysed frames usable for the shot [start_frame, end_frame] (inclusive). The first and last
    frame of a shot are left out when it is long enough: a frame that sat on a cut the old
    boundaries missed belongs to the transition, not to the shot."""
    lo, hi = int(start_frame), int(end_frame)
    if hi - lo >= 4:
        lo, hi = lo + 1, hi - 1
    return sorted_frames[bisect.bisect_left(sorted_frames, lo):bisect.bisect_right(sorted_frames, hi)]


def plan_reuse(sorted_frames, start_frame, end_frame, wanted_frames):
    """Split the sampling of one shot between frames already analysed and frames to decode.

    `wanted_frames` = the frame indices the sampling would take. Returns (reuse, missing):
    `reuse` = analysed frames standing in for some of them, `missing` = the wanted frames no
    analysed frame stands in for (decode only those). An analysed frame stands in for a wanted one
    when it lies within half the spacing between wanted frames: close enough to show the same
    moment of the shot."""
    inside = frames_inside(sorted_frames, start_frame, end_frame)
    if not inside:
        return [], list(wanted_frames)
    span = max(1, int(end_frame) - int(start_frame))
    tol = max(2, span // (2 * max(1, len(wanted_frames))))
    reuse, missing, taken = [], [], set()
    for f in wanted_frames:
        k = bisect.bisect_left(inside, f)
        best = None
        for c in inside[max(0, k - 1):k + 1]:
            if c not in taken and abs(c - f) <= tol and (best is None or abs(c - f) < abs(best - f)):
                best = c
        if best is None:
            missing.append(f)
        else:
            taken.add(best)
            reuse.append(best)
    return reuse, missing
