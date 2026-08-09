"""Mapping codec/audio → arguments d'encodage ffmpeg.

x264/x265 = CPU. Les encodeurs NVIDIA NVENC, Intel QSV et AMD AMF sont résolus et réellement
sondés par le core avant d'arriver ici. ProRes/DNxHR (montage) = profils à paramètres fixes.

Codec inconnu → ValueError explicite (PAS de repli silencieux sur ProRes)."""


class UnknownCodecError(ValueError):
    """Codec demandé absent du mapping : on échoue explicitement au lieu d'encoder un format
    inattendu (l'ancien code retombait en silence sur ProRes HQ)."""


# Codecs montage à paramètres fixes (CPU). H.264/H.265 CPU ou GPU = construits dynamiquement.
# ProRes : profil 0=Proxy 1=LT 2=422 3=HQ 4=4444 5=4444 XQ. DNxHR : profils nommés (HQX/444 = 10-bit).
FIXED_CODECS = {
    "prores_proxy":  ["-c:v", "prores_ks", "-profile:v", "0", "-pix_fmt", "yuv422p10le"],
    "prores_lt":     ["-c:v", "prores_ks", "-profile:v", "1", "-pix_fmt", "yuv422p10le"],
    "prores_422":    ["-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le"],
    "prores_hq":     ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"],
    "prores_4444":   ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"],
    "prores_4444xq": ["-c:v", "prores_ks", "-profile:v", "5", "-pix_fmt", "yuva444p10le"],
    "dnxhr_lb":      ["-c:v", "dnxhd", "-profile:v", "dnxhr_lb",  "-pix_fmt", "yuv422p"],
    "dnxhr_sq":      ["-c:v", "dnxhd", "-profile:v", "dnxhr_sq",  "-pix_fmt", "yuv422p"],
    "dnxhr_hq":      ["-c:v", "dnxhd", "-profile:v", "dnxhr_hq",  "-pix_fmt", "yuv422p"],
    "dnxhr_hqx":     ["-c:v", "dnxhd", "-profile:v", "dnxhr_hqx", "-pix_fmt", "yuv422p10le"],
    "dnxhr_444":     ["-c:v", "dnxhd", "-profile:v", "dnxhr_444", "-pix_fmt", "yuv444p10le"],
}


# Profils d'encodage réels (-profile:v) par codec réglable. Chaque profil impose son pix_fmt
# (sous-échantillonnage chroma + profondeur) → un seul sélecteur "Profil" remplace le toggle 8/10-bit.
# Contraintes matérielles : NVENC H.264 ne gère PAS le 10-bit ; NVENC HEVC 10-bit = p010le (≠ le
# yuv420p10le du CPU x265). Chaque entrée = (nom -profile:v, pix_fmt).
PROFILES = {
    "x264": {
        "baseline": ("baseline", "yuv420p"),
        "main":     ("main",     "yuv420p"),
        "high":     ("high",     "yuv420p"),
        "high10":   ("high10",   "yuv420p10le"),
        "high422":  ("high422",  "yuv422p10le"),
        "high444":  ("high444",  "yuv444p10le"),
    },
    "h264_nvenc": {
        "baseline": ("baseline", "yuv420p"),
        "main":     ("main",     "yuv420p"),
        "high":     ("high",     "yuv420p"),
        "high444":  ("high444p", "yuv444p"),
    },
    "x265": {
        "main":       ("main",       "yuv420p"),
        "main10":     ("main10",     "yuv420p10le"),
        "main12":     ("main12",     "yuv420p12le"),
        "main422-10": ("main422-10", "yuv422p10le"),
        "main422-12": ("main422-12", "yuv422p12le"),
        "main444-8":  ("main444-8",  "yuv444p"),
        "main444-10": ("main444-10", "yuv444p10le"),
        "main444-12": ("main444-12", "yuv444p12le"),
    },
    "hevc_nvenc": {
        "main":       ("main",   "yuv420p"),
        "main10":     ("main10", "p010le"),
        "rext444-8":  ("rext",   "yuv444p"),
        "rext444-10": ("rext",   "yuv444p16le"),
    },
}


def _family(codec):
    if codec == "x264" or codec.startswith("h264_"):
        return "h264"
    if codec == "x265" or codec.startswith("hevc_"):
        return "hevc"
    return None


def _profile_table(codec):
    """Les trois vendeurs partagent les profils 4:2:0 retenus par la sonde du core."""
    if codec in PROFILES:
        return PROFILES[codec]
    family = _family(codec)
    if family == "h264":
        return PROFILES["h264_nvenc"]
    if family == "hevc":
        return PROFILES["hevc_nvenc"]
    return {}


