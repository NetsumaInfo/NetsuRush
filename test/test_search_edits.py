"""Hand corrections of the search database (nrsearch/edits.py): forgetting a file, imposing shot
boundaries the indexer then prefers over detection, and face labels that survive auto-labelling."""
import os
import pathlib
import sqlite3
import sys
import tempfile
import unittest
import unittest.mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import detect                                                       # noqa: E402
from nrsearch import db as nrdb                                     # noqa: E402
from nrsearch import edits, media                                   # noqa: E402


class EditsTest(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.patches = [
            unittest.mock.patch.object(detect, "db_path", lambda: self.path),
            unittest.mock.patch.object(nrdb, "db_path", lambda: self.path),
            unittest.mock.patch.object(edits, "file_mtime", lambda p: 0.0),
            unittest.mock.patch.object(media, "file_mtime", lambda p: 0.0),
            unittest.mock.patch.object(media, "db_path", lambda: self.path),
        ]
        for p in self.patches:
            p.start()
        nrdb.db_emb().close()
        detect.db().close()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        try:
            os.remove(self.path)
        except OSError:
            pass

    def test_manual_scenes_win_over_detection(self):
        con = detect.db()
        con.execute("INSERT INTO scene_cache_v4 VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    ("rush.mp4", 0.0, "k", 0.2, 24.0, 3.0, 72,
                     '[{"startFrame":0,"endFrame":71}]', "transnetv2", "{}", 1.0))
        con.commit(); con.close()
        r = edits.cmd_set_scenes({"path": "rush.mp4", "scenes": [
            {"startFrame": 30, "endFrame": 71}, {"startFrame": 0, "endFrame": 29}]})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["fps"], 24.0)  # borrowed from the detection
        fps, frames, scenes = media.get_scenes("rush.mp4", "transnetv2", {"minSceneFrames": 6})
        self.assertEqual([(s["startFrame"], s["endFrame"]) for s in scenes], [(0, 29), (30, 71)])
        self.assertEqual(edits.cmd_clear_scenes({"path": "rush.mp4"})["removed"], 1)

    def test_overlapping_scenes_are_refused(self):
        r = edits.cmd_set_scenes({"path": "x.mp4", "fps": 24, "scenes": [
            {"startFrame": 0, "endFrame": 30}, {"startFrame": 30, "endFrame": 50}]})
        self.assertFalse(r["ok"])

    def test_forget_removes_index_rows(self):
        con = nrdb.db_emb()
        con.execute("INSERT INTO index_runs_v1(file_path, model, mtime, total, indexed, created_at, sampling) "
                    "VALUES ('a.mp4','m',0,1,1,0,'')")
        con.commit(); con.close()
        r = edits.cmd_forget({"file_paths": ["a.mp4"]})
        self.assertEqual(r["removed"]["index_runs_v1"], 1)

    def test_face_override_survives_relabel(self):
        con = nrdb.db_emb()
        con.execute("INSERT INTO face_labels_v1 VALUES ('a.mp4', 3, 0, 'anime', 7, 0.8)")
        con.commit(); con.close()
        self.assertTrue(edits.cmd_face_label({"file_path": "a.mp4", "scene_index": 3, "face_index": 0,
                                              "domain": "anime", "char_id": None})["ok"])
        con = nrdb.db_emb()
        self.assertIsNone(con.execute("SELECT char_id FROM face_labels_v1").fetchone())
        # An auto-labelling run purges and rebuilds the labels, then re-applies the overrides.
        con.execute("INSERT INTO face_labels_v1 VALUES ('a.mp4', 3, 0, 'anime', 7, 0.8)")
        edits.apply_label_overrides(con)
        self.assertIsNone(con.execute("SELECT char_id FROM face_labels_v1").fetchone())
        con.close()


if __name__ == "__main__":
    unittest.main()
