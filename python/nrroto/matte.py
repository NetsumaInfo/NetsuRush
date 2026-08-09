"""Matte fin : affine l'alpha d'un masque de segmentation avec un modèle vidéo à mémoire
(MatAnyone v1/v2). Une image entre, un PNG GRIS sort — jamais de vidéo, jamais de séquence
accumulée en mémoire.

Pourquoi ne pas appeler `process_video()` du paquet amont : ce helper est une DÉMO. Il empile
toutes les images en RAM (~8 Go sur 1000 images 1080p) puis encode l'alpha en mp4 h264 8 bits,
ce qui détruit exactement le détail de bord que le modèle vient de calculer. On pilote donc
`InferenceCore.step()` nous-même (réimplémentation propre : aucun code GPL ne doit entrer ici).

Le modèle se ré-amorce sur chaque GRAINE (une image que l'utilisateur a annotée, donc dont le
masque est validé) : `step(image, masque)` puis N passes `first_frame_pred=True`. Ce drapeau
n'est pas décoratif — il remet `curr_ti` à zéro et purge la mémoire de travail À L'INTÉRIEUR de
`step` (`clear_temp_mem`). C'est LA remise à zéro entre segments ; aucune purge externe n'est
nécessaire, et en ajouter une viderait aussi la mémoire sensorielle, que l'amont conserve
volontairement d'un segment à l'autre.
"""
import os

# Passes de stabilisation sur la graine. La première prédiction d'un segment est instable (le
# masque de segmentation a des bords durs que le modèle doit d'abord « détendre ») ; 10 est la
# valeur de l'amont.
WARMUP = 10
# Plafond du petit côté de l'image envoyée au modèle. 0 = pleine résolution. Le mécanisme est
# NATIF (`InferenceCore.max_internal_size`) : `step` réduit, complète au multiple de 16, puis
# remet la sortie à la taille d'entrée. Redimensionner nous-même doublerait le rééchantillonnage.
DEFAULT_MAX_SIZE = 0


def plan_segments(seeds, lo, hi):
    """Découpe [lo, hi] en segments `(graine, [images dans l'ordre de traitement])`.

    Une passe ARRIÈRE part de la première graine vers `lo` (le modèle ne sait propager que dans
    le sens où on le nourrit), puis une passe AVANT par graine, bornée à la graine suivante.

    La première graine est la SEULE image traitée deux fois quand une passe arrière existe :
    chaque direction doit ré-établir sa propre mémoire depuis le masque validé. Le reste de
    l'intervalle est couvert exactement une fois."""
    picked = sorted({int(s) for s in seeds if lo <= int(s) <= hi})
    if not picked:
        return []
    out = []
    first = picked[0]
    if first > lo:
        out.append((first, list(range(first, lo - 1, -1))))
    for i, seed in enumerate(picked):
        end = (picked[i + 1] - 1) if i + 1 < len(picked) else hi
        if end >= seed:
            out.append((seed, list(range(seed, end + 1))))
    return out


def frame_total(plan):
    """Nombre d'images que `plan` va réellement faire passer dans le modèle."""
    return sum(len(frames) for _, frames in plan)


def load_engine(engine_id, model_dir=None):
    """Construit le processeur d'inférence du moteur demandé.

    Les deux générations n'ont pas le même constructeur (v2 charge un `MatAnyone2` puis l'injecte,
    v1 accepte directement un chemin), mais elles exposent la même méthode `step`. Un moteur qui
    ne l'expose pas est refusé par son nom plutôt que de planter plus loin sur un attribut absent."""
    import torch

    from nrdevice import empty_torch_cache, torch_backend, torch_device
    from nri18n import t

    if str(engine_id) == "matanyone2":
        from matanyone2 import InferenceCore, MatAnyone2
        src = model_dir or os.environ.get("NETSURUSH_MATANYONE2_DIR", "") or "PeiqingYang/MatAnyone2"
        backend = torch_backend(torch)
        try:
            proc = InferenceCore(MatAnyone2.from_pretrained(src), device=torch_device(torch, backend))
        except Exception:  # noqa: BLE001 — manque de VRAM : le processeur tient sur le CPU
            if backend == "cpu":
                raise
            empty_torch_cache(torch, backend)
            proc = InferenceCore(MatAnyone2.from_pretrained(src), device="cpu")
    else:
        from matanyone import InferenceCore
        src = model_dir or os.environ.get("NETSURUSH_MATANYONE_DIR", "") or "PeiqingYang/MatAnyone"
        proc = InferenceCore(src)

    if not hasattr(proc, "step"):
        raise RuntimeError(t("engine_no_step", engine=str(engine_id)))
    return proc


