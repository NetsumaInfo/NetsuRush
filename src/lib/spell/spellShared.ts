// Modèle partagé du correcteur orthographique (Carnet + Script). PUR : aucun accès DOM, worker ou
// store — le tokenizer est testable et réutilisable des deux côtés du worker.
//
// Pourquoi un correcteur maison : le correcteur NATIF de la WebView souligne les fautes mais ses
// suggestions ne vivent QUE dans le menu contextuel du navigateur — or l'app supprime ce menu partout
// (ViewContextMenu). L'utilisateur voyait donc des soulignements sans jamais pouvoir corriger.

export type SpellLang = "fr" | "en";

// Langues avec dictionnaire embarqué. Les autres (es/de/ja/zh) retombent sur le correcteur natif :
// les dictionnaires Hunspell correspondants sont sous licence GPL, incompatible avec la distribution
// de l'app — mieux vaut un soulignement natif qu'un dictionnaire qu'on n'a pas le droit d'embarquer.
const SPELL_LANGS: readonly SpellLang[] = ["fr", "en"] as const;

export function supportedSpellLang(language: string | null | undefined): SpellLang | null {
  const base = String(language || "").slice(0, 2).toLowerCase();
  return (SPELL_LANGS as readonly string[]).includes(base) ? (base as SpellLang) : null;
}

// Un mot candidat repéré dans un texte, avec ses bornes ABSOLUES dans le document.
// `parts` = découpe secondaire d'un mot composé : si le tout est inconnu, on ne souligne que les
// segments fautifs (« blabla-truc » → seul « blabla » est souligné).
export interface SpellToken {
  word: string;
  from: number;
  to: number;
  parts?: SpellToken[];
}

const MIN_WORD_LEN = 2;
const MAX_WORD_LEN = 40;

// Élisions françaises : le segment avant l'apostrophe n'est pas un mot à vérifier (« l'été »,
// « jusqu'à »). Hors de cette liste, l'apostrophe est INTERNE au mot (« aujourd'hui », « O'Brien »)
// et le token reste entier — le découper produisait « aujourd » comme faute.
const ELISIONS = new Set(["c", "d", "j", "l", "m", "n", "s", "t", "y", "qu", "jusqu", "lorsqu", "puisqu", "quoiqu", "quelqu"]);

// Zones jamais orthographiées : URL, e-mail, chemin de fichier, couleur hexadécimale, identifiant
// à underscore. Elles contiennent des lettres mais ne sont pas de la langue.
const SKIP_RE = /(?:[a-z][\w+.-]*:\/\/|www\.)\S+|[\w.%+-]+@[\w.-]+\.\p{L}{2,}|(?:[A-Za-z]:)?[\\/][^\s]*[\\/]\S*|#[0-9a-fA-F]{3,8}\b|\w*_\w+/giu;

