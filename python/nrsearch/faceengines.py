"""Moteurs de visage par domaine — animé et réel, chargés paresseusement.

Animé : détection dghs-imgutils (YOLOv8 anime, MIT, ONNX) + identité CCIP
(deepghs, OpenRAIL) — features 768-d NON normalisées, comparées via le modèle
métrique CCIP (ccip_batch_differences), seuil officiel ccip_default_threshold().
Réel : détection YuNet + identité SFace (opencv_zoo, Apache 2.0) — alignCrop
5 points → feature 128-d, cosinus, seuil officiel 0.363.

Chaque moteur expose : available(), detect(pil) -> [(bbox xywh, conf)],
crop(pil, bbox) -> PIL, embed(pil, bbox|None) -> np.float32[dim],
scores(ref_feats, db_feats) -> np.float32[N] CALIBRÉS 0..1 (0.5 = seuil
officiel → même échelle que la recherche normale ; max sur les réfs).
"""
import os

import numpy as np

ENGINE_TAGS = {"anime": "ccip-caformer-24-randaug-pruned", "real": "sface-2021dec"}

CCIP_MODEL = ENGINE_TAGS["anime"]
YUNET_FILE = "face_detection_yunet_2023mar.onnx"
SFACE_FILE = "face_recognition_sface_2021dec.onnx"
SFACE_COS_THR = 0.363   # seuil cosinus officiel OpenCV (même identité si >=)
ANIME_MARGIN = 0.35     # CCIP entraîné sur des crops de personnage → marge généreuse
REAL_MARGIN = 0.25


def _clamp_box(x, y, w, h, W, H):
    x0 = max(0, int(x)); y0 = max(0, int(y))
    x1 = min(int(W), int(x + w)); y1 = min(int(H), int(y + h))
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1 - x0, y1 - y0)


def _expand(bbox, margin, W, H):
    x, y, w, h = bbox
    mx = int(w * margin); my = int(h * margin)
    return _clamp_box(x - mx, y - my, w + 2 * mx, h + 2 * my, W, H)


class AnimeEngine:
    """imgutils detect_faces + CCIP. Import paresseux ; absent → domaine sauté."""

    domain = "anime"
    tag = ENGINE_TAGS["anime"]
    margin = ANIME_MARGIN

    def __init__(self):
        self._ok = None
        self._thr = None

    def available(self):
        if self._ok is None:
            try:
                import imgutils.detect  # noqa: F401
                import imgutils.metrics  # noqa: F401
                self._ok = True
            except Exception:  # noqa: BLE001
                self._ok = False
        return self._ok

    def detect(self, pil):
        """[(bbox xywh, conf)] — detect_faces renvoie ((x0,y0,x1,y1), 'face', conf)."""
        from imgutils.detect import detect_faces
        out = []
        W, H = pil.size
        for (x0, y0, x1, y1), _label, conf in detect_faces(pil, level="s", version="v1.4"):
            b = _clamp_box(x0, y0, x1 - x0, y1 - y0, W, H)
            if b:
                out.append((b, float(conf)))
        return out

    def crop(self, pil, bbox):
        b = _expand(bbox, self.margin, *pil.size) or bbox
        x, y, w, h = b
        return pil.crop((x, y, x + w, y + h))

    def embed(self, pil, bbox=None):
        from imgutils.metrics import ccip_extract_feature
        img = self.crop(pil, bbox) if bbox else pil
        return np.asarray(ccip_extract_feature(img, model=CCIP_MODEL), dtype=np.float32)

    def threshold(self):
        if self._thr is None:
            from imgutils.metrics import ccip_default_threshold
            self._thr = float(ccip_default_threshold(model=CCIP_MODEL))
        return self._thr

    def scores(self, ref_feats, db_feats, chunk=512):
        """Différences CCIP (modèle métrique, PAS un cosinus) → score calibré 0..1.
        diff == seuil officiel → 0.5. Max sur les réfs (meilleure photo gagne)."""
        from imgutils.metrics import ccip_batch_differences
        thr = self.threshold()
        n = len(db_feats)
        best = np.zeros(n, dtype=np.float32)
        for ref in ref_feats:
            diffs = np.empty(n, dtype=np.float32)
            for i in range(0, n, chunk):
                part = db_feats[i:i + chunk]
                m = ccip_batch_differences([ref] + list(part))
                diffs[i:i + len(part)] = m[0, 1:]
            s = 1.0 / (1.0 + np.exp(6.0 * (diffs - thr) / max(thr, 1e-6)))
            best = np.maximum(best, s.astype(np.float32))
        return best

    def score_matrix(self, feats):
        """Matrice N×N calibrée 0..1 en UN SEUL passage modèle (ccip_batch_differences
        renvoie déjà toutes les différences par paires). Pour le clustering de la galerie :
        évite k appels modèle (un par graine) → O(1) passage au lieu de O(k)."""
        from imgutils.metrics import ccip_batch_differences
        thr = self.threshold()
        diffs = np.asarray(ccip_batch_differences(list(feats)), dtype=np.float32)
        return (1.0 / (1.0 + np.exp(6.0 * (diffs - thr) / max(thr, 1e-6)))).astype(np.float32)

    def free(self):
        self._ok = None


