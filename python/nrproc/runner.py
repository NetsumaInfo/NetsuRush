"""Cache paresseux d'UN modèle en VRAM par (mode, model). On évince au changement de clé pour
borner la VRAM (un seul modèle chargé à la fois, comme upscaler.backends.get_upsampler).

Les libs lourdes (rife_ncnn_vulkan_python, transformers, depth_anything_3) sont importées DANS les
fonctions : l'import du module ne casse jamais si un wheel manque (le handler renvoie
{ok:False, error:...})."""

import json
import os

from nri18n import t
from nrdevice import torch_backend, torch_device

# Cache d'un seul moteur chargé (worker persistant) : recharge seulement si (mode, model) change.
_CACHE = {"key": None, "engine": None}


def local_model_dir(model):
    """Dossier local d'un modèle installé par Paramètres › Modèles, sinon None.

    Le core publie la table (id → dossier) dans NETSURUSH_MODEL_DIRS. Sans elle, transformers
    retéléchargeait le dépôt dans SON cache alors que le gestionnaire venait de poser les poids sur
    le disque — le modèle s'affichait « installé » et coûtait pourtant un second téléchargement.
    """
    try:
        table = json.loads(os.environ.get("NETSURUSH_MODEL_DIRS", "") or "{}")
        directory = table.get(str(model))
        return directory if directory and os.path.isdir(directory) else None
    except Exception:  # noqa: BLE001 — table absente/illisible : on retombe sur le dépôt HF
        return None


def _get(mode, model, builder):
    """Renvoie le moteur en cache pour (mode, model) ; (re)construit via `builder` si la clé change.
    Évince l'ancien moteur (référence lâchée) avant d'en charger un nouveau → 1 modèle en VRAM."""
    key = (mode, model)
    if _CACHE["key"] != key or _CACHE["engine"] is None:
        _CACHE["engine"] = None  # lâche l'ancien (laisse le GC/Vulkan libérer la VRAM) avant de charger
        _CACHE["engine"] = builder()
        _CACHE["key"] = key
    return _CACHE["engine"]


class RifeEngine:
    """Wrapper fin autour de rife_ncnn_vulkan_python.Rife : .process(prev_bgr, cur_bgr, t)."""

    def __init__(self, model):
        from rife_ncnn_vulkan_python import Rife
        self._rife = Rife(gpuid=0, model=model)

    def process(self, img0_bgr, img1_bgr, timestep):
        # Le wheel officiel 1.2.1 n'expose QUE `.process(PIL, PIL, timestep)`, jamais `process_cv2`.
        # Le pipeline NetsuRush travaille en numpy BGR : conversion explicite BGR↔RGB autour du moteur.
        import numpy as np
        from PIL import Image
        rgb0 = Image.fromarray(np.ascontiguousarray(img0_bgr[:, :, ::-1]))
        rgb1 = Image.fromarray(np.ascontiguousarray(img1_bgr[:, :, ::-1]))
        out_rgb = np.asarray(self._rife.process(rgb0, rgb1, timestep))
        return np.ascontiguousarray(out_rgb[:, :, ::-1])


class DepthEngine:
    """Wrapper fin autour de transformers.pipeline('depth-estimation') : .predict(pil_rgb) → PIL depth."""

    def __init__(self, hf_id):
        import torch
        from transformers import pipeline
        backend = torch_backend(torch)
        device = torch_device(torch, backend)
        try:
            self._pipe = pipeline("depth-estimation", model=hf_id, device=device)
        except Exception:  # noqa: BLE001 - ops/model incompatibles avec le constructeur
            if backend == "cpu":
                raise
            self._pipe = pipeline("depth-estimation", model=hf_id, device="cpu")

    def predict(self, pil_rgb):
        return self._pipe(pil_rgb)["depth"]


