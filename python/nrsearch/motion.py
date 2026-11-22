"""How a shot moves as it opens and as it closes: camera (pan, zoom) and subject (direction, speed).

SigLIP describes what a shot SHOWS, never which way it moves, yet that is what an editor matches on
when chaining two shots (a character leaving frame right should enter the next one from the left).
This module measures the first and the last ~0.4 s of every shot with classical sparse optical flow
(no model, CPU only) and stores a few raw numbers per edge. Tags are derived from those numbers on
every read (`tags`), so thresholds can move without re-measuring anything.

Units: velocities in frame widths per second (independent of the analysis size), zoom in log scale
per second. +x is right, +y is down.

Decoding: one ffmpeg per group of shots, accurate seek to the group's first edge, `select` keeps
only the edge frames, output is raw greyscale at a small fixed width. Nothing else is decoded twice.
"""

import json
import math
import subprocess

import numpy as np

from ffbin import ffmpeg_bin, ffprobe_bin

VERSION = 1

EDGE_SEC = 0.4          # length of each measured edge
EDGE_MAX_FRAMES = 10    # frames kept per edge (60 fps sources keep the 10 closest to the edge)
WIDTH = 320             # analysis width; thresholds do not depend on it
SHOTS_PER_DECODE = 48   # max shots per ffmpeg process (bounds the `select` expression length)
GAP_SEC = 10.0          # a longer jump between two edges starts a new decode (cheaper than decoding the gap)

HOLD_DIFF = 0.6         # mean grey difference under which a frame repeats the previous drawing
MIN_POINTS = 12
PAN_MIN = 0.05
ZOOM_MIN = 0.10
STILL = 0.06
MEDIUM = 0.22
FAST = 0.60
FIT_MIN = 0.35          # share of tracked points the camera model must explain to be trusted
SUBJECT_POINTS = 10     # moving points needed before a subject direction is reported
AGREE_MIN = 0.55        # 1 = every step points the same way, 0 = they cancel out

DIRECTIONS = ("right", "down-right", "down", "down-left", "left", "up-left", "up", "up-right")


def _cv2():
    import cv2
    return cv2


# ---------------------------------------------------------------- measurement


