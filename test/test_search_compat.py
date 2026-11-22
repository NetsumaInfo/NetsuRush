"""Hardware compatibility choices of the search model: precision per GPU generation, extraction size
per patch budget, idle standby. No model is loaded."""
import pathlib
import sys
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from nrsearch import config, model  # noqa: E402


def fake_torch(major):
    cuda = types.SimpleNamespace(get_device_capability=lambda: (major, 0))
    return types.SimpleNamespace(cuda=cuda)


class PrecisionTests(unittest.TestCase):
    def test_pascal_and_older_run_fp32(self):
        self.assertFalse(model._half_ok(fake_torch(6), "cuda"))
        self.assertFalse(model._half_ok(fake_torch(5), "cuda"))

    def test_volta_and_newer_run_fp16(self):
        self.assertTrue(model._half_ok(fake_torch(7), "cuda"))
        self.assertTrue(model._half_ok(fake_torch(8), "cuda"))

    def test_other_backends(self):
        self.assertFalse(model._half_ok(fake_torch(8), "cpu"))
        self.assertTrue(model._half_ok(fake_torch(8), "rocm"))
        self.assertTrue(model._half_ok(fake_torch(8), "xpu"))


class GrabEdgeTests(unittest.TestCase):
    def test_default_budget_keeps_the_historical_size(self):
        # the default must not change a single extracted frame, or every existing index goes stale
        for patches in (128, 192, 256, 384):
            self.assertEqual(config.grab_edge_for(patches), 512)

    def test_large_budgets_get_frames_big_enough_to_fill_them(self):
        import math
        for patches in (512, 768, 1024):
            edge = config.grab_edge_for(patches)
            self.assertGreaterEqual(edge, 16 * math.sqrt(patches * 2.4))
            self.assertEqual(edge % 64, 0)


class StandbyTests(unittest.TestCase):
    def test_nothing_to_park_without_a_model_or_on_cpu(self):
        saved = (model._MODEL, model._BACKEND, model._PARKED)
        try:
            model._MODEL, model._BACKEND, model._PARKED = None, "cuda", False
            self.assertFalse(model.standby())
            model._MODEL, model._BACKEND = object(), "cpu"
            self.assertFalse(model.standby())
        finally:
            model._MODEL, model._BACKEND, model._PARKED = saved


if __name__ == "__main__":
    unittest.main()
