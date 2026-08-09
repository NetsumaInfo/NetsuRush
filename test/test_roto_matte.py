"""Matte fin du Roto Studio : découpage en segments, fenêtrage de la suppression d'objet, et
post-traitement d'un alpha DOUX.

Tout ce qui est testé ici est PUR — aucun torch, aucun poids, aucun GPU. C'est justement la partie
qu'un essai runtime ne couvre jamais : on ne relance pas une propagation de mille images pour
vérifier qu'une borne est juste.
"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from nrroto.matte import frame_total, plan_segments  # noqa: E402
from nrroto import videomama as vmm  # noqa: E402
from nrroto.minimax import blend_weights, window_plan  # noqa: E402
from nrroto.postproc import apply_post_alpha  # noqa: E402


def covered(plan):
    """Images traitées par un plan, dans l'ordre, doublons compris."""
    return [f for _seed, frames in plan for f in frames]


class PlanSegmentsTests(unittest.TestCase):
    def test_single_seed_covers_range_backward_then_forward(self):
        plan = plan_segments([50], 0, 99)
        self.assertEqual([seed for seed, _ in plan], [50, 50])
        # Arrière puis avant : les deux partent de la graine, chacun dans son sens.
        self.assertEqual(plan[0][1][:3], [50, 49, 48])
        self.assertEqual(plan[1][1][:3], [50, 51, 52])
        self.assertEqual(sorted(set(covered(plan))), list(range(0, 100)))

    def test_only_the_first_seed_is_processed_twice(self):
        seen = covered(plan_segments([10, 40, 70], 0, 99))
        twice = sorted({f for f in seen if seen.count(f) > 1})
        # Un changement de direction impose de ré-établir la mémoire depuis le masque validé :
        # cette image-là seule est repayée, jamais une autre.
        self.assertEqual(twice, [10])

    def test_seed_at_range_start_has_no_backward_pass(self):
        plan = plan_segments([0], 0, 99)
        self.assertEqual(len(plan), 1)
        self.assertEqual(covered(plan), list(range(0, 100)))

    def test_segments_stop_at_the_next_seed(self):
        plan = plan_segments([10, 40], 0, 99)
        forward_first = next(frames for seed, frames in plan if seed == 10 and frames[1] > 10)
        self.assertEqual(forward_first[-1], 39)

    def test_seeds_outside_the_range_are_dropped(self):
        plan = plan_segments([10, 40], 20, 60)
        self.assertEqual([seed for seed, _ in plan], [40, 40])
        self.assertEqual(sorted(set(covered(plan))), list(range(20, 61)))

    def test_no_seed_yields_no_work(self):
        self.assertEqual(plan_segments([], 0, 99), [])
        self.assertEqual(frame_total([]), 0)

    def test_single_frame_range(self):
        plan = plan_segments([5], 5, 5)
        self.assertEqual(covered(plan), [5])


class WindowPlanTests(unittest.TestCase):
    def written(self, total, window, overlap):
        """Images RÉELLEMENT écrites : chaque fenêtre retient celles que la suivante refondra."""
        plan = window_plan(total, window, overlap)
        out = []
        for i, (base, length, _lap) in enumerate(plan):
            hold = plan[i + 1][2] if i + 1 < len(plan) else 0
            out.extend(base + k for k in range(length - hold))
        return out

    def test_every_frame_written_exactly_once(self):
        for total, window, overlap in [(200, 81, 8), (163, 81, 8), (81, 81, 8),
                                       (10, 81, 8), (100, 20, 0), (50, 10, 5), (7, 4, 2)]:
            with self.subTest(total=total, window=window, overlap=overlap):
                self.assertEqual(self.written(total, window, overlap), list(range(total)))

    def test_overlap_is_capped_at_half_the_window(self):
        # Sans ce plafond l'avance par pas tomberait à zéro et le découpage ne progresserait plus.
        plan = window_plan(40, 10, 99)
        self.assertTrue(all(lap <= 5 for _b, _l, lap in plan))
        self.assertEqual(self.written(40, 10, 99), list(range(40)))

    def test_first_window_never_overlaps(self):
        self.assertEqual(window_plan(200, 81, 8)[0][2], 0)

    def test_blend_weights_are_strictly_increasing_inside_the_open_interval(self):
        w = blend_weights(4)
        self.assertEqual(len(w), 4)
        self.assertTrue(all(0 < x < 1 for x in w))
        self.assertEqual(w, sorted(w))
        # Complémentarité : la somme du poids et de son opposé vaut 1 sur chaque image commune.
        self.assertTrue(all(abs((x + (1 - x)) - 1) < 1e-9 for x in w))


