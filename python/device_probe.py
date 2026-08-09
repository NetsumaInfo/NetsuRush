"""Diagnostic léger du venv installé. Aucun poids ni modèle n'est chargé."""
from __future__ import annotations

import json

from nrdevice import (
    configured_onnx_backend,
    configured_torch_backend,
    onnx_providers,
    torch_backend,
    torch_device,
)


def main() -> None:
    result = {"torch": None, "onnx": None, "errors": []}
    try:
        import torch

        backend = torch_backend(torch)
        device = torch_device(torch)
        name = None
        try:
            if backend in ("cuda", "rocm"):
                name = torch.cuda.get_device_name(0)
            elif backend == "xpu":
                name = torch.xpu.get_device_name(0)
        except Exception:
            pass
        result["torch"] = {
            "configured": configured_torch_backend() or "auto",
            "actual": backend,
            "device": device,
            "deviceName": name,
            "version": str(torch.__version__),
            "accelerated": backend != "cpu",
        }
    except Exception as exc:
        result["errors"].append("torch: %s" % exc)

    try:
        import onnxruntime as ort

        providers = list(ort.get_available_providers())
        selected = onnx_providers(ort)
        result["onnx"] = {
            "configured": configured_onnx_backend() or "auto",
            "availableProviders": providers,
            "selectedProviders": selected,
            "accelerated": bool(selected and selected[0] != "CPUExecutionProvider"),
            "version": str(ort.__version__),
        }
    except Exception as exc:
        result["errors"].append("onnxruntime: %s" % exc)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
