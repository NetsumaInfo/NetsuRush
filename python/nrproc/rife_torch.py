"""Interpolation RIFE en PyTorch — familles 4.15 → 4.25 (poids TheAnimeScripter).

Complète le runtime `rife-ncnn-vulkan` (Vulkan, variantes officielles 4.6 et antérieures) : les
checkpoints 4.15+ n'existent qu'en PyTorch, aucun binaire ncnn ne les lit. L'ARCHITECTURE n'est pas
déductible du checkpoint (chaque version change le nombre de blocs, leurs largeurs et le nombre de
canaux de l'encodeur) → un module d'architecture PAR version, récupéré au téléchargement du modèle
depuis vs-rife (HolyWu, MIT) et déposé dans NETSURUSH_RIFE_ARCH_DIR. Même contrat public que
`RifeEngine` (ncnn) : `.process(bgr0, bgr1, timestep) -> bgr`, donc `nrproc/interp.py` est inchangé.
"""
from __future__ import annotations

import importlib
import math
import os
import sys
import types

from nri18n import t
from nrdevice import torch_backend, torch_device

# Paquet SYNTHÉTIQUE qui accueille les modules d'architecture téléchargés. Les fichiers vs-rife font
# `from .warplayer import warp` : sans paquet parent l'import relatif échoue, et poser un
# `__init__.py` dans un dossier téléchargé le rendrait dépendant d'un fichier non versionné. On
# déclare donc le paquet en mémoire avec son `__path__` — rien à écrire sur le disque.
_ARCH_PACKAGE = "nr_rife_arch"

# id de modèle → (module d'architecture, fichier de poids, multiple de padding exigé par l'arch).
# Le multiple vient de l'arch elle-même (nombre d'étages de sous-échantillonnage) : la 4.25 lite
# descend deux fois plus bas que la 4.22, une image non alignée y produirait un décalage de flot.
ARCHS = {
    "tas-rife4.15":       ("IFNet_HDv3_v4_15", "rife415.pth", 32),
    "tas-rife4.15-lite":  ("IFNet_HDv3_v4_15_lite", "rife415_lite.pth", 32),
    "tas-rife4.16-lite":  ("IFNet_HDv3_v4_16_lite", "rife416_lite.pth", 32),
    "tas-rife4.17":       ("IFNet_HDv3_v4_17", "rife417.pth", 32),
    "tas-rife4.18":       ("IFNet_HDv3_v4_18", "rife418.pth", 32),
    "tas-rife4.20":       ("IFNet_HDv3_v4_20", "rife420.pth", 32),
    "tas-rife4.21":       ("IFNet_HDv3_v4_21", "rife421.pth", 32),
    "tas-rife4.22":       ("IFNet_HDv3_v4_22", "rife422.pth", 32),
    "tas-rife4.22-lite":  ("IFNet_HDv3_v4_22_lite", "rife422_lite.pth", 32),
    "tas-rife4.25":       ("IFNet_HDv3_v4_25", "rife425.pth", 64),
    "tas-rife4.25-lite":  ("IFNet_HDv3_v4_25_lite", "rife425_lite.pth", 128),
    "tas-rife4.25-heavy": ("IFNet_HDv3_v4_25_heavy", "rife425_heavy.pth", 64),
}


def is_torch_model(model) -> bool:
    return str(model) in ARCHS


def _arch_dir() -> str:
    return os.environ.get("NETSURUSH_RIFE_ARCH_DIR", "")


def _weights_dir() -> str:
    return os.environ.get("NETSURUSH_RIFE_TORCH_DIR", "")


def _load_arch(module_name: str):
    """Importe le module d'architecture depuis le dossier téléchargé, via le paquet synthétique."""
    directory = _arch_dir()
    if not directory or not os.path.isdir(directory):
        raise RuntimeError(t("rife_arch_missing", model=module_name))
    package = sys.modules.get(_ARCH_PACKAGE)
    if package is None:
        package = types.ModuleType(_ARCH_PACKAGE)
        sys.modules[_ARCH_PACKAGE] = package
    # `__path__` réévalué à chaque appel : le dossier peut apparaître après le démarrage du daemon
    # (l'utilisateur télécharge le modèle pendant que le worker tourne).
    package.__path__ = [directory]
    return importlib.import_module("%s.%s" % (_ARCH_PACKAGE, module_name))


def _state_dict(torch, path: str):
    """Poids du checkpoint, débarrassés d'un éventuel préfixe DataParallel.

    Les .pth TheAnimeScripter sont déjà nus ; ceux publiés par Practical-RIFE portent `module.`.
    Filtrer SUR la présence du préfixe (comme le fait vs-rife) viderait le dict pour les premiers."""
    raw = torch.load(path, map_location="cpu", weights_only=True)
    if isinstance(raw, dict) and "state_dict" in raw:
        raw = raw["state_dict"]
    return {key.replace("module.", "", 1): value for key, value in raw.items()}