def _drawings(frames, times):
    """One frame per drawing. Anime holds each drawing two or three frames: measured frame to frame,
    half the steps show no motion and a running character reads as still. Measured drawing to
    drawing, over the real time between them, the speed is right. A window that never changes
    keeps its two ends and its middle so a static shot still measures (as zero)."""
    cv2 = _cv2()
    picked = [0]
    for i in range(1, len(frames)):
        if float(cv2.absdiff(frames[i], frames[picked[-1]]).mean()) >= HOLD_DIFF:
            picked.append(i)
    if len(picked) < 3 <= len(frames):
        picked = [0, len(frames) // 2, len(frames) - 1]
    return [frames[i] for i in picked], [times[i] for i in picked]


def _agreement(steps):
    lengths = np.linalg.norm(steps, axis=1)
    live = lengths > 1e-6
    if not live.any():
        return 0.0
    return float(np.linalg.norm((steps[live] / lengths[live, None]).mean(axis=0)))


def measure(frames, times):
    """Raw motion of one edge from greyscale frames (uint8, same size) and their times in seconds.
    None when nothing can be measured (too few frames, flat image)."""
    cv2 = _cv2()
    if len(frames) != len(times) or len(frames) < 3:
        return None
    frames, times = _drawings(frames, times)
    if len(frames) < 3:
        return None
    height, width = frames[0].shape[:2]
    points = cv2.goodFeaturesToTrack(frames[0], maxCorners=400, qualityLevel=0.01, minDistance=6)
    if points is None or len(points) < MIN_POINTS:
        return None
    moving_px = max(1.0, 0.004 * width)
    centre = np.array([[[width / 2.0, height / 2.0]]], np.float32)
    lk = dict(winSize=(21, 21), maxLevel=3)

    cam, zoom, fit, subject, counts = [], [], [], [], []
    for i in range(1, len(frames)):
        dt = times[i] - times[i - 1]
        if dt <= 0:
            continue
        ahead, ok_a, _ = cv2.calcOpticalFlowPyrLK(frames[i - 1], frames[i], points, None, **lk)
        back, ok_b, _ = cv2.calcOpticalFlowPyrLK(frames[i], frames[i - 1], ahead, None, **lk)
        # forward-backward check: a point that does not track back to where it started is noise
        good = (ok_a.ravel() == 1) & (ok_b.ravel() == 1) & (np.linalg.norm(points - back, axis=2).ravel() < 1.0)
        if good.sum() < MIN_POINTS:
            break
        src, dst = points[good], ahead[good]
        matrix, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=2.0)
        if matrix is None:
            break
        # the pan is how far the frame CENTRE moves: the matrix translation is about the corner,
        # where a pure zoom would also read as a translation
        moved = cv2.transform(centre, matrix)[0, 0] - centre[0, 0]
        cam.append(moved / width / dt)
        zoom.append(math.log(max(1e-6, math.hypot(matrix[0, 0], matrix[1, 0]))) / dt)
        fit.append(float(inliers.mean()) if inliers is not None else 0.0)
        flat_src, flat_dst = src.reshape(-1, 2), dst.reshape(-1, 2)
        residual = flat_dst - cv2.transform(src, matrix).reshape(-1, 2)
        independent = np.linalg.norm(residual, axis=1) > moving_px
        counts.append(int(independent.sum()))
        if independent.sum() >= SUBJECT_POINTS:
            # on-screen velocity of what moves on its own: what the viewer sees travel
            subject.append(np.median(flat_dst[independent] - flat_src[independent], axis=0) / width / dt)
        points = dst.reshape(-1, 1, 2)

    if not cam:
        return None
    cam_mean = np.mean(np.asarray(cam), axis=0)
    raw = {
        "v": VERSION,
        "steps": len(cam),
        "cam": [round(float(cam_mean[0]), 4), round(float(cam_mean[1]), 4), round(float(np.mean(zoom)), 4)],
        "fit": round(float(np.mean(fit)), 3),
        "moving": len(subject),
        "points": int(np.median(counts)) if counts else 0,
    }
    if subject:
        steps = np.asarray(subject)
        mean = steps.mean(axis=0)
        raw["subj"] = [round(float(mean[0]), 4), round(float(mean[1]), 4)]
        raw["agree"] = round(_agreement(steps), 3)
    return raw


# ---------------------------------------------------------------- tags


