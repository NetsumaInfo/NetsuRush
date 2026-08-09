"""Matte fin par DIFFUSION (VideoMaMa) : un UNet affiné sur Stable Video Diffusion réestime
l'alpha d'un lot d'images d'un coup, guidé par le masque de segmentation de CHAQUE image.

Rien à voir avec MatAnyone (cf. nrroto/matte.py), et c'est ce qui décide de tout le reste :
- MatAnyone s'AMORCE sur quelques images validées puis PROPAGE sa mémoire ; il ne voit qu'une image
  à la fois, et sa qualité dépend d'où on l'amorce.
- VideoMaMa ne propage rien : il reçoit un masque par image et travaille par LOTS. Il n'a donc pas
  de graine, mais il a une couture à chaque jonction de lot, traitée ici en deux temps.

Le pipeline est réimplémenté au-dessus des primitives `diffusers` (l'architecture EST
`UNetSpatioTemporalConditionModel` + `AutoencoderKLTemporalDecoder`, rien de propre au modèle) :
aucun fichier tiers n'est vendoré, contrairement à MiniMax dont le transformeur n'existe qu'en
fichier de dépôt.

Deux points du contrat amont qu'il ne faut pas « corriger » :
- le conditionnement CLIP est NUL. L'UNet a été affiné avec des `encoder_hidden_states` à zéro ;
  faire tourner un encodeur d'images à la place changerait la distribution qu'il attend.
- une SEULE étape de débruitage, à `timestep = 1`. Ce n'est pas un raccourci : le modèle est
  distillé pour ça, boucler un échantillonneur dessus dégraderait le résultat.
"""
import os

# Images par lot envoyé au modèle. La VRAM monte linéairement avec ce nombre (tout le lot vit en
# latents en même temps) ; 16 est la valeur de référence de l'amont.
DEFAULT_BATCH = 16
# Images communes à deux lots. Deux lots voisins sont débruités indépendamment, donc la jonction
# saute ; le recouvrement la traite deux fois (cf. `refine_batches`). 0 = aucun raccord.
DEFAULT_OVERLAP = 2
# Conditionnement temporel de SVD, repris tel quel : ce sont les valeurs avec lesquelles l'UNet a
# été affiné, pas des réglages de rendu.
FPS_COND = 7
MOTION_BUCKET = 127
NOISE_AUG = 0.0


def plan_batches(total, batch=DEFAULT_BATCH, overlap=DEFAULT_OVERLAP):
    """Découpe [0, total) en lots qui se recouvrent — `(début, fin exclue, recouvrement amont)`.

    Le recouvrement est borné à `batch - 1` : au-delà, l'avance par pas serait nulle et le
    découpage ne progresserait plus."""
    size = max(1, int(batch))
    lap = max(0, min(int(overlap or 0), size - 1))
    if total <= size:
        return [(0, total, 0)] if total > 0 else []
    out, pos = [], 0
    while pos < total:
        end = min(pos + size, total)
        out.append((pos, end, lap if pos else 0))
        if end >= total:
            break
        pos += size - lap
    return out