class RealEngine:
    """YuNet (détection + 5 landmarks) + SFace (alignCrop → feature 128-d, cosinus).
    Poids ONNX opencv_zoo dans NETSURUSH_FACE_DIR ; absents → domaine sauté."""

    domain = "real"
    tag = ENGINE_TAGS["real"]
    margin = REAL_MARGIN

    def __init__(self):
        self._det = None
        self._rec = None
        self._ok = None
        self._rows = {}  # bbox xywh -> ligne détecteur (15 floats, pour alignCrop)

    def _paths(self):
        d = os.environ.get("NETSURUSH_FACE_DIR", "")
        return os.path.join(d, YUNET_FILE), os.path.join(d, SFACE_FILE)

    def available(self):
        if self._ok is None:
            yunet, sface = self._paths()
            try:
                import cv2
                self._ok = bool(hasattr(cv2, "FaceDetectorYN")
                                and os.path.exists(yunet) and os.path.exists(sface))
            except Exception:  # noqa: BLE001
                self._ok = False
        return self._ok

    def _load(self):
        import cv2
        if self._det is None:
            yunet, sface = self._paths()
            self._det = cv2.FaceDetectorYN.create(yunet, "", (320, 320), 0.8, 0.3, 5000)
            self._rec = cv2.FaceRecognizerSF.create(sface, "")
        return self._det, self._rec

    @staticmethod
    def _bgr(pil):
        import cv2
        return cv2.cvtColor(np.asarray(pil.convert("RGB")), cv2.COLOR_RGB2BGR)

    def detect(self, pil):
        det, _rec = self._load()
        bgr = self._bgr(pil)
        H, W = bgr.shape[:2]
        det.setInputSize((W, H))
        _rc, faces = det.detect(bgr)
        out = []
        self._rows = {}
        if faces is None:
            return out
        for row in faces:
            b = _clamp_box(row[0], row[1], row[2], row[3], W, H)
            if not b:
                continue
            self._rows[b] = row.copy()
            out.append((b, float(row[14])))
        return out

    def crop(self, pil, bbox):
        b = _expand(bbox, self.margin, *pil.size) or bbox
        x, y, w, h = b
        return pil.crop((x, y, x + w, y + h))

    def embed(self, pil, bbox=None):
        """Feature SFace du visage. bbox connue du dernier detect() → alignCrop 5 points ;
        sinon re-détecte sur l'image (réf externe) et prend le plus grand visage."""
        _det, rec = self._load()
        bgr = self._bgr(pil)
        row = self._rows.get(tuple(bbox)) if bbox else None
        if row is None:
            found = self.detect(pil)
            if bbox:
                row = self._rows.get(tuple(bbox))
            if row is None and found:
                big = max(found, key=lambda fc: fc[0][2] * fc[0][3])[0]
                row = self._rows.get(big)
        if row is None:
            return None
        aligned = rec.alignCrop(bgr, row)
        feat = rec.feature(aligned).flatten().astype(np.float32)
        n = float(np.linalg.norm(feat))
        return feat / (n + 1e-8)

    def scores(self, ref_feats, db_feats):
        """Cosinus (features L2-normalisées au stockage) → calibré : 0.363 → 0.5."""
        db = np.stack(db_feats)
        best = np.zeros(len(db_feats), dtype=np.float32)
        for ref in ref_feats:
            cos = db @ ref.astype(np.float32)
            s = 1.0 / (1.0 + np.exp(-12.0 * (cos - SFACE_COS_THR)))
            best = np.maximum(best, s.astype(np.float32))
        return best

    def score_matrix(self, feats):
        """Matrice N×N calibrée 0..1 (cosinus complet db·dbᵀ, features L2-normalisées)."""
        db = np.stack(feats)
        cos = db @ db.T
        return (1.0 / (1.0 + np.exp(-12.0 * (cos - SFACE_COS_THR)))).astype(np.float32)

    def free(self):
        self._det = None
        self._rec = None
        self._rows = {}


_ENGINES = None


def engines():
    """{domain: engine} des moteurs disponibles (dégradation gracieuse par domaine).
    On ne met en cache QUE si un moteur est trouvé : tant que rien n'est dispo (poids/deps pas
    encore installés), on re-teste à chaque appel (available() = léger) → dès qu'un modèle est
    téléchargé pendant la session, il est pris SANS redémarrer le daemon."""
    global _ENGINES
    if _ENGINES:
        return _ENGINES
    found = {}
    for eng in (AnimeEngine(), RealEngine()):
        if eng.available():
            found[eng.domain] = eng
    if found:
        _ENGINES = found
    return found


def free_engines():
    global _ENGINES
    if _ENGINES:
        for eng in _ENGINES.values():
            eng.free()
    _ENGINES = None
