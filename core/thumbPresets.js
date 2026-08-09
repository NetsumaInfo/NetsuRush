// @ts-check
// Crans de qualité des miniatures — SOURCE UNIQUE du mapping cran → paramètres d'encodage.
// Module PUR (zéro I/O) : `thumbs.js` en tire les arguments ffmpeg et la clé de cache, `cacheAdmin.js`
// en tire la liste des variantes à purger. Les deux dérivaient de listes écrites en dur, qui pouvaient
// diverger silencieusement — une divergence laisse des vignettes orphelines introuvables.
//
// Un cran pilote la hauteur ET la compression : l'utilisateur arbitre « plus léger / plus net », jamais
// un nombre. Calage entre codecs : à cran égal, JPEG et WebP visent le MÊME rendu perçu (WebP est plus
// efficace à qualité nominale égale, d'où des valeurs volontairement différentes et non un score commun).
//
// `webpEffort` (= `-compression_level`, 0..6) ne touche PAS la qualité : il échange du temps
// d'encodage contre de la taille, à qualité constante. Le monter sur le cran net n'achèterait donc
// rien de perceptible. Mesuré (480p, q80, 12 tirages, plancher spawn+seek+scale ≈ 73 ms) : le genou
// est à 2 — au-delà, +9 à +21 ms pour 4 à 6 % de taille, et 5/6 ne gagnent plus rien du tout. Les
// vignettes sont générées par milliers et saturent déjà le CPU (THUMB_MAX ≈ cœurs/2) : les
// millisecondes comptent, le demi-kilo-octet non. D'où le genou sur les trois crans.

/** @typedef {'light' | 'balanced' | 'sharp'} ThumbPreset */
/** @typedef {{ height: number, jpegQscale: number, webpQuality: number, webpEffort: number }} ThumbParams */
/** @typedef {'jpeg' | 'webp'} ThumbFormat */

// Coût mesuré par vignette (WebP, source 1080p) : léger 69 ms / 5,3 ko · équilibré 71 ms / 7,9 ko ·
// net 88 ms / 16,4 ko. À réglage égal, JPEG produit ~2,2× plus d'octets pour un temps comparable.
/** @type {Record<ThumbPreset, ThumbParams>} */
const THUMB_PRESETS = {
  light:    { height: 360, jpegQscale: 8, webpQuality: 70, webpEffort: 2 },
  balanced: { height: 480, jpegQscale: 5, webpQuality: 80, webpEffort: 2 },
  sharp:    { height: 720, jpegQscale: 3, webpQuality: 88, webpEffort: 2 },
};

/** @type {ThumbPreset[]} */
const THUMB_PRESET_IDS = ['light', 'balanced', 'sharp'];

/** @type {ThumbFormat[]} */
const THUMB_FORMATS = ['jpeg', 'webp'];

const DEFAULT_PRESET = /** @type {ThumbPreset} */ ('balanced');

// Version du suffixe de clé de cache. Le suffixe encode les paramètres RÉSOLUS (pas l'id du cran) :
// retoucher la table ci-dessus invalide donc le cache toute seule, au lieu de servir des vignettes
// encodées sous d'anciennes valeurs. Bumper cette version quand la FORME du suffixe change.
const KEY_VERSION = 'v3';

// Modèle PRÉCÉDENT (réglage à deux nombres, hauteur + qualité) et sa version de clé. Conservés pour
// deux raisons distinctes : migrer un réglage déjà écrit en localStorage, et retrouver sur disque les
// vignettes écrites avant les crans — leur suffixe a une autre forme, il ne se reconstruit pas en
// passant d'anciens réglages aux fonctions courantes.
const LEGACY_KEY_VERSION = 'v2';
const LEGACY_HEIGHTS = [360, 480, 520, 720];
const LEGACY_QUALITIES = [70, 82, 92];

/** @param {unknown} value @returns {value is ThumbPreset} */
function isThumbPreset(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(THUMB_PRESETS, value);
}

/** @param {unknown} value @returns {ThumbFormat} */
function normalizeThumbFormat(value) {
  // Le repli doit rester aligné sur `normalizePreviewSettings` (renderer) : les deux calculent la même
  // clé de cache, une divergence ferait régénérer chaque vignette à chaque aller-retour.
  return value === 'jpeg' ? 'jpeg' : 'webp';
}

/**
 * Cran correspondant à une hauteur du modèle précédent. 520 rejoint 480 : c'est le palier voisin, et
 * un réglage intermédiaire ne doit pas dégringoler au cran le plus bas.
 * @param {unknown} height
 * @returns {ThumbPreset}
 */
function presetFromLegacyHeight(height) {
  const value = Number(height);
  if (value === 360) return 'light';
  if (value === 720) return 'sharp';
  return DEFAULT_PRESET;
}

/**
 * Résout un réglage utilisateur (nouveau `{preset}` ou ancien `{height, quality}`) en paramètres
 * d'encodage complets. Le repli est le cran équilibré, jamais une erreur : une vignette absente coûte
 * plus cher à l'utilisateur qu'une vignette au mauvais cran.
 * @param {{ format?: unknown, preset?: unknown, height?: unknown } | null | undefined} settings
 * @returns {{ format: ThumbFormat, preset: ThumbPreset } & ThumbParams}
 */
function resolveThumbSettings(settings) {
  const preset = isThumbPreset(settings && settings.preset)
    ? /** @type {ThumbPreset} */ (settings.preset)
    : settings && settings.height != null
      ? presetFromLegacyHeight(settings.height)
      : DEFAULT_PRESET;
  return { format: normalizeThumbFormat(settings && settings.format), preset, ...THUMB_PRESETS[preset] };
}

/** @param {ReturnType<typeof resolveThumbSettings>} resolved @returns {string} */
function thumbKeySuffix(resolved) {
  const { format, height, jpegQscale, webpQuality, webpEffort } = resolved;
  const codec = format === 'webp' ? `q${webpQuality}e${webpEffort}` : `q${jpegQscale}`;
  return `${format}-${height}-${codec}-${KEY_VERSION}`;
}

/** @param {ThumbFormat} format @returns {'jpg' | 'webp'} */
function thumbExt(format) {
  return format === 'webp' ? 'webp' : 'jpg';
}

/**
 * Tous les suffixes de clé sous lesquels une vignette a pu être écrite sur disque, avec leur extension.
 * La purge ciblée (par plage de timeline) reconstruit les chemins de cache : elle doit couvrir les
 * crans COURANTS et le produit cartésien du modèle PRÉCÉDENT, sinon les vignettes générées avant ce
 * changement deviennent des orphelins que plus rien ne sait nommer.
 * @returns {Array<{ suffix: string, ext: 'jpg' | 'webp' }>}
 */
function thumbKeyVariants() {
  const variants = [];
  for (const format of THUMB_FORMATS) {
    const ext = thumbExt(format);
    for (const preset of THUMB_PRESET_IDS) {
      variants.push({ suffix: thumbKeySuffix(resolveThumbSettings({ format, preset })), ext });
    }
    for (const height of LEGACY_HEIGHTS) {
      for (const quality of LEGACY_QUALITIES) {
        variants.push({ suffix: `${format}-${height}-${quality}-${LEGACY_KEY_VERSION}`, ext });
      }
    }
  }
  return variants;
}

module.exports = {
  THUMB_PRESETS,
  THUMB_PRESET_IDS,
  THUMB_FORMATS,
  DEFAULT_PRESET,
  isThumbPreset,
  normalizeThumbFormat,
  presetFromLegacyHeight,
  resolveThumbSettings,
  thumbKeySuffix,
  thumbExt,
  thumbKeyVariants,
};
