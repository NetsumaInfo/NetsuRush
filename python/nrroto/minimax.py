"""Orchestration MiniMax-Remover (suppression d'objet par diffusion vidéo, pilotée par masque).

Le CODE du pipeline (pipeline_minimax_remover.py + transformer_minimax_remover.py) n'existe PAS en
package pip : il vit dans le dépôt zibojia/MiniMax-Remover (CC-BY-NC). On le charge depuis
`nrroto/vendor/` — dépose-y les deux fichiers du dépôt (une fois). Sans eux, erreur explicite.

Chaîne de qualité (l'ordre compte) :
1. ROI globale — la diffusion ne voit que la bbox union des mattes (+ marge), résultat recollé
   plein cadre. Gain massif sur un petit objet.
2. PLAQUE PROPRE — le fond caché est d'abord cherché dans les images voisines (cleanplate) : ces
   pixels-là sont VRAIS, donc exacts en couleur comme en grain. Le modèle ne reçoit plus que le
   RÉSIDU, ce qui n'a jamais été filmé.
3. Diffusion sur le résidu seul, avec un masque DUR (le pipeline amont binarise à `>0` : lui
   donner un masque adouci ferait effacer toute la queue du dégradé) et une dilatation interne
   ramenée à 1 — c'est NOUS qui dilatons, en pleine résolution, d'après la marge demandée.
4. RACCORD — couleur, netteté et grain de la zone reconstruite alignés sur sa couronne
   (harmonize) : l'aller-retour VAE dérive en basse fréquence, sans cette étape la retouche se
   voit même quand le contenu est juste.
5. Composite dans le seul masque adouci ; tout le reste = frames originales intactes.

Poids (vae/transformer/scheduler) = téléchargés par le gestionnaire de modèles → NETSURUSH_MINIMAX_DIR.
Entrée = frames extraites + mattes union propagées. Sortie = MP4 nettoyé."""
import os
import sys

from nrdevice import empty_torch_cache, torch_backend, torch_device
from nri18n import t

_VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
if _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)

# Le pipeline traite des fenêtres de N frames (modèle Wan). 81 = valeur du README amont.
WINDOW = 81
# Images communes à deux fenêtres consécutives. Sans recouvrement les fenêtres sont diffusées
# indépendamment, donc chacune avec son propre bruit : la jonction se voit comme un saut, une fois
# toutes les WINDOW images. Le recouvrement est fondu linéairement, ce qui l'efface.
OVERLAP = 8
SNAP = 16                      # Wan exige des dimensions multiples de 16
# Paliers de résolution de diffusion. Plus haut = remplissage plus net (la zone effacée est aussi
# trahie par sa mollesse), mais la VRAM grimpe avec le carré de la dimension.
QUALITY_STEPS = (352, 512, 704, 960, 1080)
DEFAULT_QUALITY = 704
# Graine du bruit. Sans générateur explicite, deux lancements identiques donnent deux résultats
# différents : impossible de rejouer un remplissage réussi, impossible d'en retenter un raté sans
# toucher à tout le reste. Une graine fixe par défaut rend l'opération reproductible.
DEFAULT_SEED = 42
# Dilatation interne du pipeline amont. Son défaut (16) s'applique à l'échelle du MODÈLE, donc sa
# portée réelle dépend du facteur de réduction — la zone effacée n'avait plus rien à voir avec la
# marge demandée. On la neutralise et on dilate nous-même en pleine résolution.
# À ne JAMAIS mettre à 0 : scipy.binary_dilation(iterations<1) dilate jusqu'à saturation.
MODEL_DILATE = 1


def _log(message):
    """Journal développeur relayé par logbus vers Paramètres › Système › Console."""
    print("minimax: %s" % message, file=sys.stderr, flush=True)


def _require_vendor():
    try:
        from pipeline_minimax_remover import Minimax_Remover_Pipeline  # type: ignore  # noqa: F401
        from transformer_minimax_remover import Transformer3DModel  # type: ignore  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            "code MiniMax absent : dépose pipeline_minimax_remover.py et transformer_minimax_remover.py "
            "(dépôt zibojia/MiniMax-Remover) dans python/nrroto/vendor/ — %s" % exc)


