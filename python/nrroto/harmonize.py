"""Raccord d'une zone reconstruite sur son voisinage : couleur, netteté, grain.

POURQUOI. Un moteur d'inpainting (LaMa, MiniMax/Wan) ne rend jamais des pixels métriquement
identiques à la source. Trois écarts se cumulent et signent la retouche même quand le contenu
est plausible :
1. couleur — l'aller-retour VAE n'est pas sans perte, la zone régénérée dérive en teinte et en
   luminance (dérive BASSE fréquence, donc un aplat légèrement décalé) ;
2. netteté — la diffusion tourne en résolution réduite puis le patch est ré-agrandi, il porte
   moins de haute fréquence que son voisinage ;
3. grain — la sortie est débruitée par construction, posée sur une source grainée elle fait tache.

Ce module corrige les trois par mesure sur la COURONNE (l'anneau de vrais pixels qui entoure le
trou), jamais par réglage à l'aveugle. C'est la mécanique du « Lighting Correction » d'After
Effects Content-Aware Fill et de l'illumination model de Mocha, transposée en convolution
normalisée : moins cher qu'un solveur de Poisson, et le raccord tend vers zéro sur le bord du
trou donc il n'ajoute pas de couture.

Fonctions PURES (numpy + cv2, zéro I/O) → testables sans GPU ni poids, cf.
test/test_roto_harmonize.py. Sans cv2 (venv dégradé) tout le module devient neutre : la
suppression continue de fonctionner, sans raccord."""
import math

import numpy as np

try:
    import cv2
except Exception:  # noqa: BLE001 — venv sans opencv : le raccord se désactive, cf. en-tête
    cv2 = None

# Largeur de la couronne de référence, en fraction du rayon du trou. Trop étroite, les statistiques
# sont bruitées ; trop large, elle déborde sur un autre plan de l'image et mesure autre chose.
RING_RATIO = 0.35
RING_MIN = 6
RING_MAX = 64

# Le biais VAE est basse fréquence : il faut l'extrapoler sur au moins le rayon du trou, sinon la
# correction retombe à zéro au centre et laisse une bosse.
BIAS_SIGMA_RATIO = 0.9
BIAS_SIGMA_MIN = 6.0
WEIGHT_FLOOR = 1e-3          # plancher du dénominateur de la convolution normalisée (div/0)
BIAS_CLAMP = 0.35            # garde-fou en unités [0,1] : au-delà, la mesure n'est plus un biais

# Lissage temporel du champ de biais. Le champ est lisse et lent ; sans EMA, une mesure qui varie
# d'une image à l'autre ferait respirer la zone effacée.
EMA_ALPHA = 0.4

# Séparation basse/haute fréquence pour la netteté et le grain (σ en pixels).
DETAIL_SIGMA = 1.6
DETAIL_GAIN_MAX = 2.0        # amplifier plus, c'est amplifier les artefacts du moteur
GRAIN_HP_SIGMA = 1.2
GRAIN_SIZE_MIN = 0.3
GRAIN_SIZE_MAX = 3.0
GRAIN_LUMA_BINS = 8
MAD_TO_SIGMA = 1.4826        # écart-type robuste d'après l'écart absolu médian (loi normale)

# Au-delà de ce σ, le flou passe par une résolution réduite : visuellement identique, mais un noyau
# gaussien de 200 px coûte deux ordres de grandeur de plus.
SMOOTH_DIRECT_SIGMA = 12.0
SMOOTH_MAX_STEP = 8

LUMA_WEIGHTS = np.array([0.299, 0.587, 0.114], dtype=np.float32)   # RGB


def available():
    """Le raccord exige cv2. Sans lui, les appelants gardent le composite brut."""
    return cv2 is not None


def _smooth(a, sigma):
    """Flou gaussien, calculé en résolution réduite quand σ est grand (cf. SMOOTH_DIRECT_SIGMA)."""
    sigma = float(max(0.1, sigma))
    if sigma <= SMOOTH_DIRECT_SIGMA:
        return cv2.GaussianBlur(a, (0, 0), sigma)
    step = int(min(SMOOTH_MAX_STEP, max(2, round(sigma / SMOOTH_DIRECT_SIGMA))))
    h, w = a.shape[:2]
    sw, sh = max(1, w // step), max(1, h // step)
    small = cv2.resize(a, (sw, sh), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (0, 0), sigma / step)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)


def _luma(rgb):
    return rgb @ LUMA_WEIGHTS


def ring_mask(hole, width=None):
    """Anneau de vrais pixels autour du trou — la seule référence fiable pour mesurer un écart.

    `hole` = bool HxW (True = régénéré). Largeur déduite du rayon du trou si non fournie."""
    if cv2 is None or not hole.any():
        return np.zeros_like(hole)
    if width is None:
        radius = math.sqrt(max(1.0, float(hole.sum())) / math.pi)
        width = int(np.clip(radius * RING_RATIO, RING_MIN, RING_MAX))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * width + 1, 2 * width + 1))
    grown = cv2.dilate(hole.astype(np.uint8), k).astype(bool)
    return grown & ~hole


