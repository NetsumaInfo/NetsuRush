"""OmniShotCut run as a stream: ffmpeg decodes while the model infers.

`OmniShotCutModel.inference(path)` decodes the whole video into RAM first (~7 GB for a 2 h film at
128x96) and only then runs the model, with no progress in between. Here the frames come from a
streamed ffmpeg pipe and every window is inferred as soon as its frames are in. Windowing,
stitching and labels are the upstream ones (`decode_window_segments`, `collect_cuts_from_window`,
`assemble_ranges`, windows identical to `split_videos`): with the same frames the result is
identical to `inference(frames, mode="default", overlap=...)`.

Pixels matter more than they look. v1.5 was trained on decord frames, which are exactly ffmpeg's
`scale=...:flags=bilinear` output. Upstream's ffmpeg decoder uses the default (bicubic) scaler, and
that alone made v1.5 miss obvious hard cuts. Frames are therefore scaled bilinearly.

Measured on a 24 min HEVC 10-bit 1080p episode (RTX 3070 Ti laptop, 16 threads):
- upstream `inference(path)`: 152 s. Decoding alone takes 83 s and saturates the CPU.
- this stream: 96 s. Upstream's validation transform walks each window frame by frame in Python on
  that saturated CPU (46 s in total); the same normalisation runs here on the device (gap 7e-7).
- not used: NVDEC + scale_cuda decodes 2.2x faster alone, but its CUDA context and PyTorch's share
  the GPU so badly that the whole run got slower (126 s), and its pixels lost 5 cuts out of 328.
  Splitting the file into parallel ffmpeg segments only gains ~15 % on a saturated CPU.
"""
import subprocess
import threading

import numpy as np

from ffbin import ffmpeg_bin

WIDTH, HEIGHT = 128, 96
FRAME_BYTES = WIDTH * HEIGHT * 3
_MEAN = (0.485, 0.456, 0.406)
_STD = (0.229, 0.224, 0.225)


def iter_frames(path, chunk=256):
    """Yield (n, 96, 128, 3) uint8 RGB chunks, scaled like decord. Raises on an ffmpeg error."""
    proc = subprocess.Popen(
        [ffmpeg_bin(), "-nostdin", "-v", "error", "-i", path,
         "-map", "0:v:0", "-vf", f"scale={WIDTH}:{HEIGHT}:flags=bilinear", "-fps_mode", "passthrough",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    err = []
    drain = threading.Thread(target=lambda: err.append(proc.stderr.read()), daemon=True)
    drain.start()
    try:
        while True:
            buf = proc.stdout.read(FRAME_BYTES * chunk)
            if not buf:
                break
            usable = len(buf) - len(buf) % FRAME_BYTES
            if usable:
                yield np.frombuffer(buf[:usable], np.uint8).reshape(-1, HEIGHT, WIDTH, 3)
        if proc.wait() != 0:
            drain.join(5)
            raise RuntimeError((b"".join(err) or b"").decode("utf-8", "replace").strip()[-400:])
    finally:
        try:
            proc.stdout.close()
        except Exception:  # noqa: BLE001
            pass
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def _prefetch(chunks, depth=8):
    """Decode ahead on a thread so ffmpeg keeps running while the GPU infers."""
    import queue
    done = object()
    q = queue.Queue(maxsize=depth)

    def pump():
        try:
            for c in chunks:
                q.put(c)
        except BaseException as exc:  # noqa: BLE001 - handed to the consumer as is
            q.put(exc)
        else:
            q.put(done)

    threading.Thread(target=pump, daemon=True).start()
    while True:
        item = q.get()
        if item is done:
            return
        if isinstance(item, BaseException):
            raise item
        yield item


def windows(chunks, size, overlap):
    """Same windows as `engine.split_videos`, produced while frames arrive.

    Yields (window, window_start, valid_start, valid_end, valid_len). A window is final when it
    reaches the last frame, which is only known once one more frame exists (or the stream ends)."""
    stride = size - overlap
    left, right = overlap // 2, overlap - overlap // 2
    buf = np.zeros((0, HEIGHT, WIDTH, 3), np.uint8)
    base = 0      # absolute index of buf[0]
    start = 0     # absolute start of the next window
    eof = False
    it = iter(chunks)
    while True:
        while not eof and base + len(buf) <= start + size:
            nxt = next(it, None)
            if nxt is None:
                eof = True
            else:
                buf = np.concatenate((buf, nxt))
        total = base + len(buf)
        if start >= total:
            return
        end = start + size
        final = end >= total and eof
        valid_len = min(size, total - start)
        win = buf[start - base:start - base + valid_len]
        if valid_len < size:
            win = np.concatenate((win, np.zeros((size - valid_len, HEIGHT, WIDTH, 3), np.uint8)))
        valid_start = 0 if start == 0 else start + left
        valid_end = total if final else end - right
        yield win, start, valid_start, valid_end, valid_len
        if final:
            return
        start += stride
        if start > base:
            buf = buf[start - base:]
            base = start


def _to_tensor(win, device, torch):
    """`engine.video_transform` (set_type="val") on the device: [1, T, C, H, W], ImageNet-normalised."""
    x = torch.from_numpy(win).to(device).permute(0, 3, 1, 2).float().div_(255.0)
    mean = torch.tensor(_MEAN, device=device).view(1, 3, 1, 1)
    std = torch.tensor(_STD, device=device).view(1, 3, 1, 1)
    return x.sub_(mean).div_(std).unsqueeze(0)


def detect(model, path, overlap, nframes_hint=0, on_progress=None):
    """Run OmniShotCut over `path`. Returns (ranges, intra_labels, inter_labels, frames)."""
    import torch
    from omnishotcut import engine
    from omnishotcut.label_correspondence import inter_int2string, intra_int2string

    net, args = model._model, model._model_args
    size = int(args.max_process_window_length)
    overlap = max(0, min(size - 1, int(overlap)))
    cuts, total = [], 0
    for win, w_start, v_start, v_end, v_len in windows(_prefetch(iter_frames(path)), size, overlap):
        with torch.inference_mode():
            out = net(_to_tensor(win, engine._DEVICE, torch))
        intra = out["intra_clip_logits"].softmax(-1)[0, :, :-1].argmax(dim=-1)
        inter = out["inter_clip_logits"].softmax(-1)[0, :, :-1].argmax(dim=-1)
        rng = out["pred_shot_logits"].softmax(-1)[0, :, :-1].argmax(dim=-1)
        segments = engine.decode_window_segments(intra, inter, rng, v_len)
        cuts.extend(engine.collect_cuts_from_window(segments, w_start, v_start, v_end))
        total = w_start + v_len
        if on_progress and nframes_hint:
            on_progress(min(1.0, total / nframes_hint))
    if not total:
        return [], [], [], 0
    ranges, intra, inter = engine.assemble_ranges(cuts, total)
    return (ranges, [intra_int2string.get(x, str(x)) for x in intra],
            [inter_int2string.get(x, str(x)) for x in inter], total)