// Un mot = une lettre suivie de lettres, marques diacritiques, apostrophes ou traits d'union.
const WORD_RE = /\p{L}[\p{L}\p{M}'’\-]*/gu;

// Rejette ce qui n'est pas de la prose : sigles (ADN), casse interne (NetsuRush, camelCase),
// mots trop courts ou absurdement longs.
function isCheckable(word: string): boolean {
  if (word.length < MIN_WORD_LEN || word.length > MAX_WORD_LEN) return false;
  if (word === word.toUpperCase() && word !== word.toLowerCase()) return false; // sigle
  if (/\p{Ll}\p{Lu}/u.test(word)) return false;                                  // casse interne
  return true;
}

// Normalise l'apostrophe typographique : les dictionnaires Hunspell stockent l'apostrophe droite.
function normalize(word: string): string {
  return word.replace(/’/g, "'");
}

function trimEdges(raw: string, from: number): { word: string; from: number; to: number } | null {
  let start = 0;
  let end = raw.length;
  while (start < end && /['’\-]/.test(raw[start])) start++;
  while (end > start && /['’\-]/.test(raw[end - 1])) end--;
  if (end <= start) return null;
  return { word: normalize(raw.slice(start, end)), from: from + start, to: from + end };
}

// Découpe un token sur ses traits d'union (mot composé). Renvoie null si le mot n'en contient pas.
function hyphenParts(word: string, from: number): SpellToken[] | null {
  if (!word.includes("-")) return null;
  const out: SpellToken[] = [];
  let cursor = 0;
  for (const seg of word.split("-")) {
    if (seg && isCheckable(seg)) out.push({ word: seg, from: from + cursor, to: from + cursor + seg.length });
    cursor += seg.length + 1;
  }
  return out.length ? out : null;
}

// Retire l'élision de tête (« l'été » → « été »), en conservant les bornes exactes.
function stripElision(token: { word: string; from: number; to: number }): { word: string; from: number; to: number } {
  const cut = token.word.indexOf("'");
  if (cut <= 0) return token;
  const prefix = token.word.slice(0, cut).toLowerCase();
  if (!ELISIONS.has(prefix)) return token; // apostrophe interne (aujourd'hui) → mot entier
  return { word: token.word.slice(cut + 1), from: token.from + cut + 1, to: token.to };
}

/**
 * Repère les mots vérifiables d'un texte. `offset` = position du texte dans le document, reportée
 * sur toutes les bornes renvoyées (le plugin ProseMirror travaille en positions absolues).
 */
export function tokenize(text: string, offset = 0): SpellToken[] {
  const skipped: [number, number][] = [];
  SKIP_RE.lastIndex = 0;
  for (let m = SKIP_RE.exec(text); m; m = SKIP_RE.exec(text)) skipped.push([m.index, m.index + m[0].length]);
  const inSkipped = (start: number, end: number) => skipped.some(([s, e]) => start < e && end > s);

  const out: SpellToken[] = [];
  WORD_RE.lastIndex = 0;
  for (let m = WORD_RE.exec(text); m; m = WORD_RE.exec(text)) {
    if (inSkipped(m.index, m.index + m[0].length)) continue;
    const trimmed = trimEdges(m[0], m.index);
    if (!trimmed) continue;
    const token = stripElision(trimmed);
    if (!isCheckable(token.word)) continue;
    const parts = hyphenParts(token.word, token.from);
    out.push({ word: token.word, from: token.from + offset, to: token.to + offset, parts: parts?.map((p) => ({ ...p, from: p.from + offset, to: p.to + offset })) });
  }
  return out;
}

/** Tous les mots à soumettre au dictionnaire pour un lot de tokens (composés inclus, dédupliqués). */
export function wordsOf(tokens: readonly SpellToken[]): string[] {
  const set = new Set<string>();
  for (const t of tokens) {
    set.add(t.word);
    for (const p of t.parts || []) set.add(p.word);
  }
  return [...set];
}

/**
 * Bornes à souligner, connaissant l'ensemble des mots jugés fautifs. Un composé dont TOUS les
 * segments échouent est souligné en entier ; sinon seuls les segments fautifs le sont.
 */
export function badRanges(tokens: readonly SpellToken[], bad: ReadonlySet<string>): SpellToken[] {
  const out: SpellToken[] = [];
  for (const t of tokens) {
    if (!bad.has(t.word)) continue;
    const parts = t.parts;
    if (!parts?.length) { out.push(t); continue; }
    const failing = parts.filter((p) => bad.has(p.word));
    if (failing.length === parts.length) out.push(t);
    else out.push(...failing);
  }
  return out;
}

// ---- Messages du worker ------------------------------------------------------------------------
export type SpellRequest =
  | { type: "load"; lang: SpellLang; aff: ArrayBuffer; dic: ArrayBuffer; personal: string[] }
  | { type: "check"; id: number; lang: SpellLang; words: string[] }
  | { type: "suggest"; id: number; lang: SpellLang; word: string }
  | { type: "personal"; lang: SpellLang; words: string[] };

export type SpellResponse =
  | { type: "loaded"; lang: SpellLang }
  | { type: "failed"; lang: SpellLang; error: string }
  | { type: "check"; id: number; bad: string[] }
  | { type: "suggest"; id: number; suggestions: string[] };
