"""I/O ffmpeg du hub de traitements : probe, décodeur rawvideo bgr24, encodeurs vidéo et alpha,
écriture PNG (bgr et rgba). Binaires via ffbin (NETSURUSH_FFMPEG/FFPROBE).

Réutilise le mapping codec d'`upscaler.codecs` (DRY — on ne redéfinit JAMAIS les arguments codec).
`probe` et `decode_one_frame` reprennent l'approche d'`upscaler.media`."""
import json
import os
import subprocess

from ffbin import ffmpeg_bin, ffprobe_bin
from upscaler.codecs import audio_codec_args, video_codec_args


def probe(path):
    """Dimensions + fps (fraction exacte) + nb de frames estimé."""
    out = subprocess.run(
        [ffprobe_bin(), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,avg_frame_rate,nb_frames:format=duration",
         "-of", "json", path],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode()
    j = json.loads(out or "{}")
    st = (j.get("streams") or [{}])[0]
    w = int(st.get("width") or 0)
    h = int(st.get("height") or 0)
    fr = st.get("avg_frame_rate", "0/1") or "0/1"
    num, den = (fr.split("/") + ["1"])[:2]
    fps = (float(num) / float(den)) if float(den or 0) else 24.0
    dur = float((j.get("format") or {}).get("duration") or 0)
    nb = int(st.get("nb_frames") or 0) or (int(dur * fps) if dur and fps else 0)
    return w, h, (fr if float(den or 0) else "24/1"), fps, nb


def open_decoder(input_path, start, end):
    """Décodeur rawvideo bgr24 (segment [start,end] en secondes, ou None/None = tout)."""
    args = [ffmpeg_bin(), "-nostdin", "-hide_banner", "-loglevel", "error"]
    if start is not None:
        args += ["-ss", str(start)]
    if end is not None and start is not None:
        args += ["-t", str(max(0.0, end - start))]
    args += ["-i", input_path, "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:"]
    return subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def _audio_input_args(a):
    """Args de la 2e entrée = audio du segment source exact (réutilisée par les encodeurs)."""
    extra = []
    if getattr(a, "start", None) is not None:
        extra += ["-ss", str(a.start)]
    if getattr(a, "end", None) is not None and getattr(a, "start", None) is not None:
        extra += ["-t", str(max(0.0, a.end - a.start))]
    extra += ["-i", a.input]
    return extra


def open_encoder_video(out_path, ow, oh, fps_str, a, out_fps=None):
    """Entrée rawvideo bgr24 → sortie vidéo (codec d'upscaler.codecs).

    `fps_str` = fps des frames brutes en entrée. `out_fps` (optionnel) = fps de SORTIE distinct,
    nécessaire à l'interpolation (le flux émis a plus de frames donc un fps de sortie différent).
    a = namespace (codec, quality, preset, bitdepth, audio, atrack, abr, input, start, end)."""
    # Le flux brut PORTE déjà les images interpolées : sa cadence est celle de la SORTIE. Déclarer
    # l'entrée à la cadence source ferait croire à ffmpeg que la séquence dure factor× plus longtemps,
    # et le `-r` de sortie la ramènerait en DUPLIQUANT chaque image (vidéo 2× trop longue, gain nul).
    in_fps = str(out_fps) if out_fps else fps_str
    args = [ffmpeg_bin(), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", "%dx%d" % (ow, oh), "-r", in_fps, "-i", "pipe:0"]
    need_audio = getattr(a, "audio", "none") != "none"
    if need_audio:
        args += _audio_input_args(a)
    args += ["-map", "0:v:0"]
    video_args = getattr(a, "video_args", None)
    args += list(video_args) if video_args else video_codec_args(a.codec, a.quality, a.preset, a.bitdepth, getattr(a, "profile", None))
    if out_fps:
        # fps de sortie explicite (interpolation : N× frames → cadence cible).
        args += ["-r", str(out_fps)]
    if need_audio:
        # atrack = index RELATIF parmi les pistes audio (a:N) ; ? = optionnel (pas d'échec si absent).
        track = int(getattr(a, "atrack", -1))
        args += ["-map", "1:a?" if track < 0 else "1:a:%d?" % track]
        audio_args = getattr(a, "audio_args", None)
        args += list(audio_args) if audio_args else audio_codec_args(a.audio, getattr(a, "abr", 192))
    else:
        args += ["-an"]
    if getattr(a, "container", "mp4") in ("mp4", "mov"):
        args += ["-movflags", "+faststart"]
    args += [out_path]
    return subprocess.Popen(args, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)


def open_encoder_alpha(out_path, ow, oh, fps_str, fmt, a):
    """Entrée rawvideo rgba (`-pix_fmt rgba`) → sortie avec canal alpha.

    fmt :
      "prores_4444" → prores_ks profil 4444, yuva444p10le (.mov) — import Resolve direct.
      "webm_alpha"  → libvpx-vp9, yuva420p (.webm).
      "png_seq"     → `out_path` est un motif `dir/frame_%06d.png`, -pix_fmt rgba (pas d'audio).
    Audio passthrough uniquement pour prores/webm (jamais pour png_seq)."""
    args = [ffmpeg_bin(), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "%dx%d" % (ow, oh), "-r", fps_str, "-i", "pipe:0"]

    if fmt == "png_seq":
        # Séquence d'images RGBA : pas d'audio, motif numéroté en sortie.
        args += ["-map", "0:v:0", "-pix_fmt", "rgba", out_path]
        return subprocess.Popen(args, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

    need_audio = getattr(a, "audio", "none") not in ("none", None)
    if need_audio:
        args += _audio_input_args(a)
    args += ["-map", "0:v:0"]
    if fmt == "webm_alpha":
        args += ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "30"]
    else:  # prores_4444
        args += ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"]
    if need_audio:
        track = int(getattr(a, "atrack", -1))
        args += ["-map", "1:a?" if track < 0 else "1:a:%d?" % track]
        audio_args = getattr(a, "audio_args", None)
        args += list(audio_args) if audio_args else audio_codec_args(a.audio, getattr(a, "abr", 192))
    else:
        args += ["-an"]
    if getattr(a, "container", "") in ("mp4", "mov"):
        args += ["-movflags", "+faststart"]
    args += [out_path]
    return subprocess.Popen(args, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)


def write_png(bgr, out_path):
    """Encode une frame bgr24 (numpy HxWx3) en PNG via ffmpeg."""
    import numpy as np
    h, w = bgr.shape[:2]
    p = subprocess.Popen(
        [ffmpeg_bin(), "-y", "-hide_banner", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", "%dx%d" % (w, h), "-i", "pipe:0", out_path],
        stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    p.stdin.write(np.ascontiguousarray(bgr).tobytes())
    p.stdin.close()
    p.wait()
    return os.path.exists(out_path) and os.path.getsize(out_path) > 0


def write_png_rgba(rgba, out_path):
    """Encode une frame rgba (numpy HxWx4) en PNG (avec alpha) via ffmpeg."""
    import numpy as np
    h, w = rgba.shape[:2]
    p = subprocess.Popen(
        [ffmpeg_bin(), "-y", "-hide_banner", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "%dx%d" % (w, h), "-i", "pipe:0",
         "-pix_fmt", "rgba", out_path],
        stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    p.stdin.write(np.ascontiguousarray(rgba).tobytes())
    p.stdin.close()
    p.wait()
    return os.path.exists(out_path) and os.path.getsize(out_path) > 0


def decode_one_frame(input_path, time_sec, w, h):
    """Décode UNE frame bgr24 à time_sec → bytes (ou None si absente). Taille attendue = w*h*3."""
    dec = subprocess.run(
        [ffmpeg_bin(), "-nostdin", "-hide_banner", "-loglevel", "error",
         "-ss", str(max(0.0, time_sec)), "-i", input_path,
         "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout
    if not dec or len(dec) < w * h * 3:
        return None
    return dec[:w * h * 3]
