"""Constantes de la recherche : modèle SigLIP, détection d'indexation, perf, bascule FAISS.

Modèle : google/siglip2-so400m-patch16-naflex (1152-dim, multilingue → requêtes FR ok).
Override hors-ligne : env NETSURUSH_SIGLIP_DIR (dossier local) ou NETSURUSH_SIGLIP_MODEL.
"""
import os

MODEL_SRC = (os.environ.get("NETSURUSH_SIGLIP_DIR")
             or os.environ.get("NETSURUSH_SIGLIP_MODEL")
             or "google/siglip2-so400m-patch16-naflex")
# Tag d'index (colonne `model` de frame_embeddings_v1) = l'ID DE CATALOGUE de la variante, jamais
# le nom du dossier : le gestionnaire de modèles télécharge `google/siglip2-so400m-patch16-naflex`
# dans un dossier `siglip2-so400m`, donc dériver le tag du chemin le faisait CHANGER pour des poids
# IDENTIQUES — et tout l'index déjà construit devenait invisible d'un coup.
_MODEL_ID = (os.environ.get("NETSURUSH_SIGLIP_MODEL") or "").strip()
_BASE_MODEL_TAG = os.path.basename((_MODEL_ID or MODEL_SRC).rstrip("/\\")) or "siglip2"

# Résolution d'analyse SigLIP 2 naflex : nombre de patches par image. 256 = le défaut du modèle.
# Monter donne au modèle plus de détail (et coûte de la VRAM), descendre accélère sur machine faible.
# Définie ICI, avant le tag d'index, parce qu'elle en fait partie (voir juste en dessous).
DEFAULT_MAX_PATCHES = 256
try:
    MAX_PATCHES = min(1024, max(64, int(os.environ.get("NETSURUSH_MAX_PATCHES", DEFAULT_MAX_PATCHES))))
except ValueError:
    MAX_PATCHES = DEFAULT_MAX_PATCHES

# La résolution d'analyse fait PARTIE du tag d'index dès qu'elle quitte le défaut du modèle.
# MESURÉ : la même image encodée à 256 puis à 512 patches donne deux vecteurs à 0,90 de cosinus.
# Ce n'est pas un autre espace — le cosinus texte↔image reste du même ordre à 128, 256 et 512, le
# texte n'étant pas découpé en patches. Mais deux plans encodés à des résolutions différentes ne se
# comparent plus à armes égales : dans un index mélangé, le classement dépendrait de la résolution
# du jour plutôt que du contenu. La colonne `model` sépare déjà les espaces vectoriels (une variante
# de SigLIP par tag) ; la résolution s'y range naturellement. Conséquence VOULUE : changer de
# résolution affiche « index non construit » au lieu de mélanger, et revenir en arrière retrouve
# l'index d'origine intact. À la valeur par défaut, le tag est MOT POUR MOT celui d'avant.
MODEL_TAG = _BASE_MODEL_TAG if MAX_PATCHES == DEFAULT_MAX_PATCHES else "%s@p%d" % (_BASE_MODEL_TAG, MAX_PATCHES)

# Tags écrits par les versions qui dérivaient le tag du chemin ou de l'id HuggingFace. Mêmes poids,
# même espace vectoriel → l'index se RENOMME (cf. db.migrate_legacy_model_tags), il ne se refait pas.
LEGACY_MODEL_TAGS = {
    "siglip2-base": ("siglip2-base-patch16-naflex",),
    "siglip2-so400m": ("siglip2-so400m-patch16-naflex",),
    "siglip2-giant": ("siglip2-giant-opt-patch16-384",),
}

# Détection des plans pour l'indexation : TransNetV2 en précision MAX (preset "Max" = seuil 0.2,
# le plus bas → détecte le plus finement). Surchargeable via NETSURUSH_INDEX_MODEL / NETSURUSH_INDEX_THRESHOLD.
INDEX_MODEL = os.environ.get("NETSURUSH_INDEX_MODEL", "transnetv2").strip() or "transnetv2"
try:
    INDEX_THRESHOLD = float(os.environ.get("NETSURUSH_INDEX_THRESHOLD", "0.2"))
except ValueError:
    INDEX_THRESHOLD = 0.2

# Seuil du POOL de plans d'un personnage (filtre combiné « @perso + mots-clés »). Les moteurs
# de visage calibrent 0.5 = frontière officielle « même identité » — trop permissif pour un pool
# propre (des visages incidents/mal reconnus passent). On relève à 0.6 : un plan n'entre dans le
# pool que si le visage y est reconnu AVEC CONFIANCE. Appliqué au score STOCKÉ dans face_labels_v1
# (aucune ré-étiquetage nécessaire) et au repli live. Surchargeable via NETSURUSH_CHAR_POOL_THR.
try:
    CHAR_POOL_THR = float(os.environ.get("NETSURUSH_CHAR_POOL_THR", "0.6"))
except ValueError:
    CHAR_POOL_THR = 0.6