def _device_of(proc):
    return getattr(proc, "device", None) or "cpu"


def _image_tensor(torch, path, device):
    """Image disque → tenseur 3×H×W en [0,1] (l'IMAGE est normalisée, pas le masque)."""
    import numpy as np
    from PIL import Image

    arr = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr).permute(2, 0, 1).to(device)


def _mask_tensor(torch, path, device):
    """Masque disque → tenseur H×W en 0..255.

    L'amont NE normalise PAS le masque (contrairement à l'image) : son propre `process_video`
    passe le uint8 tel quel en float. Le diviser par 255 change le régime d'amorçage."""
    import numpy as np
    from PIL import Image

    arr = np.asarray(Image.open(path).convert("L"), dtype=np.float32)
    return torch.from_numpy(arr).to(device)


def _write_alpha(prob, proc, out_path, size):
    """Probabilités du modèle → PNG gris à la taille voulue.

    `+0.5` = ARRONDI : tronquer biaiserait tout l'alpha d'un demi-niveau vers le bas, donc
    grignoterait le bord sur toute la séquence."""
    import numpy as np
    from PIL import Image

    alpha = proc.output_prob_to_mask(prob).detach().float().cpu().numpy()
    u8 = np.clip(alpha * 255.0 + 0.5, 0.0, 255.0).astype(np.uint8)
    img = Image.fromarray(u8, "L")
    if img.size != size:
        img = img.resize(size, Image.BILINEAR)
    img.save(out_path)


def run(proc, plan, frame_path, seed_mask, out_dir, warmup=WARMUP, max_size=DEFAULT_MAX_SIZE,
        on_frame=None, cancelled=None):
    """Déroule `plan` (cf. plan_segments) et écrit `out_dir/%05d.png` en niveaux de gris.

    `frame_path(f)` → chemin de l'image, `seed_mask(graine)` → chemin du masque d'amorçage.
    `on_frame(done, total, frame)` est appelé après CHAQUE image (progression au fil de l'eau,
    pas par segment) et `cancelled()` est testé avant chacune — un affinage dure des minutes,
    l'abandonner ne doit pas demander de tuer le service."""
    import torch
    from PIL import Image

    from nrdevice import empty_torch_cache, torch_backend

    os.makedirs(out_dir, exist_ok=True)
    device = _device_of(proc)
    proc.max_internal_size = int(max_size or 0)
    steady = max(0, int(warmup))
    total = frame_total(plan)
    done = 0

    with torch.inference_mode():
        for seed, frames in plan:
            mask_path = seed_mask(seed)
            if not mask_path or not os.path.isfile(mask_path):
                continue
            mask = _mask_tensor(torch, mask_path, device)
            for frame in frames:
                if cancelled is not None and cancelled():
                    raise StopIteration
                path = frame_path(frame)
                if not os.path.isfile(path):
                    continue
                size = Image.open(path).size
                image = _image_tensor(torch, path, device)
                if frame == seed:
                    prob = proc.step(image, mask, objects=[1])
                    for _ in range(steady):
                        prob = proc.step(image, first_frame_pred=True)
                else:
                    prob = proc.step(image)
                _write_alpha(prob, proc, os.path.join(out_dir, "%05d.png" % frame), size)
                done += 1
                if on_frame is not None:
                    on_frame(done, total, frame)
    empty_torch_cache(torch, torch_backend(torch))
    return done


def merge_union(scope_dirs, out_dir):
    """Union DOUCE des alphas par objet : maximum par pixel, jamais un OU binaire.

    Un OU exigerait de seuiller, donc rendrait le dégradé que tout ce module sert à produire."""
    import numpy as np
    from PIL import Image

    os.makedirs(out_dir, exist_ok=True)
    names = set()
    for d in scope_dirs:
        if os.path.isdir(d):
            names.update(n for n in os.listdir(d) if n.endswith(".png"))
    for name in sorted(names):
        acc = None
        for d in scope_dirs:
            path = os.path.join(d, name)
            if not os.path.isfile(path):
                continue
            arr = np.asarray(Image.open(path).convert("L"))
            acc = arr if acc is None else np.maximum(acc, arr)
        if acc is not None:
            Image.fromarray(acc, "L").save(os.path.join(out_dir, name))
    return out_dir
