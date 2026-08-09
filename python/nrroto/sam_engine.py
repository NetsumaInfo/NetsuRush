"""Moteur SAM2 : chargement des poids (dossier modèles NetsuRush ou cache HF), init_state sur un
dossier de frames extraites, points -> masque, propagation memory-bank. Import paresseux : tant que
le package sam2 / les poids ne sont pas là, chaque appel remonte une RuntimeError propre."""
import glob
import os
from nri18n import t
from nrdevice import empty_torch_cache, torch_backend, torch_device

# Mapping nom de checkpoint -> config packagée sam2 (le package résout ses propres yaml Hydra).
_CFG_BY_HINT = [
    ("hiera_large", "configs/sam2.1/sam2.1_hiera_l.yaml"),
    ("hiera_l", "configs/sam2.1/sam2.1_hiera_l.yaml"),
    ("hiera_base_plus", "configs/sam2.1/sam2.1_hiera_b+.yaml"),
    ("hiera_b+", "configs/sam2.1/sam2.1_hiera_b+.yaml"),
    ("hiera_small", "configs/sam2.1/sam2.1_hiera_s.yaml"),
    ("hiera_s", "configs/sam2.1/sam2.1_hiera_s.yaml"),
    ("hiera_tiny", "configs/sam2.1/sam2.1_hiera_t.yaml"),
    ("hiera_t", "configs/sam2.1/sam2.1_hiera_t.yaml"),
]


def _find_ckpt(override_dir=None):
    # Priorité : dossier demandé (sélecteur de modèle UI) → env ckpt → env dir → None (cache HF).
    for d in (override_dir, os.environ.get("NETSURUSH_SAM_DIR", "")):
        if d and os.path.isdir(d):
            hits = sorted(glob.glob(os.path.join(d, "**", "*.pt"), recursive=True))
            if hits:
                return hits[0]
    ckpt = os.environ.get("NETSURUSH_SAM_CKPT", "")
    return ckpt if ckpt and os.path.isfile(ckpt) else None


def _sam2_config_root():
    """Dossier `configs/` du paquet sam2 réellement installé, ou None. Sert à détecter les configs
    qu'un FORK ajoute (SAMURAI) sans avoir à savoir qui a posé le paquet."""
    try:
        import sam2
        root = os.path.join(os.path.dirname(sam2.__file__), "configs")
        return root if os.path.isdir(root) else None
    except Exception:  # noqa: BLE001 — paquet absent : l'appelant le signalera à l'import du builder
        return None


def _cfg_for(ckpt):
    """Config Hydra correspondant au checkpoint.

    Trois cas, dans cet ordre :
      - EdgeTAM n'est pas packagé dans `sam2` : son yaml voyage AVEC ses poids (posé par le
        gestionnaire de modèles) et se référence par chemin absolu ;
      - SAMURAI est un fork de `sam2` qui ajoute `configs/samurai/` — ce sont les MÊMES réseaux, avec
        la mémoire guidée par le mouvement activée. Charger la config `sam2.1` sur ce paquet donnerait
        un SAM 2.1 ordinaire : on aurait installé SAMURAI pour rien ;
      - sinon, la config packagée de la variante Hiera correspondante.
    """
    name = os.path.basename(ckpt).lower()
    if "edgetam" in name:
        local = os.path.join(os.path.dirname(ckpt), "edgetam.yaml")
        if os.path.isfile(local):
            return local
    for hint, cfg in _CFG_BY_HINT:
        if hint in name:
            root = _sam2_config_root()
            samurai = cfg.replace("configs/sam2.1/", "configs/samurai/")
            if root and os.path.isfile(os.path.join(root, samurai.split("configs/", 1)[1])):
                return samurai
            return cfg
    return "configs/sam2.1/sam2.1_hiera_l.yaml"


