import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

from nrroto import export_alpha  # noqa: E402
from nrroto.session import RotoSession  # noqa: E402


def still_session(work, name="shot.png"):
    """Session posed on a still source, with a mask already computed for frame 0."""
    s = RotoSession()
    s.video = os.path.join(work, name)
    s.work = work
    s.still = name.lower().endswith((".png", ".jpg"))
    s.w, s.h, s.fps, s.frames = 16, 16, 24.0, 1
    mask = np.zeros((16, 16), dtype=bool)
    mask[4:12, 4:12] = True
    s.current = {0: {1: mask}}
    return s, mask


class StillCommitTests(unittest.TestCase):
    def test_commit_writes_mattes_without_any_propagation(self):
        with tempfile.TemporaryDirectory() as work:
            s, _ = still_session(work)

            self.assertTrue(s._commit_still())

            self.assertTrue(s.propagated)
            self.assertTrue(os.path.isfile(os.path.join(work, "mattes", "union", "00000.png")))
            self.assertTrue(os.path.isfile(os.path.join(work, "mattes", "obj-1", "00000.png")))

    def test_propagate_on_a_still_never_touches_the_engine(self):
        with tempfile.TemporaryDirectory() as work:
            s, _ = still_session(work)
            s.points = {(0, 1): [(8, 8, 1)]}
            s.engine = None   # any call on the SAM engine would raise here

            r = s.propagate()

            self.assertEqual(r, {"ok": True, "frames": 1, "uniqueFrames": 1, "canceled": False})
            self.assertTrue(os.path.isfile(os.path.join(work, "mattes", "union", "00000.png")))

    def test_unchanged_mask_keeps_the_fine_matte_but_a_new_one_drops_it(self):
        with tempfile.TemporaryDirectory() as work:
            s, mask = still_session(work)
            s._commit_still()
            os.makedirs(os.path.join(work, "mattes_refined", "union"), exist_ok=True)
            s.refined = True

            s._commit_still()
            self.assertTrue(s.refined)   # same mask: nothing was recomputed, the fine matte stands

            other = np.zeros((16, 16), dtype=bool)
            other[0:8, 0:8] = True
            s.current = {0: {1: other}}
            s._commit_still()
            self.assertFalse(s.refined)


class StillExportTests(unittest.TestCase):
    def test_export_sends_the_single_matte_to_the_image_writer(self):
        with tempfile.TemporaryDirectory() as work:
            s, _ = still_session(work)
            calls = {}

            def fake_still(image, matte, fmt, out, bg=None):
                calls.update(image=image, matte=matte, fmt=fmt, out=out, bg=bg)
                return out + ".png"

            def fail_video(*args, **kwargs):
                raise AssertionError("a still must not go through the video export")

            original = (export_alpha.export_still, export_alpha.export)
            export_alpha.export_still, export_alpha.export = fake_still, fail_video
            try:
                r = s.export("png_alpha")
            finally:
                export_alpha.export_still, export_alpha.export = original

            self.assertTrue(r["ok"])
            self.assertEqual(calls["fmt"], "png_alpha")
            self.assertEqual(calls["image"], s.video)
            self.assertEqual(calls["matte"], os.path.join(work, "mattes", "union", "00000.png"))
            self.assertEqual(r["output"], os.path.join(work, "shot_roto") + ".png")

    def test_export_without_any_mask_reports_instead_of_writing(self):
        with tempfile.TemporaryDirectory() as work:
            s, _ = still_session(work)
            s.current = {}

            r = s.export("png_alpha")

            self.assertFalse(r["ok"])
            self.assertTrue(r["error"])


if __name__ == "__main__":
    unittest.main()
