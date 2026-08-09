"""I/O ffmpeg : probe (dimensions/fps/frames), ouverture des process décode/encode rawvideo bgr24,
encodeur GIF, écriture PNG d'une frame. Binaires via ffbin (NETSURUSH_FFMPEG/FFPROBE)."""
import json
import os
import subprocess

from ffbin import ffmpeg_bin, ffprobe_bin

from .codecs import audio_codec_args, video_codec_args


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


def probe_color(path, width, height):
    """Sonde la colorimétrie source pour garantir un round-trip YUV→RGB→YUV identité.

    Sans cette info, swscale convertit le bgr24 (RGB plein) vers YUV avec la matrice bt601 par
    défaut alors que la source HD est en bt709 → décalage colorimétrique (sortie plus foncée). On
    normalise sur deux familles gérées par swscale (HD bt709 / SD bt601=smpte170m), avec repli par
    résolution si la source n'est pas taguée, et on réutilise la même matrice au décodage ET au tag
    de sortie (décodeur ↔ encodeur symétriques → la vraie sortie correspond à l'aperçu)."""
    out = subprocess.run(
        [ffprobe_bin(), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=color_space,color_primaries,color_transfer,color_range",
         "-of", "json", path],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode()
    st = (json.loads(out or "{}").get("streams") or [{}])[0]

    def good(v):
        return bool(v) and str(v).lower() not in ("unknown", "unspecified", "n/a", "reserved", "")

    raw_cs = st.get("color_space")
    if good(raw_cs):
        sd = str(raw_cs).lower() in ("smpte170m", "bt470bg", "bt601", "fcc", "smpte240m")
    else:
        sd = (height or 0) < 720
    matrix = "smpte170m" if sd else "bt709"
    full = str(st.get("color_range") or "").lower() in ("pc", "jpeg", "full")
    # primaries/transfer alignés sur la matrice (bt709 HD / smpte170m SD) : suffisant et robuste.
    return {"matrix": matrix, "primaries": matrix, "transfer": matrix, "range": "pc" if full else "tv"}


def _decode_vf(color):
    """Filtre de décodage : interprète la source avec la matrice/range décidés → bgr24 plein (RGB).
    None = comportement historique (laisse swscale deviner depuis les tags source)."""
    if not color:
        return []
    return ["-vf", "scale=in_range=%s:in_color_matrix=%s,format=bgr24"
            % (color["range"], color["matrix"])]


def _encode_vf(color):
    """bgr24 (RGB plein) → YUV avec la matrice/range cible (sinon swscale retombe sur bt601)."""
    if not color:
        return []
    return ["-vf", "scale=in_range=full:out_range=%s:out_color_matrix=%s"
            % (color["range"], color["matrix"])]


def _color_tags(color):
    """Tags colorimétriques de sortie → le lecteur réinterprète exactement la matrice/range encodés."""
    if not color:
        return []
    return ["-colorspace", color["matrix"], "-color_primaries", color["primaries"],
            "-color_trc", color["transfer"], "-color_range", color["range"]]


def open_decoder(input_path, start, end, color=None):
    # -hwaccel auto = décode GPU si dispo (NVDEC), repli CPU automatique sinon. Les frames sont
    # ramenées en mémoire pour le modèle (rawvideo bgr24) → transparent.
    args = [ffmpeg_bin(), "-nostdin", "-hide_banner", "-loglevel", "error", "-hwaccel", "auto"]
    if start is not None:
        args += ["-ss", str(start)]
    if end is not None and start is not None:
        args += ["-t", str(max(0.0, end - start))]
    args += ["-i", input_path]
    args += _decode_vf(color)
    args += ["-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:"]
    return subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def open_encoder(out_path, ow, oh, fps_str, a, color=None):
    """a = namespace argparse (codec, quality, preset, bitdepth, audio, atrack, input, start, end).
    color = dict de probe_color (matrice/range) → conversion RGB→YUV exacte + tags (sortie == aperçu)."""
    args = [ffmpeg_bin(), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", "%dx%d" % (ow, oh), "-r", fps_str, "-i", "pipe:0"]
    need_audio = a.audio != "none"
    if need_audio:
        # 2e entrée = source (audio du segment exact).
        if a.start is not None:
            args += ["-ss", str(a.start)]
        if a.end is not None and a.start is not None:
            args += ["-t", str(max(0.0, a.end - a.start))]
        args += ["-i", a.input]
    args += ["-map", "0:v:0"]
    args += _encode_vf(color)
    video_args = getattr(a, "video_args", None)
    args += list(video_args) if video_args else video_codec_args(a.codec, a.quality, a.preset, a.bitdepth, getattr(a, "profile", None))
    args += _color_tags(color)
    if need_audio:
        # atrack = index RELATIF parmi les pistes audio (a:N) ; ? = optionnel (pas d'échec si absent).
        track = int(getattr(a, "atrack", -1))
        args += ["-map", "1:a?" if track < 0 else "1:a:%d?" % track]
        audio_args = getattr(a, "audio_args", None)
        args += list(audio_args) if audio_args else audio_codec_args(a.audio, a.abr)
    else:
        args += ["-an"]
    if getattr(a, "container", "mp4") in ("mp4", "mov"):
        args += ["-movflags", "+faststart"]
    args += [out_path]
    return subprocess.Popen(args, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)


def open_gif_encoder(out_path, ow, oh, fps_str):
    """Encodeur GIF animé depuis des frames rawvideo bgr24 (palette générée à la volée)."""
    vf = "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3"
    args = [ffmpeg_bin(), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", "%dx%d" % (ow, oh), "-r", fps_str, "-i", "pipe:0",
            "-vf", vf, "-loop", "0", "-f", "gif", out_path]
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


def decode_one_frame(input_path, time_sec, w, h, color=None):
    """Décode UNE frame bgr24 à time_sec → bytes (ou None si absente). Taille attendue = w*h*3.
    color = même matrice que le décodeur de run → l'aperçu correspond à la vraie sortie."""
    args = [ffmpeg_bin(), "-nostdin", "-hide_banner", "-loglevel", "error",
            "-ss", str(max(0.0, time_sec)), "-i", input_path, "-frames:v", "1"]
    args += _decode_vf(color)
    args += ["-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:"]
    dec = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout
    if not dec or len(dec) < w * h * 3:
        return None
    return dec[:w * h * 3]
