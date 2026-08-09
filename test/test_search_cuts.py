"""Réutilisation des découpes déjà en cache, et identité de la découpe qui la rend sûre.

Ces règles évitent la faute la plus coûteuse de l'indexation : re-détecter au GPU un rush dont la
découpe est déjà en base parce qu'elle y est rangée sous une autre clé.
"""
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import time
import unittest
import unittest.mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from nrsearch import media                                          # noqa: E402
from nrsearch import sampling                                       # noqa: E402
from nrsearch.config import (sampling_current, sampling_format,     # noqa: E402
                             sampling_frames, sampling_tag)
from nrsearch.db import usable_embeddings                           # noqa: E402

SCENES_A = [{"startFrame": 0, "endFrame": 23}, {"startFrame": 24, "endFrame": 71}]
SCENES_B = [{"startFrame": 0, "endFrame": 40}, {"startFrame": 41, "endFrame": 71}]


def _make_db(rows_v4=(), rows_v3=(), mtime=0.0):
    """Base de caches de découpe minimale. `rows_*` = (model, options_key|None, threshold, scenes)."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE scene_cache_v3(file_path TEXT, mtime REAL, threshold REAL, fps REAL,"
                " duration REAL, frames INTEGER, scenes_json TEXT, model TEXT, created_at REAL)")
    con.execute("CREATE TABLE scene_cache_v4(file_path TEXT, mtime REAL, options_key TEXT,"
                " threshold REAL, fps REAL, duration REAL, frames INTEGER, scenes_json TEXT,"
                " model TEXT, options_json TEXT, created_at REAL)")
    for order, (model, key, thr, scenes) in enumerate(rows_v4):
        con.execute("INSERT INTO scene_cache_v4 VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    ("rush.mp4", mtime, key, thr, 24.0, 3.0, 72, json.dumps(scenes), model,
                     "{}", time.time() + order))
    for order, (model, _key, thr, scenes) in enumerate(rows_v3):
        con.execute("INSERT INTO scene_cache_v3 VALUES (?,?,?,?,?,?,?,?,?)",
                    ("rush.mp4", mtime, thr, 24.0, 3.0, 72, json.dumps(scenes), model,
                     time.time() + order))
    con.commit()
    return path, con


class CutIdentityTest(unittest.TestCase):
    def test_identity_follows_the_boundaries_not_the_settings(self):
        self.assertEqual(media.cut_identity(SCENES_A), media.cut_identity(list(SCENES_A)))
        self.assertNotEqual(media.cut_identity(SCENES_A), media.cut_identity(SCENES_B))

    def test_marker_written_from_a_reused_cut_is_recognised_next_time(self):
        marker = sampling_tag("adaptive", media.cut_identity(SCENES_A))
        self.assertTrue(sampling_current(marker, "adaptive", media.cut_identity(SCENES_A)))
        self.assertFalse(sampling_current(marker, "adaptive", media.cut_identity(SCENES_B)))

    def test_marker_written_by_an_older_version_stays_valid(self):
        legacy = media.detection_key("omnishotcut", {"minSceneFrames": 4})
        marker = sampling_tag("adaptive", legacy)
        self.assertTrue(sampling_current(marker, "adaptive", media.cut_identity(SCENES_A), legacy))


class CachedCutTest(unittest.TestCase):
    def _lookup(self, path, con, model="omnishotcut", threshold=0.0, options_key=None):
        return media._cached_cut(con, path, model, threshold, options_key)

    def test_exact_options_key_wins_over_any_other_cut(self):
        db, con = _make_db(rows_v4=[("omnishotcut", "other", 0.0, SCENES_B),
                                    ("omnishotcut", "wanted", 0.0, SCENES_A)])
        try:
            with unittest.mock.patch.object(media, "file_mtime", return_value=0.0):
                found = self._lookup("rush.mp4", con, options_key="wanted")
            self.assertEqual(found[2], SCENES_A)
        finally:
            con.close(); os.unlink(db)

    def test_falls_back_to_the_legacy_cache_instead_of_re_detecting(self):
        """Le cas qui coûtait des minutes de GPU : découpe présente, mais sans clé d'options."""
        db, con = _make_db(rows_v3=[("omnishotcut", None, 0.0, SCENES_A)])
        try:
            with unittest.mock.patch.object(media, "file_mtime", return_value=0.0):
                found = self._lookup("rush.mp4", con, options_key="absente-de-la-base")
            self.assertIsNotNone(found)
            self.assertEqual(found[2], SCENES_A)
        finally:
            con.close(); os.unlink(db)

    def test_a_cut_from_another_model_is_the_last_resort_but_still_beats_detection(self):
        db, con = _make_db(rows_v3=[("transnetv2", None, 0.2, SCENES_B)])
        try:
            with unittest.mock.patch.object(media, "file_mtime", return_value=0.0):
                found = self._lookup("rush.mp4", con, options_key="wanted")
            self.assertEqual(found[2], SCENES_B)
        finally:
            con.close(); os.unlink(db)

    def test_a_cut_of_an_older_version_of_the_file_is_refused(self):
        db, con = _make_db(rows_v3=[("omnishotcut", None, 0.0, SCENES_A)], mtime=1000.0)
        try:
            with unittest.mock.patch.object(media, "file_mtime", return_value=2000.0):
                self.assertIsNone(self._lookup("rush.mp4", con))
        finally:
            con.close(); os.unlink(db)


