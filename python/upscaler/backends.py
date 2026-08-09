"""Upsamplers : RealESRGANer (archs RRDB/SRVGG) et SpandrelUpsampler (loader générique
CUGAN/ESRGAN/SwinIR), même interface .enhance(bgr, outscale). Cache du modèle en VRAM
pour le worker persistant (recharge seulement si un paramètre clé change)."""
import sys
import types
from nri18n import t
from nrdevice import (
    empty_torch_cache, onnx_providers, onnx_session_options, torch_backend, torch_device,
)

from .log import log
from .models import MODELS, build_model, ensure_weight


def _device_line(name, backend, half):
    """Ligne console explicite : le backend effectif est visible dans les rapports bêta."""
    where = "GPU %s" % backend.upper() if backend != "cpu" else "CPU — LENT (repli compatible)"
    log("[upscale] %s → %s (%s)" % (name, where, "fp16" if half else "fp32"))


def _patch_basicsr():
    """torchvision >=0.17 a retiré transforms.functional_tensor → basicsr casse à l'import.
    On ré-expose rgb_to_grayscale sous l'ancien chemin avant tout import basicsr/realesrgan."""
    try:
        import torchvision.transforms.functional as F
        mod = types.ModuleType("torchvision.transforms.functional_tensor")
        mod.rgb_to_grayscale = F.rgb_to_grayscale
        sys.modules.setdefault("torchvision.transforms.functional_tensor", mod)
    except Exception:  # noqa: BLE001
        pass


# Cache du upsampler (worker persistant) : recharge le modèle seulement si un paramètre clé change.
_UP_CACHE = {"key": None, "up": None}


def get_upsampler(model_name, tile, fp32, denoise, tile_pad=10, pre_pad=0):
    # Les poids ne changent qu'avec (model, fp32, denoise). tile/tile_pad/pre_pad = ajustables
    # sur l'instance sans reconstruire le réseau. denoise (DNI) = bucket 0.05.
    dn_bucket = None if denoise is None else round(float(denoise), 2)
    key = (model_name, bool(fp32), dn_bucket)
    if _UP_CACHE["key"] != key or _UP_CACHE["up"] is None:
        _UP_CACHE["up"] = make_upsampler(model_name, tile, fp32, denoise, tile_pad, pre_pad)
        _UP_CACHE["key"] = key
    up = _UP_CACHE["up"]
    try:
        up.tile = int(tile or 0)        # ajuste le tiling sans reconstruire
        up.tile_pad = int(tile_pad or 0)
        up.pre_pad = int(pre_pad or 0)
        up.mod_scale = None             # recalculé à la prochaine inférence selon pre_pad
    except Exception:  # noqa: BLE001
        pass
    return up


