"""SigLIP 2 : chargement (lazy), embedding image/texte (L2-normalisé), calibration des scores
(sigmoïde appris → probabilité de pertinence) et vecteurs esthétiques zero-shot. Possède l'état
global du modèle ; torch/transformers sont importés à la demande (status/catalog n'en ont pas besoin)."""
import math
import os
import sys

import numpy as np

from .config import DEFAULT_MAX_PATCHES, GPU_BATCH, MAX_PATCHES, MODEL_SRC
from nrdevice import empty_torch_cache, torch_autocast, torch_backend, torch_device

_MODEL = None
_PROC = None
_DEV = None
_BACKEND = None
_LOGIT_SCALE = None   # exp(logit_scale) du modèle SigLIP (calibration des scores). None = non extrait.
_LOGIT_BIAS = None
_AES_VECS = None      # (vecteur "net/qualité", vecteur "flou") cachés pour le score esthétique zero-shot


def free_memory():
    """Décharge la mémoire morte : objets Python (gc) + cache VRAM réservé mais inutilisé (CUDA).
    Appelé entre les grosses étapes (après la détection, sur saturation) → on libère et on reprend
    au lieu de figer/changer de modèle. N'enlève que ce qui ne sert plus, ne touche pas SigLIP chargé."""
    import gc
    gc.collect()
    try:
        import torch
        empty_torch_cache(torch, _BACKEND)
    except Exception:  # noqa: BLE001
        pass


def load():
    """Charge SigLIP 2 (lazy : status/get_scenes n'en ont pas besoin)."""
    global _MODEL, _PROC, _DEV, _BACKEND, _LOGIT_SCALE, _LOGIT_BIAS
    if _MODEL is not None:
        return
    import torch
    from transformers import AutoModel, AutoProcessor
    forced = os.environ.get("NETSURUSH_SIGLIP_DEVICE", "").strip().lower()
    _BACKEND = torch_backend(torch, forced if forced in ("cpu", "cuda", "rocm", "xpu") else None)
    _DEV = torch_device(torch, _BACKEND)
    sys.stderr.write("PHASE:model\nSTAGE:load\n"); sys.stderr.flush()  # chargement modèle SigLIP
    _PROC = AutoProcessor.from_pretrained(MODEL_SRC)
    # fp16 sur GPU = moitié VRAM/RAM (l'inférence est déjà en autocast fp16) ; low_cpu_mem_usage
    # évite le pic ×2 en RAM au chargement → pas de swap disque (le "STAGE:load" qui figeait sur
    # machine chargée : 8 Go VRAM partagés avec Resolve + pagefile bas).
    dtype = torch.float16 if _BACKEND != "cpu" else torch.float32

    def _fp(selected_dtype, **extra):
        try:
            return AutoModel.from_pretrained(MODEL_SRC, dtype=selected_dtype, **extra)         # transformers 5.x
        except TypeError:
            return AutoModel.from_pretrained(MODEL_SRC, torch_dtype=selected_dtype, **extra)   # transformers <5

    def _load_model(selected_dtype):
        try:
            return _fp(selected_dtype, low_cpu_mem_usage=True)
        except Exception:  # noqa: BLE001  (accelerate absent / autre → repli sans l'option)
            return _fp(selected_dtype)

    _MODEL = _load_model(dtype)
    try:
        _MODEL = _MODEL.to(_DEV).eval()
    except Exception:  # noqa: BLE001 - VRAM saturée ou backend/model non compatible
        free_memory()
        try:
            _MODEL = _MODEL.to(_DEV).eval()
        except Exception as exc:  # noqa: BLE001 - accélérateur/runtime incomplet → CPU fiable
            sys.stderr.write("[search] backend %s indisponible (%s) → CPU\n" % (_BACKEND, exc))
            _BACKEND, _DEV = "cpu", "cpu"
            _MODEL = _load_model(torch.float32).to("cpu").eval()
    # Calibration : logit_scale/logit_bias appris du modèle → sigmoïde qui transforme le cosinus
    # en probabilité de pertinence lisible (slider « > X % »). logit_scale est un log-température
    # → on l'exponentie une fois. Absents (variante sans tête) → on retombe sur le cosinus brut.
    try:
        _LOGIT_SCALE = math.exp(float(_MODEL.logit_scale.detach().float().cpu().item()))
        _LOGIT_BIAS = float(_MODEL.logit_bias.detach().float().cpu().item())
    except Exception:  # noqa: BLE001
        _LOGIT_SCALE = None
        _LOGIT_BIAS = None


