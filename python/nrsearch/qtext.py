"""Compréhension de la requête texte : normalisation, langue et VUES de prompt.

Le modèle ne voit qu'une phrase : sa FORMULATION pèse autant que son contenu. Deux façons de décrire
le même plan (« court sous la pluie » / « elle est en train de courir sous la pluie ») donnaient deux
vecteurs éloignés, donc deux classements différents — c'est ce qui rendait la recherche imprévisible
« selon ce qu'on tape ». Ici on ramène la requête à un noyau, puis on en dérive quelques VUES
(la requête nue + des cadrages type légende) que `query.py` moyenne : l'ensemble annule le bruit
propre à une tournure, comme l'ensembling de prompts en zero-shot CLIP.

Les cadrages sont écrits DANS LA LANGUE de la requête (détectée, repli = langue de l'interface) :
préfixer une requête japonaise d'une phrase française mélangeait deux langues dans un même vecteur.

Module PUR (aucun torch, aucun accès disque/réseau) → testable sans modèle.
"""
import re
import unicodedata

from .config import TEMPLATE_WEIGHT

# Langues de l'interface (src/locales) = celles pour lesquelles on écrit des cadrages.
LANGS = ("de", "en", "es", "fr", "ja", "zh")
DEFAULT_LANG = "en"

# Un jeton « @Nom » non résolu n'est pas un descripteur visuel : l'embarquer ferait chercher le MOT
# (« @Violet » → la couleur violette). Le renderer les retire déjà ; garde de défense côté sidecar.
_MENTION_RE = re.compile(r"(?:^|(?<=\s))@\S+")
_SPACE_RE = re.compile(r"\s+")
_TRIM_CHARS = " \t\r\n.,;:!?\"'«»()[]{}<>/\\-–—_+*#"
# Jeton = suite de lettres/chiffres. L'apostrophe SÉPARE (« qu'elle » → « qu », « elle ») pour que le
# retrait du sujet voie le pronom collé à son élision.
_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)

# Mots-outils fréquents, servant UNIQUEMENT à deviner la langue d'une requête en écriture latine.
_STOPWORDS = {
    "en": {"the", "a", "an", "of", "and", "or", "in", "on", "at", "with", "without", "who", "that",
           "is", "are", "he", "she", "they", "it", "his", "her", "for", "by", "to", "from", "into"},
    "fr": {"le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "dans", "sur", "avec",
           "sans", "qui", "que", "est", "sont", "il", "elle", "ils", "elles", "au", "aux", "pour",
           "par", "en", "sous", "vers", "chez", "son", "sa", "ses", "leur"},
    "es": {"el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "y", "o", "en",
           "con", "sin", "que", "quien", "es", "son", "esta", "estan", "él", "ella", "ellos",
           "para", "por", "sobre", "su", "sus"},
    "de": {"der", "die", "das", "ein", "eine", "einen", "und", "oder", "in", "auf", "mit", "ohne",
           "ist", "sind", "er", "sie", "es", "für", "von", "zu", "den", "dem", "im", "am", "beim"},
}

# Sujet redondant en tête de requête QUAND un personnage est déjà cité : le pool est filtré sur son
# identité, « elle », « le personnage », « fait » n'ajoutent aucun signal visuel et déplacent le
# vecteur (genre, personne, verbe support). Retiré jeton à jeton depuis le début, jamais en entier.
_LEAD_TOKENS = {
    "fr": {"il", "elle", "ils", "elles", "on", "qui", "que", "qu", "le", "la", "les", "l",
           "personnage", "perso", "est", "sont", "etre", "fait", "faisant", "font", "en", "train",
           "de", "d", "se", "s", "entrain"},
    "en": {"he", "she", "they", "it", "who", "that", "the", "a", "an", "is", "are", "was", "were",
           "does", "do", "doing", "character", "person", "being"},
    "es": {"el", "ella", "ellos", "ellas", "que", "quien", "la", "los", "las", "un", "una",
           "personaje", "es", "esta", "estan", "hace", "haciendo", "haciendose"},
    "de": {"er", "sie", "es", "der", "die", "das", "welcher", "welche", "ein", "eine", "figur",
           "charakter", "ist", "sind", "macht", "machend", "beim"},
}
# CJK : pas de séparateur de mots → on retire des PRÉFIXES connus au lieu de jetons.
_LEAD_PREFIXES = {
    "ja": ("キャラクターが", "キャラクターは", "キャラが", "キャラは", "彼女が", "彼女は", "彼が", "彼は",
           "その人が", "その人は"),
    "zh": ("这个角色", "那个角色", "角色正在", "角色在", "角色", "他正在", "她正在", "他在", "她在", "他", "她"),
}
_MAX_LEAD_TOKENS = 5     # « elle est en train de courir » = 5 mots-outils avant le verbe utile

