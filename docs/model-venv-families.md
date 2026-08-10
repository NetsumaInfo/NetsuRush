# Model environment families

Reference table: which Python stack each model occupies, which **shared** packages it constrains, and what to do when two models cannot coexist.

Source of truth: `core/venvs.js`. Locked by `test/venv-families.test.cjs`.

## Why this document exists

Three real breakages, all the same pattern — a model installs a shared dependency and overwrites another's, with nothing saying so:

1. A model pinning `huggingface_hub==0.36.2` downgraded the package under `transformers 5.x`: **the whole search module stopped starting** (`cannot import name 'is_offline_mode' from 'huggingface_hub'`).
2. `faster-whisper` declares `onnxruntime` with no extra, so pip installed the **CPU** variant over `onnxruntime-gpu` (both distributions share the `onnxruntime/` folder) and all ONNX inference silently moved to the CPU — **7.9× lost** on face recognition, without a single error message.
3. `dghs-imgutils` requires `numpy<2`, which torch and faiss do not support.

A fourth one is worse, because the package does it itself: `imgutils.utils.onnxruntime` runs `pip install onnxruntime-gpu` at import time when the module is missing. It lands the newest wheel — the CUDA 13 branch — on top of the one built for torch's CUDA, `CUDAExecutionProvider` disappears, and every ONNX model silently moves back to the CPU. Both install paths therefore `import onnxruntime` **before** touching imgutils, so a missing runtime fails the step instead of rebuilding the venv behind our back.

None of the three was visible at install time. Families are what makes them **announceable before the click** instead of discoverable afterwards.

## One single environment

NetsuRush has **one** venv. Families describe and detect; they do not separate. Two reasons, each sufficient:

- Reproducing the **torch CUDA** install outside `scripts/setup.ps1` would cost ~6 GB per environment and a second installer to keep in sync — divergence between the two would be one more failure mode, not one fewer.
- The only model that genuinely constrains a shared package (the anime face detector) is imported **in the process** of the search sidecar, next to SigLIP. Another venv cannot be imported into an already running process: face search would have to be split into its own sidecar first.

A conflict is therefore resolved by **choosing a model**, not by multiplying environments.

## Family table

| Family | Base | Constrained shared packages | Models |
|---|---|---|---|
| `core` | torch + transformers | `huggingface_hub>=1.5`, `transformers>=4.49` | SigLIP 2 search, all depth, cutout and fine matte, real-face recognition |
| `upscale` | torch + basicsr / spandrel | — | Real-ESRGAN, CUGAN, Spandrel-loaded networks, the NTIRE entries, RTX Video, restoration |
| `interpolation` | torch + vendored architectures | — | RIFE (all generations), DistilDRBA, GMFSS, RIFE ncnn |
| `sam` | torch + `sam2` / `sam3` package | `SAM-2` (pip distribution) | SAM 2.1 sizes, EdgeTAM, SAM 3.1, **SAMURAI**, **SAM2Long** |
| `diffusion` | torch + diffusers | `diffusers>=0.33.0` | video object removal, batched matting, generative inpainting |
| `voice` | ONNX Runtime + ctranslate2 | `onnxruntime` | Whisper variants, Parakeet, Canary |
| `anime-face` | pure ONNX | `numpy<2`, `opencv-contrib-python` | the anime face engine (YOLO anime detection + CCIP identity) |
| `bundled` | none | — | shot detection models, Silero VAD, RVM, WhisperX |

The family is **derived from the model's task** (`FAMILY_BY_TASK`): one task, one stack. Writing it on every manifest entry would be that many chances to get it wrong for information that can be computed. Two declared exceptions (`FAMILY_OVERRIDES`): the anime face engine, the only face model going through `dghs-imgutils` rather than the opencv_zoo ONNX graphs; and the real-face weights, a direct download **with no task**, which the fallback rule ("a `url` entry without a task is an upscaler") would otherwise file with the upscalers.

## Mutually exclusive models

Some training-free methods are published as forks of the same pip distribution and the same module name, so only one can occupy the slot.

The installer used to uninstall the competitor **without asking**: you lost a working install for one you had not tried yet. Now the download path consults `resolveInstall` and **refuses**, naming the competitor, until the replacement is confirmed. The UI says so at three levels: an "exclusive" badge on the card, a banner at the top of the section, and a dialog at click time.

Which one is installed is read **from disk** (a fingerprint inside the installed package), never from a state file, which a manual `pip install` would falsify.

## Reading `pip check`

`readPipCheck` translates the raw output. **Two complaints are normal** on a healthy install and are marked `expected`:

| Line | Why it is normal |
|---|---|
| `faster-whisper … requires onnxruntime, which is not installed` | `onnxruntime` is installed under the name `onnxruntime-gpu` by the explicit path. "Fixing" it would restore the CPU variant and lose the 7.9× factor again. |
| `dghs-imgutils … requires opencv-contrib-python, which is not installed` | The venv carries the `headless` variant. The `cv2` module is present; reinstalling opencv would fail anyway, since the sidecar holds `cv2.pyd` open (WinError 5). |

Other lines are real drift. On a machine where the anime face engine and the batched matting model have both been installed you typically read:

```
dghs-imgutils 0.19.0 has requirement numpy<2, but you have numpy 2.4.6.
matanyone2 1.0.0 has requirement huggingface-hub==0.36.2, but you have huggingface-hub 1.26.1.
scikit-image 0.26.0 has requirement imageio!=2.35.0,>=2.33, but you have imageio 2.25.0.
```

- `numpy<2`: **expected and harmless** — that model installs with `--no-deps` precisely so numpy is not downgraded; the complaint is about metadata, not about what runs.
- `huggingface-hub==0.36.2`: **a leftover**. A `pipPatch` strips that pin from the pyproject, but an install made **before** the patch keeps it in its metadata. Reinstalling the model clears it.
- `imageio`: a downgrade coming from the matting family; watch it if `scikit-image` starts failing.

## Adding a model: the rule

1. **Any `==` pin on a shared dependency must be removed by `pipPatch`**, never merely bypassed with `--no-deps`: the pin survives in the installed package's metadata and pip honours it on every later resolution.
2. Any new bound on a shared package goes into its family's `constrains` in `core/venvs.js`. Otherwise the diagnostic stays silent exactly when it is needed.
3. A model that replaces a shared package declares `exclusiveWith` — that is what triggers the refusal and the confirmation prompt.
4. Never let a model install decide the torch version. `torch`, `torchvision` and `torchaudio` are one ABI: a wheel pulled from PyPI by a transitive dependency (`silero-vad` asks for `torchaudio>=0.12`) overwrites the one built for the installed torch, and the import then raises `[WinError 127]` in a module the user was not installing. `ensurePipPackage` therefore runs every step under a `PIP_CONSTRAINT` file pinning whichever of the three are already present, and `scripts/setup.ps1` installs all three together from the torch index.

## Installed, missing, or broken

Import failures are read in **three** states, not two (`pyImportState`). A distribution that is absent is `missing`; one that is present but whose import raises — a neighbouring ABI broken, a CUDA DLL gone — is `broken`, and the download path stops there instead of reinstalling. Reinstalling a broken package removes the correct wheel and produces the loop the states exist to prevent: "not installed" → install → still "not installed".
