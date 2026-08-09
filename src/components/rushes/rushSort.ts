// Tri de la grille de rush (Derush). Champ + sens combinés en une clé : la grille MediaTree
// préserve l'ordre du tableau dans chaque dossier → trier la liste suffit.
import type { Clip } from "@/lib/bridge";

export type SortKey =
  | "name-asc" | "name-desc"
  | "duration-asc" | "duration-desc"
  | "resolution-desc" | "resolution-asc";

export const SORT_KEYS: SortKey[] = [
  "name-asc", "name-desc", "duration-asc", "duration-desc", "resolution-desc", "resolution-asc",
];

// Clés i18n (ns « derush ») des libellés de tri, résolues au rendu via t().
export const SORT_LABEL_KEYS: Record<SortKey, string> = {
  "name-asc": "sort.nameAsc",
  "name-desc": "sort.nameDesc",
  "duration-asc": "sort.durationAsc",
  "duration-desc": "sort.durationDesc",
  "resolution-desc": "sort.resolutionDesc",
  "resolution-asc": "sort.resolutionAsc",
};

// "1920x1080" → 2 073 600 (nb de pixels) ; inconnu → -1 (rangé en fin de tri croissant).
const pixels = (r: string | null): number => {
  const m = (r ?? "").match(/(\d+)\s*[x×]\s*(\d+)/i);
  return m ? Number(m[1]) * Number(m[2]) : -1;
};

// Tri persisté (l'onglet est démonté au changement → un état local repartirait à zéro à chaque
// aller-retour). La valeur relue est validée : une clé périmée retombe sur le défaut.
const SORT_PREF_KEY = "nr.rush.sort";
export function loadSortKey(): SortKey {
  const v = (typeof localStorage !== "undefined" && localStorage.getItem(SORT_PREF_KEY)) as SortKey | null;
  return v && SORT_KEYS.includes(v) ? v : "name-asc";
}
export function saveSortKey(v: SortKey) { try { localStorage.setItem(SORT_PREF_KEY, v); } catch { /* noop */ } }

export function sortClips(list: Clip[], key: SortKey): Clip[] {
  const [field, dir] = key.split("-") as [string, "asc" | "desc"];
  const sign = dir === "asc" ? 1 : -1;
  const cmp = (a: Clip, b: Clip): number => {
    // Durée = timecode zéro-paddé (HH:MM:SS:FF) → compare lexical fiable ; null en fin.
    if (field === "duration") return sign * (a.duration ?? "~").localeCompare(b.duration ?? "~");
    if (field === "resolution") return sign * (pixels(a.resolution) - pixels(b.resolution));
    return sign * a.name.localeCompare(b.name, undefined, { numeric: true });
  };
  return [...list].sort(cmp);
}
