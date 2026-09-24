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
  return i18n.language || "en";
}

// Bytes → "1,5 Go" in French, "1.5 GB" in English: the unit and the decimal mark follow the UI
// language. Single source on the renderer side, so a cache, an export or an embedded media file
// shows its size the same way everywhere.
const BYTE_UNITS = ["kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
export function fmtBytes(n: number | undefined | null): string {
  const lang = uiLocale();
  const bytes = n && n > 0 ? n : 0;
  if (bytes < 1024) return new Intl.NumberFormat(lang, { style: "unit", unit: "byte", unitDisplay: "narrow" }).format(bytes);
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < BYTE_UNITS.length - 1) {
    value /= 1024;
    i++;
  }
  return new Intl.NumberFormat(lang, { style: "unit", unit: BYTE_UNITS[i], maximumFractionDigits: value >= 10 ? 0 : 1 }).format(value);
}

// Every number a user reads goes through these: the decimal mark, the digit grouping and the unit
// follow the interface language ("1,5 s" in French, "1.5 sec" in English, "1.5 秒" in Japanese).
// Values that are not displayed (cache keys, CSS, ffmpeg arguments, timecodes) keep plain `String`.
const safe = (n: number) => (Number.isFinite(n) ? n : 0);

export function fmtNumber(n: number, opts: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 2, ...opts }).format(safe(n));
}

/** A fixed number of decimals, like `toFixed` but in the interface locale. */
export function fmtFixed(n: number, digits: number): string {
  return fmtNumber(n, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

type UnitOpts = { digits?: number; fixed?: boolean; unitDisplay?: "short" | "narrow" | "long" };
function fmtUnit(n: number, unit: string, { digits = 1, fixed = false, unitDisplay = "short" }: UnitOpts): string {
  return fmtNumber(n, { style: "unit", unit, unitDisplay, maximumFractionDigits: digits, minimumFractionDigits: fixed ? digits : 0 });
}

/** Seconds with their unit: 1.5 → "1,5 s" (fr), "1.5 sec" (en). */
export function fmtSeconds(sec: number, opts: UnitOpts = {}): string {
  return fmtUnit(sec, "second", opts);
}

/** A frame rate as a host wrote it ("23.976", or "23,976" from a localized host); never grouped. */
export function parseFps(text: string | number | null | undefined): number {
  return parseFloat(String(text ?? "").trim().replace(",", "."));
}

/** The short seconds symbol alone, for a label next to a number field: "s", "sec", "Sek.", "秒". */
export function secondsUnit(): string {
  const parts = new Intl.NumberFormat(uiLocale(), { style: "unit", unit: "second", unitDisplay: "short" }).formatToParts(1);
  return parts.find((part) => part.type === "unit")?.value ?? "s";
}

/** Milliseconds with their unit: 1500 → "1 500 ms" (fr), "1,500 ms" (en). */
export function fmtMillis(ms: number, opts: UnitOpts = {}): string {
  return fmtUnit(ms, "millisecond", { digits: 0, ...opts });
}

/** A ratio (0–1) as a percentage: 0.42 → "42 %" (fr), "42%" (en). */
export function fmtPercent(ratio: number, digits = 0): string {
  return fmtNumber(ratio, { style: "percent", maximumFractionDigits: digits });
}

/** A frame rate: 23.976 → "23,976 fps" (fr), "23.976 fps" (en). "fps" is the same in every language. */
export function fmtFps(fps: number): string {
  return `${fmtNumber(fps, { maximumFractionDigits: 3 })} fps`;
}

/** A number written back into a text field: interface decimal mark, no digit grouping. */
export function fmtInputNumber(n: number, digits = 3): string {
  return fmtNumber(n, { maximumFractionDigits: digits, useGrouping: false });
}

/** The decimal and grouping marks of the interface language ("," and " " in French). */
function localeMarks(): { decimal: string; group: string } {
  const parts = new Intl.NumberFormat(uiLocale()).formatToParts(12345.6);
  return {
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
    group: parts.find((p) => p.type === "group")?.value ?? ",",
  };
}

/**
 * Reads a number a person typed, whatever their keyboard or habit: "1,5", "1.5", "１．５" (full-width
 * IME), "1 500,5", "1.500,5", "1,500.5" and "−2" all parse. A lone separator is the decimal mark,
 * except when it is the interface grouping mark followed by exactly three digits ("1,500" in
 * English, "1.500" in German). Returns NaN when the text is not a number.
 */
export function parseDecimal(text: string): number {
  let s = String(text ?? "").normalize("NFKC").trim().replace(/[\s'’_]/g, "").replace(/−/g, "-");
  if (!s) return NaN;
  const commas = (s.match(/,/g) ?? []).length;
  const dots = (s.match(/\./g) ?? []).length;
  if (commas && dots) {
    const decimal = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    s = s.split(decimal === "," ? "." : ",").join("").replace(",", ".");
  } else if (commas + dots > 1) {
    s = s.replace(/[.,]/g, "");
  } else if (commas + dots === 1) {
    const mark = commas ? "," : ".";
    const { decimal, group } = localeMarks();
    const isGroup = mark === group && mark !== decimal && /^[-+]?\d{1,3}[.,]\d{3}$/.test(s);
    s = isGroup ? s.replace(mark, "") : s.replace(",", ".");
  }
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? Number(s) : NaN;
}

// "1920x1080" → { width, height }. Resolve et la bibliothèque décrivent une définition par une
// chaîne ; la barre de résolutions a besoin des deux nombres pour savoir ce qui est atteignable.
export function parseResolution(r: string | null | undefined): { width: number; height: number } | null {
  const m = (r ?? "").match(/(\d+)\s*[x×]\s*(\d+)/i);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}
