# Windows multi-GPU compatibility

NetsuRush does not assume an NVIDIA card. On first launch the app inventories the Windows GPUs, picks the officially supported runtime, then validates video encoders **separately** with a real test frame. An acceleration path that fails the probe is never offered; the CPU path always stays available.

## Execution matrix

| Feature | NVIDIA | AMD | Intel | No supported GPU |
|---|---|---|---|---|
| Cut proxies and video streams | NVENC | AMF | Quick Sync | libx264 (CPU) |
| H.264 / HEVC / AV1 export | encoder probed per profile | encoder probed per profile | encoder probed per profile | matching CPU codec |
| PyTorch models | CUDA | ROCm on officially listed Windows hardware | XPU on supported Intel Arc | CPU |
| ONNX models | CUDA EP | DirectML EP | DirectML EP | CPU EP |
| Whisper / faster-whisper | CUDA | CPU | CPU | CPU |
| Notebook | identical | identical | identical | identical |

The "GPU" choice stored in upscale preferences is an **automatic intent**: it resolves to `*_nvenc`, `*_amf` or `*_qsv`. The legacy `h264_nvenc` / `hevc_nvenc` ids stay readable so existing settings keep working.

**H.265/HEVC is hardware-encoded on all three vendors** (`hevc_nvenc`, `hevc_amf`, `hevc_qsv`), not only on NVIDIA — including for the preview proxies. What decides is the **probe**, not the brand: an encoder that a machine cannot actually run degrades to hardware H.264, then to the CPU codec. Two consequences worth knowing:

- an ffmpeg build **advertises** `h264_qsv` and `h264_amf` even with no Intel or AMD GPU installed, so every hardware encoder is probed with its real profile and pixel format before being offered;
- the only genuinely NVIDIA-only profiles are **4:4:4** (`h264_high444`, HEVC RExt 4:4:4): no other vendor encodes them, so they run on the CPU elsewhere.

## Adaptive installation

- NVIDIA: PyTorch CUDA plus ONNX Runtime GPU.
- AMD officially ROCm-capable on Windows 11: Python 3.12 plus the ROCm Windows wheels.
- Intel Arc officially XPU-capable on Windows 11: the PyTorch XPU index.
- Anything else: PyTorch CPU; ONNX Runtime DirectML on a DirectX 12 capable GPU, otherwise ONNX Runtime CPU.
- FFmpeg is shared by all four paths and ships NVENC, AMF, QSV and the software codecs.

**The AMD ROCm list is deliberately strict**: Radeon RX 9070 / 9070 XT, AI PRO R9700, RX 9060 XT, RX 7900 XTX, PRO W7900 (Dual Slot included), RX 7700, and the Ryzen AI parts AMD has officially published. A neighbouring but unlisted Radeon falls back to DirectML for ONNX and CPU for PyTorch, rather than attempting an unsupported ROCm install.

## Models

- Shot detection, search, upscaling, interpolation, depth and the roto models all go through the central PyTorch selection (`cuda`, `rocm`, `xpu`, `cpu`).
- Parakeet, Silero and the ONNX graphs use CUDA, DirectML or CPU depending on the providers actually present in the venv.
- faster-whisper / WhisperX use CUDA **only** on NVIDIA, because CTranslate2 has no equivalent Windows ROCm/XPU path; AMD and Intel keep the CPU fallback.
- A model requiring an official CUDA-only pipeline is **hidden** on AMD, Intel and CPU installs rather than offered and failing.
- Turbo (shader) upscaling depends on Vulkan/libplacebo; if that is unavailable the AI engine still works.
- The notebook has no GPU dependency at all.

## Diagnostics and filtering

Settings ▸ System ▸ Compatibility shows the Windows inventory, the PyTorch backend actually active, the installed ONNX providers, and the FFmpeg encoders that passed the probe. The upscale picker hides missing GPU variants and hardware profiles that failed (for example HEVC Main 10). If a hardware session becomes unavailable **after** the probe, the job is automatically replayed on the CPU codec of the same family.

## Technical sources

- [AMD — installing PyTorch ROCm on Windows](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installryz/windows/install-pytorch.html)
- [AMD — Radeon Windows compatibility matrix](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityrad/windows/windows_compatibility.html)
- [AMD — Ryzen Windows compatibility matrix](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityryz/windows/windows_compatibility.html)
- [PyTorch — getting started with Intel XPU](https://docs.pytorch.org/docs/stable/notes/get_start_xpu.html)
- [ONNX Runtime — installation](https://onnxruntime.ai/docs/install/)
- [ONNX Runtime — DirectML execution provider](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)
- [Microsoft — PyTorch with DirectML](https://learn.microsoft.com/en-us/windows/ai/directml/pytorch-windows)
- [AMVerge — hardware detection and encoders](https://github.com/AMVerge-team/AMVerge/blob/main/frontend/src-tauri/src/commands/export/hardware.rs)
