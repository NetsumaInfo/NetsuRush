import json
import os
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

from nrroto import dedupe  # noqa: E402
from nrroto.session import RotoSession  # noqa: E402


def save_rgb(path, value):
    Image.fromarray(np.full((16, 16, 3), value, dtype=np.uint8), "RGB").save(path, quality=100)


class FrameCompactionTests(unittest.TestCase):
    def test_manifest_compacts_only_against_group_anchor(self):
        with tempfile.TemporaryDirectory() as work:
            frames = os.path.join(work, "frames")
            os.makedirs(frames)
            save_rgb(os.path.join(frames, "00000.jpg"), 0)
            save_rgb(os.path.join(frames, "00001.jpg"), 1)
            save_rgb(os.path.join(frames, "00002.jpg"), 2)

            manifest = dedupe.build_frame_manifest(work, frames, threshold=0.006)

            self.assertEqual(manifest["originalToUnique"], [0, 0, 1])
            self.assertEqual(manifest["uniqueToOriginal"], [[0, 1], [2]])
            self.assertEqual(manifest["uniqueSources"], [0, 2])
            self.assertEqual(sorted(os.listdir(dedupe.unique_frames_dir(work))), ["00000.jpg", "00001.jpg"])
            self.assertTrue(os.path.isfile(os.path.join(frames, "00001.jpg")))
            with open(dedupe.frame_manifest_path(work), encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)["originalCount"], 3)

    def test_expand_unique_mattes_restores_every_original_index(self):
        with tempfile.TemporaryDirectory() as work:
            unique = os.path.join(work, "mattes_unique")
            mattes = os.path.join(work, "mattes")
            for scope in ("union", "obj-1"):
                os.makedirs(os.path.join(unique, scope))
                Image.fromarray(np.full((4, 4), 255, dtype=np.uint8), "L").save(
                    os.path.join(unique, scope, "00000.png"))

            written = dedupe.expand_unique_mattes(unique, mattes, 0, [0, 1, 2])

            self.assertEqual(written, 6)
            for scope in ("union", "obj-1"):
                self.assertEqual(sorted(os.listdir(os.path.join(mattes, scope))),
                                 ["00000.png", "00001.png", "00002.png"])

    def test_session_propagation_expands_duplicates_and_invalidates_old_backup(self):
        class FakeEngine:
            state = object()

            def propagate(self, sink, start=None, count=None, reverse=False):
                end = start - count if reverse else start + count
                step = -1 if reverse else 1
                emitted = 0
                for frame in range(start, end + step, step):
                    sink(frame, {1: np.ones((4, 4), dtype=bool)})
                    emitted += 1
                return emitted

        with tempfile.TemporaryDirectory() as work:
            frames = os.path.join(work, "frames")
            unique = dedupe.unique_frames_dir(work)
            os.makedirs(frames)
            os.makedirs(unique)
            for i in range(3):
                save_rgb(os.path.join(frames, "%05d.jpg" % i), i * 30)
            for i in range(2):
                save_rgb(os.path.join(unique, "%05d.jpg" % i), i * 30)
            os.makedirs(dedupe.backup_dir(work))
            with open(dedupe.manifest_path(work), "w", encoding="utf-8") as fh:
                json.dump({"stale": True}, fh)

            session = RotoSession()
            session.engine = FakeEngine()
            session.video = os.path.join(work, "source.mp4")
            session.work = work
            session.frames = 3
            session.fps = 24
            session.points = {(0, 1): [(1.0, 1.0, 1)]}
            session.frame_manifest = {
                "originalToUnique": [0, 0, 1],
                "uniqueToOriginal": [[0, 1], [2]],
            }

            result = session.propagate()

            self.assertTrue(result["ok"])
            self.assertEqual(result["frames"], 3)
            self.assertEqual(sorted(os.listdir(os.path.join(work, "mattes", "union"))),
                             ["00000.png", "00001.png", "00002.png"])
            self.assertFalse(os.path.exists(dedupe.backup_dir(work)))
            self.assertFalse(os.path.exists(dedupe.manifest_path(work)))

    def test_partial_propagation_restores_backup_before_updating_its_range(self):
        class FakeEngine:
            state = object()

            def propagate(self, sink, start=None, count=None, reverse=False):
                step = -1 if reverse else 1
                emitted = 0
                try:
                    for frame in range(start, start + step * count + step, step):
                        sink(frame, {1: np.ones((4, 4), dtype=bool)})
                        emitted += 1
                except StopIteration:
                    pass
                return emitted

        with tempfile.TemporaryDirectory() as work:
            for root, value in ((os.path.join(work, "mattes"), 255),
                                (dedupe.backup_dir(work), 0)):
                os.makedirs(os.path.join(root, "union"))
                for i in range(3):
                    Image.fromarray(np.full((4, 4), value, dtype=np.uint8), "L").save(
                        os.path.join(root, "union", "%05d.png" % i))
            os.makedirs(dedupe.unique_frames_dir(work))
            frames = os.path.join(work, "frames")
            os.makedirs(frames)
            for i in range(3):
                save_rgb(os.path.join(frames, "%05d.jpg" % i), i * 30)
                save_rgb(os.path.join(dedupe.unique_frames_dir(work), "%05d.jpg" % i), i * 30)

            session = RotoSession()
            session.engine = FakeEngine()
            session.video, session.work, session.frames, session.fps = "source.mp4", work, 3, 24
            session.points = {(1, 1): [(1.0, 1.0, 1)]}
            session.frame_manifest = {
                "originalToUnique": [0, 1, 2],
                "uniqueToOriginal": [[0], [1], [2]],
            }

            result = session.propagate(mode="forward", frame=1, count=1)

            self.assertTrue(result["ok"])
            untouched = np.array(Image.open(os.path.join(work, "mattes", "union", "00000.png")))
            self.assertEqual(int(untouched.max()), 0)
            self.assertFalse(os.path.exists(dedupe.backup_dir(work)))


if __name__ == "__main__":
    unittest.main()
