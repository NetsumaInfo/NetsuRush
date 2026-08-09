# Speech-to-text: model choices

Why the transcription engines are the ones they are. The implementation lives in the Voice module — see the Voice section of [`modules.md`](modules.md).

**Hard requirement: multilingual.** Rushes include Japanese anime, French and English material, and that single constraint eliminated most of the leaderboard leaders.

## Candidates evaluated

| Model | Languages | Strength | Limit |
|---|---|---|---|
| **Whisper large-v3** | ~99 languages (FR/**JA**/EN…) | multilingual reference, robust | heavy (~1.5 GB), latency |
| **Whisper large-v3-turbo** | same | ~4-8× faster, near-identical quality | slightly weaker on difficult audio |
| **WhisperX** | same as Whisper | **word-level timestamps** (wav2vec2 alignment) + diarisation | heavier pipeline (3 models), pyannote is gated and needs a token |
| NVIDIA Canary-1b / canary-qwen | en/de/es/fr (**no JA**) | top of the OpenASR leaderboard, ASR + translation | no Japanese → unusable for anime |
| NVIDIA Parakeet-TDT | multilingual (v3) | very fast on GPU | weaker than Whisper on hard audio |
| Mistral Voxtral | multilingual | audio-LLM (transcription + Q&A) | experimental, heavy |
| Kyutai STT | multilingual | real-time streaming | built for live, not batch |

## What is wired

- **Runtime: `faster-whisper`** (CTranslate2 backend) running the Whisper weights — roughly 4× faster than the reference implementation at the same quality, with lower VRAM (float16/int8 on GPU). The default is **`large-v3-turbo`**.
- **Parakeet TDT v3** as the fast option, driven through **onnx-asr** rather than NeMo or transformers, which pull a far larger dependency tree.
- **WhisperX** stays a deliberate option, not the default: it adds word alignment and diarisation but pulls a gated pyannote model plus an HF token, which is packaging friction. It also carries **its own VAD**, so it must never be stacked on top of Silero.
- Word timestamps are the module's contract (`{start, end, word, conf}` in seconds), so subtitles, silence removal and text-based editing all consume one source.

## Consumers

1. **Subtitles** — SRT/VTT export, re-timed against the cut list.
2. **Text-based editing** — click a word to seek, delete a passage to cut it.
3. **Silence removal** — the ASR words act as a guard so no cut boundary ever lands inside a word.
4. **Resolve markers** — one marker per line via `Timeline.AddMarker(frame, …)`, `frame = round(start * fps)`. ⚠️ Respect the frame-accurate invariants (clip fps, inclusive end frame) in [`invariants.md`](invariants.md).

## Runtime notes

Transcription needs a GPU to be practical (float16). Audio is extracted by ffmpeg as 16 kHz mono WAV — no video decoding. The transcript is cached in SQLite, keyed per file **and per model**, so switching engines does not invalidate the other's cache and reopening a rush is instant. See the Voice section of [`modules.md`](modules.md) for the measured installation traps (torchaudio pinning, cuDNN DLL path, word-boundary parsing).