class TorchUpsampler:
    """Socle commun des upsamplers PyTorch chargés hors RealESRGANer : place le module sur le bon
    device, gère le fp16 et son repli, découpe en tuiles et expose .enhance(bgr, outscale) comme
    RealESRGANer. Entrée/sortie = numpy BGR uint8 (HxWx3), comme la boucle ffmpeg bgr24.

    Une sous-classe construit le module puis appelle _setup() : elle n'a JAMAIS à réécrire
    l'inférence, seulement à savoir d'où viennent ses poids."""

    def _setup(self, torch, module, scale, fp32, tile, tile_pad, pre_pad, label):
        self._torch = torch
        self.backend = torch_backend(torch)
        self.dev = torch.device(torch_device(torch, self.backend))
        # CUGAN/ESRGAN/Compact tournent en fp16 sur GPU (≈2× plus rapide, ~2× moins de VRAM). On force
        # le half quand CUDA sans se fier à `supports_half` (souvent faux à tort pour CUGAN → fp32 lent).
        # Repli fp32 automatique si l'inférence fp16 diverge (cf. enhance).
        self.half = self.backend != "cpu" and not fp32
        try:
            module = module.to(self.dev)
        except Exception as exc:  # noqa: BLE001 - backend/model non compatible → CPU universel
            log("[upscale] %s indisponible pour %s (%s) → CPU" % (self.backend, label, exc))
            self.backend, self.dev, self.half = "cpu", torch.device("cpu"), False
            module = module.to(self.dev)
        # `eval()` AVANT `half()` : les architectures reparamétrables (RepConv de RTMoSR) fusionnent
        # leurs branches au passage en évaluation. Fusionner en demi-précision mélange un tenseur
        # construit en float32 avec des poids en float16 et lève ; fusionner d'abord, convertir
        # ensuite, donne le même réseau sans le conflit — et avec une fusion plus précise.
        module.eval()
        if self.half:
            module.half()
        self.desc = module
        _device_line(label, self.backend, self.half)
        self.scale = int(scale or 1)
        # Attributs ajustables par get_upsampler (parité avec RealESRGANer).
        self.tile = int(tile or 0)
        self.tile_pad = int(tile_pad or 0)
        self.pre_pad = int(pre_pad or 0)
        self.mod_scale = None

    def _infer(self, rgb):
        """rgb numpy HxWx3 uint8 → HxWx3 uint8 (scale natif du modèle)."""
        import numpy as np
        import torch.nn.functional as F
        torch = self._torch
        h, w = rgb.shape[:2]
        t = torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1).unsqueeze(0).float().div_(255.0)
        t = t.to(self.dev)
        if self.half:
            t = t.half()
        # CUGAN & co exigent des dimensions multiples d'un facteur → pad réplication puis crop.
        mod = 8
        ph = (mod - h % mod) % mod
        pw = (mod - w % mod) % mod
        if ph or pw:
            t = F.pad(t, (0, pw, 0, ph), mode="replicate")
        with torch.inference_mode():
            out = self.desc(t)
        s = self.scale
        out = out[..., : h * s, : w * s]
        # Une sortie créée sous `torch.inference_mode()` est un inference tensor : toute opération
        # inplace après la sortie du contexte lève sur PyTorch 2.6. Garder cette normalisation
        # strictement out-of-place (les anciens clamp_/mul_/round_ cassaient les restaurateurs 1×).
        out = out.squeeze(0).float().clamp(0.0, 1.0).mul(255.0).round()
        return out.permute(1, 2, 0).byte().cpu().numpy()

    def _infer_tiled(self, rgb):
        """Découpe en tuiles `tile`×`tile` avec recouvrement `tile_pad` (cache les coutures)."""
        import numpy as np
        h, w = rgb.shape[:2]
        t, pad, s = self.tile, self.tile_pad, self.scale
        out = np.empty((h * s, w * s, 3), np.uint8)
        for y in range(0, h, t):
            for x in range(0, w, t):
                x0, y0 = max(0, x - pad), max(0, y - pad)
                x1, y1 = min(w, x + t + pad), min(h, y + t + pad)
                tile_out = self._infer(rgb[y0:y1, x0:x1])
                ex, ey = min(t, w - x), min(t, h - y)
                vx0, vy0 = (x - x0) * s, (y - y0) * s
                out[y * s:(y + ey) * s, x * s:(x + ex) * s] = tile_out[vy0:vy0 + ey * s, vx0:vx0 + ex * s]
        return out

    def enhance(self, bgr, outscale=None):
        import numpy as np
        import cv2
        rgb = np.ascontiguousarray(bgr[:, :, ::-1])
        h, w = rgb.shape[:2]
        use_tile = self.tile and (h > self.tile or w > self.tile)
        try:
            out_rgb = self._infer_tiled(rgb) if use_tile else self._infer(rgb)
        except RuntimeError as exc:  # OOM probable → repli en tuiles forcées
            if "out of memory" not in str(exc).lower():
                raise
            empty_torch_cache(self._torch, self.backend)
            self.tile = self.tile or 256
            out_rgb = self._infer_tiled(rgb)
        if self.half and float(out_rgb.std()) < 1e-3:
            # Sortie dégénérée (uniforme) → le fp16 a divergé pour ce modèle. Bascule fp32 DÉFINITIVE
            # (instance cachée) et refait une fois. Évite des frames noires/grises sur archs fragiles.
            log("[upscale] fp16 instable → repli fp32 pour ce modèle")
            self.half = False
            self.desc.float()
            out_rgb = self._infer_tiled(rgb) if use_tile else self._infer(rgb)
        # outscale = multiplicateur final vs source ; si != scale natif, on (sur/sous)-échantillonne.
        if outscale and int(outscale) != self.scale:
            tw, th = w * int(outscale), h * int(outscale)
            interp = cv2.INTER_AREA if tw < out_rgb.shape[1] else cv2.INTER_LANCZOS4
            out_rgb = cv2.resize(out_rgb, (tw, th), interpolation=interp)
        return np.ascontiguousarray(out_rgb[:, :, ::-1]), None


