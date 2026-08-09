"""Modèles du challenge NTIRE 2026 Efficient Super-Resolution (dépôt Amazingren/NTIRE2026_ESR, MIT).

Chaque équipe livre son architecture dans un module `models/teamXX_Nom.py` : Spandrel ne peut pas la
déduire d'un checkpoint, il faut le code. Ces modules sont autonomes (aucun n'importe son voisin),
donc on télécharge le fichier d'architecture À CÔTÉ des poids et on le charge par chemin — plutôt que
d'installer un paquet nommé `models`, bien trop générique pour vivre dans site-packages.

Non intégrés volontairement : les deux modèles Mamba (compilation CUDA de `mamba_ssm`) et team22
(opérateur CUDA maison) — ils exigeraient une chaîne de build sur le poste de l'utilisateur.
"""

from nri18n import t

from .backends import TorchUpsampler
from .log import log

# id NetsuRush → (classe, args positionnels, kwargs). Constructeurs repris À L'IDENTIQUE de
# `test_demo.py` : ce sont les seules valeurs pour lesquelles les poids publiés chargent.
NTIRE_ARCHS = {
    "ntire-span":      ("SPAN", (3, 3), {"upscale": 4, "feature_channels": 28}),
    "ntire-pds":       ("PDS", (), {}),
    "ntire-zenosr":    ("ZenoSR", (), {}),
    "ntire-haesr":     ("HAESR", (), {
        "num_feat": 48, "upsampling": 4, "window_size": 8, "res_num": 3,
        "block_num": 1, "bias": True, "ffn_bias": True, "pe": True}),
    "ntire-rfdn-span": ("RFDN_SPAN", (), {
        "in_nc": 3, "nf": 46, "num_modules": 4, "out_nc": 3, "upscale": 4}),
    "ntire-hfenet":    ("HFENet", (), {}),
    "ntire-vscinet":   ("VSCINet", (), {}),
    "ntire-dscf":      ("DSCF_Fused", (), {
        "num_in_ch": 3, "num_out_ch": 3, "feature_channels": 26, "upscale": 4}),
    "ntire-pkdsr":     ("SPANFPrunedKD", (3, 3), {
        "upscale": 4, "tail_channels": 24, "feature_channels": 32}),
    "ntire-amcanet":   ("AMCANet", (), {
        "in_nc": 3, "out_nc": 3, "dim": 32, "n_blocks": 7, "upscaling_factor": 4, "num_heads": 2}),
    "ntire-disp":      ("DISP", (), {}),
    "ntire-bviesr":    ("BVI_SRF", (), {}),
    "ntire-errn2":     ("ERRN2", (), {
        "in_channels": 3, "out_channels": 3, "feature_channels": 32, "upscale": 4}),
    "ntire-safmn":     ("SAFMN_Deep15", (), {
        "num_in_ch": 3, "num_out_ch": 3, "dim": 40, "num_blocks": 15, "upscale": 4}),
}

# Tous les modèles du challenge concourent sur la même tâche ×4.
NTIRE_SCALE = 4


def _load_arch(code_path, model_id):
    """Importe le module d'architecture par CHEMIN (il n'est sur aucun sys.path)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("nr_ntire_%s" % model_id.replace("-", "_"), code_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(t("ntire_code_missing", model=model_id, error=code_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _state_dict(raw):
    """Les équipes publient tantôt le state dict nu, tantôt sous `params`/`params_ema`, tantôt
    préfixé `module.` (entraînement DataParallel). On normalise plutôt que d'écrire 14 variantes."""
    state = raw
    for key in ("params_ema", "params"):
        if isinstance(state, dict) and key in state:
            state = state[key]
            break
    if isinstance(state, dict) and any(str(k).startswith("module.") for k in state):
        state = {str(k).replace("module.", "", 1): v for k, v in state.items()}
    return state


class NtireUpsampler(TorchUpsampler):
    """Architecture NTIRE 2026 ESR + poids du `model_zoo` officiel."""

    def __init__(self, model_id, model_path, code_path, fp32, tile=0, tile_pad=10, pre_pad=0):
        import torch

        entry = NTIRE_ARCHS.get(model_id)
        if not entry:
            raise RuntimeError("modèle NTIRE inconnu : %s" % model_id)
        class_name, args, kwargs = entry
        try:
            arch_module = _load_arch(code_path, model_id)
        except Exception as exc:  # noqa: BLE001 - dépendance manquante ou fichier corrompu
            raise RuntimeError(t("ntire_code_missing", model=model_id, error=exc)) from exc

        net = getattr(arch_module, class_name)(*args, **kwargs)
        # `strict=True` : un poids qui ne correspond pas à ces hyperparamètres produirait des images
        # plausibles mais fausses — mieux vaut échouer en nommant le modèle.
        net.load_state_dict(_state_dict(torch.load(model_path, map_location="cpu")), strict=True)
        log("[upscale] NTIRE ESR %s (%s)" % (model_id, class_name))
        self._setup(torch, net, NTIRE_SCALE, fp32, tile, tile_pad, pre_pad, "modèle %s" % class_name)
