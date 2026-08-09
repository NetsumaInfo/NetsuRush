"""Registre des modèles Real-ESRGAN/CUGAN : backend + arch + poids (local/offline ou auto-DL),
dossier de poids, téléchargement, construction de l'architecture.

Poids lus en local (offline) depuis NETSURUSH_REALESRGAN_DIR ; auto-DL en repli."""
import os
import urllib.request
from nri18n import t

from .log import log


def weights_dir():
    return os.environ.get("NETSURUSH_REALESRGAN_DIR", "") or os.path.join(
        os.path.expanduser("~"), ".netsurush", "realesrgan")


# Hôte de poids communautaire (releases GitHub de NevermindNilas/TAS-Models-Host) : modèles anime
# CUGAN/ShuffleCUGAN en .pth, téléchargeables directement. Tous chargés en RealCUGAN par Spandrel.
TAS = "https://github.com/NevermindNilas/TAS-Models-Host/releases/download/main/"

# Modules d'architecture des modèles communautaires (MIT). Épinglés sur un COMMIT : sur une branche
# mouvante, une refonte amont changerait l'architecture sous des poids déjà installés.
SMOSR_ARCH = "https://raw.githubusercontent.com/umzi2/SMoSR/6bfa011453c7a0ab404e7c00cd65eac6598d84bd/traiNNer/archs/smosr_arch.py"
FIGSR_ARCH = "https://raw.githubusercontent.com/enhancr/figsr/e5097dcd5849dbe5a8e0d1a045045abe97ad6e48/figsr_arch.py"
ANIMESR_ARCH = "https://raw.githubusercontent.com/TencentARC/AnimeSR/80a24bf7a5270907c703158ff6affb3248bf0dc2/animesr/archs/vsr_arch.py"
RTMOSR_ARCH = "https://raw.githubusercontent.com/JepEtau/pynnlib/d6c42c2b529b48c1d903a3471de7a8998515a95f/pynnlib/nn_pytorch/archs/RTMoSR/module/RTMoSR.py"


