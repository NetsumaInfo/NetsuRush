import importlib.util
import os
import pathlib
import sqlite3
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON_DIR = ROOT / "python"
sys.path.insert(0, str(PYTHON_DIR))
SPEC = importlib.util.spec_from_file_location("netsurush_nrident", PYTHON_DIR / "nrident.py")
IDENT = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(IDENT)

# Same fixture as test/media-identity.test.cjs: both implementations must produce this exact string,
# otherwise Node and python stop recognising the same file.
FIXTURE = b"netsurush-identity-fixture\n" * 64
FIXTURE_SIG = "s1:1728:ebef112b00d41fa039d5b60d"


def write(path, blob):
    with open(path, "wb") as f:
        f.write(blob)
    return path


class SignatureTests(unittest.TestCase):
    def test_signature_is_stable_and_shared_with_node(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = write(os.path.join(tmp, "a.mp4"), FIXTURE)
            sig, size, _mtime = IDENT.signature(a)
            self.assertEqual(size, len(FIXTURE))
            self.assertEqual(sig, FIXTURE_SIG)

    def test_copies_match_and_edits_do_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = write(os.path.join(tmp, "a.mp4"), FIXTURE)
            copy = write(os.path.join(tmp, "sub_copy.mp4"), FIXTURE)
            other = write(os.path.join(tmp, "other.mp4"), FIXTURE + b"x")
            self.assertEqual(IDENT.signature(a)[0], IDENT.signature(copy)[0])
            self.assertNotEqual(IDENT.signature(a)[0], IDENT.signature(other)[0])

    def test_missing_file_has_no_signature(self):
        self.assertEqual(IDENT.signature(os.path.join("nowhere", "gone.mp4"))[0], None)

    def test_path_key_ignores_separators_and_windows_casing(self):
        self.assertEqual(IDENT.path_key("/a/B/c.mp4"), IDENT.path_key("/a/B//c.mp4"))
        if os.name == "nt":
            self.assertEqual(IDENT.path_key("S:\\rush\\A.mp4"), IDENT.path_key("s:/rush/a.mp4"))


class RescueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.con = sqlite3.connect(os.path.join(self.dir, "cache.db"))
        self.con.execute(
            "CREATE TABLE scene_cache_v4(file_path TEXT, mtime REAL, options_key TEXT, "
            "scenes_json TEXT, PRIMARY KEY(file_path, options_key))"
        )
        IDENT.ensure(self.con)

    def tearDown(self):
        self.con.close()
        self.tmp.cleanup()

    def cache(self, path, scenes="[1,2]", key="k"):
        self.con.execute(
            "INSERT OR REPLACE INTO scene_cache_v4 VALUES (?,?,?,?)",
            (path, IDENT.file_stat(path)[1], key, scenes),
        )
        self.con.commit()

    def rows(self, path):
        return self.con.execute(
            "SELECT scenes_json, mtime FROM scene_cache_v4 WHERE file_path=?", (path,),
        ).fetchall()

    def test_identical_file_inherits_the_cache_without_any_witness(self):
        """The pre-existing cache has no identity row: the bounded survey must still find it."""
        old = write(os.path.join(self.dir, "old.mp4"), FIXTURE)
        new = write(os.path.join(self.dir, "renamed.mp4"), FIXTURE)
        self.cache(old)
        linked = IDENT.rescue(self.con, new, ["scene_cache_v4"])
        self.assertIsNotNone(linked)
        self.assertEqual(linked["from"], old)
        self.assertFalse(linked["moved"])          # both files live → copied, not moved
        self.assertEqual(len(self.rows(new)), 1)
        self.assertEqual(len(self.rows(old)), 1)   # the original keeps its cache

    def test_a_moved_file_takes_its_cache_with_it(self):
        old = os.path.join(self.dir, "gone.mp4")
        write(old, FIXTURE)
        self.cache(old)
        IDENT.remember(self.con, old)   # witness written at detection time
        os.remove(old)
        new = write(os.path.join(self.dir, "moved.mp4"), FIXTURE)
        linked = IDENT.rescue(self.con, new, ["scene_cache_v4"])
        self.assertIsNotNone(linked)
        self.assertTrue(linked["moved"])
        self.assertEqual(len(self.rows(new)), 1)
        self.assertEqual(self.rows(old), [])       # no duplicate left behind
        self.assertEqual(
            self.con.execute(
                "SELECT COUNT(*) FROM media_ident_v1 WHERE file_path=?", (old,)).fetchone()[0], 0)

    def test_a_different_file_is_never_linked(self):
        old = write(os.path.join(self.dir, "old.mp4"), FIXTURE)
        new = write(os.path.join(self.dir, "other.mp4"), FIXTURE + b"tail")
        self.cache(old)
        self.assertIsNone(IDENT.rescue(self.con, new, ["scene_cache_v4"]))
        self.assertEqual(self.rows(new), [])

    def test_adopted_rows_carry_the_new_timestamp(self):
        old = write(os.path.join(self.dir, "old.mp4"), FIXTURE)
        self.cache(old)
        new = write(os.path.join(self.dir, "copy.mp4"), FIXTURE)
        os.utime(new, (10_000_000, 10_000_000))
        IDENT.rescue(self.con, new, ["scene_cache_v4"])
        self.assertAlmostEqual(self.rows(new)[0][1], 10_000_000, delta=1.0)

    def test_an_empty_source_never_wipes_what_is_already_there(self):
        """A twin without rows must not cost the destination its own (possibly partial) cache."""
        twin = write(os.path.join(self.dir, "twin.mp4"), FIXTURE)
        mine = write(os.path.join(self.dir, "mine.mp4"), FIXTURE)
        self.cache(mine, scenes="[9]")
        IDENT.remember(self.con, twin)
        IDENT.rescue(self.con, mine, ["scene_cache_v4"])
        self.assertEqual(self.rows(mine)[0][0], "[9]")


class TimestampDriftTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.con = sqlite3.connect(os.path.join(self.dir, "cache.db"))
        self.con.execute("CREATE TABLE scene_cache_v4(file_path TEXT PRIMARY KEY, mtime REAL)")
        IDENT.ensure(self.con)

    def tearDown(self):
        self.con.close()
        self.tmp.cleanup()

    def test_a_touched_file_keeps_its_cache(self):
        path = write(os.path.join(self.dir, "a.mp4"), FIXTURE)
        cached_mtime = IDENT.file_stat(path)[1]
        self.con.execute("INSERT INTO scene_cache_v4 VALUES (?,?)", (path, cached_mtime))
        self.con.commit()
        IDENT.remember(self.con, path)
        os.utime(path, (20_000_000, 20_000_000))   # copy / restore / sync: bytes untouched
        self.assertTrue(IDENT.realign(self.con, path, ["scene_cache_v4"], cached_mtime))
        row = self.con.execute("SELECT mtime FROM scene_cache_v4").fetchone()
        self.assertAlmostEqual(row[0], 20_000_000, delta=1.0)

    def test_rewritten_content_is_still_declared_stale(self):
        path = write(os.path.join(self.dir, "a.mp4"), FIXTURE)
        cached_mtime = IDENT.file_stat(path)[1]
        self.con.execute("INSERT INTO scene_cache_v4 VALUES (?,?)", (path, cached_mtime))
        self.con.commit()
        IDENT.remember(self.con, path)
        write(path, FIXTURE + b"re-encoded")
        os.utime(path, (20_000_000, 20_000_000))
        self.assertFalse(IDENT.realign(self.con, path, ["scene_cache_v4"], cached_mtime))

    def test_drift_without_a_witness_stays_stale(self):
        """No identity row (cache older than this feature) → the old behaviour, no false hit."""
        path = write(os.path.join(self.dir, "a.mp4"), FIXTURE)
        cached_mtime = IDENT.file_stat(path)[1]
        os.utime(path, (20_000_000, 20_000_000))
        self.assertFalse(IDENT.realign(self.con, path, ["scene_cache_v4"], cached_mtime))


if __name__ == "__main__":
    unittest.main()