def _pool(out):
    """get_image/text_features peut renvoyer un tensor OU un objet de sortie selon la
    version de transformers (5.x renvoie BaseModelOutputWithPooling) → on extrait le vecteur."""
    import torch
    if isinstance(out, torch.Tensor):
        return out
    for attr in ("pooler_output", "image_embeds", "text_embeds"):
        v = getattr(out, attr, None)
        if v is not None:
            return v
    lhs = getattr(out, "last_hidden_state", None)
    if lhs is not None:
        return lhs.mean(dim=1)
    raise RuntimeError("sortie d'embedding inattendue: %s" % type(out).__name__)


def _l2(t):
    import torch
    return torch.nn.functional.normalize(t, p=2, dim=-1)


_PATCHES_SUPPORTED = None   # None = pas encore sondé ; False = processeur à grille fixe


def _process_images(pil_list):
    """Prépare les tenseurs d'entrée, à la résolution d'analyse demandée.

    À la valeur par défaut on n'envoie PAS `max_num_patches` : l'appel reste MOT POUR MOT celui
    d'avant, donc les vecteurs aussi — c'est ce qui garantit qu'un index existant reste valide.
    Les variantes naflex acceptent le paramètre ; celles à grille fixe (…-patch16-384) le refusent,
    on le constate une fois et on n'insiste plus."""
    global _PATCHES_SUPPORTED
    if MAX_PATCHES == DEFAULT_MAX_PATCHES or _PATCHES_SUPPORTED is False:
        return _PROC(images=pil_list, return_tensors="pt")
    try:
        inputs = _PROC(images=pil_list, return_tensors="pt", max_num_patches=MAX_PATCHES)
    except (TypeError, ValueError) as exc:
        _PATCHES_SUPPORTED = False
        sys.stderr.write("[search] %s ignore max_num_patches (%s) → résolution d'analyse du modèle\n"
                         % (type(_PROC).__name__, exc))
        return _PROC(images=pil_list, return_tensors="pt")
    _PATCHES_SUPPORTED = True
    return inputs


def embed_images(pil_list, batch=GPU_BATCH):
    """Embed une liste d'images en sous-batches de `batch` (sature le GPU, borne la VRAM).
    Retourne (N, dim) float32 L2-normalisé."""
    import torch
    if not pil_list:
        return np.zeros((0, 0), dtype=np.float32)
    out = []
    for i in range(0, len(pil_list), batch):
        sub = pil_list[i:i + batch]
        inputs = _process_images(sub).to(_DEV)
        with torch.no_grad():
            with torch_autocast(torch, _BACKEND, torch.float16):
                feats = _pool(_MODEL.get_image_features(**inputs))
        out.append(_l2(feats.float()).cpu().numpy().astype(np.float32))
    return np.concatenate(out, axis=0)


def embed_texts(texts):
    """Embed une LISTE de textes en UN SEUL forward → les vues d'une même requête (cf. qtext) ne
    coûtent pas N allers-retours GPU. Retourne (N, dim) float32 L2-normalisé."""
    import torch
    if not texts:
        return np.zeros((0, 0), dtype=np.float32)
    inputs = _PROC(text=[t.lower() for t in texts], return_tensors="pt",
                   padding="max_length", max_length=64).to(_DEV)
    with torch.no_grad():
        with torch_autocast(torch, _BACKEND, torch.float16):
            feats = _pool(_MODEL.get_text_features(**inputs))
    return _l2(feats.float()).cpu().numpy().astype(np.float32)


def embed_text(text):
    return embed_texts([text])[0]


def calibrate(cos):
    """Cosinus → probabilité de pertinence [0,1] via le sigmoïde calibré de SigLIP
    (sigmoid(cos·exp(logit_scale)+logit_bias)). Monotone → ne change PAS le classement, rend le
    score lisible en %. Paramètres absents → renvoie le cosinus brut."""
    if _LOGIT_SCALE is None:
        return float(cos)
    x = float(cos) * _LOGIT_SCALE + _LOGIT_BIAS
    if x >= 0:                       # forme stable du sigmoïde (évite overflow exp)
        return 1.0 / (1.0 + math.exp(-x))
    e = math.exp(x)
    return e / (1.0 + e)


def aesthetic_vecs():
    """Deux vecteurs texte (cachés) pour un score netteté/qualité zero-shot (Tier B sans
    entraînement) : aesthetic = cos(plan, « net/qualité ») − cos(plan, « flou/mauvaise qualité »)."""
    global _AES_VECS
    if _AES_VECS is None:
        g = embed_text("a sharp, high quality, well exposed, in focus photo")
        b = embed_text("a blurry, low quality, out of focus, poorly exposed photo")
        _AES_VECS = (g.astype(np.float32), b.astype(np.float32))
    return _AES_VECS
