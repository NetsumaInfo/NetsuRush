import json
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from upscaler.plan import plan_size, resize_to  # noqa: E402

CASES = json.loads((ROOT / "test" / "fixtures" / "upscale-plan.json").read_text(encoding="utf-8"))["cases"]


class UpscalePlanTests(unittest.TestCase):
    def test_shared_table(self):
        """Same table as core/upscaleArgs.js: the two sizing implementations must agree."""
        for case in CASES:
            if not case["native"]:
                continue  # free-size engines (libplacebo) only exist on the JS side
            with self.subTest(case["name"]):
                w, h = case["src"]
                feed, out = plan_size(w, h, case["native"], case["target"], case["scale"])
                self.assertEqual(list(feed), case["feed"])
                self.assertEqual(list(out), case["out"])
                exact = feed[0] * case["native"] == out[0] and feed[1] * case["native"] == out[1]
                self.assertEqual("none" if exact else "down", case["resample"])

    def test_resize_is_a_no_op_at_the_right_size(self):
        frame = np.zeros((10, 20, 3), np.uint8)
        self.assertIs(resize_to(frame, (20, 10)), frame)

    def test_resize_reaches_the_exact_size(self):
        frame = np.full((1080, 1920, 3), 128, np.uint8)
        self.assertEqual(resize_to(frame, (960, 540)).shape, (540, 960, 3))
        self.assertEqual(resize_to(frame, (2560, 1440), before_network=True).shape, (1440, 2560, 3))

    def test_reduction_averages_instead_of_skipping_pixels(self):
        # One-pixel stripes: a skipping filter keeps one colour, an averaging one lands on grey.
        frame = np.zeros((8, 8, 3), np.uint8)
        frame[:, ::2] = 255
        reduced = resize_to(frame, (4, 4))
        self.assertTrue(np.all(np.abs(reduced.astype(int) - 128) <= 1))


if __name__ == "__main__":
    unittest.main()