class SamEngine:
    """Une session vidéo SAM2 (predictor + inference_state). reset() avant de changer de vidéo."""

    def __init__(self):
        self.predictor = None
        self.state = None
        self.device = "cpu"
        self.backend = "cpu"

    def _autocast(self):
        """bf16 sur CUDA (Ampere+) : ~2× plus rapide, <0,5 % de perte.
        fp32 partout ailleurs (nullcontext)."""
        import contextlib
        import torch
        if self.backend in ("cuda", "rocm") and torch.cuda.is_bf16_supported():
            return torch.autocast("cuda", dtype=torch.bfloat16)
        return contextlib.nullcontext()

    def load(self, sam_dir=None):
        if self.predictor is not None:
            return
        try:
            import torch
            from sam2.build_sam import build_sam2_video_predictor
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(t("sam_package_missing", error=exc))
        ckpt = _find_ckpt(sam_dir)
        if not ckpt:
            raise RuntimeError(t("sam_weights_missing"))
        self.backend = torch_backend(torch)
        self.device = torch_device(torch, self.backend)
        try:
            self.predictor = build_sam2_video_predictor(_cfg_for(ckpt), ckpt, device=self.device)
        except Exception:  # noqa: BLE001 - SAM/ops non disponibles sur ce backend → CPU
            if self.backend == "cpu":
                raise
            empty_torch_cache(torch, self.backend)
            self.backend, self.device = "cpu", "cpu"
            self.predictor = build_sam2_video_predictor(_cfg_for(ckpt), ckpt, device="cpu")

    def open(self, frames_dir, sam_dir=None):
        """Charge les frames extraites (JPEG) dans l'état SAM2. Offload CPU = RAM maîtrisée."""
        self.load(sam_dir)
        import torch
        with torch.inference_mode(), self._autocast():
            self.state = self.predictor.init_state(
                video_path=frames_dir, offload_video_to_cpu=True, offload_state_to_cpu=True)

    def _masks_of(self, obj_ids, logits):
        return {int(o): (logits[i][0] > 0.0).cpu().numpy() for i, o in enumerate(obj_ids)}

    def add_points(self, frame, obj, pts):
        """pts = [(x, y, label)] en pixels de la résolution EXTRAITE. Renvoie {obj: masque bool HxW}."""
        if self.state is None:
            raise RuntimeError(t("no_video"))
        import numpy as np
        import torch
        with torch.inference_mode(), self._autocast():
            _f, obj_ids, logits = self.predictor.add_new_points_or_box(
                inference_state=self.state, frame_idx=int(frame), obj_id=int(obj),
                points=np.array([[p[0], p[1]] for p in pts], dtype=np.float32),
                labels=np.array([int(p[2]) for p in pts], dtype=np.int32))
        return self._masks_of(obj_ids, logits)

    def propagate(self, sink, start=None, count=None, reverse=False):
        """Propage ; sink(frame_idx, {obj: masque}) appelé frame par frame (écriture disque au fil
        de l'eau). start/count/reverse = re-propagation PARTIELLE depuis une frame corrigée via les
        args natifs de propagate_in_video (start_frame_idx, max_frame_num_to_track, reverse).
        sink peut lever StopIteration (annulation) → arrêt propre, les frames déjà écrites restent."""
        if self.state is None:
            raise RuntimeError(t("no_video"))
        import torch
        kw = {}
        if start is not None:
            kw["start_frame_idx"] = int(start)
        if count is not None:
            kw["max_frame_num_to_track"] = int(count)
        if reverse:
            kw["reverse"] = True
        n = 0
        with torch.inference_mode(), self._autocast():
            try:
                for f, obj_ids, logits in self.predictor.propagate_in_video(self.state, **kw):
                    sink(int(f), self._masks_of(obj_ids, logits))
                    n += 1
            except StopIteration:
                pass
        return n

    def reset_prompts(self):
        """Efface points + tracking en GARDANT la vidéo chargée (re-pose de points après correction)."""
        if self.predictor is not None and self.state is not None:
            self.predictor.reset_state(self.state)

    def unload(self):
        """Libère la VRAM de SAM (poids + état) en GARDANT tout ce qui a été calculé : les mattes sont
        déjà écrites sur disque et les points persistés. Le predictor ET l'état sont relâchés ; ils se
        rechargent paresseusement au prochain point/propagation (Session._ensure_open → init_state +
        re-pose des points). Sert à laisser la place à un gros modèle (MiniMax/Wan) sur petite carte."""
        self.predictor = None
        self.state = None
        self.device = "cpu"
        backend, self.backend = self.backend, "cpu"
        try:
            import gc
            import torch
            gc.collect()
            empty_torch_cache(torch, backend)
        except Exception:  # noqa: BLE001
            pass

    def reset(self):
        if self.predictor is not None and self.state is not None:
            try:
                self.predictor.reset_state(self.state)
            except Exception:  # noqa: BLE001
                pass
        self.state = None
