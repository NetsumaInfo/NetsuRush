"""Two-stage cut: the instant keyframe cut (python/detect.py) and the rule that keeps it from ever
standing in for the refined cut (python/nrsearch/media.py `_cached_cut`)."""
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import detect  # noqa: E402
from nrsearch import media, motion  # noqa: E402


class KeyframeScenesTests(unittest.TestCase):
    def test_shots_cover_the_file_from_keyframe_to_keyframe(self):
        scenes = detect.keyframe_scenes([0.0, 2.0, 5.0], 10.0, 80)
        self.assertEqual(scenes, [(0, 19), (20, 49), (50, 79)])

    def test_keyframes_past_the_end_and_duplicates_are_ignored(self):
        self.assertEqual(detect.keyframe_scenes([2.0, 2.01, 9.0], 10.0, 50), [(0, 19), (20, 49)])

    def test_no_keyframe_after_the_first_gives_one_shot(self):
        self.assertEqual(detect.keyframe_scenes([], 25.0, 10), [(0, 9)])


class CachedCutTests(unittest.TestCase):
    def setUp(self):
        fd, self.video = tempfile.mkstemp(suffix=".mkv")
        os.close(fd)
        self.mtime = os.path.getmtime(self.video)
        self.con = sqlite3.connect(":memory:")
        self.con.execute(
            """CREATE TABLE scene_cache_v4(file_path TEXT, mtime REAL, options_key TEXT, threshold REAL,
               fps REAL, duration REAL, frames INTEGER, scenes_json TEXT, model TEXT, options_json TEXT,
               created_at REAL)""")

    def tearDown(self):
        os.remove(self.video)

    def put(self, model, scenes, created):
        self.con.execute("INSERT INTO scene_cache_v4 VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                         (self.video, self.mtime, model, 0.0, 24.0, 1.0, 24, json.dumps(scenes), model, "{}", created))

    def test_keyframe_cut_never_answers_a_model_request(self):
        self.put("keyframes", [{"startFrame": 0, "endFrame": 23}], 1.0)
        self.assertIsNone(media._cached_cut(self.con, self.video, "transnetv2", 0.2, None))

    def test_keyframe_request_takes_the_better_cut_when_there_is_one(self):
        self.put("keyframes", [{"startFrame": 0, "endFrame": 23}], 2.0)
        self.put("omnishotcut", [{"startFrame": 0, "endFrame": 11}, {"startFrame": 12, "endFrame": 23}], 1.0)
        got = media._cached_cut(self.con, self.video, "keyframes", 0.0, None)
        self.assertEqual(len(got[2]), 1)  # its own row first...
        got = media._cached_cut(self.con, self.video, "transnetv2", 0.2, None)
        self.assertEqual(len(got[2]), 2)  # ...while a model request skips it for any real model


class MotionCarryTests(unittest.TestCase):
    def test_unchanged_shots_keep_their_measurement_for_the_same_file_version(self):
        con = sqlite3.connect(":memory:")
        motion.ensure_tables(con)
        raw = {"v": 1, "steps": 3, "cam": [0.1, 0.0, 0.0], "fit": 0.9, "moving": 0, "points": 0}
        motion.store(con, "a.mkv", 5.0, "k1", [(0, 0, 47), (1, 48, 95)], {0: (raw, raw), 1: (None, raw)})
        prev = motion.previous(con, "a.mkv", 5.0)
        self.assertEqual(prev[(0, 47)], (raw, raw))
        self.assertEqual(prev[(48, 95)], (None, raw))
        self.assertEqual(motion.previous(con, "a.mkv", 9.0), {})


if __name__ == "__main__":
    unittest.main()
