// Détection des mots de remplissage / hésitations FR (heuristique, pas de modèle) : liste statique
// + répétitions immédiates (« je je », « le le »). Sert le surlignage et le bouton « retirer les
// hésitations ». Volontairement conservateur : les mots ambigus légitimes (« donc », « alors »,
// « genre » employé comme nom) sont EXCLUS de la liste pour éviter les faux positifs.
import type { VoiceWord, VoiceSpan, FillerSpan, HesitationParams } from "@/lib/bridge";

const HES_DEFAULT: HesitationParams = { sensitivity: 0.5, min_ms: 400, max_ms: 1500, monotone: 0.5, lexical: true, prolongation: true, acoustic: true, markers: false, extraWords: "" };

// Parse les « mots perso » (chaîne séparée par virgule/retour) en formes normalisées.
function parseExtra(extra?: string): Set<string> {
  if (!extra) return new Set();
  return new Set(extra.split(/[,\n;]/).map(normalize).filter(Boolean));
}

// Hésitations pures FR + tics très marqués. Pas de « donc/alors/genre » (trop souvent légitimes).
// MULTILINGUE (formes NORMALISÉES : minuscule, accents retirés). Hésitations pures — PAS de mots de
// discours ambigus (donc/alors/genre/like/du coup/o sea…). « ah/eh » inclus (les « E/A » tenus) :
// risque de faux positifs assumé → l'utilisateur déselectionne au clic dans le panneau CUTS.
// Catégories de mots d'hésitation (« type de mot » paramétrable). Formes NORMALISÉES (minuscule, sans
// accents). L'utilisateur active/désactive chaque catégorie via hesitationParams.wordTypes.
export const FILLER_CATS: Record<string, string[]> = {
  euh: ["euh", "euhh", "euhhh", "heu", "heuu", "heuh", "euhm", "eee"],
  nasal: ["hum", "humm", "hmm", "hmmm", "hm", "mmh", "mmm", "mm", "mhm", "ehm"],
  interj: ["ah", "ahh", "oh", "eh", "ehh", "hein", "ahem", "ahm", "pff", "pfff"],
  tics: ["bah", "ben", "bin", "beh"],
  en: ["um", "umm", "uhm", "uh", "uhh", "er", "err", "erm", "este", "esto"],
};
// Étiquettes courtes pour les chips de catégorie (UI) : clés i18n (namespace "voice"), résolues
// au rendu via t() dans le composant consommateur.
export const FILLER_CAT_LABELS: Record<string, string> = {
  euh: "fillerCats.euh", nasal: "fillerCats.nasal", interj: "fillerCats.interj", tics: "fillerCats.tics", en: "fillerCats.en",
};
type LexParams = { extraWords?: string; wordTypes?: Record<string, boolean> };

// Ensemble actif = union des catégories activées (défaut : toutes) + mots perso.
function activeFillerSet(hp?: LexParams): Set<string> {
  const wt = hp?.wordTypes;
  const set = new Set<string>();
  for (const [k, list] of Object.entries(FILLER_CATS)) {
    if (!wt || wt[k] !== false) for (const w of list) set.add(w);
  }
  for (const w of parseExtra(hp?.extraWords)) set.add(w);
  return set;
}

