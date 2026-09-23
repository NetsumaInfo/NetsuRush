"""Paths outside the ANSI code page (profile folders such as `Hélène` or `山田`).

OpenCV and FAISS open paths as narrow strings on Windows; `nrpaths` reads and writes the bytes in
Python instead. Also covers the language-dependent text joins that need no model.
"""
import pathlib
import shutil
import sys
import tempfile
import unittest

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import nrpaths                                   # noqa: E402

try:
    import cv2
except Exception:  # noqa: BLE001
    cv2 = None
try:
    import faiss
except Exception:  # noqa: BLE001
    faiss = None


class NonAsciiDirTestCase(unittest.TestCase):
    def setUp(self):
        base = tempfile.mkdtemp()
        self.dir = pathlib.Path(base) / "Hélène 山田"
        self.dir.mkdir()
        self.addCleanup(shutil.rmtree, base, ignore_errors=True)


class BufferTests(NonAsciiDirTestCase):
    def test_read_u8_returns_the_file_bytes(self):
        p = self.dir / "poids.onnx"
        p.write_bytes(b"\x00\x01\xff")
        self.assertEqual(nrpaths.read_u8(str(p)).tolist(), [0, 1, 255])


@unittest.skipIf(cv2 is None, "OpenCV not installed")
class OpenCvTests(NonAsciiDirTestCase):
    def test_png_round_trip(self):
        img = np.zeros((4, 6, 3), np.uint8)
        img[1, 2] = (10, 20, 30)
        out = str(self.dir / "image.png")
        self.assertTrue(nrpaths.cv_imwrite(out, img))
        back = nrpaths.cv_imread(out, cv2.IMREAD_UNCHANGED)
        self.assertIsNotNone(back)
        self.assertTrue(np.array_equal(back, img))

    def test_16_bit_png_keeps_its_depth(self):
        img = np.full((3, 3), 65535, np.uint16)
        out = str(self.dir / "depth.png")
        self.assertTrue(nrpaths.cv_imwrite(out, img))
        self.assertEqual(nrpaths.cv_imread(out, cv2.IMREAD_UNCHANGED).dtype, np.uint16)

    def test_missing_or_empty_file_reads_as_none(self):
        self.assertIsNone(nrpaths.cv_imread(str(self.dir / "absent.png"), cv2.IMREAD_UNCHANGED))
        empty = self.dir / "vide.png"
        empty.write_bytes(b"")
        self.assertIsNone(nrpaths.cv_imread(str(empty), cv2.IMREAD_UNCHANGED))

    def test_write_into_missing_folder_reports_failure(self):
        out = str(self.dir / "absent" / "image.png")
        self.assertFalse(nrpaths.cv_imwrite(out, np.zeros((2, 2, 3), np.uint8)))


@unittest.skipIf(faiss is None, "FAISS not installed")
class FaissTests(NonAsciiDirTestCase):
    def test_index_round_trip(self):
        index = faiss.IndexFlatIP(4)
        index.add(np.eye(4, dtype=np.float32))
        p = str(self.dir / "index.faiss")
        nrpaths.faiss_write(faiss, index, p)
        self.assertEqual(nrpaths.faiss_read(faiss, p).ntotal, 4)


class TextJoinTests(unittest.TestCase):
    def test_unspaced_scripts_are_joined_without_spaces(self):
        from nrvoice.asr_whisperx import join_words
        self.assertEqual(join_words(["こ", "ん", "に", "ち", "は"], "ja"), "こんにちは")
        self.assertEqual(join_words(["hello", "world"], "en"), "hello world")
        self.assertEqual(join_words(["hello", "world"], None), "hello world")

    def test_cjk_and_spanish_punctuation_is_trimmed_from_queries(self):
        from nrsearch import qtext
        self.assertEqual(qtext.normalize("「雨の中を走る」。"), "雨の中を走る")
        self.assertEqual(qtext.normalize("¿quién corre?"), "quién corre")

    def test_parakeet_refuses_a_language_outside_its_european_set(self):
        from nrvoice.asr_parakeet import transcribe_parakeet
        res = transcribe_parakeet("absent.wav", "ja")
        self.assertTrue(res.get("error"))
        self.assertEqual(res["words"], [])


if __name__ == "__main__":
    unittest.main()
