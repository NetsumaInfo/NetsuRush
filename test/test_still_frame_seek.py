"""A still image is one frame with a nominal duration: `-ss 0` seeks past it on the mjpeg and tga
demuxers and ffmpeg writes nothing, which surfaced as "frame not found at 0.000s" whenever the
process hub tested an image. The seek is therefore only added when there is somewhere to seek to."""
import unittest
from unittest import mock

import nrproc.media as proc_media
import nrsearch.media as search_media
import upscaler.media as up_media


class _Captured:
    """Stands in for a finished ffmpeg process, and records the command it was given."""

    def __init__(self, sink, payload):
        self.sink = sink
        self.payload = payload

    def __call__(self, cmd, *_args, **_kwargs):
        self.sink.append(cmd)
        return mock.Mock(stdout=self.payload, returncode=0)


def _frames(width, height):
    return b"\0" * (width * height * 3)


class StillFrameSeekTests(unittest.TestCase):
    def _run(self, module, call):
        calls = []
        with mock.patch.object(module.subprocess, "run", _Captured(calls, _frames(4, 4))):
            call()
        self.assertEqual(len(calls), 1)
        return calls[0]

    def test_upscale_preview_does_not_seek_at_zero(self):
        cmd = self._run(up_media, lambda: up_media.decode_one_frame("still.jpg", 0.0, 4, 4))
        self.assertNotIn("-ss", cmd)

    def test_upscale_preview_still_seeks_inside_a_video(self):
        cmd = self._run(up_media, lambda: up_media.decode_one_frame("clip.mp4", 2.5, 4, 4))
        self.assertEqual(cmd[cmd.index("-ss") + 1], "2.5")
        self.assertLess(cmd.index("-ss"), cmd.index("-i"))

    def test_process_preview_does_not_seek_at_zero(self):
        cmd = self._run(proc_media, lambda: proc_media.decode_one_frame("still.jpg", 0.0, 4, 4))
        self.assertNotIn("-ss", cmd)

    def test_process_preview_still_seeks_inside_a_video(self):
        cmd = self._run(proc_media, lambda: proc_media.decode_one_frame("clip.mp4", 2.5, 4, 4))
        self.assertEqual(cmd[cmd.index("-ss") + 1], "2.5")

    def test_search_grab_does_not_seek_at_zero(self):
        self.assertEqual(search_media._seek_args(0.0), [])
        self.assertEqual(search_media._seek_args(-1.0), [])
        self.assertEqual(search_media._seek_args(2.5), ["-ss", "2.500"])


if __name__ == "__main__":
    unittest.main()