class TorchScriptUpsampler(TorchUpsampler):
    """Checkpoint TorchScript : le graphe est SÉRIALISÉ AVEC les poids, donc rien à embarquer ni à
    reconnaître — c'est la voie propre pour une architecture que Spandrel ignore (RTMoSR). Seul le
    facteur d'échelle manque au fichier : il vient du registre."""

    def __init__(self, model_path, scale, fp32, tile=0, tile_pad=10, pre_pad=0):
        import torch
        module = torch.jit.load(model_path, map_location="cpu")
        self._setup(torch, module, scale, fp32, tile, tile_pad, pre_pad, "modèle TorchScript")


class SpandrelUpsampler(TorchUpsampler):
    """Modèle chargé par Spandrel (CUGAN, ESRGAN, SwinIR…) : l'architecture est déduite du
    checkpoint, il n'y a donc aucun code d'arch à embarquer."""

    def __init__(self, model_path, fp32, tile=0, tile_pad=10, pre_pad=0):
        import torch
        from spandrel import ImageModelDescriptor, ModelLoader
        try:
            # Certaines archs (licences restrictives) vivent dans le paquet extra ; CUGAN est dans
            # le registre principal mais on enrichit si dispo, sans échouer si absent.
            from spandrel import MAIN_REGISTRY
            from spandrel_extra_arches import EXTRA_REGISTRY
            MAIN_REGISTRY.add(*EXTRA_REGISTRY)
        except Exception:  # noqa: BLE001
            pass

        desc = ModelLoader().load_from_file(model_path)
        if not isinstance(desc, ImageModelDescriptor):
            raise RuntimeError(t("spandrel_not_i2i", path=model_path))
        self._setup(torch, desc, getattr(desc, "scale", 1), fp32, tile, tile_pad, pre_pad, "modèle Spandrel")


class ArtCNNUpsampler:
    """ArtCNN R16F96/R8F64 officiel via ONNX Runtime.

    Ces réseaux reconstruisent uniquement la luminance en 2×. La chrominance est agrandie en
    bilinéaire, conformément au contrat ArtCNN, puis recombinée. L'interface reste identique aux
    autres upsamplers pour réutiliser tout le pipeline vidéo/image existant.
    """

    def __init__(self, model_path, tile=0, tile_pad=10):
        import onnxruntime as ort

        providers = onnx_providers(ort)
        self.session = ort.InferenceSession(
            model_path, providers=providers, sess_options=onnx_session_options(ort))
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        self.scale = 2
        self.tile = int(tile or 0)
        self.tile_pad = int(tile_pad or 0)
        self.pre_pad = 0
        self.mod_scale = None
        log("[upscale] ArtCNN ONNX → %s" % ", ".join(self.session.get_providers()))

    def _infer(self, y):
        import numpy as np

        inp = np.ascontiguousarray(y, dtype=np.float32)[None, None, :, :] / 255.0
        out = self.session.run([self.output_name], {self.input_name: inp})[0]
        out = np.asarray(out).squeeze()
        return np.clip(np.rint(out * 255.0), 0, 255).astype(np.uint8)

    def _infer_tiled(self, y):
        import numpy as np

        h, w = y.shape
        t, pad, s = self.tile, max(self.tile_pad, 16), self.scale
        out = np.empty((h * s, w * s), np.uint8)
        for top in range(0, h, t):
            for left in range(0, w, t):
                x0, y0 = max(0, left - pad), max(0, top - pad)
                x1, y1 = min(w, left + t + pad), min(h, top + t + pad)
                tile_out = self._infer(y[y0:y1, x0:x1])
                copy_w, copy_h = min(t, w - left), min(t, h - top)
                src_x, src_y = (left - x0) * s, (top - y0) * s
                out[top * s:(top + copy_h) * s, left * s:(left + copy_w) * s] = \
                    tile_out[src_y:src_y + copy_h * s, src_x:src_x + copy_w * s]
        return out

    def enhance(self, bgr, outscale=None):
        import cv2
        import numpy as np

        h, w = bgr.shape[:2]
        ycc = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb)
        y, cr, cb = cv2.split(ycc)
        use_tile = self.tile and (h > self.tile or w > self.tile)
        y2 = self._infer_tiled(y) if use_tile else self._infer(y)
        target = (y2.shape[1], y2.shape[0])
        cr2 = cv2.resize(cr, target, interpolation=cv2.INTER_LINEAR)
        cb2 = cv2.resize(cb, target, interpolation=cv2.INTER_LINEAR)
        out = cv2.cvtColor(cv2.merge((y2, cr2, cb2)), cv2.COLOR_YCrCb2BGR)

        requested = int(outscale or self.scale)
        if requested != self.scale:
            size = (w * requested, h * requested)
            interpolation = cv2.INTER_AREA if requested < self.scale else cv2.INTER_LANCZOS4
            out = cv2.resize(out, size, interpolation=interpolation)
        return np.ascontiguousarray(out), None