class VideoMaMaEngine:
    """Charge l'UNet + le VAE une fois et les garde chauds entre deux lots."""

    def __init__(self, weights_dir, device=None, dtype=None):
        import torch
        from diffusers.models import AutoencoderKLTemporalDecoder, UNetSpatioTemporalConditionModel

        from nrdevice import torch_backend, torch_device
        backend = torch_backend(torch)
        self.device = device or torch_device(torch, backend)
        # fp16 sur accélérateur, fp32 sur processeur : la moitié des opérateurs fp16 n'existent pas
        # côté CPU et l'inférence échouerait au premier convolutionnel.
        self.dtype = dtype or (torch.float16 if str(self.device) != "cpu" else torch.float32)
        self.vae = AutoencoderKLTemporalDecoder.from_pretrained(
            os.path.join(weights_dir, "vae"), torch_dtype=self.dtype).to(self.device).eval()
        self.unet = UNetSpatioTemporalConditionModel.from_pretrained(
            os.path.join(weights_dir, "unet"), torch_dtype=self.dtype).to(self.device).eval()
        # Le VAE décode image par image : c'est le pic mémoire du lot, et le découper ne coûte
        # presque rien puisqu'il n'y a aucune dépendance spatiale entre images à ce stade.
        for method in ("enable_slicing",):
            try:
                getattr(self.vae, method)()
            except Exception:  # noqa: BLE001 — accélération best-effort
                pass

    def unload(self):
        import torch
        from nrdevice import empty_torch_cache, torch_backend
        self.vae = None
        self.unet = None
        empty_torch_cache(torch, torch_backend(torch))

    def _to_video(self, torch, arrays):
        """Liste d'images uint8 → tenseur (1, F, 3, H, W) dans [-1, 1]. Un masque en niveaux de
        gris est répliqué sur trois canaux : le VAE n'encode que du RVB."""
        import numpy as np
        stack = []
        for arr in arrays:
            a = np.asarray(arr)
            if a.ndim == 2:
                a = np.stack([a] * 3, axis=-1)
            stack.append(torch.from_numpy(np.ascontiguousarray(a)).permute(2, 0, 1).float() / 255.0)
        return (torch.stack(stack).unsqueeze(0) * 2.0 - 1.0)

    def _encode(self, torch, video):
        """Vidéo → latents BRUTS (1, F, C, h, w).

        Pas de `scaling_factor` ici : l'entrée de l'UNet est la sortie NUE de l'encodeur. Seule la
        sortie du réseau est remise à l'échelle avant décodage — se tromper de côté donne une image
        plausible mais fausse, ce qu'aucune erreur ne signalerait."""
        frames = video.shape[1]
        flat = video.reshape(-1, *video.shape[2:]).to(self.dtype).to(self.device)
        chunks = [self.vae.encode(flat[i:i + 1]).latent_dist.sample() for i in range(flat.shape[0])]
        latents = torch.cat(chunks, dim=0)
        return latents.reshape(1, frames, *latents.shape[1:])

    def _time_ids(self, torch):
        ids = [FPS_COND, MOTION_BUCKET, NOISE_AUG]
        expected = self.unet.add_embedding.linear_1.in_features
        got = self.unet.config.addition_time_embed_dim * len(ids)
        if expected != got:
            raise RuntimeError("VideoMaMa : conditionnement temporel de taille %d, attendu %d" % (got, expected))
        return torch.tensor([ids], dtype=self.dtype, device=self.device)

    def run_batch(self, frames, masks, seed=42):
        """Un lot d'images + leurs masques → liste d'alphas uint8 (H, W), même taille qu'en entrée."""
        import numpy as np
        import torch

        with torch.no_grad():
            cond = self._encode(torch, self._to_video(torch, frames))
            guide = self._encode(torch, self._to_video(torch, masks))
            # Bruit tiré sur le PROCESSEUR : un générateur d'accélérateur ne donne pas la même suite
            # d'un pilote à l'autre, donc la graine ne serait pas reproductible entre machines.
            generator = torch.Generator(device="cpu").manual_seed(int(seed))
            noise = torch.randn(cond.shape, generator=generator, device="cpu", dtype=self.dtype).to(self.device)
            hidden = torch.zeros((1, 1, self.unet.config.cross_attention_dim),
                                 dtype=self.dtype, device=self.device)
            step = torch.full((1,), 1.0, device=self.device, dtype=torch.int32)
            # Concaténation sur les CANAUX (dim 2 d'un tenseur (B, F, C, h, w)) : bruit, image, masque.
            model_input = torch.cat([noise, cond, guide], dim=2)
            del noise, cond, guide
            out = self.unet(model_input, step, hidden, added_time_ids=self._time_ids(torch)).sample
            del model_input

            out = out.squeeze(0) / self.vae.config.scaling_factor
            decoded = []
            for i in range(out.shape[0]):
                chunk = out[i:i + 1]
                decoded.append(self.vae.decode(chunk, num_frames=1).sample.cpu())
            video = torch.cat(decoded, dim=0)

        # [-1,1] → [0,1], puis moyenne des canaux : la sortie est une matte, pas une image couleur.
        video = (video / 2.0 + 0.5).clamp(0, 1).mean(dim=1).float().numpy()
        return [np.clip(a * 255.0 + 0.5, 0, 255).astype(np.uint8) for a in video]


def refine_batches(engine, frames, frame_image, frame_mask, write, batch=DEFAULT_BATCH,
                   overlap=DEFAULT_OVERLAP, seed=42, on_frame=None, cancelled=None):
    """Affine `frames` (indices d'images, ordonnés) lot par lot et écrit un alpha par image.

    Le recouvrement est traité DEUX fois, comme chez l'amont, et les deux mécanismes servent :
    1. **Rétroaction** : les images communes reçoivent, en guise de masque, l'alpha DOUX que le lot
       précédent vient de produire — pas le masque binaire de la segmentation. Le modèle repart donc
       de sa propre estimation de bord, ce qui aligne les deux lots au lieu de les laisser diverger.
    2. **Fondu** : ces images ont deux prédictions ; la seconde est mélangée linéairement à la
       première déjà écrite. Sans lui, la jonction reste visible même après la rétroaction.
    """
    plan = plan_batches(len(frames), batch, overlap)
    carry_masks = None      # alphas doux des images communes, à la résolution du modèle
    carry_alphas = None     # alphas déjà écrits pour ces mêmes images
    done = 0
    for start, end, lap in plan:
        if cancelled is not None and cancelled():
            raise StopIteration
        window = frames[start:end]
        images = [frame_image(f) for f in window]
        guides = [frame_mask(f) for f in window]
        if lap and carry_masks:
            for i in range(min(lap, len(guides), len(carry_masks))):
                guides[i] = carry_masks[i]

        alphas = engine.run_batch(images, guides, seed=seed)
        for i, alpha in enumerate(alphas):
            frame = window[i]
            if i < lap and carry_alphas is not None and i < len(carry_alphas):
                alpha = _blend(carry_alphas[i], alpha, (i + 1) / float(lap + 1))
            write(frame, alpha)
            # Les images communes sont RÉÉCRITES, pas découvertes : les compter ferait dépasser le
            # total et reculer la barre à chaque jonction.
            if i >= lap:
                done += 1
                if on_frame is not None:
                    on_frame(done, len(frames), frame)
        # Le recouvrement du lot SUIVANT vaut toujours `overlap` : c'est cette queue-là qu'on garde.
        carry_masks = alphas[-overlap:] if overlap else None
        carry_alphas = alphas[-overlap:] if overlap else None
    return done


def _blend(previous, current, weight):
    """Mélange linéaire de deux estimations d'une même image (0 = l'ancienne, 1 = la nouvelle)."""
    import numpy as np
    return np.clip(previous.astype(np.float32) * (1.0 - weight)
                   + current.astype(np.float32) * weight, 0, 255).astype(np.uint8)