class FakeBatchEngine:
    """Moteur par lots simulé : rend un alpha CONSTANT par lot, la valeur portant le numéro du lot.

    Ça suffit à vérifier tout ce qui n'est pas l'inférence — découpage, rétroaction du masque,
    fondu de jonction, progression — sans torch ni poids de plusieurs gigaoctets."""

    def __init__(self):
        self.calls = []
        self.n = 0

    def run_batch(self, frames, masks, seed=42):
        self.n += 1
        self.calls.append({"frames": len(frames), "masks": [m[0, 0] for m in masks], "seed": seed})
        return [np.full_like(frames[0][:, :, 0], self.n * 10) for _ in frames]


class VideoMaMaBatchTests(unittest.TestCase):
    def test_batches_cover_the_range_with_overlap(self):
        for total, batch, lap in [(100, 16, 2), (16, 16, 2), (7, 16, 2), (50, 10, 5), (33, 8, 0)]:
            with self.subTest(total=total, batch=batch, lap=lap):
                plan = vmm.plan_batches(total, batch, lap)
                covered = {f for start, end, _ in plan for f in range(start, end)}
                self.assertEqual(covered, set(range(total)))
                self.assertEqual(plan[0][2], 0, "le premier lot n'a rien avant lui")

    def test_overlap_is_capped_below_the_batch_size(self):
        # À recouvrement >= taille de lot, l'avance par pas serait nulle et le découpage bouclerait.
        plan = vmm.plan_batches(40, 8, 99)
        self.assertTrue(all(lap < 8 for _s, _e, lap in plan))
        self.assertEqual({f for s, e, _ in plan for f in range(s, e)}, set(range(40)))

    def run_fake(self, frames, batch, lap):
        engine = FakeBatchEngine()
        written = {}
        img = np.zeros((4, 4, 3), dtype=np.uint8)
        seen = []
        vmm.refine_batches(
            engine, frames,
            frame_image=lambda f: img,
            frame_mask=lambda f: np.full((4, 4), 200, dtype=np.uint8),
            write=lambda f, a: written.__setitem__(f, a.copy()),
            batch=batch, overlap=lap,
            on_frame=lambda done, tot, f: seen.append((done, tot, f)),
        )
        return engine, written, seen

    def test_every_frame_gets_an_alpha(self):
        frames = list(range(30))
        _engine, written, _seen = self.run_fake(frames, 8, 2)
        self.assertEqual(sorted(written), frames)

    def test_progress_never_exceeds_the_total_nor_repeats(self):
        frames = list(range(30))
        _engine, _written, seen = self.run_fake(frames, 8, 2)
        counts = [done for done, _tot, _f in seen]
        # Les images du recouvrement sont RÉÉCRITES : les compter ferait dépasser le total et
        # reculer la barre à chaque jonction.
        self.assertEqual(counts, list(range(1, len(frames) + 1)))
        self.assertTrue(all(tot == len(frames) for _d, tot, _f in seen))

    def test_next_batch_is_guided_by_the_previous_alpha(self):
        engine, _written, _seen = self.run_fake(list(range(30)), 8, 2)
        self.assertGreater(len(engine.calls), 1)
        first_masks = engine.calls[0]["masks"]
        second_masks = engine.calls[1]["masks"]
        # Premier lot : le masque de segmentation (200 partout). Lots suivants : les deux premières
        # images reçoivent l'alpha DOUX du lot précédent (10), pas le masque binaire.
        self.assertTrue(all(m == 200 for m in first_masks))
        self.assertEqual(list(second_masks[:2]), [10, 10])
        self.assertTrue(all(m == 200 for m in second_masks[2:]))

    def test_seam_frames_are_blended_between_the_two_predictions(self):
        _engine, written, _seen = self.run_fake(list(range(30)), 8, 2)
        # Lot 1 rend 10, lot 2 rend 20 : les deux images communes doivent tomber ENTRE les deux,
        # en progressant vers la nouvelle prédiction. Une simple réécriture donnerait 20 aux deux.
        seam = [int(written[f][0, 0]) for f in (6, 7)]
        self.assertTrue(10 < seam[0] < seam[1] < 20, "fondu attendu, obtenu %r" % seam)

    def test_without_overlap_no_blending_and_no_feedback(self):
        engine, written, _seen = self.run_fake(list(range(24)), 8, 0)
        self.assertTrue(all(m == 200 for c in engine.calls for m in c["masks"]))
        self.assertEqual(int(written[8][0, 0]), 20, "sans recouvrement, la valeur du lot est nette")