class AnimeSrUpsampler(TorchUpsampler):
    """AnimeSR (TencentARC, Apache-2.0) — sur-résolution VIDÉO récurrente, pas image par image.

    Le réseau (MSRSWVSR) propage un état caché et l'image reconstruite précédente d'une image à la
    suivante : c'est là que se joue sa stabilité temporelle. On garde donc cet état SUR L'INSTANCE,
    que le worker persistant réutilise pour toute la séquence, et on le réinitialise dès que la
    taille change (nouveau plan) — sinon l'état d'une autre vidéo fuiterait dans celle-ci.

    Limite assumée : le pipeline lit les images une par une, sans lecture en avance. La fenêtre
    glissante du modèle attend (précédente, courante, suivante) ; faute de suivante on répète la
    courante — exactement ce que fait le réseau lui-même pour la dernière image d'une séquence. La
    mémoire récurrente, elle, reste intacte."""

    SCALE = 4
    FEATURES = 64
    BLOCKS = (5, 3, 2)
    # Le réseau est MULTI-ÉCHELLE : il sous-échantillonne par 2 et par 4 puis recombine. Une
    # dimension non multiple de 4 fait diverger les tailles à la recombinaison.
    MODULO = 4

    def __init__(self, model_path, code_path, fp32, tile=0, tile_pad=10, pre_pad=0):
        import torch

        from .ntire import _load_arch, _state_dict
        arch_module = _load_arch(code_path, "animesr")
        net = arch_module.MSRSWVSR(num_feat=self.FEATURES, num_block=self.BLOCKS, netscale=self.SCALE)
        net.load_state_dict(_state_dict(torch.load(model_path, map_location="cpu")), strict=True)
        self._reset()
        self._setup(torch, net, self.SCALE, fp32, tile, tile_pad, pre_pad, "modèle AnimeSR")

    def _reset(self):
        self._prev = None       # image source précédente (tenseur LR)
        self._out = None        # image reconstruite précédente (entrée récurrente du réseau)
        self._state = None      # état caché
        self._shape = None

    def _to_tensor(self, rgb, padded_h, padded_w):
        import numpy as np
        import torch.nn.functional as F
        torch = self._torch
        tensor = torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1).unsqueeze(0)
        tensor = tensor.to(self.dev).float().div(255.0)
        pad = (0, padded_w - rgb.shape[1], 0, padded_h - rgb.shape[0])
        if any(pad):
            tensor = F.pad(tensor, pad, mode="replicate")
        return tensor.half() if self.half else tensor

    def enhance(self, bgr, outscale=None):
        import cv2
        import math
        import numpy as np
        torch = self._torch
        rgb = np.ascontiguousarray(bgr[:, :, ::-1])
        h, w = rgb.shape[:2]
        if self._shape != (h, w):
            self._reset()
            self._shape = (h, w)
        padded_h = math.ceil(h / self.MODULO) * self.MODULO
        padded_w = math.ceil(w / self.MODULO) * self.MODULO
        current = self._to_tensor(rgb, padded_h, padded_w)
        if self._prev is None:
            # Première image d'un plan : le réseau réutilise l'image courante comme précédente.
            self._prev = current
            dtype = current.dtype
            self._out = torch.zeros(1, 3, padded_h * self.SCALE, padded_w * self.SCALE,
                                    device=self.dev, dtype=dtype)
            self._state = torch.zeros(1, self.FEATURES, padded_h, padded_w,
                                      device=self.dev, dtype=dtype)
        with torch.inference_mode():
            window = torch.cat((self._prev, current, current), dim=1)
            out, state = self.desc.cell(window, self._out, self._state)
        # `inference_mode` rend des tenseurs figés : on les clone pour pouvoir les rechaîner.
        self._out, self._state, self._prev = out.clone(), state.clone(), current
        frame = out[0, :, : h * self.SCALE, : w * self.SCALE]
        frame = frame.float().clamp(0.0, 1.0).mul(255.0).round().byte()
        out_rgb = frame.permute(1, 2, 0).cpu().numpy()
        requested = int(outscale or self.SCALE)
        if requested != self.SCALE:
            size = (w * requested, h * requested)
            interpolation = cv2.INTER_AREA if requested < self.SCALE else cv2.INTER_LANCZOS4
            out_rgb = cv2.resize(out_rgb, size, interpolation=interpolation)
        return np.ascontiguousarray(out_rgb[:, :, ::-1]), None