function normalize(w: string): string {
  return (w || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // accents
    .replace(/[.,!?;:…«»"'’`()\-]/g, "")
    .trim();
}

// Hésitations LEXICALES : mots « euh/heu/hmm… » (catégories activées + mots perso) → spans.
function lexicalFillerSpans(words: VoiceWord[], hp?: LexParams): FillerSpan[] {
  return fillerIndices(words, hp).map((i) => ({ start: words[i].start, end: words[i].end, conf: 1 }));
}

// Mots-outils souvent TRAÎNÉS quand on hésite (« etttt », « laaaa », « doncccc », « jeeee »). L'ASR les
// transcrit comme le mot de base mais avec une durée anormale → on les attrape par la DURÉE (sans audio).
const DRAGGABLE = new Set([
  "et", "euh", "heu", "la", "le", "les", "de", "des", "du", "un", "une", "mais", "donc", "alors", "puis",
  "ou", "que", "qui", "on", "je", "tu", "il", "ben", "bah", "hmm", "hum", "ah", "eh", "um", "uh", "y", "à",
  "so", "and", "like", "that", "the", "a",
]);

// Hésitations par PROLONGATION : un mot TENU trop longtemps = son traîné (« je reste prolongé dans un
// mot »). Pas d'audio requis (durée des timestamps). 3 règles cumulées pour un recall large :
//  1. mot-outil traîné (et/la/donc… ≥ 0.42 s) — l'hésitation classique ;
//  2. mot très court tenu (≤ 3 lettres ≥ 0.55 s) ;
//  3. N'IMPORTE quel mot ~2× plus long que sa durée attendue (≈ 0.075 s/lettre) ET ≥ 0.55 s absolu —
//     attrape les prolongations sur mots pleins (« alorssss », « doncccc », « ouiiii ») sans flaguer
//     les mots longs normaux (« magnifiquement » : ratio ≈ 1, ignoré).
function prolongationSpans(words: VoiceWord[], params: HesitationParams = HES_DEFAULT): FillerSpan[] {
  const sens = params.sensitivity ?? 0.5;
  const minAbs = (params.min_ms ?? 400) / 1000;          // durée mini absolue (curseur)
  const maxAbs = (params.max_ms ?? 1500) / 1000;         // au-dessus = vrai mot long, pas une traînée
  const ratio = 2.2 - sens * 1.2;                         // sensible → ratio bas → attrape plus (1.0..2.2)
  const out: FillerSpan[] = [];
  for (const w of words) {
    const dur = w.end - w.start;
    const t = normalize(w.word);
    if (!t) continue;
    const expected = Math.max(0.12, t.length * 0.075);
    const held = dur <= maxAbs && (
      (DRAGGABLE.has(t) && dur >= minAbs) ||
      (t.length <= 3 && dur >= minAbs + 0.13) ||
      (dur >= minAbs && dur >= expected * ratio));
    if (held) out.push({ start: w.start, end: w.end, conf: 0.6 });
  }
  return out;
}

// Mots BASSE CONFIANCE isolés : l'ASR entend mal un « euh/mmh » et le transcrit comme un petit mot
// plausible (« et », « un », « en »…) avec une confiance faible. Signature fiable : mot court, conf
// basse, ENTOURÉ de trous des deux côtés (une vraie syllabe de phrase colle à ses voisines). Modulé
// par la sensibilité (seuil de confiance plus permissif quand on monte) ; OFF sous ~35 %.
function lowConfSpans(words: VoiceWord[], params: HesitationParams = HES_DEFAULT): FillerSpan[] {
  const sens = params.sensitivity ?? 0.5;
  if (sens < 0.35) return [];
  const confMax = 0.25 + sens * 0.3; // 0.36..0.55 : + sensible = tolère une confiance moins mauvaise
  const out: FillerSpan[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const t = normalize(w.word);
    if (!t || t.length > 4) continue;
    if ((w.conf ?? 1) >= confMax) continue;
    if (w.end - w.start < 0.12) continue;
    const gapBefore = i === 0 ? Infinity : w.start - words[i - 1].end;
    const gapAfter = i === words.length - 1 ? Infinity : words[i + 1].start - w.end;
    if (gapBefore < 0.25 || gapAfter < 0.25) continue;
    out.push({ start: w.start, end: w.end, conf: 0.45 });
  }
  return out;
}

// Tics de langage / marqueurs de discours : souvent des hésitations déguisées (« du coup », « en
// fait », « genre », « tu vois »…). AMBIGUS (parfois légitimes) → méthode SÉPARÉE, OFF par défaut.
// Phrases multi-mots d'abord (plus longues prioritaires), sinon mots seuls. Inclut les « donc/alors/
// genre » volontairement EXCLUS du lexique de base (faux positifs) — réintroduits ici sur option.
const MARKER_PHRASES: string[][] = [
  ["c", "est", "a", "dire"], ["je", "veux", "dire"], ["je", "sais", "pas"], ["on", "va", "dire"],
  ["comment", "dire"], ["du", "coup"], ["en", "fait"], ["tu", "vois"], ["tu", "sais"], ["par", "exemple"],
].sort((a, b) => b.length - a.length);
const MARKER_WORDS = new Set([
  "genre", "voila", "quoi", "disons", "bref", "enfin", "donc", "alors", "machin", "truc", "style", "carrement",
]);

// Spans des tics/marqueurs (méthode optionnelle). Mots normalisés (minuscule, sans accents).
function discourseMarkerSpans(words: VoiceWord[]): FillerSpan[] {
  const norm = words.map((w) => normalize(w.word));
  const out: FillerSpan[] = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (const ph of MARKER_PHRASES) {
      if (i + ph.length > words.length) continue;
      let ok = true;
      for (let k = 0; k < ph.length; k++) if (norm[i + k] !== ph[k]) { ok = false; break; }
      if (ok) { out.push({ start: words[i].start, end: words[i + ph.length - 1].end, conf: 0.5 }); i += ph.length; matched = true; break; }
    }
    if (matched) continue;
    if (norm[i] && MARKER_WORDS.has(norm[i])) out.push({ start: words[i].start, end: words[i].end, conf: 0.5 });
    i++;
  }
  return out;
}

// Hésitations UNIFIÉES : TOUTES les méthodes mélangées → recall maximal. Acoustiques (trous, signal),
// lexicales (mots « euh » transcrits), prolongations (mots traînés), tics/marqueurs (option). Triées,
// chevauchements fondus. Source unique pour le panneau CUTS, la waveform et le montage. L'utilisateur
// déselectionne les faux positifs au clic (suggestions) → on assume l'agressivité pour ne RIEN rater.
// Confiance = fusion PROBABILISTE (OR) : deux méthodes indépendantes d'accord sur la même plage →
// conf composée 1-(1-a)(1-b) > max(a,b). `silences` (option) : une hésitation COLLÉE à une pause
// (≤ 0,3 s) = pattern classique « euh… [blanc] » → conf +0.15.
export function combineFillerSpans(acoustic: FillerSpan[], words: VoiceWord[], params: HesitationParams = HES_DEFAULT, silences: VoiceSpan[] = []): FillerSpan[] {
  const all = [
    ...(params.acoustic === false ? [] : acoustic),
    ...(params.lexical === false ? [] : lexicalFillerSpans(words, params)),
    ...(params.lexical === false ? [] : lowConfSpans(words, params)),
    ...(params.prolongation === false ? [] : prolongationSpans(words, params)),
    ...(params.markers ? discourseMarkerSpans(words) : []),
  ].sort((a, b) => a.start - b.start);
  // Fusion : chevauchements ET micro-trous ≤ 0,15 s (deux hésitations collées = UNE coupe ; une
  // lamelle de parole < 0,15 s entre deux coupes est inmontable de toute façon).
  const out: FillerSpan[] = [];
  for (const s of all) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + 0.15) {
      last.end = Math.max(last.end, s.end);
      last.conf = 1 - (1 - last.conf) * (1 - s.conf); // OR probabiliste (accord multi-méthodes)
    } else out.push({ ...s });
  }
  if (silences.length) {
    for (const s of out) {
      // distance inter-intervalles (négative = chevauchement) ≤ 0,3 s → adjacent à une pause
      const near = silences.some((sil) => Math.max(sil.start - s.end, s.start - sil.end) <= 0.3);
      if (near) s.conf = Math.min(1, s.conf + 0.15);
    }
  }
  return out.map((s) => ({ ...s, conf: Math.round(s.conf * 100) / 100 }));
}

