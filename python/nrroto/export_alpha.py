"""Export Roto piloté par les mattes propagées (union/%05d.png) : vidéo alpha (ProRes 4444 /
WebM VP9), matte N&B (MP4), ou séquence PNG des mattes. ffmpeg = binaire fourni par le core.

`union_dir` peut être la version post-traitée (mattes_post) — l'appelant choisit. Les mattes
peuvent démarrer à un index > 0 (suivi borné in/out) : -start_number cale ffmpeg, la source est
décalée d'autant (`in_s` + start/fps)."""
import os
import shutil
import subprocess

FFMPEG = os.environ.get("NETSURUSH_FFMPEG", "ffmpeg")

# format -> (suffixe, args encodeur). ffv1 = lossless archivage (mkv, alpha bgra).
FORMATS = {
    "prores_4444": (".mov", ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"]),
    "webm_alpha": (".webm", ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "24"]),
    "ffv1_alpha": (".mkv", ["-c:v", "ffv1", "-level", "3", "-pix_fmt", "bgra"]),
    "matte_mp4": (".mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16"]),
    "bgcolor_mp4": (".mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16"]),
}


def _run(args):
    p = subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error"] + args,
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or "ffmpeg a échoué").strip()[-400:])


def export(video, union_dir, fmt, out, fps, in_s=None, bg=None):
    """`video` = source ; mattes = <union_dir>/%05d.png à `fps` (union OU un obj-N — l'appelant
    choisit la portée). Alpha : la matte est recalée sur la résolution source (scale2ref) puis
    fusionnée (alphamerge). bgcolor_mp4 : composite opaque sur couleur unie `bg` (hex)."""
    if not os.path.isdir(union_dir) or not os.listdir(union_dir):
        raise RuntimeError("aucune matte propagée — lance le suivi d'abord")
    names = sorted(n for n in os.listdir(union_dir) if n.endswith(".png"))
    start = int(os.path.splitext(names[0])[0])
    pattern = os.path.join(union_dir, "%05d.png")

    if fmt == "png_seq":
        os.makedirs(out, exist_ok=True)
        for f in names:
            shutil.copy2(os.path.join(union_dir, f), os.path.join(out, f))
        return out

    suffix, codec = FORMATS.get(fmt, FORMATS["prores_4444"])
    if not out.lower().endswith(suffix):
        out += suffix

    seq_in = ["-framerate", str(fps or 24), "-start_number", str(start), "-i", pattern]
    if fmt == "matte_mp4":
        _run(seq_in + codec + [out])
        return out

    # RGB source (bornée in/out si plan + décalage si suivi partiel) + matte.
    offset = (in_s or 0) + (start / float(fps or 24))
    src_in = ["-i", video] if offset <= 0 else ["-ss", str(offset), "-i", video]

    if fmt == "bgcolor_mp4":
        # Frame découpée par la matte, composée sur une couleur unie (calée sur la source).
        color = "0x%s" % (bg or "00ff00").lstrip("#")
        _run(src_in + seq_in + ["-f", "lavfi", "-i", "color=c=%s" % color] +
             ["-filter_complex",
              "[1:v][0:v]scale2ref[m][v];[2:v][0:v]scale2ref[c][v2];"
              "[v2][m]alphamerge[fg];[c][fg]overlay=shortest=1[outv]",
              "-map", "[outv]", "-shortest"] + codec + [out])
        return out

    _run(src_in + seq_in +
         ["-filter_complex", "[1:v][0:v]scale2ref[m][v];[v][m]alphamerge[outv]",
          "-map", "[outv]", "-shortest"] + codec + [out])
    return out
