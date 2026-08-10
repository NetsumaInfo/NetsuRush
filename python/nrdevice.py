"""Sélection centrale des backends IA NetsuRush.

PyTorch ROCm conserve l'API ``torch.cuda`` : le backend réel est distingué par ``torch.version.hip``.
Intel utilise ``torch.xpu``. DirectML est réservé ici aux graphes ONNX ; le plugin PyTorch DirectML
impose une version de torch trop ancienne pour le venv principal. Toute sélection finit sur CPU.
"""
from __future__ import annotations

import contextlib
import os
from typing import Any, Iterable


TORCH_BACKENDS = ("cuda", "rocm", "xpu", "cpu")
ONNX_BACKENDS = ("cuda", "directml", "openvino", "cpu")


def configured_torch_backend() -> str:
    value = os.environ.get("NETSURUSH_ML_BACKEND", "").strip().lower()
    return value if value in TORCH_BACKENDS else ""


def _cuda_available(torch: Any) -> bool:
    try:
        return bool(torch.cuda.is_available())
    except Exception:  # pragma: no cover - API tierce défensive
        return False


def _xpu_available(torch: Any) -> bool:
    try:
        return bool(hasattr(torch, "xpu") and torch.xpu.is_available())
    except Exception:  # pragma: no cover - API tierce défensive
        return False


def _is_rocm(torch: Any) -> bool:
    try:
        return bool(getattr(getattr(torch, "version", None), "hip", None))
    except Exception:  # pragma: no cover
        return False


def torch_backend(torch: Any, forced: str | None = None) -> str:
    """Retourne le backend réellement utilisable, jamais seulement celui demandé."""
    requested = (forced or configured_torch_backend()).strip().lower()
    cuda = _cuda_available(torch)
    rocm = cuda and _is_rocm(torch)
    xpu = _xpu_available(torch)

    if requested == "cpu":
        return "cpu"
    if requested == "rocm" and rocm:
        return "rocm"
    if requested == "cuda" and cuda and not rocm:
        return "cuda"
    if requested == "xpu" and xpu:
        return "xpu"
    if requested:
        return "cpu"
    if cuda:
        return "rocm" if rocm else "cuda"
    if xpu:
        return "xpu"
    return "cpu"


def torch_device(torch: Any, forced: str | None = None) -> str:
    backend = torch_backend(torch, forced)
    if backend in ("cuda", "rocm"):
        return "cuda"
    if backend == "xpu":
        return "xpu"
    return "cpu"


def empty_torch_cache(torch: Any, backend: str | None = None) -> None:
    active = backend or torch_backend(torch)
    try:
        if active in ("cuda", "rocm"):
            torch.cuda.empty_cache()
            if hasattr(torch.cuda, "ipc_collect"):
                torch.cuda.ipc_collect()
        elif active == "xpu":
            torch.xpu.empty_cache()
    except Exception:  # pragma: no cover - best effort mémoire
        pass


def torch_autocast(torch: Any, backend: str, dtype: Any):
    if backend in ("cuda", "rocm"):
        return torch.autocast("cuda", dtype=dtype)
    if backend == "xpu":
        return torch.autocast("xpu", dtype=dtype)
    return contextlib.nullcontext()


def configured_onnx_backend() -> str:
    value = os.environ.get("NETSURUSH_ONNX_BACKEND", "").strip().lower()
    return value if value in ONNX_BACKENDS else ""


def onnx_gpu_enabled() -> bool:
    """Bascule utilisateur « accélérer ONNX par le GPU » (visages, dictée, upscale ONNX).

    Distincte de `NETSURUSH_ONNX_BACKEND`, qui dit QUEL accélérateur la machine sait faire tourner :
    celle-ci dit si on l'utilise. Un pilote instable se contourne alors sans réinstaller le runtime
    en CPU — et sans perdre le réglage de backend, qu'il faudrait retrouver pour revenir en arrière."""
    value = os.environ.get("NETSURUSH_ONNX_GPU")
    if value is None:
        return True
    return value.strip().lower() not in ("0", "false", "no", "off")


