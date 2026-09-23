import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import i18n from "@/i18n"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Dernier segment d'un chemin (Windows ou POSIX) → nom de fichier.
export function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

// Dossier parent d'un chemin (Windows ou POSIX). Chaîne vide si le chemin n'en a pas.
export function dirname(p: string): string {
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return cut > 0 ? p.slice(0, cut) : "";
}

// Concatène un dossier et un nom de fichier en gardant le séparateur du dossier : un chemin Windows
// rendu avec des « / » se ferait recoller de travers par le dialogue natif.
export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`;
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

// The locale every date, time, number and sort order is written in: the interface language,
// never the OS locale nor a hardcoded "fr-FR".
export function uiLocale(): string {
  return i18n.language || "fr";
}

// Bytes → "1,5 Go" in French, "1.5 GB" in English: the unit and the decimal mark follow the UI
// language. Single source on the renderer side, so a cache, an export or an embedded media file
// shows its size the same way everywhere.
const BYTE_UNITS = ["kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
export function fmtBytes(n: number | undefined | null): string {
  const lang = uiLocale();
  const bytes = n && n > 0 ? n : 0;
  if (bytes < 1024) return `${new Intl.NumberFormat(lang).format(bytes)} ${lang.startsWith("fr") ? "o" : "B"}`;
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < BYTE_UNITS.length - 1) {
    value /= 1024;
    i++;
  }
  return new Intl.NumberFormat(lang, { style: "unit", unit: BYTE_UNITS[i], maximumFractionDigits: value >= 10 ? 0 : 1 }).format(value);
}

// "1920x1080" → { width, height }. Resolve et la bibliothèque décrivent une définition par une
// chaîne ; la barre de résolutions a besoin des deux nombres pour savoir ce qui est atteignable.
export function parseResolution(r: string | null | undefined): { width: number; height: number } | null {
  const m = (r ?? "").match(/(\d+)\s*[x×]\s*(\d+)/i);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}
