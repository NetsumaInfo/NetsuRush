import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from nrsearch import store
from nrsearch.config import MODEL_TAG


class SearchScopeTest(unittest.TestCase):
    def test_project_scope_excludes_other_indexed_projects(self):
        fd, db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        con = sqlite3.connect(db_path)
        try:
            con.execute(
                "CREATE TABLE frame_embeddings_v1("
                "file_path TEXT, model TEXT, scene_index INTEGER, start_frame INTEGER, "
                "end_frame INTEGER, mid_frame INTEGER, start_sec REAL, end_sec REAL, fps REAL, "
                "src_frames INTEGER, thumb BLOB, embedding BLOB, dim INTEGER)"
            )
            insert = (
                "INSERT INTO frame_embeddings_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
            )
            con.execute(insert, ("project.mp4", MODEL_TAG, 0, 0, 9, 4, 0.0, 1.0, 10.0, 10,
                                 None, np.array([0.7, 0.7], np.float32).tobytes(), 2))
            con.execute(insert, ("other-project.mp4", MODEL_TAG, 0, 0, 9, 4, 0.0, 1.0, 10.0, 10,
                                 None, np.array([1.0, 0.0], np.float32).tobytes(), 2))
            con.commit()
        finally:
            con.close()

        def open_db():
            return sqlite3.connect(db_path)

        try:
            engine = store.SearchStore()
            with patch.object(store, "db_emb", open_db), \
                    patch.object(store, "purge_malformed_embeddings", lambda _con: 0), \
                    patch.object(store.model, "calibrate", lambda score: float(score)):
                result = engine.search_paths(np.array([1.0, 0.0], np.float32),
                                             ["project.mp4"], 10)
            self.assertEqual([hit["file_path"] for hit in result["hits"]], ["project.mp4"])
        finally:
            os.unlink(db_path)


if __name__ == "__main__":
    unittest.main()
