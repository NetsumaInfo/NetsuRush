// @ts-check
// core/netsu/levels.js
// Niveaux d'embarquement d'un média dans un fichier .netsu — logique PURE, zéro I/O.
//
// Un board de référence porte des vidéos. Recopier la source dans le fichier est presque toujours
// absurde : l'item ne joue qu'une boucle de quelques secondes, souvent extraite d'un rush de 2 Go.
// Le niveau dit CE QU'ON GARDE du média, du plus léger au plus lourd :
//
//   link    → rien du média, juste de quoi le retrouver (+ une image de poster)
//   preview → la plage jouée, réencodée petit                            ← défaut
//   margin  → la plage jouée ÉLARGIE, pour pouvoir rogner/allonger après coup sans l'original
//   full    → le fichier source entier
//
// La qualité et la marge sont des RÉGLAGES, pas des niveaux : elles ne changent pas ce qu'on garde,
// seulement sa finesse et son amplitude. Ce module ne produit aucun octet — il décrit ce qu'il
// faudra produire (`planEmbed`) et ce que ça pèsera (`estimateBytes`). Tout l'encodage vit dans
// core/netsu/embed.js, ce qui rend les règles ci-dessous testables sans ffmpeg.

/** @typedef {'link'|'preview'|'margin'|'full'} EmbedLevel */
/** @typedef {'eco'|'standard'|'high'} EmbedQuality */
/** @typedef {'none'|'link'|'clip'|'file'} EmbedMode */

const EMBED_LEVELS = /** @type {EmbedLevel[]} */ (['link', 'preview', 'margin', 'full']);
const DEFAULT_LEVEL = /** @type {EmbedLevel} */ ('preview');

// Les réglages d'encodage sont ceux des proxies de lecture (core/proxyEncoder.js) : hauteurs
// snappées aux paliers déjà utilisés et presets level1/2/3 (cq 30/27/23). Un seul vocabulaire
// d'encodage dans l'app — un second jeu de valeurs finirait par diverger.
const EMBED_QUALITIES = {
  eco: { height: 360, preset: 'level1' },
  standard: { height: 520, preset: 'level2' },
  high: { height: 720, preset: 'level3' },
};
const DEFAULT_QUALITY = /** @type {EmbedQuality} */ ('standard');

const DEFAULT_MARGIN_SEC = 2;
const MAX_MARGIN_SEC = 30;

// Au-delà, l'item embarqué pèsera lourd quel que soit le réglage (vidéo posée sans bornes de
// boucle, par exemple). On le SIGNALE au lieu de rogner en douce : une troncature silencieuse
// ferait croire à un board complet alors qu'il manquerait des images.
const LONG_CLIP_SEC = 120;

// Kinds qui portent un média local embarquable.
const MEDIA_KINDS = new Set(['image', 'video', 'sequence']);
// Kinds dont le contenu vit chez un tiers : il n'y a rien à embarquer, jamais.
const REMOTE_KINDS = new Set(['youtube', 'embed']);

// Poster = une image fixe encodée petite ; sa taille varie peu, une constante suffit à l'estimation.
const POSTER_BYTES = 48 * 1024;
// Une image posée sur le board pèse en général quelques centaines de Ko ; sert de repli quand la
// taille réelle du fichier n'est pas connue au moment de l'estimation.
const IMAGE_FALLBACK_BYTES = 400 * 1024;

// Débits vidéo observés (kbit/s) par hauteur et preset. Servent UNIQUEMENT à l'estimation affichée
// à l'utilisateur : le poids réel dépend de la source (une scène fixe compresse bien mieux qu'un
// panoramique). L'UI doit donc les présenter comme un ordre de grandeur, jamais comme une promesse.
const VIDEO_KBPS = {
  360: { level1: 500, level2: 700, level3: 1000 },
  520: { level1: 900, level2: 1300, level3: 1800 },
  720: { level1: 1600, level2: 2200, level3: 3000 },
};
const AUDIO_KBPS = 128;

/** @param {unknown} value @returns {EmbedLevel} */
function normalizeLevel(value) {
  const level = String(value || '');
  return EMBED_LEVELS.includes(/** @type {EmbedLevel} */ (level))
    ? /** @type {EmbedLevel} */ (level)
    : DEFAULT_LEVEL;
}

/** @param {unknown} value @returns {EmbedQuality} */
function normalizeQuality(value) {
  const quality = String(value || '');
  return quality in EMBED_QUALITIES ? /** @type {EmbedQuality} */ (quality) : DEFAULT_QUALITY;
}

/** @param {unknown} value @returns {number} */
function normalizeMargin(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_MARGIN_SEC;
  return Math.min(seconds, MAX_MARGIN_SEC);
}