class UsableEmbeddingsTest(unittest.TestCase):
    def test_keeps_the_majority_length_and_drops_the_leftovers(self):
        rows = [(1, b"x" * 8), (2, b"x" * 8), (3, b"x" * 4), (4, None)]
        self.assertEqual(usable_embeddings(rows, 1), [(1, b"x" * 8), (2, b"x" * 8)])

    def test_a_homogeneous_batch_is_returned_untouched(self):
        rows = [(1, b"x" * 8), (2, b"x" * 8)]
        self.assertIs(usable_embeddings(rows, 1), rows)


class FramePlacementTest(unittest.TestCase):
    """Où se prennent les images d'un plan, et combien."""

    def test_the_edges_of_a_shot_are_never_sampled(self):
        """Un plan s'ouvre souvent sur un fondu : la première prise ne doit pas tomber dessus."""
        times = sampling.shot_times(10.0, 14.0, 2)
        self.assertGreater(times[0], 10.0)
        self.assertLess(times[-1], 14.0)

    def test_the_margin_is_capped_so_a_long_shot_keeps_its_content(self):
        times = sampling.shot_times(0.0, 600.0, 2)
        self.assertLessEqual(times[0], sampling.EDGE_MARGIN_MAX_SEC)

    def test_takes_are_spread_as_far_apart_as_the_shot_allows(self):
        times = sampling.shot_times(0.0, 10.0, 3)
        gaps = [round(b - a, 6) for a, b in zip(times, times[1:])]
        self.assertEqual(len(set(gaps)), 1)      # écarts égaux = séparation maximale

    def test_a_single_take_lands_in_the_middle(self):
        self.assertEqual(sampling.shot_times(4.0, 8.0, 1), [6.0])

    def test_even_a_one_frame_shot_keeps_its_takes_inside(self):
        """La marge est proportionnelle : elle ne peut jamais manger le plan entier."""
        times = sampling.shot_times(0.0, 0.04, 2)
        self.assertEqual(len(times), 2)
        self.assertTrue(all(0.0 < t < 0.04 for t in times))

    def test_a_shot_without_duration_falls_back_to_its_position(self):
        self.assertEqual(sampling.shot_times(3.0, 3.0, 2), [3.0])

    def test_a_long_shot_gets_one_more_take(self):
        self.assertEqual(sampling.frame_count(2.0, 2), 2)
        self.assertEqual(sampling.frame_count(sampling.LONG_SHOT_SEC, 2), 3)
        self.assertEqual(sampling.frame_count(sampling.LONG_SHOT_SEC, 1), 2)

    def test_the_cap_is_never_exceeded(self):
        self.assertEqual(sampling.frame_count(3600.0, 3), 3)

    def test_the_retry_stays_inside_the_shot_and_turns_back_at_the_end(self):
        self.assertGreater(sampling.retry_time(1.0, 0.0, 10.0), 1.0)
        self.assertLess(sampling.retry_time(9.9, 0.0, 10.0), 9.9)
        self.assertIsNone(sampling.retry_time(0.0, 0.0, 0.0))


class SamplingFormatTest(unittest.TestCase):
    """Un index déjà construit ne doit se refaire que si la demande est PLUS riche."""

    def test_historic_formats_keep_their_name(self):
        self.assertEqual(sampling_format(2), "adaptive")
        self.assertEqual(sampling_format(3), "precise")
        self.assertEqual(sampling_format(1), "single")

    def test_an_impossible_count_falls_back_on_the_default(self):
        self.assertEqual(sampling_frames(0), 2)
        self.assertEqual(sampling_frames(9), 2)

    def test_a_richer_index_satisfies_a_lighter_request(self):
        key = media.cut_identity(SCENES_A)
        rich = sampling_tag("precise", key)
        self.assertTrue(sampling_current(rich, "single", key))
        self.assertTrue(sampling_current(rich, "adaptive", key))

    def test_a_poorer_index_is_refused(self):
        key = media.cut_identity(SCENES_A)
        poor = sampling_tag("single", key)
        self.assertFalse(sampling_current(poor, "adaptive", key))
        self.assertFalse(sampling_current(poor, "precise", key))

    def test_an_unknown_format_never_satisfies_anything(self):
        key = media.cut_identity(SCENES_A)
        self.assertFalse(sampling_current(None, "single", key))
        self.assertFalse(sampling_current("image:%s" % key, "single", key))


if __name__ == "__main__":
    unittest.main()