def _load_pipe(weights_dir):
    import torch
    from diffusers.models import AutoencoderKLWan
    from diffusers.schedulers import UniPCMultistepScheduler
    from pipeline_minimax_remover import Minimax_Remover_Pipeline
    from transformer_minimax_remover import Transformer3DModel
    backend = torch_backend(torch)
    # Le pipeline vendoré contient des kernels CUDA ; ROCm conserve cette API. XPU retombe CPU tant
    # que l'amont ne publie pas de chemin Intel vérifié.
    active = backend if backend in ("cuda", "rocm") else "cpu"
    dtype = torch.float16 if active != "cpu" else torch.float32
    vae = AutoencoderKLWan.from_pretrained(os.path.join(weights_dir, "vae"), torch_dtype=dtype)
    transformer = Transformer3DModel.from_pretrained(os.path.join(weights_dir, "transformer"), torch_dtype=dtype)
    scheduler = UniPCMultistepScheduler.from_pretrained(os.path.join(weights_dir, "scheduler"))
    dev = torch_device(torch, active)
    try:
        return Minimax_Remover_Pipeline(vae=vae, transformer=transformer, scheduler=scheduler).to(dev), active
    except Exception:  # noqa: BLE001
        if active == "cpu":
            raise
        del vae, transformer
        empty_torch_cache(torch, active)
        # Recharge en fp32 : convertir un pipeline fp16 en CPU laisse certains opérateurs invalides.
        vae = AutoencoderKLWan.from_pretrained(os.path.join(weights_dir, "vae"), torch_dtype=torch.float32)
        transformer = Transformer3DModel.from_pretrained(os.path.join(weights_dir, "transformer"), torch_dtype=torch.float32)
        return Minimax_Remover_Pipeline(vae=vae, transformer=transformer, scheduler=scheduler).to("cpu"), "cpu"


def _idx_of(name):
    """Index ABSOLU d'une frame d'après son nom (%05d.jpg) — robuste au découpage start/count."""
    try:
        return int(os.path.splitext(name)[0])
    except ValueError:
        return 0


def quality_ladder(quality):
    """Paliers de résolution à tenter, du demandé au plus économe.

    Une carte modeste peut manquer de VRAM sur une grande ROI. Plutôt que d'échouer, on redescend
    d'un cran : un remplissage un peu plus doux vaut mieux qu'une suppression qui ne sort pas."""
    try:
        wanted = int(quality or DEFAULT_QUALITY)
    except (TypeError, ValueError):
        wanted = DEFAULT_QUALITY
    steps = sorted(set(QUALITY_STEPS) | {wanted}, reverse=True)
    return [s for s in steps if s <= wanted] or [min(QUALITY_STEPS)]


def _is_out_of_memory(exc):
    return type(exc).__name__ == "OutOfMemoryError" or "out of memory" in str(exc).lower()


def model_size(roi_size, maxdim):
    """(taille utile, taille d'entrée du modèle) pour une ROI donnée, en (largeur, hauteur).

    Deux contraintes : Wan exige des multiples de 16, la VRAM impose un plafond. Quand la ROI tient
    déjà sous le plafond on ne la REDIMENSIONNE PAS — on la complète jusqu'au multiple de 16 et on
    recadre au retour. L'aller-retour de rééchantillonnage coûtait de la netteté sur la seule zone
    qu'on cherche justement à rendre indiscernable."""
    w, h = roi_size
    scale = min(1.0, float(maxdim) / float(max(w, h)))
    used = (max(SNAP, int(round(w * scale))), max(SNAP, int(round(h * scale))))
    return used, (used[0] + (-used[0]) % SNAP, used[1] + (-used[1]) % SNAP)


def _to_model_space(images, masks, used, padded):
    """Images en [-1,1] « f h w c » et masques BINAIRES en [0,1] « f h w 1 », taille `padded`."""
    import numpy as np
    from PIL import Image

    pad_w, pad_h = padded[0] - used[0], padded[1] - used[1]
    img = np.stack([np.asarray(im if im.size == used else im.resize(used, Image.LANCZOS),
                               dtype=np.float32) for im in images])
    msk = np.stack([np.asarray(mk if mk.size == used else mk.resize(used, Image.NEAREST),
                               dtype=np.float32) for mk in masks])
    if pad_w or pad_h:
        img = np.pad(img, ((0, 0), (0, pad_h), (0, pad_w), (0, 0)), mode="reflect")
        # Le masque est complété à ZÉRO : le refléter creuserait un trou fantôme dans la marge.
        msk = np.pad(msk, ((0, 0), (0, pad_h), (0, pad_w)), mode="constant")
    return img / 127.5 - 1.0, (msk > 127.0).astype(np.float32)[..., None]