/**
 * Plage à extraire, marge comprise, TOUJOURS dans les bornes du média : demander 2 s avant un plan
 * qui commence à 0,5 s ne doit pas produire un début négatif (ffmpeg rendrait un fichier vide).
 * Une durée inconnue (0) laisse la fin libre — c'est le sondeur qui tranchera.
 * @param {{ in?: number|null, out?: number|null, duration?: number|null, marginSec?: number }} range
 * @returns {{ start: number, end: number }}
 */
function clampRange(range) {
  const duration = Number(range.duration) > 0 ? Number(range.duration) : 0;
  const margin = normalizeMargin(range.marginSec != null ? range.marginSec : 0);
  const rawIn = Number(range.in);
  const rawOut = Number(range.out);
  const hasIn = Number.isFinite(rawIn);
  const hasOut = Number.isFinite(rawOut) && rawOut > 0;

  const start = Math.max(0, (hasIn ? rawIn : 0) - margin);
  const wanted = (hasOut ? rawOut : duration) + margin;
  const end = duration > 0 ? Math.min(duration, wanted) : wanted;
  // Bornes croisées (item corrompu, out < in) : on rend une plage vide plutôt qu'inversée.
  return { start, end: Math.max(start, end) };
}

/**
 * Ce qu'il faudra produire pour cet item, sans rien produire. `embed.js` exécute ce descripteur.
 * @param {{ kind?: string, ref?: string, trimIn?: number|null, trimOut?: number|null, dur?: number|null }} item
 * @param {{ level?: unknown, quality?: unknown, marginSec?: unknown, duration?: number|null }} [opts]
 * @returns {{ mode: EmbedMode, level: EmbedLevel, quality: EmbedQuality, marginSec: number,
 *             poster: boolean, wholeFile: boolean, long: boolean,
 *             clip: { start: number, end: number, height: number, preset: string }|null }}
 */
function planEmbed(item, opts) {
  const options = opts || {};
  const level = normalizeLevel(options.level);
  const quality = normalizeQuality(options.quality);
  const marginSec = level === 'margin' ? normalizeMargin(options.marginSec) : 0;
  const base = { level, quality, marginSec, poster: false, wholeFile: false, long: false, clip: null };

  const kind = String(item.kind || '');
  // Note, cadre, tracé : aucun média. Lien YouTube/embed : le contenu n'est pas à nous.
  if (!MEDIA_KINDS.has(kind) || REMOTE_KINDS.has(kind)) return { ...base, mode: 'none' };
  if (level === 'link') return { ...base, mode: 'link', poster: true };

  // Une image (ou une frame de séquence) n'a pas de plage : les trois niveaux embarqués la
  // recopient telle quelle. La réencoder pour gagner quelques Ko abîmerait une référence visuelle.
  if (kind !== 'video') return { ...base, mode: 'file', wholeFile: true };
  if (level === 'full') return { ...base, mode: 'file', wholeFile: true };

  const duration = Number(options.duration) > 0 ? Number(options.duration) : Number(item.dur) || 0;
  const { start, end } = clampRange({
    in: item.trimIn, out: item.trimOut, duration, marginSec,
  });
  const { height, preset } = EMBED_QUALITIES[quality];
  return {
    ...base,
    mode: 'clip',
    poster: true,
    long: end - start > LONG_CLIP_SEC,
    clip: { start, end, height, preset },
  };
}

/** @param {number} height @param {string} preset @returns {number} octets par seconde */
function clipBytesPerSecond(height, preset) {
  const row = VIDEO_KBPS[height] || VIDEO_KBPS[520];
  const kbps = (row[preset] || row.level2) + AUDIO_KBPS;
  return (kbps * 1000) / 8;
}

/**
 * Ordre de grandeur du poids du média embarqué, pour que l'utilisateur voie ce qu'il fabrique
 * AVANT de lancer l'export. Jamais présenté comme exact (cf. VIDEO_KBPS).
 * @param {ReturnType<typeof planEmbed>} plan
 * @param {{ sourceSize?: number|null }} [info]
 * @returns {number} octets
 */
function estimateBytes(plan, info) {
  const sourceSize = Number((info || {}).sourceSize) || 0;
  if (plan.mode === 'none') return 0;
  if (plan.mode === 'link') return POSTER_BYTES;
  if (plan.mode === 'file') return sourceSize > 0 ? sourceSize : IMAGE_FALLBACK_BYTES;
  if (!plan.clip) return POSTER_BYTES;
  const seconds = Math.max(0, plan.clip.end - plan.clip.start);
  return POSTER_BYTES + Math.round(seconds * clipBytesPerSecond(plan.clip.height, plan.clip.preset));
}

module.exports = {
  EMBED_LEVELS,
  EMBED_QUALITIES,
  DEFAULT_LEVEL,
  DEFAULT_QUALITY,
  DEFAULT_MARGIN_SEC,
  MAX_MARGIN_SEC,
  LONG_CLIP_SEC,
  normalizeLevel,
  normalizeQuality,
  normalizeMargin,
  clampRange,
  planEmbed,
  estimateBytes,
};
