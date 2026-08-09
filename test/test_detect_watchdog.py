import contextlib
import importlib.util
import io
import pathlib
import sys
import time
import unittest


DETECT = pathlib.Path(__file__).parents[1] / "python" / "detect.py"
sys.path.insert(0, str(DETECT.parent))


def load_detect():
    spec = importlib.util.spec_from_file_location("netsurush_detect", DETECT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DetectWatchdogTests(unittest.TestCase):
    def test_estimated_heartbeat_continues_after_progress_cap(self):
        detect = load_detect()
        detect._reset_progress()
        stream = io.StringIO()
        with contextlib.redirect_stderr(stream):
            detect._progress(95)
            with detect._heartbeat(interval=0.01, estimate=(5, 90, 0.001)):
                time.sleep(0.04)
            time.sleep(0.02)  # let the daemon heartbeat observe stop.set()
        output = stream.getvalue()
        self.assertIn("PROGRESS:95", output)
        self.assertIn("HEARTBEAT", output)


if __name__ == "__main__":
    unittest.main()