# Cadrages type légende. `{q}` = noyau de la requête. « scene » = requête libre, « character » =
# requête posée SUR un personnage déjà filtré (le cadrage rend la tournure « qui court » naturelle).
_TEMPLATES = {
    "en": {"scene": ("a photo of {q}", "a video frame showing {q}"),
           "character": ("a photo of a character {q}", "a video frame of a character {q}")},
    "fr": {"scene": ("une photo de {q}", "une image de film montrant {q}"),
           "character": ("une photo d'un personnage {q}", "une image de film d'un personnage {q}")},
    "es": {"scene": ("una foto de {q}", "un fotograma que muestra {q}"),
           "character": ("una foto de un personaje {q}", "un fotograma de un personaje {q}")},
    "de": {"scene": ("ein Foto von {q}", "ein Filmbild, das {q} zeigt"),
           "character": ("ein Foto einer Figur {q}", "ein Filmbild einer Figur {q}")},
    "ja": {"scene": ("{q}の写真", "{q}を映した映像"),
           "character": ("キャラクターが{q}写真", "キャラクターの{q}映像")},
    "zh": {"scene": ("{q}的照片", "展示{q}的影片画面"),
           "character": ("一个角色{q}的照片", "一个角色{q}的影片画面")},
}
BARE_WEIGHT = 1.0        # la requête nue reste la vue de référence, les cadrages la stabilisent


def normalize(text):
    """Requête brute → texte propre : mentions résiduelles retirées, espaces et ponctuation de bord
    nettoyés. Ne touche NI à la casse (le modèle s'en charge) NI aux accents (ils portent du sens)."""
    cleaned = _MENTION_RE.sub(" ", text or "")
    cleaned = _SPACE_RE.sub(" ", cleaned).strip()
    return cleaned.strip(_TRIM_CHARS).strip()


def _fold(word):
    """Minuscule sans accents — comparaison de mots-outils insensible à la saisie (« Elle », « ÉLÈVE »)."""
    decomposed = unicodedata.normalize("NFD", word.lower())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _script_lang(text, fallback):
    """Langue déduite de l'ÉCRITURE : kana ⇒ japonais ; han seul ⇒ chinois, sauf si l'interface est
    en japonais (un titre tout en kanji reste japonais). None = écriture non décisive."""
    kana = han = 0
    for ch in text:
        code = ord(ch)
        if 0x3040 <= code <= 0x30FF or 0xFF66 <= code <= 0xFF9D:
            kana += 1
        elif 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
            han += 1
    if kana:
        return "ja"
    if han:
        return "ja" if fallback == "ja" else "zh"
    return None


def detect_lang(text, fallback=None):
    """Langue de la requête : écriture d'abord, puis vote des mots-outils, sinon `fallback`
    (langue de l'interface) — c'est le meilleur a priori pour une requête d'un ou deux mots."""
    fallback = fallback if fallback in LANGS else DEFAULT_LANG
    text = text or ""
    by_script = _script_lang(text, fallback)
    if by_script:
        return by_script
    words = [_fold(w) for w in _TOKEN_RE.findall(text)]
    if not words:
        return fallback
    scores = {lang: sum(1 for w in words if w in stop) for lang, stop in _STOPWORDS.items()}
    best = max(scores.values())
    if not best:
        return fallback
    tied = [lang for lang, n in scores.items() if n == best]
    return fallback if fallback in tied else sorted(tied)[0]


def strip_subject(text, lang):
    """Retire le sujet/verbe support en tête quand un personnage est déjà cité (« elle est en train
    de courir » → « courir »). Ne renvoie JAMAIS une chaîne vide : si tout serait mangé, on garde le
    texte d'origine (mieux vaut une requête bavarde qu'une requête absente)."""
    if not text:
        return text
    for prefix in _LEAD_PREFIXES.get(lang, ()):
        if text.startswith(prefix) and len(text) > len(prefix):
            return strip_subject(text[len(prefix):].strip(), lang)
    lead = _LEAD_TOKENS.get(lang)
    if not lead:
        return text
    spans = [(m.start(), m.end()) for m in _TOKEN_RE.finditer(text)]
    kept = 0
    for start, end in spans[:_MAX_LEAD_TOKENS]:
        if _fold(text[start:end]) not in lead:
            break
        kept += 1
    if not kept or kept >= len(spans):
        return text
    return text[spans[kept][0]:].strip()


def build_views(text, lang, character=False):
    """Vues à embedder pour UNE requête : [(texte, poids)] — la requête nue plus deux cadrages dans
    sa langue. Moyennées puis re-normalisées par l'appelant → un vecteur robuste à la tournure."""
    core = (text or "").strip()
    if not core:
        return []
    lang = lang if lang in _TEMPLATES else DEFAULT_LANG
    kind = "character" if character else "scene"
    views = [(core, BARE_WEIGHT)]
    if TEMPLATE_WEIGHT <= 0:
        return views
    seen = {core}
    for template in _TEMPLATES[lang][kind]:
        framed = template.format(q=core)
        if framed not in seen:
            seen.add(framed)
            views.append((framed, TEMPLATE_WEIGHT))
    return views


def prepare(text, ui_lang=None, character=False):
    """Chaîne complète : brut → (vues, langue). `character` = un @perso est cité (le pool est déjà
    filtré sur l'identité) → le sujet redondant saute et le cadrage parle d'un personnage."""
    cleaned = normalize(text)
    lang = detect_lang(cleaned, ui_lang)
    if character:
        cleaned = strip_subject(cleaned, lang)
    return build_views(cleaned, lang, character), lang