class RifeTorchEngine:
    """RIFE PyTorch. `.process(bgr0, bgr1, timestep)` rend l'image intermédiaire en BGR uint8."""

    def __init__(self, model: str):
        import torch

        module_name, weight_file, self._modulo = ARCHS[str(model)]
        weights = os.path.join(_weights_dir(), weight_file)
        if not os.path.isfile(weights):
            raise RuntimeError(t("rife_weights_missing", file=weights))

        arch = _load_arch(module_name)
        self._torch = torch
        backend = torch_backend(torch)
        self._device = torch.device(torch_device(torch, backend))
        # Demi-précision réservée au GPU : sur CPU elle est plus lente que float32 et certaines
        # convolutions n'ont pas de noyau half.
        self._dtype = torch.half if self._device.type == "cuda" else torch.float

        state = _state_dict(torch, weights)
        # `scale=1` = pleine résolution (le facteur d'échelle de vs-rife sert au 4K sur petit GPU) ;
        # `ensemble=False` car plusieurs versions 4.2x lèvent explicitement dessus.
        flownet = arch.IFNet(1, False)
        flownet.load_state_dict({k: v for k, v in state.items() if not k.startswith("encode.")}, strict=False)
        encode = arch.Head()
        encode.load_state_dict({k[len("encode."):]: v for k, v in state.items() if k.startswith("encode.")})
        self._flownet = flownet.eval().to(self._device, self._dtype)
        self._encode = encode.eval().to(self._device, self._dtype)
        self._geometry = None  # (h, w) → grille de warp + diviseur de flot, recalculés au changement

    def _prepare(self, height: int, width: int):
        """Grille de backwarp et diviseur de flot pour la taille PADDÉE. Mis en cache : ils ne
        dépendent que des dimensions, et les recalculer à chaque image coûterait deux linspace."""
        torch = self._torch
        if self._geometry and self._geometry[0] == (height, width):
            return self._geometry[1]
        padded_h = math.ceil(height / self._modulo) * self._modulo
        padded_w = math.ceil(width / self._modulo) * self._modulo
        div = torch.tensor([(padded_w - 1.0) / 2.0, (padded_h - 1.0) / 2.0],
                           dtype=torch.float, device=self._device)
        horizontal = torch.linspace(-1.0, 1.0, padded_w, dtype=torch.float, device=self._device)
        horizontal = horizontal.view(1, 1, 1, padded_w).expand(-1, -1, padded_h, -1)
        vertical = torch.linspace(-1.0, 1.0, padded_h, dtype=torch.float, device=self._device)
        vertical = vertical.view(1, 1, padded_h, 1).expand(-1, -1, -1, padded_w)
        grid = torch.cat([horizontal, vertical], 1)
        geometry = (padded_h, padded_w, div, grid)
        self._geometry = ((height, width), geometry)
        return geometry

    def _to_tensor(self, bgr, padded_h: int, padded_w: int):
        import numpy as np
        import torch.nn.functional as F
        torch = self._torch
        rgb = np.ascontiguousarray(bgr[:, :, ::-1])
        tensor = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0)
        tensor = tensor.to(self._device, self._dtype).div_(255.0)
        pad = (0, padded_w - bgr.shape[1], 0, padded_h - bgr.shape[0])
        # Réplication du bord : un remplissage à zéro créerait une bande noire que le flot suivrait.
        return F.pad(tensor, pad, mode="replicate") if any(pad) else tensor

    def process(self, img0_bgr, img1_bgr, timestep):
        torch = self._torch
        height, width = img0_bgr.shape[:2]
        padded_h, padded_w, div, grid = self._prepare(height, width)
        first = self._to_tensor(img0_bgr, padded_h, padded_w)
        second = self._to_tensor(img1_bgr, padded_h, padded_w)
        # L'instant voulu est une CARTE (un canal plein cadre), pas un scalaire : les IFBlock le
        # concatènent aux images en entrée de convolution.
        step = torch.full((1, 1, padded_h, padded_w), float(timestep),
                          dtype=self._dtype, device=self._device)
        with torch.inference_mode():
            out = self._flownet(first, second, step, div, grid,
                                self._encode(first), self._encode(second))
        frame = out[0, :, :height, :width].clamp(0.0, 1.0).mul(255.0).byte()
        rgb = frame.permute(1, 2, 0).cpu().numpy()
        import numpy as np
        return np.ascontiguousarray(rgb[:, :, ::-1])
