// @ts-check
// Résolution de la LANGUE d'une piste audio (module pur, zéro I/O). Un fichier a souvent plusieurs
// pistes (VO japonaise, VF, VOSTFR…) étiquetées de façon incohérente (jpn / Japanese / japonais / ja
// / 日本語). On normalise ces variantes vers un CODE canonique (ISO 639-1) pour choisir toujours la
// même piste quel que soit l'étiquetage. Le repli ML (deviner à l'oreille) vit côté sidecar : ce
// module ne fait que la normalisation + la sélection sur des métadonnées déjà sondées.
/**
 * @typedef {object} AudioTrackInfo
 * @property {number} index   index relatif (a:N)
 * @property {string} [codec]
 * @property {number} [channels]
 * @property {string|null} [lang]   tag `language` brut (jpn/eng/und…)
 * @property {string|null} [title]  titre de piste brut (« Japanese 5.1 », « VF »…)
 */

// Langues canoniques (code ISO 639-1) + toutes les variantes rencontrées dans les tags/titres :
// ISO 639-1/2, nom anglais, nom français, endonyme, abréviations de doublage courantes. Tout en
// minuscules, comparé après normalisation (trim + lowercase). L'ordre des langues = ordre du menu.
const LANGUAGES = [
  { code: 'ja', label: 'Japonais', variants: ['ja', 'jpn', 'jp', 'jap', 'japanese', 'japonais', 'nihongo', '日本語', '日本', 'vo', 'vostfr'] },
  { code: 'en', label: 'Anglais', variants: ['en', 'eng', 'english', 'anglais', 'vostfr-en'] },
  { code: 'fr', label: 'Français', variants: ['fr', 'fra', 'fre', 'french', 'francais', 'français', 'vf', 'vff', 'vfq', 'truefrench', 'vf2'] },
  { code: 'es', label: 'Espagnol', variants: ['es', 'spa', 'esp', 'spanish', 'espagnol', 'espanol', 'español', 'castellano', 'latino'] },
  { code: 'de', label: 'Allemand', variants: ['de', 'deu', 'ger', 'german', 'allemand', 'deutsch'] },
  { code: 'it', label: 'Italien', variants: ['it', 'ita', 'italian', 'italien', 'italiano'] },
  { code: 'pt', label: 'Portugais', variants: ['pt', 'por', 'portuguese', 'portugais', 'portugues', 'português', 'pt-br', 'ptbr', 'brasil'] },
  { code: 'ru', label: 'Russe', variants: ['ru', 'rus', 'russian', 'russe', 'русский'] },
  { code: 'zh', label: 'Chinois', variants: ['zh', 'zho', 'chi', 'chinese', 'chinois', 'mandarin', 'cmn', 'zh-cn', 'zh-hans', 'zh-hant', '中文', '普通话'] },
  { code: 'ko', label: 'Coréen', variants: ['ko', 'kor', 'korean', 'coreen', 'coréen', '한국어', '한국말'] },
  { code: 'ar', label: 'Arabe', variants: ['ar', 'ara', 'arabic', 'arabe', 'العربية'] },
  { code: 'hi', label: 'Hindi', variants: ['hi', 'hin', 'hindi'] },
];

// Index inverse variante → code (exact) + liste de mots pour le repérage dans un titre libre.
const EXACT = new Map();
/** @type {{ code: string, word: string }[]} */
const WORDS = [];
for (const l of LANGUAGES) {
  for (const v of l.variants) {
    const w = v.toLowerCase();
    EXACT.set(w, l.code);
    // Mots ≥ 3 caractères → repérables par sous-chaîne dans un titre (« Japanese 5.1 »). Les codes très
    // courts (ja/fr/vo) sont trop ambigus en sous-chaîne → réservés au match EXACT du tag.
    if (w.length >= 3 && !/^\d/.test(w)) WORDS.push({ code: l.code, word: w });
  }
}
// Plus longs d'abord → « portugues » l'emporte sur « pt » ; évite les collisions partielles.
WORDS.sort((a, b) => b.word.length - a.word.length);

/** Nettoie une chaîne brute → minuscules, sans espaces de bord. @param {string|null|undefined} s */
function clean(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

/**
 * Normalise une étiquette de langue (tag OU chaîne libre) → code canonique, ou null si inconnue.
 * D'abord un match EXACT (tag propre : « jpn », « ja »), sinon un repérage par MOT dans une chaîne
 * libre (titre : « Japanese Audio », « Piste FR »). Les codes très courts ne sont matchés qu'en exact.
 * @param {string|null|undefined} raw @returns {string|null}
 */
function normalizeLang(raw) {
  const s = clean(raw);
  if (!s) return null;
  if (EXACT.has(s)) return EXACT.get(s);
  // « und » / « unknown » = explicitement non défini → pas de langue.
  if (s === 'und' || s === 'unknown' || s === 'mul' || s === 'zxx') return null;
  // Titre libre : cherche un mot de langue en sous-chaîne, séparé par une frontière non alphabétique.
  for (const { code, word } of WORDS) {
    const i = s.indexOf(word);
    if (i < 0) continue;
    const before = i === 0 ? '' : s[i - 1];
    const after = i + word.length >= s.length ? '' : s[i + word.length];
    const isBoundary = (c) => c === '' || !/[a-zà-ÿ]/.test(c);
    if (isBoundary(before) && isBoundary(after)) return code;
  }
  return null;
}

/**
 * Code de langue d'une piste : le tag `language` d'abord (le plus fiable), puis le titre libre.
 * @param {AudioTrackInfo} track @returns {string|null}
 */
function trackLangCode(track) {
  if (!track) return null;
  return normalizeLang(track.lang) || normalizeLang(track.title);
}

/**
 * Choisit l'index (a:N) de la piste dont la langue = `code`, sur les seules MÉTADONNÉES. -1 si
 * aucune piste étiquetée ne correspond (l'appelant tentera le repli ML sur les pistes non étiquetées).
 * @param {AudioTrackInfo[]} tracks @param {string} code @returns {number}
 */
function pickTrackByLanguage(tracks, code) {
  if (!Array.isArray(tracks) || !code) return -1;
  for (const t of tracks) {
    if (trackLangCode(t) === code) return t.index;
  }
  return -1;
}

module.exports = { LANGUAGES, normalizeLang, trackLangCode, pickTrackByLanguage };
