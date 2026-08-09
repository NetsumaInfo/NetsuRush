# TheAnimeScripter model inventory

Reference inventory based on `NevermindNilas/TheAnimeScripter` at commit `f0d6c055f746d2f54a6a8bf79bc68994c1f24839` (27 July 2026).

The upstream registry holds **233 backend ids**, reduced to **85 logical models** by grouping the CUDA, TensorRT, DirectML, OpenVINO, NCNN and MPS variants. A backend variant is not a new model: it reuses the same checkpoint, or its ONNX/NCNN conversion.

> **Licensing note.** TheAnimeScripter's code is **AGPL-3.0**, so **none of its code may be reused here** (see [`licensing.md`](licensing.md)). Its GPL code does not relicense the third-party **weights** it hosts, which is why the weights are usable while the architectures below all come from permissive repositories (MIT/Apache/BSD). A checkpoint with no clearly identified licence of its own is marked **unknown licence / NC by precaution** in the UI.

Status values used below:

- **Usable** — download and engine wired. Every weight offered for download is in this state: a weight with no engine would be disk space disguised as a feature, and a test refuses it.
- **Equivalent** — the same model is already provided under a more explicit id.
- **Dropped** — deliberately absent, for a named reason (licence, source, measured quality).
- **No weights** — an algorithm or a proprietary runtime, so there is no checkpoint to download.

Architectures that Spandrel 0.4.2 does not recognise travel with their `.py` module, pinned to a commit of the original repository: on a moving branch, an upstream refactor would change the architecture under already-installed weights.

## Upscaling

| Logical model | Status |
| --- | --- |
| `shufflecugan`, `adore`, `aniscale2`, `open-proteus`, `span`, `figsr`, `smosr` | Usable |
| `fallin_soft`, `fallin_strong` | Usable |
| `animesr` | Usable — **recurrent** video super-resolution (hidden state carried frame to frame) |
| `shufflespan` | Usable — ONNX with a **fixed** 1080×1920 graph, so it is run in windows |
| `rtmosr` | Usable — TorchScript: the graph travels with the weights, no architecture to embed |
| `saryn` | Usable — RTMoSR architecture |
| `gauss` | **Dropped** — architecture not reconstructible: of twelve plausible residual arrangements measured against ground truth, the best returns 37.1 dB where plain bicubic returns 40.0 |
| `artcnn_c4f16`, `artcnn_c4f32` (+ `_dn` softening, `_ds` sharpening variants) | Shipped as Turbo shaders |
| `artcnn_r8f64`, `artcnn_r16f96` | Usable, weights shipped with the shaders |

The `maxine-*` modes exposed upstream use NVIDIA Maxine: **no public weights**. The RTX Video SDK, on the other hand, is usable and exposed in the same real-time picker (the RTXVideoProcessor CLI plus NVIDIA DLLs the user provides — they are not redistributable).

## Restoration

Usable in Upscale ▸ Restoration: `scunet`, `nafnet`, `dpir`, `real-plksr`, `anime1080fixer`, `deh264_real`, `deh264_span`, `hurrdeblur`, `dehalo`.

- `deepdeband-f` — **dropped**: the upstream asset no longer exists, so there is no fake download button.
- `fastlinedarken`, `autocas`, `linethinner-*`, `maxine-denoise/deblur-*` — **no weights** in the upstream registry.

Every restorer marked usable was loaded with the loader actually installed in the venv and run on an RGB tensor: all produce a finite output of the same size. They are therefore **1× restorers of the upscale engine**, not a separate top-level operation.

## Interpolation and optical flow

| Logical model | Status |
| --- | --- |
| `rife` | Equivalent to RIFE 4.22 |
| `rife4.6` | Equivalent, in the bundled RIFE NCNN runtime |
| `rife4.15` → `rife4.25-heavy` | Usable — twelve PyTorch generations (the NCNN runtime does not carry them) |
| `distildrba` | Usable — **three-frame** interpolator |
| `distildrba-lite` | Usable — same engine, shorter pyramid |
| `gmfss` | Usable — GMFSS Fortuna: five networks (GMFlow, RIFE, metric, feature, fusion) |
| `rife_elexor` | **Dropped** — the only two sources for its architecture are TheAnimeScripter (AGPL-3.0) and AMVerge-CLI (GPL-3.0), so there is no reusable code here |
| `flownets` | Dropped (duplicate) |

A PyTorch RIFE architecture **cannot be deduced from its checkpoint**: every version needs its own architecture module. Those modules are **downloaded next to the weights at install time from `HolyWu/vs-rife` (MIT), at a pinned tag** — they are not vendored in this repository, and the pin exists because a moving branch would change the architecture under already-installed weights.

Assumed limit on DRBA and AnimeSR: the stream is read forward, with no look-ahead. AnimeSR repeats the current frame as the next one — which the network already does at the end of a sequence, its recurrent memory staying exact. DRBA is only affected beyond fraction 0.5, so **at factor 2 the only requested fraction is 0.5 and the context is always exact**; at factors 3 and 4 the higher fractions lose the only downstream context.

## Depth

Upstream V2 and V3 ids map onto the equivalents already in the catalog (small/base/large for Depth Anything V2, the distilled variants, the video variants, and the V3 generation); the `og_*` ids are upstream aliases of the same weights.

- `giant_v2` — **dropped**: the only repository carrying it is a third-party re-upload **with no declared licence**, outside the transformers format, of a model the authors never published.
- `video_small_v2`, `video_large_v2` — upstream CLI choices with no clean download mapping.

## Segmentation, detection and metrics

| Logical model | Status |
| --- | --- |
| `segment` (IS-Net anime) | Equivalent, provided by rembg |
| `transnetv2` | Usable |
| `shift_lpips` | Dropped — a comparison metric, not an operation of the app |
| `yolov9_*` | Dropped — object detection, outside the scope of the processing hub |

PySceneDetect, SSIM, MSE and VMAF are algorithms or metrics: **no weights**.

## Download sources

- Community weights: the `NevermindNilas/TAS-Models-Host` release.
- Non-Spandrel architectures: their original repositories (`umzi2/SMoSR`, `enhancr/figsr`, `umzi2/GaterV3`, `TencentARC/AnimeSR`, `JepEtau/pynnlib` for RTMoSR), each pinned to a commit.
- PyTorch RIFE architectures: `HolyWu/vs-rife`, pinned tag.
- GMFSS Fortuna and DistilDRBA: `98mxr/GMFSS_Fortuna` and `routineLife1/DistilDRBA`, pinned to a commit.
- Shot detection and Depth Anything V2: the official Hugging Face repositories.