# Poids de la CONFIANCE DE RECONNAISSANCE dans le tri d'un « @perso + action ». Une action décrite en
# deux mots sépare mal les plans d'un même personnage (tous les cosinus se tiennent) : le classement
# tombait au bruit. Les deux signaux sont centrés-réduits puis additionnés → à action comparable, le
# plan où le visage est reconnu avec certitude passe devant. 0 = tri par l'action seule.
try:
    IDENTITY_WEIGHT = max(0.0, float(os.environ.get("NETSURUSH_IDENTITY_WEIGHT", "0.25")))
except ValueError:
    IDENTITY_WEIGHT = 0.25

# Poids des CADRAGES de prompt (cf. qtext) face à la requête nue, dont le poids vaut 1. Les vues
# cadrées stabilisent le vecteur d'une requête mal tournée ; 0 = requête nue seule (aucune vue
# supplémentaire n'est alors embeddée). Surchargeable via NETSURUSH_QUERY_TEMPLATE_WEIGHT.
try:
    TEMPLATE_WEIGHT = max(0.0, float(os.environ.get("NETSURUSH_QUERY_TEMPLATE_WEIGHT", "0.5")))
except ValueError:
    TEMPLATE_WEIGHT = 0.5

# Images fixes : pas de détection de plans (1 image = 1 plan = l'image entière → embed direct).
IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif")


def is_image(path):
    return os.path.splitext(path)[1].lower() in IMG_EXTS


# Échantillonnage d'un plan : combien d'images le représentent. UN seul réglage — le placement de
# ces images et l'image supplémentaire des plans longs sont décidés par le programme (cf. sampling),
# pas par l'utilisateur : ce sont des règles, pas des goûts.
SAMPLING_FRAMES = (1, 2, 3)
DEFAULT_SAMPLING_FRAMES = 2


def sampling_frames(asked):
    """Demande normalisée : 1, 2 ou 3 images par plan."""
    return asked if asked in SAMPLING_FRAMES else DEFAULT_SAMPLING_FRAMES


# Marqueur d'indexation (index_runs_v1.sampling) : "<format>:<cut_key>" — format d'échantillonnage
# ET identité de la découpe. Les helpers vivent ici (et pas dans index.py) pour que le catalogue,
# qui ne lit que SQLite, n'ait pas à importer torch/numpy juste pour lire un marqueur.
# Les deux formats historiques gardent leur nom : renommer 'adaptive' ou 'precise' périmerait d'un
# coup tout index déjà construit.
_SAMPLING_TOKENS = {1: "single", 2: "adaptive", 3: "precise"}
# Richesse croissante. Un index PLUS riche que la demande la satisfait (trois images poolées
# couvrent ce qu'on demandait à deux) ; l'inverse est faux — d'où un rang, et pas une égalité.
SAMPLING_RANK = {"single": 1, "adaptive": 2, "precise": 3}


def sampling_format(frames):
    """Nom de format porté par le marqueur pour cette demande."""
    return _SAMPLING_TOKENS[sampling_frames(frames)]


def sampling_mode(tag):
    """Format porté par un marqueur, sans la clé de découpe ('adaptive:<key>' → 'adaptive'). Les
    marqueurs d'avant la clé ('adaptive', 'precise', 'image') se lisent tels quels."""
    return ((tag or "").split(":", 1)[0]) or None


def sampling_tag(fmt, cut_key):
    return "%s:%s" % (fmt, cut_key)


def sampling_current(tag, fmt, cut_key, legacy_key=None):
    """Le marqueur satisfait-il la demande ? Un index au moins aussi riche que `fmt` convient
    (cf. SAMPLING_RANK) : redemander moins d'images n'a aucune raison de tout refaire.

    Un marqueur SANS clé de découpe (écrit avant qu'elle existe) est accepté : la découpe d'alors
    est toujours celle que rend le cache de plans, et l'appelant vérifie de toute façon que le
    nombre de plans correspond — le refuser jetterait tout index antérieur à la clé.

    `cut_key` = identité des frontières posées (cf. media.cut_identity). `legacy_key` = identité des
    RÉGLAGES, telle que l'écrivaient les versions antérieures : l'accepter évite de périmer d'un
    coup tout index déjà construit sur le simple changement de schéma de clé."""
    have = SAMPLING_RANK.get(sampling_mode(tag))
    want = SAMPLING_RANK.get(fmt)
    if have is None or want is None or have < want:
        return False
    key = tag.split(":", 1)[1] if ":" in tag else None
    return key is None or key == cut_key or key == legacy_key


# Extraction de la frame représentative : ffmpeg avec seek KEYFRAME (-noaccurate_seek) → quasi
# instantané même sur HEVC long-GOP (pas de décodage keyframe→timestamp exact, inutile pour une
# vignette). Bornée par un timeout court PAR FRAME : une frame illisible/lente est juste SAUTÉE
# (le clip et ses autres plans restent indexés, on n'écarte jamais tout le clip ; jamais de gel).
GRAB_TIMEOUT = 6.0     # s max par frame (mode normal) ; au-delà = frame sautée
FORCE_TIMEOUT = 45.0   # mode "Forcer" : seek précis + longue attente pour récupérer les frames récalcitrantes