class FixedOnnxUpsampler:
    """Graphe ONNX exporté à dimensions FIGÉES (ShuffleSPAN : 1×3×1080×1920).

    Un tel graphe refuse toute autre taille — ni plus petite, ni plus grande. On découpe donc l'image
    en fenêtres de la taille exigée, avec recouvrement pour masquer les coutures ; les fenêtres de
    bord sont complétées par réflexion puis recadrées. Une image plus petite que la fenêtre passe en
    une seule fois, entièrement complétée."""

    OVERLAP = 32  # marge rognée de chaque côté d'une fenêtre intérieure (en pixels source)

    def __init__(self, model_path, scale, tile_pad=None):
        import onnxruntime as ort
        import numpy as np

        self.session = ort.InferenceSession(
            model_path, providers=onnx_providers(ort), sess_options=onnx_session_options(ort))
        spec_in = self.session.get_inputs()[0]
        self.input_name = spec_in.name
        self.output_name = self.session.get_outputs()[0].name
        _, _, self.win_h, self.win_w = [int(d) for d in spec_in.shape]
        self.dtype = np.float16 if "float16" in spec_in.type else np.float32
        self.scale = int(scale)
        self.overlap = int(tile_pad) if tile_pad else self.OVERLAP
        # Attributs de parité avec RealESRGANer ; le tuilage est imposé par le graphe, pas réglable.
        self.tile = 0
        self.tile_pad = self.overlap
        self.pre_pad = 0
        self.mod_scale = None
        log("[upscale] ONNX à fenêtre figée %dx%d → %s"
            % (self.win_w, self.win_h, ", ".join(self.session.get_providers())))

    def _run_window(self, rgb_window):
        """Fenêtre RGB uint8 (≤ win_h × win_w) → sortie uint8 à l'échelle, recadrée à la fenêtre."""
        import numpy as np
        h, w = rgb_window.shape[:2]
        padded = np.pad(rgb_window, ((0, self.win_h - h), (0, self.win_w - w), (0, 0)), mode="reflect") \
            if (h < self.win_h or w < self.win_w) else rgb_window
        tensor = padded.transpose(2, 0, 1)[None].astype(self.dtype) / self.dtype(255.0)
        out = np.asarray(self.session.run([self.output_name], {self.input_name: tensor})[0])[0]
        out = np.clip(np.rint(out.transpose(1, 2, 0).astype(np.float32) * 255.0), 0, 255).astype(np.uint8)
        return out[: h * self.scale, : w * self.scale]

    def enhance(self, bgr, outscale=None):
        import cv2
        import numpy as np
        rgb = np.ascontiguousarray(bgr[:, :, ::-1])
        h, w = rgb.shape[:2]
        s, pad = self.scale, self.overlap
        out = np.empty((h * s, w * s, 3), np.uint8)
        # Pas utile = fenêtre moins le recouvrement des deux côtés.
        step_y, step_x = max(1, self.win_h - 2 * pad), max(1, self.win_w - 2 * pad)
        for top in range(0, h, step_y):
            for left in range(0, w, step_x):
                y0, x0 = max(0, top - pad), max(0, left - pad)
                y1, x1 = min(h, y0 + self.win_h), min(w, x0 + self.win_w)
                # Recolle la fenêtre au bord quand on déborde, pour rester à la taille exigée.
                y0, x0 = max(0, y1 - self.win_h), max(0, x1 - self.win_w)
                window = self._run_window(rgb[y0:y1, x0:x1])
                copy_h, copy_w = min(step_y, h - top), min(step_x, w - left)
                src_y, src_x = (top - y0) * s, (left - x0) * s
                out[top * s:(top + copy_h) * s, left * s:(left + copy_w) * s] = \
                    window[src_y:src_y + copy_h * s, src_x:src_x + copy_w * s]
        requested = int(outscale or s)
        if requested != s:
            size = (w * requested, h * requested)
            interpolation = cv2.INTER_AREA if requested < s else cv2.INTER_LANCZOS4
            out = cv2.resize(out, size, interpolation=interpolation)
        return np.ascontiguousarray(out[:, :, ::-1]), None