_ONNX_DLLS_READY = False


def prepare_onnx_dlls() -> None:
    """Rend les DLL CUDA visibles AVANT qu'ONNX Runtime ne charge son provider (Windows).

    Sans cela `onnxruntime_providers_cuda.dll` échoue à se charger et ORT retombe sur le
    processeur **en silence** : `get_available_providers()` continue d'annoncer
    `CUDAExecutionProvider`, mais chaque session rend `CPUExecutionProvider`. Mesuré sur une
    installation saine : 17,8 ms/visage au lieu de 2,3 ms (SFace), soit 7,9× perdus sans un
    seul message d'erreur.

    Deux gestes, tous deux nécessaires :
      1. importer `torch` D'ABORD — c'est lui qui livre `cudart64_12.dll`, que les wheels
         `nvidia-*` ne fournissent pas et dont le provider dépend ;
      2. déclarer `torch/lib` et `site-packages/nvidia/*/bin` comme répertoires de DLL, le PATH
         du process n'étant pas consulté par le chargeur pour ces dépendances.

    Sans effet hors Windows (`add_dll_directory` n'y existe pas) et idempotent.
    """
    global _ONNX_DLLS_READY
    if _ONNX_DLLS_READY or not hasattr(os, "add_dll_directory"):
        return
    _ONNX_DLLS_READY = True
    import glob
    dirs = []
    try:
        import torch  # noqa: F401  (l'import lui-même charge le runtime CUDA dans le process)
        dirs.append(os.path.join(os.path.dirname(torch.__file__), "lib"))
        site_packages = os.path.dirname(os.path.dirname(torch.__file__))
        dirs.extend(glob.glob(os.path.join(site_packages, "nvidia", "*", "bin")))
    except Exception:  # noqa: BLE001 - torch absent (venv allégé) : ONNX tournera sur CPU
        return
    for directory in dirs:
        try:
            os.add_dll_directory(directory)
        except OSError:  # répertoire absent selon la variante installée
            pass


def onnx_providers(ort: Any, forced: str | None = None) -> list[str]:
    """Ordre de providers supportés par le runtime installé, CPU toujours en dernier recours.

    Un provider EXPLICITE (`forced`) l'emporte sur la bascule utilisateur : c'est ce que fait la
    sonde d'installation, qui doit pouvoir mesurer le GPU même si l'utilisateur ne s'en sert pas."""
    cpu_only = forced is None and not onnx_gpu_enabled()
    if not cpu_only:
        prepare_onnx_dlls()   # inutile en CPU seul, et il coûte un import de torch
    try:
        available: Iterable[str] = ort.get_available_providers()
    except Exception:
        available = ()
    present = set(available)
    requested = ("cpu" if cpu_only else (forced or configured_onnx_backend())).strip().lower()
    names = {
        "cuda": "CUDAExecutionProvider",
        "directml": "DmlExecutionProvider",
        "openvino": "OpenVINOExecutionProvider",
        "cpu": "CPUExecutionProvider",
    }
    order: list[str] = []
    if requested and names[requested] in present:
        order.append(names[requested])
    elif not requested:
        for candidate in ("CUDAExecutionProvider", "DmlExecutionProvider", "OpenVINOExecutionProvider"):
            if candidate in present:
                order.append(candidate)
                break
    if ("CPUExecutionProvider" in present or not order) and "CPUExecutionProvider" not in order:
        order.append("CPUExecutionProvider")
    return order


def onnx_session_options(ort: Any, forced: str | None = None):
    """Options compatibles DirectML ; neutres pour CUDA/OpenVINO/CPU."""
    options = ort.SessionOptions()
    if onnx_providers(ort, forced)[0] == "DmlExecutionProvider":
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return options