# Plusieurs images d'un plan → UN vecteur. On mesure leur écart EN ESPACE EMBEDDING (spread = 1 − cos,
# robuste au grain et au flicker anime) : sous ce seuil le plan n'a pas changé et l'image du milieu
# le résume aussi bien ; au-dessus on mean-poole (re-normalisé) pour couvrir ce qu'il a montré.
STATIC_THR = 0.10
# Dedup : cosinus ≥ ce seuil = prises quasi-identiques / plan mal recoupé (union-find des paires).
DEDUP_THR = 0.93

def _env_bool(name, default):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in ("0", "false", "no", "off")


# Options de performance pilotées par les préférences partagées (core/prefs.js → DETECT_ENV).
# Le décodage groupé garde les mêmes timestamps et les mêmes pixels d'entrée : il est donc actif par
# défaut. La résolution d'analyse, elle, CHANGE les vecteurs produits — d'où le marqueur ci-dessous.
SHOT_DECODE = _env_bool("NETSURUSH_SHOT_DECODE", True)

# Profil VRAM : un seul réglage utilisateur pour les trois plafonds qui décident du pic mémoire.
# Le décodage est borné par les processus ffmpeg (RAM + CPU), l'embedding par la taille du batch
# (VRAM), le lot par le nombre de frames décodées vivantes en même temps (RAM). Aucun de ces trois
# ne change un vecteur : ils ne pèsent que sur la vitesse et la mémoire.
_CPUS = os.cpu_count() or 4
_VRAM_PROFILES = {
    "economy":     {"workers": 2,                       "batch": 8,  "chunk": 32},
    "balanced":    {"workers": max(2, min(8, _CPUS)),   "batch": 24, "chunk": 64},
    "performance": {"workers": max(4, min(12, _CPUS)),  "batch": 48, "chunk": 96},
}
_VRAM_PROFILE = os.environ.get("NETSURUSH_VRAM_PROFILE", "balanced").strip().lower()
VRAM_PROFILE = _VRAM_PROFILE if _VRAM_PROFILE in _VRAM_PROFILES else "balanced"

# Perf indexation. Le coût = décodage ffmpeg (I/O+process, libère le GIL) puis embedding SigLIP (GPU).
# On découple : décodage PARALLÈLE par lots de plans (threads), puis embedding GPU par GROS batches
# (GPU saturé au lieu de mini-forwards). Frames downscalées à l'extraction (le modèle redimensionne de
# toute façon → embedding identique, RAM/pipe divisés). Couplé à l'escalade (2→3 frames), la majorité
# des plans (statiques) ne coûtent que 2 décodes.
DECODE_WORKERS = _VRAM_PROFILES[VRAM_PROFILE]["workers"]  # threads ffmpeg concurrents (process-bound)
GPU_BATCH = _VRAM_PROFILES[VRAM_PROFILE]["batch"]         # images/forward SigLIP (sature le GPU, borne la VRAM)
INDEX_CHUNK = _VRAM_PROFILES[VRAM_PROFILE]["chunk"]       # plans décodés/embeddés par lot (borne la RAM)
GRAB_MAX_EDGE = 512     # bord max des frames extraites pour l'embedding (px). 0 = pleine résolution.

# Bascule BruteForce → FAISS. Le seuil = nb de plans dont la matrice brute (dim×4 o/plan)
# tiendrait dans le budget RAM ; au-delà on passe à l'index compressé. Override fixe via
# NETSURUSH_FAISS_THRESHOLD ; fraction de RAM via NETSURUSH_RAM_FRACTION (défaut 0.5).
_thr_env = os.environ.get("NETSURUSH_FAISS_THRESHOLD", "").strip()
try:
    FAISS_THRESHOLD_FIXED = max(1, int(_thr_env)) if _thr_env else None
except ValueError:
    FAISS_THRESHOLD_FIXED = None
try:
    RAM_FRACTION = min(0.9, max(0.05, float(os.environ.get("NETSURUSH_RAM_FRACTION", "0.5"))))
except ValueError:
    RAM_FRACTION = 0.5
FAISS_FLOOR = 50000   # sous ce nb de plans : toujours brute-force (overhead FAISS pas rentable)

# FAISS tier = IndexIVFPQ (index compressé) : codes PQ ~64 o/plan → libère la RAM que la matrice
# brute saturait. nlist/nprobe dimensionnés au build ; entraînement + ajout par lots.
PQ_NBITS = 8
TRAIN_CAP = 100000    # taille max de l'échantillon d'entraînement IVF/PQ (RAM/vitesse)
ADD_BATCH = 20000     # ajout par lots → plafonne le pic RAM au build quel que soit N
