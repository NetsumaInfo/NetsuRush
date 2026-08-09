"""Où prendre les images qui représentent un plan, et combien.

Trois règles, chacune tirée d'un défaut observé sur de vrais rushs :

1. **Jamais l'image du bord.** Un plan s'ouvre et se ferme souvent sur un fondu ou un noir : prise à
   l'image près, la première prise ne représente rien du plan. On écarte une marge des deux côtés.
2. **Les prises s'écartent au maximum.** Réparties dans ce qui reste, elles tombent sur des moments
   aussi différents que la durée le permet — deux images voisines n'apprendraient rien de plus
   qu'une seule.
3. **Un plan long reçoit une image de plus.** C'est la durée, pas le mouvement, qui dit qu'un plan a
   eu le temps de montrer autre chose ; un plan court n'a rien de plus à donner.

Un aplat qui passe malgré la marge (noir prolongé, surexposition) est repris un peu plus loin.
"""

# Part de la durée écartée à CHAQUE bout, et son plafond en secondes : sur un plan de dix minutes,
# rogner 12 % écarterait plus d'une minute de contenu pour se protéger d'un fondu qui dure une seconde.
EDGE_MARGIN = 0.12
EDGE_MARGIN_MAX_SEC = 0.5
LONG_SHOT_SEC = 6.0    # au-delà, le plan a eu le temps de changer → une prise de plus
MAX_FRAMES = 3         # plafond dur : au-delà les vecteurs se ressemblent et le décodage coûte
FLAT_STD = 6.0         # écart-type (0..255) sous lequel une image est un aplat : noir, blanc, fondu
RETRY_SHIFT = 0.08     # décalage de repli, en part de la durée du plan


def frame_count(duration, asked):
    """Nombre d'images à prendre sur un plan de `duration` secondes pour une demande de `asked`."""
    count = max(1, min(MAX_FRAMES, int(asked or 1)))
    if duration >= LONG_SHOT_SEC and count < MAX_FRAMES:
        return count + 1
    return count


def shot_times(start, end, count):
    """Timestamps des prises, marges écartées. Une prise unique se place au CENTRE : c'est le moment
    le plus représentatif d'un plan quand on n'en garde qu'un.

    La marge étant PROPORTIONNELLE avant d'être plafonnée, elle laisse toujours de la place : sur un
    plan d'une seule image elle vaut presque zéro, et le plafond ne s'applique qu'au-delà de quatre
    secondes. Il n'y a donc pas de cas où elle mangerait le plan entier."""
    span = max(0.0, end - start)
    if span <= 0 or count <= 1:
        return [start + span / 2]
    margin = min(span * EDGE_MARGIN, EDGE_MARGIN_MAX_SEC)
    low, high = start + margin, end - margin
    step = (high - low) / (count - 1)
    return [low + step * index for index in range(count)]


def is_flat(image):
    """Image sans contenu (noir, blanc, fondu) : elle ne représenterait pas le plan. Mesuré sur une
    vignette 32×32 en niveaux de gris — l'écart-type d'un aplat reste au ras de zéro."""
    import numpy as np
    small = image.convert("L").resize((32, 32))
    return float(np.asarray(small, dtype=np.float32).std()) < FLAT_STD


def retry_time(sec, start, end):
    """Où retenter quand la prise est un aplat : un peu plus loin dans le plan, et vers l'arrière
    quand on butait déjà sur la fin. None = le plan est trop court pour offrir une alternative."""
    span = max(0.0, end - start)
    if span <= 0:
        return None
    shift = max(0.1, span * RETRY_SHIFT)
    forward = sec + shift
    if forward < end:
        return forward
    backward = sec - shift
    return backward if backward > start else None
