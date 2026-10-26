# Speech-to-text: model choices

Why the transcription engines are the ones they are. Speech recognition has one consumer left: identifying the language of an audio track whose tag is missing or unreadable, when the export picks a track by language (`core/audioLang.js` → `sidecars.detectTrackLang` → `python/transcribe.py`, op `langid`).

**Hard requirement: multilingual.** Rushes include Japanese anime, French and English material, and that single constraint eliminated most of the leaderboard leaders.

## Candidates evaluated

| Model | Languages | Strength | Limit |
|---|---|---|---|
| **Whisper large-v3** | ~99 languages (FR/**JA**/EN…) | multilingual reference, robust | heavy (~1.5 GB), latency |
| **Whisper large-v3-turbo** | same | ~4-8× faster, near-identical quality | slightly weaker on difficult audio |
| NVIDIA Canary-1b / canary-qwen | en/de/es/fr (**no JA**) | top of the OpenASR leaderboard, ASR + translation | no Japanese → unusable for anime |
| NVIDIA Parakeet-TDT | multilingual (v3) | very fast on GPU | weaker than Whisper on hard audio |

## What is wired

- **Runtime: `faster-whisper`** (CTranslate2 backend) running the Whisper weights, in a warm daemon (`transcribe.py serve`) so a second track does not reload the model. The default is **`large-v3-turbo`**; language identification uses Whisper's own `detect_language` on a short excerpt.
- **Parakeet TDT v3** is driven through **onnx-asr** rather than NeMo or transformers, which pull a far larger dependency tree.

## Runtime notes

Audio is extracted by ffmpeg as 16 kHz mono WAV — no video decoding — into the session cache (`VOICE_DIR`). Measured traps: faster-whisper on GPU needs `site-packages/nvidia/{cudnn,cublas}/bin` on the DLL search path, otherwise it silently falls back to CPU; read WAV through `soundfile`, not torchaudio; a dependency that pulls the latest `torchaudio` breaks a pinned torch (`WinError 127`).