def direction(vx, vy):
    """Eight 45° sectors, +y down."""
    angle = math.degrees(math.atan2(vy, vx)) % 360.0
    return DIRECTIONS[int(((angle + 22.5) % 360.0) // 45.0)]


def _speed(value):
    return "fast" if value >= FAST else "medium" if value >= MEDIUM else "slow"


def camera_tag(raw):
    if not raw or raw.get("steps", 0) < 2 or raw.get("fit", 0.0) < FIT_MIN:
        return "unclear"
    vx, vy, z = raw["cam"]
    pan = math.hypot(vx, vy)
    if abs(z) >= ZOOM_MIN and abs(z) * 0.5 >= pan:
        return "zoom-in" if z > 0 else "zoom-out"
    if pan >= PAN_MIN:
        # the picture sliding right means the camera turns left
        return "pan-" + direction(-vx, -vy)
    return "static"


def subject_tag(raw):
    """(direction | "still" | "unclear", speed or None)."""
    if not raw or raw.get("steps", 0) < 2:
        return "unclear", None
    if raw.get("moving", 0) * 2 < raw["steps"]:
        # nothing moves on its own for most of the edge; only trust that over a solid camera fit
        return ("still", None) if camera_tag(raw) != "unclear" else ("unclear", None)
    if raw.get("agree", 0.0) < AGREE_MIN or raw.get("points", 0) < SUBJECT_POINTS or "subj" not in raw:
        return "unclear", None
    vx, vy = raw["subj"]
    speed = math.hypot(vx, vy)
    if speed < STILL:
        return "still", None
    return direction(vx, vy), _speed(speed)


def tags(raw):
    subject, speed = subject_tag(raw)
    return {"subject": subject, "camera": camera_tag(raw), "speed": speed}


def shot_tags(start_raw, end_raw):
    return {"start": tags(start_raw), "end": tags(end_raw)}


def tag_matches(tag, wanted):
    """`wanted` is a coarse request: "left" matches left, up-left and down-left; "pan-left" the same
    for the camera. Exact tags ("zoom-in", "still", "static") only match themselves."""
    if not tag or tag == "unclear":
        return False
    if tag == wanted:
        return True
    base_tag = tag[4:] if tag.startswith("pan-") else tag
    if wanted.startswith("pan-"):
        if not tag.startswith("pan-"):
            return False
        wanted = wanted[4:]
    elif tag.startswith("pan-"):
        return False
    return wanted in DIRECTIONS[::2] and wanted in base_tag.split("-")


# ---------------------------------------------------------------- decoding


def edge_ranges(start_frame, end_frame, fps):
    """Inclusive frame ranges of the opening and closing edges of one shot (they overlap on a short
    shot, which is fine: each edge is measured on its own)."""
    span = max(1, min(EDGE_MAX_FRAMES, int(round(EDGE_SEC * fps)) if fps else 3))
    sf, ef = int(start_frame), max(int(start_frame), int(end_frame))
    return (sf, min(ef, sf + span - 1)), (max(sf, ef - span + 1), ef)


def _probe_size(path):
    try:
        out = subprocess.run(
            [ffprobe_bin(), "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height:stream_side_data=rotation", "-of", "json", path],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30).stdout.decode()
        stream = (json.loads(out).get("streams") or [{}])[0]
        w, h = int(stream.get("width") or 0), int(stream.get("height") or 0)
        rotation = 0
        for side in stream.get("side_data_list") or []:
            rotation = int(side.get("rotation") or 0) or rotation
        if abs(rotation) % 180 == 90:
            w, h = h, w
        return w, h
    except Exception:  # noqa: BLE001
        return 0, 0


def _groups(shots, fps, workers=1):
    """Shots grouped into decodes: consecutive, split at long gaps, and small enough that every
    worker gets one (decoding is the whole cost, a short file in four groups left half the cores idle)."""
    gap = GAP_SEC * fps
    per = max(8, min(SHOTS_PER_DECODE, -(-len(shots) // max(1, workers))))
    groups = []
    for shot in shots:
        current = groups[-1] if groups else None
        if (current is not None and len(current) < per
                and shot[1][0][0] - current[-1][1][1][1] <= gap):
            current.append(shot)
        else:
            groups.append([shot])
    return groups


def _decode_group(path, fps, size, group, threads, timeout):
    """Grey frames of every edge in `group`, keyed by absolute frame index. Empty on failure."""
    wanted = sorted({f for _, (a, b) in group for lo, hi in (a, b) for f in range(lo, hi + 1)})
    if not wanted:
        return {}
    first, last = wanted[0], wanted[-1]
    spans, lo = [], wanted[0]
    for prev, cur in zip(wanted, wanted[1:] + [None]):
        if cur is None or cur != prev + 1:
            spans.append((lo, prev))
            lo = cur
    terms = "+".join("between(n,%d,%d)" % (a - first, b - first) for a, b in spans)
    width, height = size
    vf = "select='%s',scale=%d:%d:flags=area,format=gray" % (terms, width, height)
    start = max(0.0, (first - 0.5) / fps)
    # no deblocking: ~10 % less decode, invisible once shrunk to the analysis width
    cmd = [ffmpeg_bin(), "-nostdin", "-v", "error", "-skip_loop_filter", "all"]
    if threads:
        cmd += ["-threads", str(threads)]
    if start > 0:
        cmd += ["-ss", "%.4f" % start]
    cmd += ["-i", path, "-t", "%.4f" % ((last - first + 2) / fps), "-map", "0:v:0", "-vf", vf,
            "-fps_mode", "passthrough", "-frames:v", str(len(wanted)), "-f", "rawvideo", "-"]
    try:
        out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             timeout=timeout + (last - first) / max(fps, 1.0)).stdout
    except Exception:  # noqa: BLE001  (timeout or missing binary: these shots stay unmeasured)
        return {}
    frame_bytes = width * height
    count = len(out) // frame_bytes
    if count != len(wanted):
        # a frame missing somewhere says nothing about WHICH one: refuse to guess
        return {}
    pixels = np.frombuffer(out, np.uint8)[: count * frame_bytes].reshape(count, height, width)
    return dict(zip(wanted, pixels))


def measure_file(path, fps, shots, workers=4, threads=0, timeout=30.0, on_progress=None):
    """{scene_index: (start_raw, end_raw)} for `shots` = [(scene_index, start_frame, end_frame)].
    Shots that could not be decoded are left out (they read as unclear)."""
    from concurrent.futures import ThreadPoolExecutor

    if not fps or not shots:
        return {}
    w, h = _probe_size(path)
    if not w or not h:
        return {}
    size = (WIDTH, max(2, int(round(h * WIDTH / w / 2.0)) * 2))
    planned = [(index, edge_ranges(sf, ef, fps)) for index, sf, ef in shots]
    groups = _groups(planned, fps, workers)
    done = [0]

    def run(group):
        frames = _decode_group(path, fps, size, group, threads, timeout)
        result = {}
        for index, edges in group:
            raws = []
            for lo, hi in edges:
                window = [frames.get(f) for f in range(lo, hi + 1)]
                if not window or any(img is None for img in window):
                    raws.append(None)
                    continue
                try:
                    raws.append(measure(window, [f / fps for f in range(lo, hi + 1)]))
                except Exception:  # noqa: BLE001  (one bad edge stays unclear, never fails the file)
                    raws.append(None)
            if frames:
                result[index] = (raws[0], raws[1])
        return group, result

    measured = {}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for group, result in pool.map(run, groups):
            measured.update(result)
            done[0] += len(group)
            if on_progress:
                on_progress(done[0], len(planned))
    return measured


# ---------------------------------------------------------------- storage


def ensure_tables(con):
    con.execute(
        """CREATE TABLE IF NOT EXISTS shot_motion_v1(
            file_path TEXT, mtime REAL, scene_index INTEGER, start_frame INTEGER, end_frame INTEGER,
            start_raw TEXT, end_raw TEXT, PRIMARY KEY(file_path, scene_index))"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS motion_runs_v1(
            file_path TEXT PRIMARY KEY, mtime REAL, cut_key TEXT, version INTEGER, total INTEGER,
            created_at REAL)"""
    )


def is_current(con, path, mtime, cut_key, total):
    row = con.execute(
        "SELECT mtime, cut_key, version, total FROM motion_runs_v1 WHERE file_path=?", (path,)
    ).fetchone()
    return bool(row and row[0] is not None and abs(row[0] - mtime) <= 1.0 and row[1] == cut_key
                and row[2] == VERSION and row[3] == total)


def store(con, path, mtime, cut_key, shots, measured):
    import time
    rows = []
    for index, sf, ef in shots:
        start_raw, end_raw = measured.get(index, (None, None))
        rows.append((path, mtime, index, sf, ef,
                     json.dumps(start_raw, separators=(",", ":")) if start_raw else None,
                     json.dumps(end_raw, separators=(",", ":")) if end_raw else None))
    con.execute("DELETE FROM shot_motion_v1 WHERE file_path=?", (path,))
    con.executemany("INSERT OR REPLACE INTO shot_motion_v1 VALUES (?,?,?,?,?,?,?)", rows)
    con.execute("INSERT OR REPLACE INTO motion_runs_v1 VALUES (?,?,?,?,?,?)",
                (path, mtime, cut_key, VERSION, len(shots), time.time()))
    con.commit()


def tags_for_hits(con, hits):
    """Attach `motion` ({"start": tags, "end": tags}) to every hit whose shot was measured with the
    same boundaries. Hits without a measurement get nothing (the UI shows no badge)."""
    by_file = {}
    for hit in hits:
        by_file.setdefault(hit.get("file_path"), []).append(hit)
    for path, group in by_file.items():
        if not path:
            continue
        rows = {}
        for index, sf, ef, start_raw, end_raw in con.execute(
                "SELECT scene_index, start_frame, end_frame, start_raw, end_raw FROM shot_motion_v1 "
                "WHERE file_path=?", (path,)):
            rows[int(index)] = (sf, ef, start_raw, end_raw)
        for hit in group:
            row = rows.get(int(hit.get("scene_index", -1)))
            if row is None:
                continue
            if hit.get("start_frame") is not None and (row[0] != hit["start_frame"] or row[1] != hit["end_frame"]):
                continue
            hit["motion"] = shot_tags(json.loads(row[2]) if row[2] else None,
                                      json.loads(row[3]) if row[3] else None)
    return hits
