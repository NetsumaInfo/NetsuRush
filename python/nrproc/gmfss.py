"""GMFSS Fortuna (98mxr, MIT) — interpolation par flot optique GMFlow + fusion.

Contrairement à RIFE (un seul réseau), GMFSS en enchaîne cinq : flot (GMFlow), RIFE auxiliaire,
métrique, extraction de traits et fusion. Son code est un paquet python entier qui s'importe par
chemins absolus (`from model.gmflow.gmflow import GMFlow`) — on déclare donc le paquet `model` en
mémoire, pointé sur l'arborescence extraite, plutôt que de toucher au disque ou au PYTHONPATH.

Même contrat public que `RifeEngine` : `.process(bgr0, bgr1, timestep) -> bgr`.
"""
from __future__ import annotations

import glob
import math
import os
import sys
import types

from nri18n import t
from nrdevice import torch_backend, torch_device

MODEL_ID = "tas-gmfss"
# Le paquet du dépôt s'appelle `model` : nom très générique, mais ce sont ses propres imports
# absolus qui l'exigent, et le sidecar est un process dédié au traitement.
_PACKAGE = "model"
# Variante « union » : les poids `*_union.pkl` de l'archive, entraînés conjointement.
_WEIGHTS = {
    "flownet": "flownet.pkl",
    "ifnet": "rife.pkl",
    "metricnet": "metric_union.pkl",
    "feat_ext": "feat_union.pkl",
    "fusionnet": "fusionnet_union.pkl",
}
# GMFlow descend de plusieurs octaves : une dimension non alignée casse la recombinaison.
MODULO = 64


def is_gmfss(model) -> bool:
    return str(model) == MODEL_ID


def _root() -> str:
    return os.environ.get("NETSURUSH_GMFSS_DIR", "")


def _code_dir(root: str) -> str:
    """Racine du dépôt extrait : l'archive GitHub crée un dossier suffixé par le commit."""
    for candidate in sorted(glob.glob(os.path.join(root, "GMFSS_Fortuna-*"))):
        if os.path.isdir(os.path.join(candidate, "model")):
            return candidate
    raise RuntimeError(t("gmfss_missing", path=root))


def _install_package(code_dir: str):
    package = sys.modules.get(_PACKAGE)
    if package is None or not isinstance(getattr(package, "__path__", None), list):
        package = types.ModuleType(_PACKAGE)
        sys.modules[_PACKAGE] = package
    package.__path__ = [os.path.join(code_dir, "model")]


class GmfssEngine:
    """GMFSS Fortuna. `.process(bgr0, bgr1, timestep)` rend l'image intermédiaire en BGR uint8."""

    def __init__(self, _model=MODEL_ID):
        import torch

        root = _root()
        if not root or not os.path.isdir(root):
            raise RuntimeError(t("gmfss_missing", path=root or "?"))
        _install_package(_code_dir(root))
        # Import APRÈS la déclaration du paquet : c'est lui qui résout `from model.… import …`.
        from model.GMFSS_infer_u import Model  # type: ignore

        self._torch = torch
        backend = torch_backend(torch)
        self._device = torch.device(torch_device(torch, backend))
        net = Model()
        for attribute, filename in _WEIGHTS.items():
            path = os.path.join(root, filename)
            if not os.path.isfile(path):
                raise RuntimeError(t("gmfss_missing", path=path))
            getattr(net, attribute).load_state_dict(torch.load(path, map_location="cpu"))
        net.eval()
        # `Model.device()` déplace les cinq réseaux ; le module choisit lui-même CUDA si disponible.
        net.device()
        self._net = net
        self._geometry = None

    def _padded(self, height: int, width: int):
        if self._geometry and self._geometry[0] == (height, width):
            return self._geometry[1]
        padded = (math.ceil(height / MODULO) * MODULO, math.ceil(width / MODULO) * MODULO)
        self._geometry = ((height, width), padded)
        return padded

    def _to_tensor(self, bgr, padded_h, padded_w):
        import numpy as np
        import torch.nn.functional as F
        torch = self._torch
        rgb = np.ascontiguousarray(bgr[:, :, ::-1])
        tensor = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0)
        tensor = tensor.to(self._device).float().div(255.0)
        pad = (0, padded_w - bgr.shape[1], 0, padded_h - bgr.shape[0])
        return F.pad(tensor, pad, mode="replicate") if any(pad) else tensor

    def process(self, img0_bgr, img1_bgr, timestep):
        import numpy as np
        torch = self._torch
        height, width = img0_bgr.shape[:2]
        padded_h, padded_w = self._padded(height, width)
        first = self._to_tensor(img0_bgr, padded_h, padded_w)
        second = self._to_tensor(img1_bgr, padded_h, padded_w)
        with torch.inference_mode():
            # `reuse` calcule flot et traits une fois pour la paire ; l'appelant peut demander
            # plusieurs instants entre les deux mêmes images, d'où le cache par paire.
            shared = self._net.reuse(first, second, 1.0)
            out = self._net.inference(first, second, shared, timestep=float(timestep))
        frame = out[0, :, :height, :width].clamp(0.0, 1.0).mul(255.0).round().byte()
        rgb = frame.permute(1, 2, 0).cpu().numpy()
        return np.ascontiguousarray(rgb[:, :, ::-1])
