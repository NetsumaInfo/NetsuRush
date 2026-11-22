"""Per-frame analysis cache (python/nrsearch/framecache.py): which analysed frames a new cut can reuse."""
import pathlib
import sqlite3
import sys
import unittest

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from nrsearch import framecache  # noqa: E402


class PlanReuseTests(unittest.TestCase):
    def test_no_analysed_frame_means_decode_everything(self):
        self.assertEqual(framecache.plan_reuse([], 0, 99, [12, 87]), ([], [12, 87]))

    def test_close_frames_stand_in_for_the_wanted_ones(self):
        have, missing = framecache.plan_reuse([15, 80], 0, 99, [12, 87])
        self.assertEqual((have, missing), ([15, 80], []))

    def test_only_the_uncovered_instant_is_decoded(self):
        # the old shot ended at 50: its frames cover the first half of the new shot only
        have, missing = framecache.plan_reuse([15], 0, 99, [12, 87])
        self.assertEqual((have, missing), ([15], [87]))

    def test_one_analysed_frame_never_stands_in_twice(self):
        have, missing = framecache.plan_reuse([50], 40, 60, [45, 55])
        self.assertEqual(len(have), 1)
        self.assertEqual(len(missing), 1)

    def test_frames_on_the_boundaries_are_ignored(self):
        # a frame sitting exactly on a cut belongs to the transition
        self.assertEqual(framecache.frames_inside([0, 50, 99], 0, 99), [50])
        self.assertEqual(framecache.frames_inside([0, 1, 2], 0, 2), [0, 1, 2])


class StorageTests(unittest.TestCase):
    def test_vectors_survive_in_half_precision_and_expire_with_the_file(self):
        con = sqlite3.connect(":memory:")
        framecache.ensure_table(con)
        v = np.random.default_rng(0).normal(size=1152).astype(np.float32)
        v /= np.linalg.norm(v)
        framecache.store(con, "a.mkv", "m", 10.0, [(42, v)])
        got = framecache.load(con, "a.mkv", "m", 10.0)
        self.assertGreater(float(got[42] @ v), 0.9999)
        self.assertEqual(framecache.load(con, "a.mkv", "m", 99.0), {})
        framecache.drop_stale(con, "a.mkv", "m", 99.0)
        self.assertEqual(framecache.load(con, "a.mkv", "m", 10.0), {})


if __name__ == "__main__":
    unittest.main()
