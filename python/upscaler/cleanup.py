"""Nettoyage optionnel après upscale, commun aux previews et aux exports."""


def _strength(value):
    try:
        return max(0.0, min(1.0, float(value or 0.0)))
    except (TypeError, ValueError):
        return 0.0


def cleanup_frame(frame, noise=0.0, edges=0.0):
    """Réduit le bruit fin puis amortit les halos forts sans changer taille/type."""
    noise = _strength(noise)
    edges = _strength(edges)
    if noise <= 0 and edges <= 0:
        return frame

    import cv2
    import numpy as np

    work = np.ascontiguousarray(frame)
    if noise > 0:
        # Bilatéral : lisse le bruit dans les aplats en conservant mieux les traits qu'un flou gaussien.
        filtered = cv2.bilateralFilter(work, 5, 18 + 52 * noise, 18 + 52 * noise)
        work = cv2.addWeighted(work, 1.0 - noise, filtered, noise, 0)

    if edges > 0:
        # Un halo/ringing est un détail haute fréquence très fort au voisinage d'un contour. On ne
        # l'amortit que là où ce détail est présent afin de préserver les textures calmes.
        base = cv2.GaussianBlur(work, (0, 0), 0.8)
        detail = work.astype(np.float32) - base.astype(np.float32)
        energy = np.max(np.abs(detail), axis=2)
        mask = np.clip((energy - 8.0) / 40.0, 0.0, 1.0)
        mask = cv2.GaussianBlur(mask, (0, 0), 0.8)[..., None] * (0.7 * edges)
        work = np.clip(work.astype(np.float32) - detail * mask, 0, 255).astype(np.uint8)

    return np.ascontiguousarray(work)