# Registre des modèles : backend + arch + poids + scale natif + support du denoise (DNI).
# backend défaut = "realesrgan" (archs RRDB/SRVGG via RealESRGANer) ; "spandrel" = loader générique.
MODELS = {
    # ArtCNN R — les deux architectures haute qualité officielles. Les poids sont livrés dans le
    # paquet de shaders NetsuRush ; l'URL reste un repli pour un environnement dev non provisionné.
    "artcnn_r16f96": {
        "file": "ArtCNN_R16F96.onnx", "backend": "artcnn_onnx", "netscale": 2, "dn": False,
        "bundled_shader": True,
        "url": "https://github.com/Artoriuz/ArtCNN/releases/download/v1.6.2/ArtCNN_R16F96.onnx",
    },
    "artcnn_r8f64": {
        "file": "ArtCNN_R8F64.onnx", "backend": "artcnn_onnx", "netscale": 2, "dn": False,
        "bundled_shader": True,
        "url": "https://github.com/Artoriuz/ArtCNN/releases/download/v1.6.2/ArtCNN_R8F64.onnx",
    },
    "anime": {
        "file": "realesr-animevideov3.pth", "arch": "srvgg", "num_conv": 16, "netscale": 4, "dn": False,
        "url": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth",
    },
    "general": {
        "file": "RealESRGAN_x4plus.pth", "arch": "rrdb", "num_block": 23, "netscale": 4, "dn": False,
        "url": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
    },
    "light": {
        "file": "realesr-general-x4v3.pth", "arch": "srvgg", "num_conv": 32, "netscale": 4, "dn": True,
        "url": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth",
        "wdn_file": "realesr-general-wdn-x4v3.pth",
        "wdn_url": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-wdn-x4v3.pth",
    },
    # Anime CUGAN (poids TAS-Models-Host, auto-DL). Chargés en RealCUGAN par Spandrel.
    "fallin": {
        "file": "Fallin_soft.pth", "backend": "spandrel", "netscale": 2, "dn": False,
        "url": TAS + "Fallin_soft.pth",
    },
    "fallin_strong": {
        "file": "Fallin_strong.pth", "backend": "spandrel", "netscale": 2, "dn": False,
        "url": TAS + "Fallin_strong.pth",
    },
    "adore": {
        "file": "adore.pth", "backend": "spandrel", "netscale": 2, "dn": False,
        "url": TAS + "adore.pth",
    },
    "shufflecugan": {
        "file": "sudo_shuffle_cugan_9.584.969.pth", "backend": "spandrel", "netscale": 2, "dn": False,
        "url": TAS + "sudo_shuffle_cugan_9.584.969.pth",
    },
    # Real-CUGAN officiel (Bilibili) — débruitage intégré (variante denoise3x), Apache 2.0.
    "cugan": {
        "file": "up2x-latest-denoise3x.pth", "backend": "spandrel", "netscale": 2, "dn": False,
        "url": "https://huggingface.co/spaces/mayhug/Real-CUGAN/resolve/main/weights/up2x-latest-denoise3x.pth",
    },
    # LD-Anime Compact — anti-artefacts sources abîmées (DVD : bruit, compression, rainbows, halos).
    "ld_anime": {
        "file": "2x-LD-Anime-Compact.pth", "backend": "spandrel", "netscale": 2, "dn": False,
        "url": "https://objectstorage.us-phoenix-1.oraclecloud.com/n/ax6ygfvpvzka/b/open-modeldb-files/o/2x-LD-Anime-Compact.pth",
    },
    # Modèles anime du catalogue TheAnimeScripter. Le gestionnaire app-wide les place dans ce
    # même dossier ; Spandrel détecte l'architecture depuis le checkpoint.
    "aniscale2": {
        "file": "2x_AniScale2S_Compact_i8_60K.pth", "backend": "spandrel", "netscale": 2, "dn": False,
        "url": TAS + "2x_AniScale2S_Compact_i8_60K.pth",
    },
    "open-proteus": {
        "file": "2x_OpenProteus_Compact_i2_70K.pth", "backend": "spandrel", "netscale": 2, "dn": False,
        "url": TAS + "2x_OpenProteus_Compact_i2_70K.pth",
    },
    "span": {
        "file": "2x_ModernSpanimationV2.pth", "backend": "spandrel", "netscale": 2, "dn": False,
        "url": TAS + "2x_ModernSpanimationV2.pth",
    },
    # Architectures communautaires hors registre Spandrel (cf. upscaler/community.py) : le module
    # .py voyage avec les poids, comme pour NTIRE. Dépôts épinglés sur un commit.
    "smosr": {
        "file": "2x_enhancr_da_smosr_v1.safetensors", "backend": "community", "netscale": 2, "dn": False,
        "url": TAS + "2x_enhancr_da_smosr_v1.safetensors",
        "code_file": "smosr_arch.py", "code_url": SMOSR_ARCH,
    },
    "figsr": {
        "file": "2x_enhancr_da_figsr.pth", "backend": "community", "netscale": 2, "dn": False,
        "url": TAS + "2x_enhancr_da_figsr.pth",
        "code_file": "figsr_arch.py", "code_url": FIGSR_ARCH,
    },
    "saryn": {
        "file": "Saryn-V1-Lite.pth", "backend": "community", "netscale": 2, "dn": False,
        "url": TAS + "Saryn-V1-Lite.pth",
        "code_file": "RTMoSR.py", "code_url": RTMOSR_ARCH,
    },
    # sudo Shuffle SPAN — ONNX exporté à dimensions FIGÉES (1080p) : le pipeline découpe l'image en
    # fenêtres de cette taille exacte (cf. FixedOnnxUpsampler).
    "shufflespan": {
        "file": "sudo_shuffle_span_op20_10.5m_1080p_fp16_op21_slim.onnx",
        "backend": "onnx_fixed", "netscale": 2, "dn": False,
        "url": TAS + "sudo_shuffle_span_op20_10.5m_1080p_fp16_op21_slim.onnx",
    },
    # AnimeSR — sur-résolution VIDÉO récurrente (état caché propagé) : moteur dédié, pas le socle
    # image par image. Architecture MSRSWVSR de TencentARC (Apache-2.0).
    "animesr": {
        "file": "AnimeSR_v2.pth", "backend": "animesr", "netscale": 4, "dn": False,
        "url": TAS + "AnimeSR_v2.pth",
        "code_file": "vsr_arch.py", "code_url": ANIMESR_ARCH,
    },
    # RTMoSR — publié en TorchScript : le graphe voyage avec les poids, donc pas de code d'arch à
    # embarquer (Spandrel ne reconnaît pas cette architecture, elle n'est pas dans son registre).
    "rtmosr": {
        "file": "2x_umzi_anime_rtmosr.pth", "backend": "torchscript", "netscale": 2, "dn": False,
        "url": TAS + "2x_umzi_anime_rtmosr.pth",
    },
    # Restauration 1× TheAnimeScripter. Même contrat image→image que Spandrel ; la sortie conserve
    # strictement les dimensions de la source et peut donc traverser le pipeline vidéo existant.
    "tas-scunet": {
        "file": "scunet_color_real_psnr.pth", "backend": "spandrel", "netscale": 1, "dn": False,
        "url": TAS + "scunet_color_real_psnr.pth",
    },
    "tas-nafnet": {
        "file": "NAFNet-GoPro-width64.pth", "backend": "spandrel", "netscale": 1, "dn": False,
        "url": TAS + "NAFNet-GoPro-width64.pth",
    },
    "tas-dpir": {
        "file": "drunet_deblocking_color.pth", "backend": "spandrel", "netscale": 1, "dn": False,
        "url": TAS + "drunet_deblocking_color.pth",
    },
    "tas-real-plksr": {
        "file": "1xDeJPG_realplksr_otf.pth", "backend": "spandrel", "netscale": 1, "dn": False,
        "url": TAS + "1xDeJPG_realplksr_otf.pth",
    },
    "tas-anime1080fixer": {
        "file": "1x_Anime1080Fixer_SuperUltraCompact.pth", "backend": "spandrel", "netscale": 1, "dn": False,
        "url": TAS + "1x_Anime1080Fixer_SuperUltraCompact.pth",
    },
    "tas-deh264-real": {
        "file": "1xDeH264_realplksr.pth", "backend": "spandrel", "netscale": 1, "dn": False,
        "url": TAS + "1xDeH264_realplksr.pth",
    },
    "tas-deh264-span": {
        "file": "1x_DeH264_SPAN.safetensors", "backend": "spandrel", "netscale": 1, "dn": False,
        "url": TAS + "1x_DeH264_SPAN.safetensors",
    },
    "tas-hurrdeblur": {
        "file": "1x_HurrDeblur_SuperUltraCompact.pth", "backend": "spandrel", "netscale": 1, "dn": False,
        "url": TAS + "1x_HurrDeblur_SuperUltraCompact.pth",
    },
    "tas-dehalo": {
        "file": "1x_DeHalo_v1_Compact.pth", "backend": "spandrel", "netscale": 1, "dn": False,
        "url": TAS + "1x_DeHalo_v1_Compact.pth",
    },
}

