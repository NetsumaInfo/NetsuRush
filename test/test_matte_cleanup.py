import unittest

import numpy as np

from nrproc.matte import cleanup_rgba


class MatteCleanupTests(unittest.TestCase):
    def test_disabled_cleanup_is_pixel_exact(self):
        rgba = np.zeros((24, 24, 4), dtype=np.uint8)
        rgba[5:19, 5:19, 3] = 255
        self.assertTrue(np.array_equal(cleanup_rgba(rgba, 0, 0, 0), rgba))

    def test_despeckle_removes_small_foreground_islands(self):
        rgba = np.zeros((32, 32, 4), dtype=np.uint8)
        rgba[8:24, 8:24, 3] = 255
        rgba[2, 2, 3] = 255
        cleaned = cleanup_rgba(rgba, despeckle=8)
        self.assertEqual(int(cleaned[2, 2, 3]), 0)
        self.assertEqual(int(cleaned[12, 12, 3]), 255)

    def test_positive_and_negative_offsets_expand_and_contract_alpha(self):
        rgba = np.zeros((32, 32, 4), dtype=np.uint8)
        rgba[10:22, 10:22, 3] = 255
        original = int(np.count_nonzero(rgba[:, :, 3]))
        expanded = int(np.count_nonzero(cleanup_rgba(rgba, edge_offset=2)[:, :, 3]))
        contracted = int(np.count_nonzero(cleanup_rgba(rgba, edge_offset=-2)[:, :, 3]))
        self.assertGreater(expanded, original)
        self.assertLess(contracted, original)

    def test_edge_smoothing_creates_a_soft_transition(self):
        rgba = np.zeros((32, 32, 4), dtype=np.uint8)
        rgba[8:24, 8:24, 3] = 255
        alpha = cleanup_rgba(rgba, edge_smoothing=2)[:, :, 3]
        self.assertTrue(np.any((alpha > 0) & (alpha < 255)))


if __name__ == '__main__':
    unittest.main()