// Une répétition détectée : la PREMIÈRE occurrence à retirer (on garde la dernière prise).
export interface RepeatSpan { start: number; end: number; text: string }

// Détecte les répétitions de PHRASES (1 à maxK mots) : reprise immédiate (« la la », « la découpe la
// découpe »), faux départs avec interruption (« je vais euh je vais faire » : ≤ skipMax mots
// intercalés), ET bégaiements par préfixe (« com… comment », « vrai vraiment » : le mot avorté est un
// préfixe ≥ 3 lettres du mot suivant). Match = égalité normalisée mot à mot. On retire la 1re
// occurrence (+ l'éventuelle interruption), on garde la dernière prise. Reprise = prochain candidat
// → capte les triples.
export function repetitionSpans(words: VoiceWord[], maxK = 6, gapMax = 1.0, skipMax = 2): RepeatSpan[] {
  const out: RepeatSpan[] = [];
  const norm = words.map((w) => normalize(w.word));
  let i = 0;
  while (i < words.length - 1) {
    let matched = false;
    const kmax = Math.min(maxK, (words.length - i) >> 1);
    for (let k = kmax; k >= 1 && !matched; k--) {
      // skip = mots intercalés entre les 2 occurrences. 0 = répétition immédiate. >0 = faux départ
      // (réservé aux phrases k ≥ 2 : un mot seul « le … le » trop loin = souvent légitime).
      const maxSkip = k >= 2 ? skipMax : 0;
      for (let skip = 0; skip <= maxSkip; skip++) {
        const j = i + k + skip;
        if (j + k > words.length) continue;
        let eq = true;
        for (let m = 0; m < k; m++) { if (!norm[i + m] || norm[i + m] !== norm[j + m]) { eq = false; break; } }
        if (!eq) continue;
        const gap = words[j].start - words[i + k - 1].end;
        if (gap > gapMax + skip * 0.6) continue; // un faux départ tolère un peu plus de trou
        out.push({
          start: words[i].start,
          end: words[j].start, // retire 1re occurrence + interruption, garde la reprise
          text: words.slice(i, i + k).map((w) => w.word).join(" "),
        });
        i = j; // la reprise devient le prochain candidat (triples « la la la », chaînes de faux départs)
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Bégaiement par préfixe : mot avorté repris entier juste après (« com comment »). Préfixe ≥ 3
      // lettres ET mot complet ≥ préfixe + 2 (évite les paires légitimes « pense penser », « le les »).
      const a = norm[i], b = norm[i + 1];
      if (a && b && a.length >= 3 && b.length >= a.length + 2 && b.startsWith(a)
        && words[i + 1].start - words[i].end <= 0.45) {
        out.push({ start: words[i].start, end: words[i + 1].start, text: words[i].word });
        i += 1; // la reprise (mot complet) devient le prochain candidat
        continue;
      }
      i++;
    }
  }
  return out;
}

// Indices (dans `words`) des HÉSITATIONS lexicales (catégories activées + mots perso). Les répétitions
// ont leur propre détection (repetitionSpans) → on ne les compte PAS ici (sinon double comptage).
export function fillerIndices(words: VoiceWord[], hp?: LexParams): number[] {
  const set = activeFillerSet(hp);
  const out: number[] = [];
  for (let i = 0; i < words.length; i++) if (set.has(normalize(words[i].word))) out.push(i);
  return out;
}