def bias_sigma(hole):
    """σ du champ de biais, dérivé du rayon du trou (cf. BIAS_SIGMA_RATIO)."""
    radius = math.sqrt(max(1.0, float(hole.sum())) / math.pi)
    side = float(max(hole.shape))
    return float(np.clip(radius * BIAS_SIGMA_RATIO, BIAS_SIGMA_MIN, max(BIAS_SIGMA_MIN, side * 0.5)))


def bias_field(src, gen, hole, sigma=None):
    """Champ de correction couleur lisse, en float32 HxWx3 (à AJOUTER au généré).

    L'écart `src - gen` n'est mesurable que là où la source est vraie, donc HORS du trou ; il est
    extrapolé DEDANS par convolution normalisée `flou(diff·w) / flou(w)` où `w` vaut 1 hors du
    trou et 0 dedans. Le champ vaut donc l'écart réel sur le bord (raccord invisible) et sa
    moyenne pondérée au centre."""
    weight = (~hole).astype(np.float32)
    if weight.sum() < 1.0:
        return np.zeros_like(gen)      # le trou couvre tout : aucune référence, aucune correction
    if sigma is None:
        sigma = bias_sigma(hole)
    diff = (src - gen) * weight[..., None]
    num = _smooth(diff, sigma)
    den = np.maximum(_smooth(weight, sigma), WEIGHT_FLOOR)
    return np.clip(num / den[..., None], -BIAS_CLAMP, BIAS_CLAMP)


def detail_gain(gen, src, hole, ring):
    """Facteur d'accentuation qui égalise la variance haute fréquence du patch sur sa couronne.

    Un patch de diffusion basse résolution ré-agrandi est plus MOU que son voisinage, et cette
    différence de netteté se repère autant qu'un écart de couleur. Borné (DETAIL_GAIN_MAX) :
    au-delà on n'accentue plus du détail mais les artefacts du moteur."""
    if not ring.any() or not hole.any():
        return 1.0
    hp_src = _luma(src) - _luma(_smooth(src, DETAIL_SIGMA))
    hp_gen = _luma(gen) - _luma(_smooth(gen, DETAIL_SIGMA))
    target = float(np.std(hp_src[ring]))
    have = float(np.std(hp_gen[hole]))
    if have <= 1e-5 or target <= 1e-5:
        return 1.0
    return float(np.clip(target / have, 1.0, DETAIL_GAIN_MAX))


def _grain_size(residual, ring):
    """Taille de grain (σ gaussien) d'après l'autocorrélation du résidu à un pixel d'écart.

    Pour un champ gaussien de largeur σ, corr(1) = exp(-1/(4σ²)) — on inverse. Un bruit blanc pur
    (corr ≈ 0) donne la borne basse, un grain épais la borne haute."""
    both = ring[:, :-1] & ring[:, 1:]
    if both.sum() < 32:
        return GRAIN_SIZE_MIN
    a = residual[:, :-1][both]
    b = residual[:, 1:][both]
    energy = float(np.mean(a * a))
    if energy <= 1e-9:
        return GRAIN_SIZE_MIN
    corr = float(np.mean(a * b)) / energy
    if corr <= 0.05 or corr >= 0.999:
        return GRAIN_SIZE_MIN if corr <= 0.05 else GRAIN_SIZE_MAX
    return float(np.clip(math.sqrt(-1.0 / (4.0 * math.log(corr))), GRAIN_SIZE_MIN, GRAIN_SIZE_MAX))


def grain_profile(src, ring):
    """Signature du grain de la source mesurée dans la couronne.

    Renvoie {sigma (3 canaux), size, curve} — `curve` = amplitude relative par tranche de
    luminance : sur une vraie source le grain est plus marqué dans les basses lumières, un bruit
    d'amplitude constante se repère tout de suite."""
    flat = {"sigma": np.zeros(3, np.float32), "size": GRAIN_SIZE_MIN,
            "curve": np.ones(GRAIN_LUMA_BINS, np.float32)}
    if cv2 is None or ring.sum() < 64:
        return flat
    residual = src - _smooth(src, GRAIN_HP_SIGMA)
    vals = residual[ring]                                    # (N, 3)
    # Écart-type ROBUSTE : la couronne contient des arêtes, une variance brute les compterait
    # comme du grain et sur-bruiterait la zone effacée.
    sigma = (MAD_TO_SIGMA * np.median(np.abs(vals), axis=0)).astype(np.float32)
    if float(sigma.max()) <= 1e-4:
        return flat
    size = _grain_size(_luma(residual), ring)
    luma = _luma(src)[ring]
    amp = np.abs(vals).mean(axis=1)
    bins = np.clip((luma * GRAIN_LUMA_BINS).astype(np.int32), 0, GRAIN_LUMA_BINS - 1)
    curve = np.ones(GRAIN_LUMA_BINS, np.float32)
    overall = float(amp.mean()) or 1.0
    for b in range(GRAIN_LUMA_BINS):
        sel = bins == b
        if sel.sum() >= 32:
            curve[b] = float(amp[sel].mean()) / overall
    return {"sigma": sigma, "size": size, "curve": np.clip(curve, 0.25, 2.5)}