class VideoDepthEngine:
    """Video Depth Anything (profondeur vidéo TEMPORELLE, Small = Apache 2.0). SCAFFOLD non testé :
    import paresseux du package `video_depth_anything` ; expose la même interface `.predict(pil_rgb)`
    que DepthEngine pour rester compatible avec la boucle streamée de depth.py.

    NOTE : la vraie force de VDA est la cohérence temporelle sur une FENÊTRE de frames (pas image par
    image). Le traitement par fenêtre glissante est une amélioration future — ici on route l'inférence
    image par image (best-effort). Package absent → erreur propre remontée par le handler."""

    _ENCODERS = {"small": "vits", "base": "vitb", "large": "vitl"}

    def __init__(self, variant="small", metric=False):
        # Import paresseux : un package manquant donne {ok:False, error:...} côté handler.
        import torch  # noqa: F401
        encoder = self._ENCODERS.get(variant, "vits")
        if metric:
            # Variante MÉTRIQUE (distances absolues) : classe dédiée du même package (best-effort,
            # nom d'API à confirmer runtime → repli sur la classe relative si absente).
            try:
                from video_depth_anything.metric_video_depth import MetricVideoDepthAnything  # type: ignore
                self._model = MetricVideoDepthAnything(encoder=encoder).eval()
                return
            except Exception:  # noqa: BLE001
                pass
        from video_depth_anything.video_depth import VideoDepthAnything  # type: ignore
        self._model = VideoDepthAnything(encoder=encoder).eval()

    def predict(self, pil_rgb):
        import numpy as np
        from PIL import Image
        arr = np.asarray(pil_rgb)
        # API réelle à confirmer runtime (infer_video_depth attend une liste de frames) → best-effort.
        depth = self._model.infer_image_depth(arr) if hasattr(self._model, "infer_image_depth") else arr
        return Image.fromarray(np.asarray(depth))


class Da3Engine:
    """Depth Anything 3 (ByteDance, Apache-2.0). Ce N'EST PAS un modèle transformers : les dépôts DA3
    déclarent `library_name: depth-anything-3` et `pipeline('depth-estimation')` échoue dessus — il
    faut le package officiel `depth_anything_3`. Expose `.predict(pil_rgb)` comme DepthEngine.

    `inference()` prend une LISTE d'images (PIL accepté) et renvoie une prédiction dont `.depth` est
    un tableau flottant HxW ; depth.py le normalise lui-même, aucune conversion en PIL n'est utile."""

    def __init__(self, source):
        import torch
        try:
            from depth_anything_3.api import DepthAnything3  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(t("da3_missing", error=exc))
        backend = torch_backend(torch)
        self._model = DepthAnything3.from_pretrained(source).to(device=torch_device(torch, backend))

    def predict(self, pil_rgb):
        import numpy as np
        prediction = self._model.inference([pil_rgb])
        depth = getattr(prediction, "depth", prediction)
        depth = np.asarray(depth)
        # Une prédiction par lot peut arriver en (1, H, W) : depth.py attend une carte HxW.
        return depth[0] if depth.ndim == 3 else depth


class BiRefNetEngine:
    """BiRefNet et ses fine-tunes Transformers : `.cutout(rgb) → RGBA` pour le flux removeBG."""

    def __init__(self, repo="ZhengPeng7/BiRefNet_dynamic", env_key="NETSURUSH_BIREFNET_DIR"):
        import os
        import torch
        from transformers import AutoModelForImageSegmentation
        self._torch = torch
        managed = os.environ.get(env_key, "")
        src = managed if managed and os.path.isdir(managed) else repo
        self._model = AutoModelForImageSegmentation.from_pretrained(
            src, trust_remote_code=True, local_files_only=os.path.isdir(src))
        backend = torch_backend(torch)
        self._dev = torch_device(torch, backend)
        try:
            self._model.to(self._dev).eval()
        except Exception:  # noqa: BLE001
            self._dev = "cpu"
            self._model.to(self._dev).eval()
        # Certains checkpoints BiRefNet déclarent `torch_dtype=float16`. C'est adapté au GPU,
        # mais invalide sur CPU et surtout doit être répercuté sur l'entrée : sinon Conv2d reçoit
        # un tensor float32 avec un bias float16 (« Input type ... bias type ... Half »).
        if self._dev == "cpu":
            self._model.float()
        self._input_dtype = next(
            (p.dtype for p in self._model.parameters() if p.is_floating_point()),
            torch.float32,
        )
        if self._dev == "cpu":
            self._input_dtype = torch.float32
        try:
            torch.set_float32_matmul_precision("high")
        except Exception:  # noqa: BLE001
            pass

    def cutout(self, rgb):
        import numpy as np
        import torch
        import torch.nn.functional as F
        h, w = rgb.shape[:2]
        # Prétraitement : 1024², normalisation ImageNet.
        t = torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1).to(self._input_dtype).div(255.0)
        t = F.interpolate(t.unsqueeze(0), size=(1024, 1024), mode="bilinear", align_corners=False)
        t = t.to(self._dev)
        mean = torch.tensor([0.485, 0.456, 0.406], device=self._dev, dtype=self._input_dtype).view(1, 3, 1, 1)
        std = torch.tensor([0.229, 0.224, 0.225], device=self._dev, dtype=self._input_dtype).view(1, 3, 1, 1)
        t = (t - mean) / std
        with torch.inference_mode():
            pred = self._model(t)[-1].sigmoid().cpu()
        mask = F.interpolate(pred, size=(h, w), mode="bilinear", align_corners=False)[0, 0]
        alpha = (mask.clamp(0, 1).mul(255).byte().numpy())
        return np.dstack([rgb, alpha])


