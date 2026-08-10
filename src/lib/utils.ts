import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Dernier segment d'un chemin (Windows ou POSIX) → nom de fichier.
export function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

// Décalage (s) de la vignette d'un plan : on capture quelques frames APRÈS le début, jamais la
// toute 1re frame (souvent une transition/fondu/flou de coupe → vignette trompeuse). ~3-4 frames à
// 24 fps. Source UNIQUE : sert aussi de clé de cache (path@time.toFixed(2)) → écriture et lecture
// DOIVENT passer la même valeur, donc tous les appels passent par thumbTime().
const THUMB_LEAD = 0.15;

// Instant « AUTO » : le core choisit une frame REPRÉSENTATIVE (≈10 % de la durée) au lieu du début
// du fichier. À passer pour un CLIP ENTIER (pas d'in-point utile) : les rushs ouvrent presque
// toujours sur du noir (fondu, logo, amorce) → une vignette prise à t≈0 est une case noire.
// Un plan TRIMÉ garde son in-point (thumbTime) : c'est l'image du plan, elle doit être exacte.
export const THUMB_AUTO = -1;

// Instant (s) où générer/lire la vignette d'un plan. Borné à 40 % de la durée du plan pour les
// plans très courts (sinon on viserait au-delà de la fin → frame noire / plan suivant).
export function thumbTime(inSec: number, outSec?: number): number {
  const span = outSec != null ? outSec - inSec : Infinity;
  return inSec + (span > 0 ? Math.min(THUMB_LEAD, span * 0.4) : THUMB_LEAD);
}

// Formate une durée (secondes) en horodatage lisible — source unique pour les lecteurs et grilles.
//  - centis : ajoute les centièmes (`.cs`) → précision lecteur (mm:ss.cs).
//  - hours  : préfixe l'heure quand t ≥ 1 h (h:mm:ss) ; sinon mm:ss.
//  - padMinutes : zéro-pad les minutes (`05:` au lieu de `5:`).
export function fmtTime(t: number, opts: { centis?: boolean; hours?: boolean; padMinutes?: boolean } = {}): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const { centis = false, hours = false, padMinutes = true } = opts;
  const h = Math.floor(t / 3600);
  const m = hours ? Math.floor((t % 3600) / 60) : Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const mm = padMinutes ? String(m).padStart(2, "0") : String(m);
  let out = `${mm}:${String(s).padStart(2, "0")}`;
  if (hours && h > 0) out = `${h}:${out}`;
  if (centis) out += `.${String(Math.floor((t % 1) * 100)).padStart(2, "0")}`;
  return out;
}

// Octets → format lisible (Ko/Mo/Go). Source unique côté renderer : le poids d'un cache, d'un
// fichier exporté ou d'un média embarqué s'écrit partout pareil.
export function fmtBytes(n: number | undefined | null): string {
  if (!n || n <= 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