def _from_model_space(frames, used, roi_size):
    """Sortie du pipeline (float [0,1] ou uint8) → images PIL recadrées et remises à la taille ROI."""
    import numpy as np
    from PIL import Image

    out = []
    for frame in frames:
        arr = np.asarray(frame)
        if arr.dtype != np.uint8:
            # +0.5 = ARRONDI. Tronquer biaiserait toute la zone générée d'un demi-niveau vers le
            # bas — donc la rendrait très légèrement plus sombre que son voisinage intact.
            arr = (np.clip(arr, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        patch = Image.fromarray(arr[:used[1], :used[0]]).convert("RGB")
        out.append(patch if patch.size == roi_size else patch.resize(roi_size, Image.LANCZOS))
    return out


def window_plan(total, window, overlap):
    """Découpe [0, total) en fenêtres qui se RECOUVRENT de `overlap` images.

    Rend `(début, longueur, nb d'images fondues avec la fenêtre précédente)`. Le recouvrement est
    borné à la moitié de la fenêtre : au-delà, l'avance par pas devient nulle et le découpage ne
    progresse plus."""
    win = max(1, int(window or WINDOW))
    lap = max(0, min(int(overlap or 0), win // 2))
    plan, base = [], 0
    while base < total:
        length = min(win, total - base)
        plan.append((base, length, lap if base else 0))
        if base + length >= total:
            break
        base += max(1, length - lap)
    return plan


def blend_weights(count):
    """Poids de fondu croissants sur `count` images (0 exclu, 1 exclu) — somme complémentaire à 1
    avec la fenêtre précédente, donc aucune image n'est ni doublée ni perdue."""
    return [(k + 1) / float(count + 1) for k in range(count)]


def _diffuse(pipe, images, masks, steps, ladder, generator=None):
    """Diffuse une fenêtre, en redescendant d'un palier de résolution à chaque manque de VRAM."""
    import torch

    roi_size = images[0].size
    for rank, maxdim in enumerate(ladder):
        used, padded = model_size(roi_size, maxdim)
        img_np, msk_np = _to_model_space(images, masks, used, padded)
        try:
            result = pipe(images=torch.from_numpy(img_np), masks=torch.from_numpy(msk_np),
                          num_frames=len(images), height=padded[1], width=padded[0],
                          num_inference_steps=int(steps), iterations=MODEL_DILATE,
                          generator=generator).frames[0]
        except Exception as exc:  # noqa: BLE001 — seul le manque de VRAM est rattrapable
            if not _is_out_of_memory(exc) or rank + 1 >= len(ladder):
                raise
            _log("mémoire insuffisante à %d px, repli sur %d px" % (maxdim, ladder[rank + 1]))
            empty_torch_cache(torch, torch_backend(torch))
            continue
        return _from_model_space(result, used, roi_size)
    raise RuntimeError(t("engine_failed", engine="MiniMax-Remover", error="out of memory"))


class _Sequence:
    """Invariants d'un run : chemins, masques, ROI, plaque propre. Évite de faire transiter dix
    arguments identiques à travers chaque étape de la boucle."""

    def __init__(self, frames_dir, union, names, rect, grow, use_plate):
        from nrroto import postproc
        from nrroto.cleanplate import CleanPlate

        self.frames_dir, self.union, self.names, self.rect = frames_dir, union, names, rect
        # Masque DUR pour le modèle (il attend un trou binaire), masque ADOUCI pour le composite
        # (raccord invisible). Dilater couvre les bords et l'ombre portée de l'objet effacé.
        self.hard_post = {"grow": int(grow), "feather": 0, "holes": 0, "dots": 0}
        self.soft_post = {"grow": int(grow), "feather": max(2, int(grow) // 2), "holes": 0, "dots": 0}
        self.feather = self.soft_post["feather"]
        self.postproc = postproc
        self.plate = CleanPlate(frames_dir, names, self.hard_mask, crop=rect) if use_plate else None

    def raw_mask(self, index, size):
        """Matte union propagée de la frame `index`, à la taille demandée (noir si absente)."""
        from PIL import Image
        path = os.path.join(self.union, "%05d.png" % index)
        if not os.path.isfile(path):
            return Image.new("L", size, 0)
        return Image.open(path).convert("L").resize(size)

    def hard_mask(self, name, size):
        """Masque dur plein cadre d'une frame nommée — contrat attendu par CleanPlate."""
        import numpy as np
        base = np.asarray(self.raw_mask(_idx_of(name), size)) > 127
        return self.postproc.apply_post(base, self.hard_post) > 127

    def alpha_of(self, mask):
        """Alpha 0..1 adouci d'un masque booléen : bord de correction et de grain sans marche."""
        import numpy as np
        if not mask.any():
            return None
        soft = self.postproc.apply_post(mask, {"grow": 0, "feather": self.feather})
        return soft.astype(np.float32) / 255.0


def _load_window(seq, chunk):
    """(originaux PIL, alphas de composite PIL, sources ROI np, trous durs ROI bool)."""
    import numpy as np
    from PIL import Image
    from nrroto import roi as roi_mod

    originals = [Image.open(os.path.join(seq.frames_dir, n)).convert("RGB") for n in chunk]
    size = originals[0].size
    bases = [np.asarray(seq.raw_mask(_idx_of(n), size)) > 127 for n in chunk]
    soft = [Image.fromarray(seq.postproc.apply_post(b, seq.soft_post), "L") for b in bases]
    hard = [seq.postproc.apply_post(b, seq.hard_post) > 127 for b in bases]
    sources = [np.asarray(roi_mod.crop_image(im, seq.rect), dtype=np.uint8) for im in originals]
    return originals, soft, sources, [roi_mod.crop_array(m, seq.rect) for m in hard]


def _plate_window(seq, first_index, sources, holes):
    """(plaques ROI np, résidus ROI bool) : ce que le fond réel a comblé, et ce qu'il reste à inventer."""
    plates, residuals = [], []
    for k, (source, hole) in enumerate(zip(sources, holes)):
        if seq.plate is None or seq.plate.off:
            plates.append(source)
            residuals.append(hole)
            continue
        plate, filled, _ = seq.plate.for_frame(first_index + k, source, hole)
        plates.append(plate)
        residuals.append(hole & ~filled)
    return plates, residuals


def run_minimax_remover(frames_dir, mattes_root, weights_dir, out_path, fps, progress=None,
                        steps=12, grow=8, start=None, count=None, preview_index=None,
                        plate=True, harmonize=0.85, grain=1.0, quality=DEFAULT_QUALITY,
                        seed=DEFAULT_SEED, window=WINDOW, overlap=OVERLAP, vae_tiling=True,
                        cpu_offload=False):
    """Efface l'objet masqué sur toute la séquence, par fenêtres qui se recouvrent, écrit `out_path`.

    start/count = sous-plage de frames (test) ; preview_index = renvoie la PIL.Image de CETTE frame
    de la sous-plage au lieu d'écrire la vidéo (aperçu « et si » sur une image, rien sur disque).
    plate/harmonize/grain/quality : cf. en-tête du module.

    Réglages du MODÈLE (distincts de ceux du masque) : `seed` rend le tirage reproductible,
    `window`/`overlap` arbitrent cohérence temporelle contre VRAM et effacent la couture entre
    fenêtres, `vae_tiling` et `cpu_offload` échangent de la vitesse contre de la mémoire."""
    _require_vendor()
    import numpy as np
    import torch
    from PIL import Image

    from nrroto import roi as roi_mod
    from nrroto.harmonize import harmonize as harmonize_frame
    from nrroto.video import abort, finish, open_writer

    all_names = sorted(f for f in os.listdir(frames_dir) if f.lower().endswith((".jpg", ".png")))
    if not all_names:
        raise RuntimeError(t("no_frame_to_process"))
    first = max(0, int(start or 0)) if (start is not None or count is not None) else 0
    names = all_names[first:first + int(count)] if count else all_names[first:]
    if not names:
        raise RuntimeError(t("empty_frame_range"))

    union = os.path.join(mattes_root, "union")
    full_size = Image.open(os.path.join(frames_dir, names[0])).size
    # `pad` = marge d'effacement : sans elle, sur un petit objet la ROI ne contiendrait ni le masque
    # dilaté ni la couronne de référence du raccord.
    rect = roi_mod.compute_roi(union, full_size[0], full_size[1], snap=SNAP, pad=int(grow) * 2)
    seq = _Sequence(frames_dir, union, all_names, rect, grow, bool(plate))
    ladder = quality_ladder(quality)

    requested_backend = torch_backend(torch)
    # VRAM : libère ce qui traîne (SAM chaud + éventuel pipe d'un run précédent) AVANT de charger Wan.
    empty_torch_cache(torch, requested_backend)
    pipe, active_backend = _load_pipe(weights_dir)
    if cpu_offload:
        # Les poids ne montent sur le GPU que le temps de leur passe. Beaucoup plus lent, mais
        # c'est la différence entre « ça tourne » et « mémoire insuffisante » sur une petite carte.
        try:
            pipe.enable_model_cpu_offload()
        except Exception:  # noqa: BLE001
            _log("déport CPU indisponible sur ce pipeline")
    # Le découpage du VAE est le levier mémoire principal (son encode/decode plein cadre est le
    # plus gros pic), mais le tuilage laisse des raccords : à couper quand la VRAM suffit.
    methods = ("enable_tiling", "enable_slicing") if vae_tiling else ("enable_slicing",)
    for method in methods:
        try:
            getattr(pipe.vae, method)()
        except Exception:  # noqa: BLE001
            pass
    generator = torch.Generator(device="cpu").manual_seed(int(seed))

    total, produced, preview, writer, state = len(names), 0, None, None, {}
    plan = window_plan(total, window, overlap)
    carry = []          # images de la fenêtre précédente qui recouvrent celle-ci, pas encore écrites
    try:
        for step_i, (base, length, lap) in enumerate(plan):
            # Les images communes avec la fenêtre SUIVANTE sont retenues : elles ne seront écrites
            # qu'une fois fondues avec leur seconde version. Sans cette retenue, le recouvrement
            # produirait des images en double dans la vidéo de sortie.
            hold = plan[step_i + 1][2] if step_i + 1 < len(plan) else 0
            chunk = names[base:base + length]
            originals, soft, sources, holes = _load_window(seq, chunk)
            plates, residuals = _plate_window(seq, first + base, sources, holes)
            if any(r.any() for r in residuals):
                masks = [Image.fromarray(r.astype(np.uint8) * 255, "L") for r in residuals]
                patches = _diffuse(pipe, [Image.fromarray(p) for p in plates], masks, steps,
                                   ladder, generator=generator)
            else:
                # Tout le fond caché était filmé ailleurs : rien à inventer, rien à diffuser.
                patches = None

            pending = []
            for k in range(len(chunk)):
                if patches is None or not residuals[k].any():
                    merged = plates[k]
                else:
                    # La sortie du modèle est passée BRUTE : c'est autour du trou, là où la plaque
                    # dit la vérité, que le raccord mesure la dérive avant de l'extrapoler dedans.
                    merged, state = harmonize_frame(
                        plates[k], np.asarray(patches[k], dtype=np.uint8), residuals[k],
                        seq.alpha_of(residuals[k]), strength=harmonize, grain=grain,
                        state=state, seed=first + base + k)
                # Zone commune avec la fenêtre précédente : les deux versions sont fondues au lieu
                # que la seconde écrase la première — c'est ce fondu qui supprime le saut.
                if k < lap and k < len(carry):
                    w = blend_weights(lap)[k]
                    merged = (carry[k].astype(np.float32) * (1.0 - w)
                              + merged.astype(np.float32) * w).astype(np.uint8)
                if k >= len(chunk) - hold:
                    pending.append(merged)
                    continue
                patch = Image.fromarray(merged)
                inpainted = roi_mod.paste_into(originals[k], patch, rect) if rect is not None else patch
                out = Image.composite(inpainted, originals[k], soft[k])
                if preview_index is not None:
                    if produced == int(preview_index):
                        preview = out
                        break
                else:
                    if writer is None:
                        writer = open_writer(out_path, out.size, fps)
                    writer.stdin.write(np.asarray(out, dtype=np.uint8).tobytes())
                produced += 1
            carry = pending
            if preview is not None:
                break
            if progress:
                progress(min(base + len(chunk), total), total)
    except BaseException:
        if writer is not None:
            abort(writer, out_path)
            writer = None
        raise
    finally:
        # Daemon persistant : ne JAMAIS laisser le pipe Wan résident (sinon il s'empile à chaque run
        # et sature les 8 Go — c'était la cause du « 12.79 GiB allocated »).
        del pipe
        empty_torch_cache(torch, active_backend)
        if writer is not None:
            finish(writer)

    if preview_index is not None:
        if preview is None:
            raise RuntimeError(t("preview_out_of_range"))
        return preview
    return out_path
