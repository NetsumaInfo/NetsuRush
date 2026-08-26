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


# Ce que le renderer ajoute par-dessus la mesure (cf. src/lib/smoothProgress.ts) : il s'autorise
# HEAD points d'avance et bute sur CAP. Une estimation qui monterait trop haut collerait donc
# l'affichage à CAP — figé — pour tout le temps que l'inférence prend au-delà du prévu.
RENDERER_HEAD = 8
RENDERER_CAP = 99
OMNISHOT_BASE, OMNISHOT_SPAN = 5, 85


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


class EstimateRatioTests(unittest.TestCase):
    """Estimation temps-based d'OmniShotCut : elle doit toujours avancer, si tard soit-il."""

    def setUp(self):
        self.detect = load_detect()

    def test_reaches_the_knee_exactly_at_the_expected_time(self):
        self.assertAlmostEqual(self.detect._estimate_ratio(100.0, 100.0), self.detect._ESTIMATE_KNEE)
        self.assertAlmostEqual(self.detect._estimate_ratio(50.0, 100.0), self.detect._ESTIMATE_KNEE / 2)
        self.assertEqual(self.detect._estimate_ratio(0.0, 100.0), 0.0)

    def test_never_stops_advancing_however_late(self):
        # Le défaut corrigé : l'estimation saturait à son plafond, la barre restait immobile — ce qui
        # se lit comme une application plantée, pas comme un travail qui déborde.
        previous = -1.0
        for elapsed in (0, 10, 99, 100, 101, 200, 1_000, 100_000, 10_000_000):
            ratio = self.detect._estimate_ratio(elapsed, 100.0)
            self.assertGreater(ratio, previous, elapsed)
            self.assertLess(ratio, 1.0, elapsed)
            previous = ratio

    def test_stays_clear_of_the_renderer_ceiling_while_inferring(self):
        # Tant que l'inférence tourne, l'affichage doit garder de la marge sous CAP : c'est cette
        # marge qui fait la différence entre « ça avance lentement » et « c'est figé à 99 % ».
        worst = OMNISHOT_BASE + OMNISHOT_SPAN * self.detect._estimate_ratio(10 ** 9, 30.0)
        self.assertLess(worst + RENDERER_HEAD, RENDERER_CAP)

    def test_a_zero_or_negative_expectation_never_divides_by_zero(self):
        self.assertEqual(self.detect._estimate_ratio(0.0, 0.0), 0.0)
        self.assertGreater(self.detect._estimate_ratio(5.0, 0.0), 0.0)
        self.assertEqual(self.detect._estimate_ratio(-5.0, 100.0), 0.0)


if __name__ == "__main__":
    unittest.main()
