// @ts-check
// Capacités NATIVES du contrat public de chaque hôte. Les propriétés CEP variables exigent en plus
// un sondage runtime ; l'absence au sondage remplace `exact` par `unsupported`, jamais par une réussite.

const CAPABILITY_EXACT = "exact";
const CAPABILITY_APPROX = "approx";
const CAPABILITY_BAKE = "bake";
const CAPABILITY_UNSUPPORTED = "unsupported";

const BASE = {
  "clip.media": CAPABILITY_EXACT,
  "clip.trim": CAPABILITY_EXACT,
  "clip.position": CAPABILITY_EXACT,
  "clip.track": CAPABILITY_EXACT,
};

const VIDEO = [
  "video.position", "video.scale", "video.anchor", "video.rotation", "video.opacity",
  "video.flip", "video.crop",
];
const VIDEO_KEYS = VIDEO.slice(0, 5).map((property) => `${property}.keyframes`);
const AUDIO = ["audio.gain", "audio.volume", "audio.pan", "audio.mute"];
const AUDIO_KEYS = AUDIO.map((property) => `${property}.keyframes`);
const TIMING = ["timing.speed", "timing.reverse", "timing.freeze", "timing.timeMap"];

function entries(keys, value) {
  return Object.fromEntries(keys.map((key) => [key, value]));
}

const OUT_OF_SCOPE = {
  "text": CAPABILITY_UNSUPPORTED,
  "transition": CAPABILITY_UNSUPPORTED,
  "effect": CAPABILITY_UNSUPPORTED,
};

// Un titre est RECRÉÉ chez la cible, jamais copié : le texte, la police, le corps et la couleur
// traversent, mais la mise en page fine (interlettrage, contour, ombre, animation du modèle) n'a
// aucune correspondance d'un logiciel à l'autre. Jamais `exact`, donc, même quand tout se pose.
const RESOLVE_TITLE_RUNTIME = { "text": CAPABILITY_APPROX };

// Resolve : l'API de script ne KEYFRAME rien (vérifié jusqu'à l'API v21 — SetProperty pose une
// valeur fixe, aucune méthode d'image clé n'existe sur TimelineItem) et n'expose AUCUNE commande de
// gain, panoramique ou coupure audio. Une comp Fusion posée sur le plan est la seule voie d'écriture
// d'une animation ; elle relève le contrat par `runtime` quand le writer l'emprunte.
const MATRICES = {
  resolve: {
    ...BASE,
    ...entries(VIDEO, CAPABILITY_EXACT),
    ...entries(VIDEO_KEYS, CAPABILITY_UNSUPPORTED),
    ...entries(AUDIO, CAPABILITY_UNSUPPORTED),
    ...entries(AUDIO_KEYS, CAPABILITY_UNSUPPORTED),
    ...entries(TIMING, CAPABILITY_UNSUPPORTED),
    ...OUT_OF_SCOPE,
  },
  ppro: {
    ...BASE,
    ...entries(VIDEO, CAPABILITY_EXACT),
    ...entries(VIDEO_KEYS, CAPABILITY_EXACT),
    ...entries(AUDIO, CAPABILITY_EXACT),
    ...entries(AUDIO_KEYS, CAPABILITY_EXACT),
    // Le niveau de Premiere est en dB ; la correspondance d'un volume LINÉAIRE n'est pas documentée.
    "audio.volume": CAPABILITY_UNSUPPORTED,
    "audio.volume.keyframes": CAPABILITY_UNSUPPORTED,
    ...entries(TIMING, CAPABILITY_UNSUPPORTED),
    ...OUT_OF_SCOPE,
  },
  aeft: {
    ...BASE,
    ...entries(VIDEO, CAPABILITY_EXACT),
    ...entries(VIDEO_KEYS, CAPABILITY_EXACT),
    // Un calque AE n'a ni recadrage (il faut un masque) ni panoramique.
    "video.crop": CAPABILITY_UNSUPPORTED,
    ...entries(AUDIO, CAPABILITY_UNSUPPORTED),
    ...entries(AUDIO_KEYS, CAPABILITY_UNSUPPORTED),
    "audio.gain": CAPABILITY_EXACT,
    "audio.gain.keyframes": CAPABILITY_EXACT,
    "audio.mute": CAPABILITY_EXACT,
    "timing.speed": CAPABILITY_EXACT,
    "timing.reverse": CAPABILITY_EXACT,
    "timing.freeze": CAPABILITY_EXACT,
    "timing.timeMap": CAPABILITY_EXACT,
    ...OUT_OF_SCOPE,
  },
};

/**
 * Contrat relevé quand l'écrivain Resolve peut poser une comp Fusion : elle porte les images clés
 * des transformations ET le contenu d'un titre inséré, deux écritures qu'aucune autre voie n'offre.
 */
const RESOLVE_FUSION_RUNTIME = {
  ...entries(VIDEO_KEYS, CAPABILITY_EXACT),
  ...RESOLVE_TITLE_RUNTIME,
};

/**
 * @param {import('./types').TransferHost} host
 * @param {Record<string, string>|null|undefined} runtime sondage writer/CEP optionnel
 */
function capabilitiesFor(host, runtime) {
  const base = MATRICES[host] || {};
  return { ...base, ...(runtime || {}) };
}

module.exports = {
  CAPABILITY_EXACT, CAPABILITY_APPROX, CAPABILITY_BAKE, CAPABILITY_UNSUPPORTED,
  capabilitiesFor, RESOLVE_FUSION_RUNTIME,
};
