import unittest

import numpy as np

from upscaler.cleanup import cleanup_frame
from upscaler.commands import IMAGE_DEFAULTS, Req


class UpscaleCleanupTests(unittest.TestCase):
    def test_legacy_image_requests_keep_cleanup_disabled(self):
        request = Req({}, IMAGE_DEFAULTS)
        self.assertEqual(request.cleanup_noise, 0)
        self.assertEqual(request.cleanup_edges, 0)

    def test_disabled_cleanup_is_pixel_exact(self):
        frame = np.arange(12 * 12 * 3, dtype=np.uint8).reshape(12, 12, 3)
        self.assertTrue(np.array_equal(cleanup_frame(frame, 0, 0), frame))

    def test_noise_cleanup_reduces_flat_area_variance(self):
        rng = np.random.default_rng(4)
        frame = np.clip(128 + rng.normal(0, 18, (48, 48, 3)), 0, 255).astype(np.uint8)
        cleaned = cleanup_frame(frame, 1, 0)
        self.assertLess(float(cleaned.var()), float(frame.var()))

    def test_edge_cleanup_reduces_ringing_without_changing_shape(self):
        frame = np.zeros((48, 48, 3), dtype=np.uint8)
        frame[:, 24:] = 180
        frame[:, 22:24] = 255
        cleaned = cleanup_frame(frame, 0, 1)
        self.assertEqual(cleaned.shape, frame.shape)
        self.assertLess(float(cleaned[:, 22:24].mean()), float(frame[:, 22:24].mean()))


if __name__ == '__main__':
    unittest.main()