# Modèles du challenge NTIRE 2026 Efficient Super-Resolution (MIT) : tous en ×4 photographique, tous
# minuscules (< 5 Mo). L'architecture vit dans le code du dépôt, pas dans le checkpoint → backend
# dédié (cf. upscaler/ntire.py) plutôt que Spandrel.
NTIRE_REPO = "https://raw.githubusercontent.com/Amazingren/NTIRE2026_ESR/main"
# id → nom de l'équipe dans le dépôt : le poids est `model_zoo/<team>.pth`, l'architecture
# `models/<team>.py`. Le fichier d'architecture du team22 (`SPANV2_ESR`) ne suit pas cette règle et
# n'est de toute façon pas intégrable (opérateur CUDA à compiler).
NTIRE_TEAMS = {
    "ntire-span": "team00_SPAN",
    "ntire-pds": "team01_PDS",
    "ntire-zenosr": "team04_ZenoSR",
    "ntire-haesr": "team06_HAESR",
    "ntire-rfdn-span": "team09_RFDN_SPAN",
    "ntire-hfenet": "team10_HFENet",
    "ntire-vscinet": "team11_VSCINet",
    "ntire-dscf": "team15_DSCF_Fused",
    "ntire-pkdsr": "team16_PKDSR",
    "ntire-amcanet": "team17_AMCANet",
    "ntire-disp": "team18_DISP",
    "ntire-bviesr": "team19_BVIESR",
    "ntire-errn2": "team20_ERRN2",
    "ntire-safmn": "team21_SAFMN_Deep15",
}
for _id, _team in NTIRE_TEAMS.items():
    MODELS[_id] = {
        "file": "%s.pth" % _team, "url": "%s/model_zoo/%s.pth" % (NTIRE_REPO, _team),
        "code_file": "%s.py" % _team, "code_url": "%s/models/%s.py" % (NTIRE_REPO, _team),
        "backend": "ntire", "netscale": 4, "dn": False,
    }


def build_model(spec):
    if spec["arch"] == "rrdb":
        from basicsr.archs.rrdbnet_arch import RRDBNet
        return RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64,
                       num_block=spec["num_block"], num_grow_ch=32, scale=spec["netscale"])
    from realesrgan.archs.srvgg_arch import SRVGGNetCompact
    return SRVGGNetCompact(num_in_ch=3, num_out_ch=3, num_feat=64,
                           num_conv=spec["num_conv"], upscale=spec["netscale"], act_type="prelu")


# Une entrée peut porter plusieurs fichiers : les poids (`file`), leur variante débruitée pour le DNI
# (`wdn_file`), ou le module d'architecture d'un modèle NTIRE (`code_file`). Chaque URL sait donc quel
# nom de fichier elle alimente.
URL_TO_FILE = {"url": "file", "wdn_url": "wdn_file", "code_url": "code_file"}


def ensure_weight(spec, kind="url"):
    bundled = bool(spec.get("bundled_shader"))
    wdir = os.environ.get("NETSURUSH_SHADER_DIR", "") if bundled else weights_dir()
    if not wdir:
        wdir = weights_dir()
    os.makedirs(wdir, exist_ok=True)
    file_key = URL_TO_FILE.get(kind, "file")
    url_key = kind
    filename = spec.get(file_key)
    target = os.path.join(wdir, filename or "")
    if filename and os.path.exists(target):
        return target
    url = spec.get(url_key)
    if not url:
        page = spec.get("manual_url")
        raise FileNotFoundError(t("weight_missing", file=target, url=page or "OpenModelDB", folder=wdir))

    tmp = target + ".tmp"
    log("STAGE:download")
    log("Téléchargement modèle : %s" % filename)
    try:
        with urllib.request.urlopen(url, timeout=120) as res, open(tmp, "wb") as f:
            while True:
                chunk = res.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
        os.replace(tmp, target)
    except Exception as exc:  # noqa: BLE001
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(t("model_download_failed", file=filename, error=exc)) from exc
    return target
