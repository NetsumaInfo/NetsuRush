"""Architectures de super-résolution communautaires publiées HORS du registre Spandrel.

Spandrel déduit l'architecture d'un `state_dict` : il ne connaît que celles qu'il embarque. SMoSR et
FIGSR n'y sont pas, et leurs checkpoints ne portent aucune métadonnée d'architecture —
seul le code du dépôt d'origine (MIT) permet de les instancier. Comme pour NTIRE, on télécharge le
module d'architecture À CÔTÉ des poids et on le charge par chemin.

Les hyperparamètres ci-dessous ne sont pas des valeurs par défaut recopiées : ils ont été DÉDUITS des
formes des tenseurs de chaque checkpoint, puis validés par un chargement `strict` (aucune clé
manquante ni inattendue) suivi d'une passe avant. Un jeu d'hyperparamètres faux produirait des images
plausibles mais fausses — d'où le `strict`, qui échoue au lieu de deviner.
"""

import sys
import types

from nri18n import t

from .backends import TorchUpsampler
from .log import log
from .ntire import _load_arch, _state_dict

# id NetsuRush → classe, hyperparamètres, échelle de sortie, et clés dont l'absence est ATTENDUE.
COMMUNITY_ARCHS = {
    # umzi2/SMoSR — `rep=True` : les convolutions sont reparamétrables, d'où les `eval_conv`/`mul`
    # présents dans le checkpoint.
    "smosr": {
        "class": "SMoSR", "scale": 2,
        "kwargs": {"dim": 48, "n_mb": 3, "scale": 2, "rep": True,
                   "upsampler": "pixelshuffledirect", "upsampler_mid_dim": 16, "d_kernel": 1},
    },
    # enhancr/figsr — 24 blocs répartis en deux moitiés, ratio d'expansion 2.5 (fc1 sort 2× la
    # dimension cachée puisque la moitié sert de porte).
    "figsr": {
        "class": "FIGSR", "scale": 2,
        "kwargs": {"dim": 32, "scale": 2, "n_blocks": 24, "gc": 8, "expansion_ratio": 2.5,
                   "square_kernel_size": 13, "band_kernel_size": 17,
                   "upsampler": "pixelshuffledirect"},
    },
    # Saryn V1 Lite = un RTMoSR (mêmes `to_feat`/`body`/`to_img` à convolutions reparamétrables).
    # `reshape_params` : le checkpoint stocke les paramètres RMSNorm déjà en (C,1,1) alors que cette
    # implémentation les garde en (C,) et ajoute les axes à l'application — mêmes valeurs, même calcul.
    "saryn": {
        "class": "RTMoSR", "scale": 2, "reshape_params": True,
        "kwargs": {"scale": 2, "dim": 32, "ffn_expansion": 2, "n_blocks": 2},
    },
}

# `smosr_arch.py` est extrait d'un dépôt d'entraînement : il importe le registre de traiNNer pour un
# simple décorateur. Installer traiNNer entier pour ça serait absurde — on fournit le décorateur.
_TRAINNER_STUB = "traiNNer.utils.registry"


def _install_trainner_stub():
    if _TRAINNER_STUB in sys.modules:
        return
    registry = types.ModuleType(_TRAINNER_STUB)

    class _Registry:
        def register(self, *args, **_kwargs):
            def decorate(obj):
                return obj
            return decorate(args[0]) if args else decorate

    registry.ARCH_REGISTRY = _Registry()
    for name in ("traiNNer", "traiNNer.utils"):
        if name not in sys.modules:
            package = types.ModuleType(name)
            package.__path__ = []
            sys.modules[name] = package
    sys.modules[_TRAINNER_STUB] = registry
    sys.modules["traiNNer"].utils = sys.modules["traiNNer.utils"]
    sys.modules["traiNNer.utils"].registry = registry


def _read_state(path):
    """Poids du checkpoint, `.pth` comme `.safetensors` (le catalogue mélange les deux formats)."""
    if path.lower().endswith(".safetensors"):
        from safetensors.torch import load_file
        return load_file(path)
    import torch
    return _state_dict(torch.load(path, map_location="cpu"))


def _reshape_to_model(net, state):
    """Remet un tenseur dans la forme attendue quand seule sa DISPOSITION diffère (même nombre
    d'éléments). Deux implémentations d'une même normalisation peuvent stocker (C,) ou (C,1,1) ;
    la valeur et le calcul sont identiques. Toute autre divergence de forme reste une erreur."""
    own = net.state_dict()
    for key, value in list(state.items()):
        target = own.get(key)
        if target is not None and value.shape != target.shape and value.numel() == target.numel():
            state[key] = value.reshape(target.shape)
    return state


def _load_weights(net, state, optional_keys):
    """Charge en exigeant la correspondance EXACTE, sauf pour des tampons de configuration nommés."""
    if not optional_keys:
        net.load_state_dict(state, strict=True)
        return
    missing, unexpected = net.load_state_dict(state, strict=False)
    missing = [key for key in missing if not key.endswith(optional_keys)]
    if missing or unexpected:
        raise RuntimeError("état incompatible — manquantes %s, inattendues %s"
                           % (missing[:3], list(unexpected)[:3]))


class CommunityUpsampler(TorchUpsampler):
    """Architecture communautaire (module .py téléchargé) + poids du catalogue."""

    def __init__(self, model_id, model_path, code_path, fp32, tile=0, tile_pad=10, pre_pad=0):
        import torch

        entry = COMMUNITY_ARCHS.get(model_id)
        if not entry:
            raise RuntimeError("architecture communautaire inconnue : %s" % model_id)
        _install_trainner_stub()
        try:
            arch_module = _load_arch(code_path, model_id)
        except Exception as exc:  # noqa: BLE001 - dépendance manquante ou fichier corrompu
            raise RuntimeError(t("ntire_code_missing", model=model_id, error=exc)) from exc

        net = getattr(arch_module, entry["class"])(**entry["kwargs"])
        state = _read_state(model_path)
        if entry.get("reshape_params"):
            state = _reshape_to_model(net, dict(state))
        _load_weights(net, state, entry.get("optional_keys"))
        log("[upscale] architecture communautaire %s (%s)" % (model_id, entry["class"]))
        self._setup(torch, net, entry["scale"], fp32, tile, tile_pad, pre_pad,
                    "modèle %s" % entry["class"])
