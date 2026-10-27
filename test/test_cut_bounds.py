"""upscaler.media.cut_bounds: the processing engines decode a shot with the same frame-exact bounds as
a re-encode (core/export/frameCut.js encodeCutBounds): seek a quarter frame early, stop on a frame
count. Locked against the JS table so the two never drift apart."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from upscaler.media import cut_bounds  # noqa: E402


class CutBoundsTests(unittest.TestCase):
    def test_quarter_frame_seek_and_frame_count(self):
        ss, duration, frames = cut_bounds(10, 12, 24)
        self.assertAlmostEqual(ss, 10 - 0.25 / 24)
        self.assertAlmostEqual(duration, 12 - ss)
        self.assertEqual(frames, 48)

    def test_seek_stays_between_previous_and_target_frame(self):
        fps = 24000 / 1001
        for frame in (1, 2, 25, 12000, 124284):
            ss, _, frames = cut_bounds(frame / fps, (frame + 7) / fps, fps)
            self.assertGreater(ss, (frame - 1) / fps)
            self.assertLess(ss, frame / fps)
            self.assertEqual(frames, 7)

    def test_unknown_rate_or_open_range_keeps_legacy_seek(self):
        self.assertIsNone(cut_bounds(1, 2, 0))
        self.assertIsNone(cut_bounds(None, 2, 24))
        self.assertIsNone(cut_bounds(1, None, 24))


if __name__ == "__main__":
    unittest.main()