def add_grain(img, profile, alpha, seed):
    """Ajoute un grain conforme au profil mesuré, pondéré par `alpha` (0..1 par pixel).

    `seed` = index d'image : le grain d'une vraie pellicule est DÉCORRÉLÉ d'une image à l'autre,
    un motif figé se verrait immédiatement comme une texture collée."""
    sigma = np.asarray(profile["sigma"], np.float32)
    if cv2 is None or float(sigma.max()) <= 1e-4:
        return img
    rng = np.random.default_rng(int(seed) & 0x7FFFFFFF)
    noise = rng.standard_normal(img.shape).astype(np.float32)
    size = float(profile["size"])
    if size > GRAIN_SIZE_MIN:
        noise = cv2.GaussianBlur(noise, (0, 0), size)        # corrélation spatiale = taille de grain
    std = noise.reshape(-1, 3).std(axis=0)
    noise *= (sigma / np.maximum(std, 1e-6))
    centers = (np.arange(GRAIN_LUMA_BINS, dtype=np.float32) + 0.5) / GRAIN_LUMA_BINS
    modulation = np.interp(np.clip(_luma(img), 0.0, 1.0), centers, profile["curve"]).astype(np.float32)
    return img + noise * (modulation * alpha)[..., None]


def _blend(reference, generated, alpha):
    weight = alpha[..., None]
    return np.clip(reference * (1.0 - weight) + generated * weight, 0.0, 1.0)


def harmonize(reference, generated, hole, alpha=None, strength=0.85, grain=1.0, detail=True,
              state=None, seed=0):
    """Raccorde la sortie d'un moteur sur son voisinage ET la compose sur les vrais pixels.

    reference : uint8 RGB — la VÉRITÉ colorimétrique : l'image source, complétée par la plaque
                propre là où le fond réel a pu être récupéré.
    generated : uint8 RGB — la sortie BRUTE du moteur sur toute la zone de travail, y compris
                AUTOUR du trou. C'est essentiel : la dérive du modèle s'y mesure là où l'on connaît
                la vérité, ce qui permet de l'extrapoler à l'intérieur du trou, où on ne la connaît
                pas. Composer la référence dans le généré avant d'appeler ce raccord annulerait la
                mesure et la correction serait nulle.
    hole      : bool HxW — ce qu'on GARDE du généré (le résidu que la plaque n'a pas comblé).
    alpha     : float32 HxW 0..1 — poids de composition (masque adouci). Défaut = `hole`.
    state     : dict porté d'une image à l'autre (EMA du champ de biais, profil de grain). {} au
                premier appel.

    Renvoie (uint8 RGB, state). Toute mesure impossible (pas de cv2, trou vide, couronne vide) rend
    la composition NUE plutôt qu'une correction inventée."""
    if state is None:
        state = {}
    hole = np.asarray(hole, dtype=bool)
    if alpha is None:
        alpha = hole.astype(np.float32)
    alpha = np.clip(np.asarray(alpha, dtype=np.float32), 0.0, 1.0)
    ref = reference.astype(np.float32) / 255.0
    out = generated.astype(np.float32) / 255.0
    ring = ring_mask(hole) if cv2 is not None else np.zeros_like(hole)
    if cv2 is None or not hole.any() or not ring.any():
        # Trou vide, trou collé aux bords du cadre, venv sans cv2 : rien de mesurable.
        return (_blend(ref, out, alpha) * 255.0 + 0.5).astype(np.uint8), state

    strength = float(np.clip(strength, 0.0, 1.0))
    if strength > 0.0:
        field = bias_field(ref, out, hole)
        previous = state.get("bias")
        if previous is not None and previous.shape == field.shape:
            field = EMA_ALPHA * field + (1.0 - EMA_ALPHA) * previous
        state["bias"] = field
        out = out + field * strength

    if detail:
        gain = detail_gain(out, ref, hole, ring)
        if gain > 1.0:
            out = out + (out - _smooth(out, DETAIL_SIGMA)) * (gain - 1.0)

    grain = float(np.clip(grain, 0.0, 1.0))
    if grain > 0.0:
        profile = state.get("grain")
        if profile is None:
            # Le grain d'un plan ne change pas d'une image à l'autre : mesuré une fois, réutilisé
            # (une mesure par image ferait respirer l'amplitude).
            profile = grain_profile(ref, ring)
            state["grain"] = profile
        out = add_grain(out, profile, alpha * grain, seed)

    return (_blend(ref, out, alpha) * 255.0 + 0.5).astype(np.uint8), state
