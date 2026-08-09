"""Nettoyage réglable de matte alpha, commun à l'aperçu et à l'export removeBG."""


def cleanup_rgba(rgba, despeckle=0, edge_smoothing=0, edge_offset=0):
    """Supprime les îlots, décale le contour puis l'adoucit, sans toucher au RGB."""
    import cv2
    import numpy as np

    despeckle = max(0, min(30, int(despeckle or 0)))
    edge_smoothing = max(0, min(16, int(edge_smoothing or 0)))
    edge_offset = max(-20, min(20, int(edge_offset or 0)))
    if despeckle == 0 and edge_smoothing == 0 and edge_offset == 0:
        return rgba

    out = np.ascontiguousarray(rgba.copy())
    alpha = out[:, :, 3]

    if despeckle > 0:
        # Les petites composantes opaques isolées sont le bruit typique d'une matte automatique.
        binary = (alpha >= 16).astype(np.uint8)
        min_area = despeckle * despeckle
        count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
        for idx in range(1, count):
            if int(stats[idx, cv2.CC_STAT_AREA]) < min_area:
                alpha[labels == idx] = 0

    if edge_offset:
        kernel = np.ones((3, 3), np.uint8)
        if edge_offset > 0:
            alpha = cv2.dilate(alpha, kernel, iterations=edge_offset)
        else:
            alpha = cv2.erode(alpha, kernel, iterations=-edge_offset)

    if edge_smoothing > 0:
        sigma = max(0.5, edge_smoothing / 2.0)
        alpha = cv2.GaussianBlur(alpha, (0, 0), sigmaX=sigma, sigmaY=sigma)

    out[:, :, 3] = alpha
    return np.ascontiguousarray(out)
