// Mentions @perso dans la requête de recherche. Le texte de la barre EST la source de vérité :
// un jeton « @Nom » y reste littéral, et on en extrait les personnages cités au moment de chercher.
// Plusieurs @perso dans une phrase = intersection côté backend (plans réunissant TOUS les persos).
//
// L'appariement est TOLÉRANT : insensible à la casse, aux accents et à la ponctuation, et un PRÉFIXE
// de nom suffit s'il ne désigne qu'un personnage (« @Violet » → « Violet Evergarden »). Sans cela un
// nom tapé de mémoire ne citait personne : le jeton partait tel quel dans la requête SigLIP, qui
// cherchait alors le MOT (« violet » → la couleur) au lieu de filtrer sur le personnage.
// Un jeton qui ne désigne personne est RETIRÉ du texte et remonté dans `unknown` (l'appelant en
// avertit) : le garder empoisonnait silencieusement la recherche.

export interface MentionChar {
  id: number;
  name: string;
  color?: string;
  avatar?: string | null;
}

// Un personnage cité + ce qui a réellement été tapé (le texte peut porter un préfixe du nom).
interface MentionMatch extends MentionChar {
  token: string;   // texte tapé après le @
  start: number;   // index du @ dans la requête
  end: number;     // index après le dernier caractère consommé (espace de séparation compris)
}

export interface ParsedMentions {
  ids: number[];            // ids des persos cités (ordre d'apparition, dédoublonnés)
  mentions: MentionMatch[];  // mêmes persos, pour l'affichage des pastilles
  cleanText: string;        // requête sans les jetons @ → texte SigLIP pur
  unknown: string[];        // jetons @xxx ne désignant aucun personnage (retirés du texte)
}

const MAX_NAME_TOKENS = 5;   // au-delà, ce n'est plus un nom mais la phrase qui suit
// Mot d'un nom : lettres/chiffres, éventuellement liés par apostrophe, point ou trait d'union.
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’.\-_]*/gu;
const NON_WORD_RE = /[^\p{L}\p{N}]+/gu;

// Un @ n'ouvre une mention que s'il est en début de chaîne ou précédé d'une espace (évite les
// e-mails « a@b » et les @ collés dans un mot).
function isBoundary(text: string, idx: number): boolean {
  return idx === 0 || /\s/.test(text[idx - 1]);
}

// Forme de comparaison : minuscules, sans accents, ponctuation ramenée à une espace.
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(NON_WORD_RE, " ")
    .trim();
}

interface Word { text: string; start: number; end: number }

// Mots qui suivent le @, tant qu'ils ne sont séparés que par UNE espace : une virgule, un point ou
// un saut de ligne ferme le nom (« @Violet, elle court » ne cite pas « Violet elle »).
function wordsAfter(text: string, from: number): Word[] {
  WORD_RE.lastIndex = from;
  const words: Word[] = [];
  let cursor = from;
  for (let m = WORD_RE.exec(text); m; m = WORD_RE.exec(text)) {
    const gap = text.slice(cursor, m.index);
    if (words.length > 0 && gap !== " ") break;
    if (words.length === 0 && gap !== "") break;
    words.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    cursor = m.index + m[0].length;
    if (words.length >= MAX_NAME_TOKENS) break;
  }
  WORD_RE.lastIndex = 0;
  return words;
}

// Personnage désigné par les `count` premiers mots : nom exact d'abord, sinon UNIQUE nom dont ils
// forment le début (à la frontière d'un mot). Ambigu = pas de mention (on ne devine pas à la place
// de l'utilisateur).
function charFor(words: Word[], count: number, roster: MentionChar[]): MentionChar | null {
  const key = fold(words.slice(0, count).map((w) => w.text).join(" "));
  if (!key) return null;
  const exact = roster.find((c) => c.name && fold(c.name) === key);
  if (exact) return exact;
  const prefixed = roster.filter((c) => c.name && fold(c.name).startsWith(key + " "));
  return prefixed.length === 1 ? prefixed[0] : null;
}

// Mention à la position `at` (index du @) : le nom le plus LONG gagne (« @Violet Evergarden » avant
// « @Violet »). null = aucun personnage ne correspond.
function matchAt(text: string, at: number, roster: MentionChar[]): MentionMatch | null {
  const words = wordsAfter(text, at + 1);
  for (let count = words.length; count >= 1; count--) {
    const found = charFor(words, count, roster);
    if (!found) continue;
    const stop = words[count - 1].end;
    return {
      ...found,
      token: text.slice(at + 1, stop),
      start: at,
      end: text[stop] === " " ? stop + 1 : stop,   // avale l'espace de séparation → pas de double espace
    };
  }
  return null;
}

export function parseMentions(text: string, roster: MentionChar[]): ParsedMentions {
  const seen = new Set<number>();
  const mentions: MentionMatch[] = [];
  const unknown: string[] = [];
  let clean = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "@" && isBoundary(text, i)) {
      const hit = matchAt(text, i, roster);
      if (hit) {
        if (!seen.has(hit.id)) { seen.add(hit.id); mentions.push(hit); }
        i = hit.end;
        continue;
      }
      const words = wordsAfter(text, i + 1);
      if (words.length) {   // « @quelqu'un » inconnu : on le sort du texte et on le signale
        unknown.push(words[0].text);
        i = text[words[0].end] === " " ? words[0].end + 1 : words[0].end;
        continue;
      }
    }
    clean += text[i];
    i += 1;
  }
  return {
    ids: mentions.map((m) => m.id),
    mentions,
    cleanText: clean.replace(/\s+/g, " ").trim(),
    unknown,
  };
}

// Mention en cours de frappe au curseur : dernier @ frontière avant le curseur, sans @ ni saut de
// ligne entre lui et le curseur. `query` = ce qui suit le @ (peut contenir des espaces pour les noms
// composés) → le sélecteur filtre le roster dessus. null = pas de mention active (popover fermé).
export function detectMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  let at = -1;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") { at = i; break; }
    if (ch === "\n") return null;
  }
  if (at < 0 || !isBoundary(text, at)) return null;
  const query = text.slice(at + 1, caret);
  if (query.includes("@")) return null;
  return { start: at, query };
}

// Remplace le fragment « @query » (de `start` au curseur) par « @Nom » suivi d'une espace.
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const head = text.slice(0, start) + "@" + name + " ";
  return { text: head + text.slice(caret), caret: head.length };
}

// Retire de la requête le jeton qui désigne CE personnage (croix d'une pastille de mention). On
// repasse par l'analyse plutôt que par le nom : le jeton tapé peut n'en être qu'un préfixe.
export function removeMention(text: string, charId: number, roster: MentionChar[]): string {
  const hit = parseMentions(text, roster).mentions.find((m) => m.id === charId);
  if (!hit) return text;
  return (text.slice(0, hit.start) + text.slice(hit.end)).replace(/\s+/g, " ").trim();
}