class AlphaPostTests(unittest.TestCase):
    def gradient(self):
        """Bord dégradé sur 32 px — ce qu'un modèle de matte produit sur des cheveux."""
        ramp = np.linspace(0, 255, 32, dtype=np.float32)
        return np.tile(ramp, (16, 1)).astype(np.uint8)

    def test_default_settings_leave_the_alpha_untouched(self):
        a = self.gradient()
        self.assertTrue(np.array_equal(apply_post_alpha(a, {}), a))

    def test_feather_keeps_the_gradient_a_gradient(self):
        out = apply_post_alpha(self.gradient(), {"feather": 3})
        mid = out[8]
        # Un seuillage aurait laissé deux valeurs ; le dégradé en garde beaucoup.
        self.assertGreater(len(np.unique(mid)), 16)
        self.assertLess(int(mid[0]), 32)
        self.assertGreater(int(mid[-1]), 223)

    def test_gamma_shifts_density_without_flattening(self):
        base = self.gradient()
        ref = base[8].astype(int)
        # `gamma > 1` DENSIFIE la matte (remonte l'alpha), `gamma < 1` l'allège — dans les deux sens
        # le dégradé doit survivre, sinon le réglage rendrait un contour dur.
        denser = apply_post_alpha(base, {"gamma": 2.0})[8].astype(int)
        lighter = apply_post_alpha(base, {"gamma": 0.5})[8].astype(int)
        self.assertTrue((denser >= ref).all())
        self.assertTrue((lighter <= ref).all())
        self.assertGreater(len(np.unique(denser)), 16)
        self.assertGreater(len(np.unique(lighter)), 16)

    def test_grow_moves_the_edge_on_the_grayscale(self):
        base = self.gradient()
        grown = apply_post_alpha(base, {"grow": 3})
        eroded = apply_post_alpha(base, {"grow": -3})
        self.assertGreater(int(grown[8].sum()), int(base[8].sum()))
        self.assertLess(int(eroded[8].sum()), int(base[8].sum()))
        self.assertGreater(len(np.unique(grown[8])), 16)

    def test_holes_are_filled_to_opaque_without_touching_the_soft_edge(self):
        a = np.zeros((32, 32), dtype=np.uint8)
        a[4:28, 4:28] = 255
        a[14:18, 14:18] = 0            # trou intérieur
        a[4:28, 4] = 128               # bord volontairement doux
        out = apply_post_alpha(a, {"holes": 8})
        self.assertEqual(int(out[16, 16]), 255)
        self.assertEqual(int(out[16, 4]), 128)

    def test_dots_are_cleared_without_touching_the_body(self):
        a = np.zeros((32, 32), dtype=np.uint8)
        a[10:22, 10:22] = 255
        a[2, 2] = 255                  # poussière isolée
        out = apply_post_alpha(a, {"dots": 4})
        self.assertEqual(int(out[2, 2]), 0)
        self.assertEqual(int(out[16, 16]), 255)


if __name__ == "__main__":
    unittest.main()