def _profile_for(codec, profile, bitdepth):
    """(-profile:v | None, pix_fmt) pour un codec réglable. Profil explicite prioritaire ; sinon
    repli sur la profondeur (8/10-bit 4:2:0) → compat avec les anciennes requêtes sans profil."""
    table = _profile_table(codec)
    if profile and profile in table:
        return table[profile]
    ten = int(bitdepth) >= 10
    family = _family(codec)
    if codec == "x264":
        return ("high", "yuv420p")           # H.264 NVENC/CPU : pas de 10-bit au repli, high 4:2:0
    if family == "h264":
        return ("high", "yuv420p")
    if codec == "x265":
        return ("main10", "yuv420p10le") if ten else ("main", "yuv420p")
    if family == "hevc":
        return ("main10", "p010le") if ten else ("main", "yuv420p")
    return (None, "yuv420p")


# NVENC (encode GPU) : presets pX (p1 = le plus rapide … p7 = qualité max). On mappe les libellés de
# vitesse x264 (veryfast..veryslow) sur ces paliers → un seul sélecteur "Vitesse" pilote CPU et GPU.
NVENC_PRESET = {
    "ultrafast": "p1", "superfast": "p1", "veryfast": "p2", "faster": "p3",
    "fast": "p4", "medium": "p4", "slow": "p6", "slower": "p7", "veryslow": "p7",
}


def _nvenc_args(codec, quality, preset, bitdepth, profile=None):
    """Encode GPU HAUTE QUALITÉ (le défaut p1/p2 rapide de NVENC dégrade visiblement) :
    VBR piloté qualité (-cq, bas = mieux) + AQ spatiale/temporelle + -tune hq. Bien plus rapide que
    x264/x265 (CPU) pour une qualité visuelle proche au preset pX élevé."""
    p = NVENC_PRESET.get(preset, "p5")
    base = ["-preset", p, "-tune", "hq", "-rc", "vbr", "-cq", str(quality), "-b:v", "0",
            "-spatial-aq", "1", "-temporal-aq", "1"]
    ffp, pix = _profile_for(codec, profile, bitdepth)
    if codec == "h264_nvenc":
        return ["-c:v", "h264_nvenc"] + base + ["-profile:v", ffp, "-pix_fmt", pix]
    # hevc_nvenc : -tag:v hvc1 OBLIGATOIRE pour <video>.
    return (["-c:v", "hevc_nvenc"] + base
            + (["-profile:v", ffp] if ffp else []) + ["-pix_fmt", pix, "-tag:v", "hvc1"])


def _hardware_args(codec, quality, preset, bitdepth, profile=None):
    """Arguments haute qualité propres au vendeur, avec une sémantique de qualité commune."""
    if codec.endswith("_nvenc"):
        return _nvenc_args(codec, quality, preset, bitdepth, profile)
    ffp, pix = _profile_for(codec, profile, bitdepth)
    family = _family(codec)
    if codec.endswith("_qsv"):
        args = ["-c:v", codec, "-preset", preset, "-global_quality", str(quality)]
    elif codec.endswith("_amf"):
        args = ["-c:v", codec, "-usage", "transcoding", "-quality", "quality", "-rc", "cqp",
                "-qp_i", str(quality), "-qp_p", str(quality)]
    else:
        raise UnknownCodecError("encodeur matériel inconnu: %s" % codec)
    if ffp:
        args += ["-profile:v", ffp]
    # QSV/AMF acceptent plus sûrement leurs surfaces natives pour les profils 4:2:0.
    args += ["-pix_fmt", "p010le" if "10" in pix else "nv12"]
    if family == "hevc":
        args += ["-tag:v", "hvc1"]
    return args


def video_codec_args(codec, quality, preset, bitdepth, profile=None):
    if codec == "x264":
        ffp, pix = _profile_for(codec, profile, bitdepth)
        return ["-c:v", "libx264", "-crf", str(quality), "-preset", preset,
                "-profile:v", ffp, "-pix_fmt", pix]
    if codec == "x265":
        ffp, pix = _profile_for(codec, profile, bitdepth)
        return ["-c:v", "libx265", "-crf", str(quality), "-preset", preset,
                "-profile:v", ffp, "-pix_fmt", pix, "-tag:v", "hvc1"]
    if codec.startswith("h264_") or codec.startswith("hevc_"):
        return _hardware_args(codec, quality, preset, bitdepth, profile)
    if codec in FIXED_CODECS:
        return FIXED_CODECS[codec]
    raise UnknownCodecError("codec inconnu: %s" % codec)


def audio_codec_args(mode, abr):
    if mode == "copy":
        return ["-c:a", "copy"]
    if mode == "aac":
        return ["-c:a", "aac", "-b:a", "%dk" % abr]
    if mode == "ac3":
        return ["-c:a", "ac3", "-b:a", "%dk" % abr]
    if mode == "flac":
        return ["-c:a", "flac"]
    if mode == "pcm":
        return ["-c:a", "pcm_s16le"]
    return ["-c:a", "copy"]