class Ben2Engine:
    """BEN2 (détourage image haut de gamme, MIT — PramaLLC/BEN2). Import paresseux du package `ben2`
    (fourni par le dépôt) sinon des poids via le safetensors. Expose `.cutout(rgb) → RGBA`.

    BEN2 s'utilise via son API `BEN_Base.loadcheckpoints(...).inference(pil)` renvoyant une image RGBA
    (fond transparent). On reconstruit l'alpha en le collant sur le RGB d'origine."""

    def __init__(self, weights_dir=None):
        import os
        import torch
        try:
            from ben2 import BEN_Base  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(t("ben2_missing", error=exc))
        wdir = weights_dir or os.environ.get("NETSURUSH_BEN2_DIR", "")
        backend = torch_backend(torch)
        self._dev = torch_device(torch, backend)
        # Charge depuis le dossier de poids géré si présent, sinon laisse la lib tirer le repo HF.
        self._model = BEN_Base.from_pretrained(wdir) if wdir and os.path.isdir(wdir) else BEN_Base.from_pretrained("PramaLLC/BEN2")
        try:
            self._model.to(self._dev).eval()
        except Exception:  # noqa: BLE001
            self._dev = "cpu"
            self._model.to(self._dev).eval()

    def cutout(self, rgb):
        import numpy as np
        from PIL import Image
        out = self._model.inference(Image.fromarray(rgb), refine_foreground=True)
        rgba = np.asarray(out.convert("RGBA"))
        # Reconstruit sur le RGB source (l'alpha de BEN2 est la matte).
        return np.dstack([rgb, rgba[:, :, 3]])


class RvmEngine:
    """Robust Video Matting (MIT, temps réel, ONNX/torch). SCAFFOLD non testé : matte vidéo permissif
    alternatif à rembg. Expose `.cutout(rgb) → RGBA` pour rester compatible avec seg.py.

    NOTE : RVM est RÉCURRENT (état caché propagé frame→frame) → pour un vrai gain il faudrait porter
    l'état entre appels (amélioration future) ; ici chaque frame est traitée indépendamment (best-effort)."""

    def __init__(self):
        import torch
        self._torch = torch
        # hub.load télécharge le modèle au 1er appel (à confirmer runtime) ; sinon erreur propre.
        self._model = torch.hub.load("PeterL1n/RobustVideoMatting", "mobilenetv3")
        backend = torch_backend(torch)
        self._dev = torch_device(torch, backend)
        try:
            self._model.to(self._dev).eval()
        except Exception:  # noqa: BLE001
            self._dev = "cpu"
            self._model.to(self._dev).eval()
        self._rec = [None] * 4  # état récurrent RVM

    def cutout(self, rgb):
        import numpy as np
        torch = self._torch
        t = torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1).float().div(255.0).unsqueeze(0).to(self._dev)
        with torch.no_grad():
            fgr, pha, *self._rec = self._model(t, *self._rec, downsample_ratio=0.25)
        fgr = (fgr[0].permute(1, 2, 0).clamp(0, 1).mul(255).byte().cpu().numpy())
        pha = (pha[0, 0].clamp(0, 1).mul(255).byte().cpu().numpy())
        return np.dstack([fgr, pha])


