import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
import nrdevice  # noqa: E402


class FakeAccelerator:
    def __init__(self, available=False):
        self._available = available
        self.emptied = False

    def is_available(self):
        return self._available

    def empty_cache(self):
        self.emptied = True

    def ipc_collect(self):
        pass


class FakeSessionOptions:
    def __init__(self):
        self.enable_mem_pattern = True
        self.execution_mode = "parallel"


def fake_torch(cuda=False, hip=None, xpu=False):
    return SimpleNamespace(
        cuda=FakeAccelerator(cuda),
        xpu=FakeAccelerator(xpu),
        version=SimpleNamespace(hip=hip),
    )


class DeviceSelectionTests(unittest.TestCase):
    def test_nvidia_cuda(self):
        torch = fake_torch(cuda=True)
        self.assertEqual(nrdevice.torch_backend(torch, "cuda"), "cuda")
        self.assertEqual(nrdevice.torch_device(torch, "cuda"), "cuda")

    def test_rocm_uses_cuda_api_but_keeps_its_identity(self):
        torch = fake_torch(cuda=True, hip="7.2.1")
        self.assertEqual(nrdevice.torch_backend(torch, "rocm"), "rocm")
        self.assertEqual(nrdevice.torch_device(torch, "rocm"), "cuda")
        self.assertEqual(nrdevice.torch_backend(torch, "cuda"), "cpu")

    def test_intel_xpu(self):
        torch = fake_torch(xpu=True)
        self.assertEqual(nrdevice.torch_backend(torch, "xpu"), "xpu")
        self.assertEqual(nrdevice.torch_device(torch, "xpu"), "xpu")

    def test_requested_accelerator_always_falls_back_to_cpu(self):
        torch = fake_torch()
        for backend in ("cuda", "rocm", "xpu"):
            self.assertEqual(nrdevice.torch_backend(torch, backend), "cpu")

    def test_onnx_provider_order_and_cpu_fallback(self):
        ort = SimpleNamespace(
            get_available_providers=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
            SessionOptions=FakeSessionOptions,
            ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL="sequential"),
        )
        self.assertEqual(nrdevice.onnx_providers(ort, "directml"), ["DmlExecutionProvider", "CPUExecutionProvider"])
        self.assertEqual(nrdevice.onnx_providers(ort, "cuda"), ["CPUExecutionProvider"])
        self.assertEqual(nrdevice.onnx_providers(ort, "cpu"), ["CPUExecutionProvider"])
        options = nrdevice.onnx_session_options(ort, "directml")
        self.assertFalse(options.enable_mem_pattern)
        self.assertEqual(options.execution_mode, "sequential")


if __name__ == "__main__":
    unittest.main()
