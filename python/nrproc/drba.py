"""DistilDRBA (routineLife1, MIT) — interpolation guidée par TROIS images.

Là où RIFE n'observe que la paire à interpoler, DRBA reçoit aussi l'image voisine et centre son
estimation de flot sur l'image du milieu : l'instant demandé vit dans [0,5 ; 1,5] autour de ce
centre, jamais au-delà. On aiguille donc chaque fraction vers le bon centre :

    fraction ≤ 0,5 entre A et B  → fenêtre (précédente, A, B), instant 1 + fraction
    fraction > 0,5 entre A et B  → fenêtre (A, B, suivante), instant fraction

L'image PRÉCÉDENTE est mémorisée sur le moteur : le pipeline la lui a déjà passée au tour d'avant.
L'image SUIVANTE, elle, n'existe pas encore quand on écrit les images intermédiaires — le flux est
lu en avançant, sans lecture en avance. Au-delà de 0,5 on répète donc l'image B comme suivante, ce
que le modèle fait lui-même en fin de séquence. Conséquence concrète : **au facteur 2 la seule
fraction demandée est 0,5, donc le contexte est toujours exact** ; aux facteurs 3 et 4, les
fractions supérieures à 0,5 perdent le seul contexte aval.

Même contrat public que `RifeEngine` : `.process(bgr0, bgr1, timestep) -> bgr`.
"""
from __future__ import annotations

import importlib
import math
import os
import sys
import types

from nri18n import t
from nrdevice import torch_backend, torch_device

# Paquet synthétique qui accueille les modules téléchargés (mêmes raisons que nrproc/rife_torch).
_ARCH_PACKAGE = "nr_drba_arch"

# id → (module d'architecture, fichier de poids, échelles de travail du réseau).
# Les échelles viennent du dépôt : la variante allégée s'arrête plus tôt dans la pyramide.
ARCHS = {
    "tas-distildrba": ("distilDRBA", "v1.pkl", (16, 8, 4, 2, 1)),
    "tas-distildrba-lite": ("distilDRBA_v2_lite", "v2_lite.pkl", (16, 8, 4)),
}


def is_drba(model) -> bool:
    return str(model) in ARCHS


def _arch_dir() -> str:
    return os.environ.get("NETSURUSH_DRBA_ARCH_DIR", "")


def _weights_dir() -> str:
    return os.environ.get("NETSURUSH_DRBA_DIR", "")


def _declare(name: str, search_path):
    module = sys.modules.get(name)
    if module is None:
        module = types.ModuleType(name)
        sys.modules[name] = module
    module.__path__ = list(search_path)
    return module


def _load_arch(module_name: str):
    directory = _arch_dir()
    if not directory or not os.path.isdir(directory):
        raise RuntimeError(t("drba_arch_missing", model=module_name))
    # Les modules du dépôt importent `warplayer` en ABSOLU (`from models.drba.warplayer import warp`)
    # parce qu'ils y vivent sous `models/drba/`. On recrée donc ce chemin de paquets en mémoire,
    # pointé sur le dossier téléchargé — rien à écrire sur le disque, aucun PYTHONPATH à bricoler.
    parent = _declare("models", [])
    parent.drba = _declare("models.drba", [directory])
    _declare(_ARCH_PACKAGE, [directory])
    return importlib.import_module("%s.%s" % (_ARCH_PACKAGE, module_name))


class DrbaEngine:
    """DistilDRBA. `.process(bgr0, bgr1, timestep)` rend l'image intermédiaire en BGR uint8."""

    def __init__(self, model: str):
        import torch

        module_name, weight_file, scales = ARCHS[str(model)]
        weights = os.path.join(_weights_dir(), weight_file)
        if not os.path.isfile(weights):
            raise RuntimeError(t("drba_weights_missing", file=weights))
        arch = _load_arch(module_name)
        self._torch = torch
        self._scales = list(scales)
        # La pyramide descend jusqu'à `scales[0]` : les dimensions doivent lui rester alignées.
        self._modulo = int(scales[0]) * 4
        backend = torch_backend(torch)
        self._device = torch.device(torch_device(torch, backend))
        self._dtype = torch.half if self._device.type == "cuda" else torch.float
        net = arch.IFNet()
        net.load_state_dict(torch.load(weights, map_location="cpu"), strict=True)
        self._net = net.eval().to(self._device, self._dtype)
        self._geometry = None
        self._context = None   # image AVANT celle de gauche, tenue d'un appel à l'autre
        self._left = None      # image de gauche de la paire en cours, pour détecter son changement

    def _padded(self, height: int, width: int):
        if self._geometry and self._geometry[0] == (height, width):
            return self._geometry[1]
        padded = (math.ceil(height / self._modulo) * self._modulo,
                  math.ceil(width / self._modulo) * self._modulo)
        self._geometry = ((height, width), padded)
        return padded

    def _to_tensor(self, bgr, padded_h, padded_w):
        import numpy as np
        import torch.nn.functional as F
        torch = self._torch
        rgb = np.ascontiguousarray(bgr[:, :, ::-1])
        tensor = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0)
        tensor = tensor.to(self._device, self._dtype).div_(255.0)
        pad = (0, padded_w - bgr.shape[1], 0, padded_h - bgr.shape[0])
        return F.pad(tensor, pad, mode="replicate") if any(pad) else tensor

    def _advance(self, left):
        """Suit l'avancée du flux : le pipeline répète la même paire pour chaque fraction, donc le
        contexte ne glisse QUE lorsque l'image de gauche change."""
        if left is self._left:
            return
        self._context = self._left if self._left is not None else left
        self._left = left

    def process(self, img0_bgr, img1_bgr, timestep):
        import numpy as np
        torch = self._torch
        self._advance(img0_bgr)
        height, width = img0_bgr.shape[:2]
        padded_h, padded_w = self._padded(height, width)
        left = self._to_tensor(img0_bgr, padded_h, padded_w)
        right = self._to_tensor(img1_bgr, padded_h, padded_w)
        fraction = float(timestep)
        if fraction <= 0.5:
            window = (self._to_tensor(self._context, padded_h, padded_w), left, right)
            instant = 1.0 + fraction
        else:
            # Pas d'image aval disponible : on répète celle de droite (cf. en-tête du module).
            window = (left, right, right)
            instant = fraction
        with torch.inference_mode():
            out, _, _, _ = self._net(*window, timestep=instant, scale_list=self._scales)
        frame = out[0, :, :height, :width].clamp(0.0, 1.0).mul(255.0).round().byte()
        rgb = frame.permute(1, 2, 0).cpu().numpy()
        return np.ascontiguousarray(rgb[:, :, ::-1])