# Mapping modèle UI → identifiant Hugging Face (depth). Tous natifs transformers
# (model_type=depth_anything → pipeline depth-estimation sans trust_remote_code).
HF_ID = {
    "depth-anything-v2-small": "depth-anything/Depth-Anything-V2-Small-hf",
    "depth-anything-v2-base": "depth-anything/Depth-Anything-V2-Base-hf",
    "depth-anything-v2-large": "depth-anything/Depth-Anything-V2-Large-hf",
    # Distill Any Depth (Westlake, MIT) : multi-teacher, distillé DA-V2 → qualité SOTA, usage commercial.
    "distill-any-depth-small": "xingyang1/Distill-Any-Depth-Small-hf",
    "distill-any-depth-base": "lc700x/Distill-Any-Depth-Base-hf",
    "distill-any-depth-large": "xingyang1/Distill-Any-Depth-Large-hf",
    # Depth Anything V1 (Apache) : génération précédente, conservée pour comparaison / compat.
    "depth-anything-v1-small": "LiheYoung/depth-anything-small-hf",
    "depth-anything-v1-base": "LiheYoung/depth-anything-base-hf",
    "depth-anything-v1-large": "LiheYoung/depth-anything-large-hf",
    # DPT (Intel) : archis alternatives — SwinV2 (léger→lourd), BEiT (qualité), Hybrid MiDaS.
    "dpt-swinv2-tiny": "Intel/dpt-swinv2-tiny-256",
    "dpt-swinv2-large": "Intel/dpt-swinv2-large-384",
    "dpt-hybrid-midas": "Intel/dpt-hybrid-midas",
    "dpt-beit-base": "Intel/dpt-beit-base-384",
    "dpt-beit-large": "Intel/dpt-beit-large-512",
    "dpt-large": "Intel/dpt-large",
    # GLPN (SegFormer, Apache) : très léger, profondeur intérieure/extérieure.
    "glpn-nyu": "vinvino02/glpn-nyu",
    "glpn-kitti": "vinvino02/glpn-kitti",
    # ZoeDepth (Intel, MIT) : profondeur MÉTRIQUE (distances absolues), généraliste NYU+KITTI.
    "zoedepth-nyu-kitti": "Intel/zoedepth-nyu-kitti",
}
# Depth Anything 3 : id UI → dépôt HF (small/base = non-1.1, seules variantes publiées).
DA3_ID = {
    "da3-small": "depth-anything/DA3-SMALL",
    "da3-base": "depth-anything/DA3-BASE",
    "da3-large": "depth-anything/DA3-LARGE-1.1",
    "da3-giant": "depth-anything/DA3NESTED-GIANT-LARGE-1.1",
    "da3-metric-large": "depth-anything/DA3METRIC-LARGE",  # profondeur métrique (Apache)
    "da3-mono-large": "depth-anything/DA3MONO-LARGE",       # monoculaire dédié (Apache)
}


def get_rife(model):
    """Moteur d'interpolation RIFE pour `model`.

    Deux runtimes selon la version : ncnn-vulkan pour les variantes officielles livrées avec le
    binaire (rife-v4.6 / rife-anime / …), PyTorch pour les checkpoints 4.15+ (cf. rife_torch), qui
    n'existent pas en ncnn. Même interface `.process` des deux côtés."""
    from .drba import DrbaEngine, is_drba
    from .gmfss import GmfssEngine, is_gmfss
    from .rife_torch import RifeTorchEngine, is_torch_model
    if is_gmfss(model):
        return _get("interpolate", model, lambda: GmfssEngine(model))
    if is_drba(model):
        return _get("interpolate", model, lambda: DrbaEngine(model))
    if is_torch_model(model):
        return _get("interpolate", model, lambda: RifeTorchEngine(model))
    return _get("interpolate", model, lambda: RifeEngine(model))


def get_depth(model):
    """Moteur de profondeur pour `model`. `video-depth-anything*` → moteur vidéo temporel (scaffold),
    `da3-*` → Depth Anything 3, sinon transformers depth-estimation (DA-V2 small/base/large,
    Distill Any Depth small/large, dpt-large — tous natifs pipeline, cf. HF_ID)."""
    m = str(model)
    if m.startswith("video-depth-anything"):
        variant = "large" if "large" in m else "base" if "base" in m else "small"
        metric = "metric" in m
        return _get("depth", m, lambda: VideoDepthEngine(variant, metric=metric))
    if m in DA3_ID:
        da3_src = local_model_dir(m) or DA3_ID[m]
        return _get("depth", m, lambda: Da3Engine(da3_src))
    hf_id = local_model_dir(m) or HF_ID.get(m, HF_ID["depth-anything-v2-small"])
    return _get("depth", m, lambda: DepthEngine(hf_id))


# Moteur de matte/détourage par id. Les modèles rembg (U²-Net, IS-Net) ont été retirés du catalogue :
# leurs masques ne tiennent pas la comparaison avec BiRefNet sur les mêmes images.
SEG_ENGINES = {
    "birefnet": lambda: BiRefNetEngine(),
    "lucida": lambda: BiRefNetEngine("egeorcun/lucida", "NETSURUSH_LUCIDA_DIR"),
    "ben2": lambda: Ben2Engine(),
    "rvm": lambda: RvmEngine(),
}


def get_seg(model):
    """Moteur de matte/détourage : Lucida/BiRefNet via Transformers, sinon backend spécialisé."""
    m = str(model)
    build = SEG_ENGINES.get(m)
    if build is None:
        raise RuntimeError(t("unknown_seg_model", model=m))
    return _get("removebg", m, build)
