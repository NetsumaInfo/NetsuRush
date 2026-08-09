import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from upscaler.codecs import video_codec_args  # noqa: E402


class MultiVendorCodecTests(unittest.TestCase):
    def test_amd_h264_uses_amf_quality_controls(self):
        args = video_codec_args("h264_amf", 20, "medium", 8, "high")
        self.assertEqual(args[:2], ["-c:v", "h264_amf"])
        self.assertIn("-qp_i", args)
        self.assertIn("nv12", args)

    def test_intel_hevc_main10_uses_qsv_and_hvc1(self):
        args = video_codec_args("hevc_qsv", 21, "medium", 10, "main10")
        self.assertEqual(args[:2], ["-c:v", "hevc_qsv"])
        self.assertIn("p010le", args)
        self.assertEqual(args[-2:], ["-tag:v", "hvc1"])

    def test_nvidia_path_remains_supported(self):
        args = video_codec_args("hevc_nvenc", 20, "slow", 8, "main")
        self.assertEqual(args[:2], ["-c:v", "hevc_nvenc"])
        self.assertIn("-cq", args)


if __name__ == "__main__":
    unittest.main()
