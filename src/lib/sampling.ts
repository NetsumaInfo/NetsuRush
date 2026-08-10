// Combien d'images représentent un plan dans l'index. UN seul réglage : où les prendre, et quand en
// ajouter une sur un plan long, sont des règles décidées par le service (python/nrsearch/sampling),
// pas des goûts d'utilisateur.
//
// Ce nombre CHANGE les vecteurs produits. Le service reconnaît le format d'un index déjà construit
// et n'en refait un que si la demande est plus riche (miroir de config.SAMPLING_RANK) — redemander
// moins d'images ne relance donc rien.

export type SamplingFrames = 1 | 2 | 3;

export const FRAME_CHOICES: SamplingFrames[] = [1, 2, 3];
export const DEFAULT_FRAMES: SamplingFrames = 2;

const STORAGE_KEY = "nr-search-frames.v1";
const RANK: Record<string, number> = { single: 1, adaptive: 2, precise: 3 };
const FORMAT: Record<SamplingFrames, string> = { 1: "single", 2: "adaptive", 3: "precise" };

function normalizeFrames(value: unknown): SamplingFrames {
  return value === 1 || value === 3 ? value : DEFAULT_FRAMES;
}

export function readFrames(): SamplingFrames {
  if (typeof localStorage === "undefined") return DEFAULT_FRAMES;
  return normalizeFrames(Number(localStorage.getItem(STORAGE_KEY)));
}

export function writeFrames(value: SamplingFrames): SamplingFrames {
  const next = normalizeFrames(value);
  try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* mode privé */ }
  return next;
}

/** Détail d'un index déjà construit, dans l'unité du réglage. null = format non reconnu (index
 *  antérieur au marqueur) ou image fixe, qui n'échantillonne aucun plan. */
export function framesOfMode(mode: string | null | undefined): SamplingFrames | null {
  const found = FRAME_CHOICES.find((count) => FORMAT[count] === mode);
  return found ?? null;
}

/** L'index déjà construit couvre-t-il ce qu'on demanderait maintenant ? Une image fixe n'a qu'un
 *  seul format possible — la confronter à un échantillonnage de plan n'a pas de sens. */
export function framesSatisfied(mode: string | null | undefined, frames: SamplingFrames): boolean {
  if (mode === "image") return true;
  const have = mode ? RANK[mode] : undefined;
  return have !== undefined && have >= RANK[FORMAT[normalizeFrames(frames)]];
}