def _tune_torch(torch, backend):
    """Optimisations GPU globales (appliquées une fois au chargement) :
    - cudnn.benchmark : cuDNN cherche les algos de conv les plus rapides pour une taille d'entrée fixe.
      Sur une vidéo (frames de taille constante, tuile Auto) → gain net après la 1re frame.
    - TF32 : matmul/conv sur tensor cores (Ampere+), quasi sans perte visuelle, plus rapide."""
    if backend == "cuda":
        torch.backends.cudnn.benchmark = True
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True


def make_upsampler(model_name, tile, fp32, denoise, tile_pad=10, pre_pad=0):
    _patch_basicsr()
    import os

    import torch
    backend = torch_backend(torch)
    _tune_torch(torch, backend)

    spec = MODELS.get(model_name) or MODELS["light"]

    model_path = ensure_weight(spec, "url")

    if spec.get("backend") == "artcnn_onnx":
        return ArtCNNUpsampler(model_path, tile, tile_pad)

    if spec.get("backend") == "ntire":
        from .ntire import NtireUpsampler
        code_path = ensure_weight(spec, "code_url")
        return NtireUpsampler(model_name, model_path, code_path, fp32, tile, tile_pad, pre_pad)

    if spec.get("backend") == "animesr":
        code_path = ensure_weight(spec, "code_url")
        return AnimeSrUpsampler(model_path, code_path, fp32, tile, tile_pad, pre_pad)

    if spec.get("backend") == "onnx_fixed":
        return FixedOnnxUpsampler(model_path, spec["netscale"], tile_pad)

    if spec.get("backend") == "community":
        from .community import CommunityUpsampler
        code_path = ensure_weight(spec, "code_url")
        return CommunityUpsampler(model_name, model_path, code_path, fp32, tile, tile_pad, pre_pad)

    if spec.get("backend") == "torchscript":
        return TorchScriptUpsampler(model_path, spec["netscale"], fp32, tile, tile_pad, pre_pad)

    if spec.get("backend") == "spandrel":
        return SpandrelUpsampler(model_path, fp32, tile, tile_pad, pre_pad)

    from realesrgan import RealESRGANer

    # DNI : modèle léger (general-x4v3) → mélange avec sa variante débruitée (wdn) selon denoise.
    paths = model_path
    dni_weight = None
    if spec["dn"] and denoise is not None and denoise < 1.0:
        try:
            wdn = ensure_weight(spec, "wdn_url")
        except Exception:
            wdn = ""
        if os.path.exists(wdn):
            paths = [model_path, wdn]
            dni_weight = [denoise, 1.0 - denoise]

    half = backend != "cpu" and not fp32   # fp16 accélérateur = moins de mémoire, même rendu visuel
    _device_line("modèle %s" % model_name, backend, half)

    def _make(active, use_half):
        return RealESRGANer(
            scale=spec["netscale"], model_path=paths, dni_weight=dni_weight,
            model=build_model(spec), tile=int(tile or 0), tile_pad=int(tile_pad or 0), pre_pad=int(pre_pad or 0),
            half=use_half, device=torch.device(torch_device(torch, active)),
        )
    try:
        return _make(backend, half)
    except Exception as exc:  # noqa: BLE001 - roue/ops constructeur incomplètes → CPU fiable
        if backend == "cpu":
            raise
        log("[upscale] %s indisponible pour %s (%s) → CPU" % (backend, model_name, exc))
        empty_torch_cache(torch, backend)
        return _make("cpu", False)
