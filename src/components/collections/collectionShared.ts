// Helpers partagés de l'onglet Collections : palette de labels couleur, tri, filtre, préférences de vue.
import { type CollectionShot, type CollectionMeta, type CollectionFolder } from "@/lib/bridge";

// Labels couleur (inspirés des couleurs de clip Resolve) — un seul label par plan, sert au tri/filtre.
// `nameKey` = clé i18n (ns « collections ») résolue au rendu.
export const LABELS: { id: string; nameKey: string; color: string }[] = [
  { id: "red", nameKey: "label.red", color: "#ef4444" },
  { id: "orange", nameKey: "label.orange", color: "#f59e0b" },
  { id: "amber", nameKey: "label.amber", color: "#f97316" },
  { id: "yellow", nameKey: "label.yellow", color: "#eab308" },
  { id: "lime", nameKey: "label.lime", color: "#84cc16" },
  { id: "green", nameKey: "label.green", color: "#22c55e" },
  { id: "emerald", nameKey: "label.emerald", color: "#10b981" },
  { id: "teal", nameKey: "label.teal", color: "#14b8a6" },
  { id: "sky", nameKey: "label.sky", color: "#0ea5e9" },
  { id: "blue", nameKey: "label.blue", color: "#3b82f6" },
  { id: "indigo", nameKey: "label.indigo", color: "#6366f1" },
  { id: "violet", nameKey: "label.violet", color: "#8b5cf6" },
  { id: "fuchsia", nameKey: "label.fuchsia", color: "#d946ef" },
  { id: "pink", nameKey: "label.pink", color: "#ec4899" },
  { id: "rose", nameKey: "label.rose", color: "#f43f5e" },
  { id: "slate", nameKey: "label.slate", color: "#64748b" },
];
export function labelColor(id?: string | null): string | null {
  return id ? (LABELS.find((l) => l.id === id)?.color ?? null) : null;
}
/** Clé i18n du label (ns « collections ») — la couleur seule n'est pas lisible par un lecteur d'écran. */
export function labelNameKey(id?: string | null): string | null {
  return id ? (LABELS.find((l) => l.id === id)?.nameKey ?? null) : null;
}

// Collections FAVORITES (épinglées) — partagées entre le bouton « Ranger » (accès en 1 clic) et les
// cartes de la liste. Persistées localStorage (pas de méta serveur : un favori est un choix LOCAL).
const FAV_KEY = "nr.coll.fav:v1";
export const loadCollFavs = (): string[] => { try { return JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); } catch { return []; } };
export const saveCollFavs = (a: string[]) => { try { localStorage.setItem(FAV_KEY, JSON.stringify(a)); } catch { /* noop */ } };

// Modes d'affichage de la grille de plans (boutons de la barre d'outils).
export type CollShotView = "gallery" | "grid" | "compact" | "list";
export const SHOT_VIEWS: CollShotView[] = ["gallery", "grid", "compact", "list"];

export type CollSortKey = "added-desc" | "added-asc" | "name" | "dur-desc" | "dur-asc" | "rating-desc";
// Valeurs = clés i18n (ns « collections ») résolues au rendu.
export const SORT_LABELS: Record<CollSortKey, string> = {
  "added-desc": "sort.addedDesc",
  "added-asc": "sort.addedAsc",
  "name": "sort.name",
  "dur-desc": "sort.durDesc",
  "dur-asc": "sort.durAsc",
  "rating-desc": "sort.ratingDesc",
};
export const SORT_KEYS = Object.keys(SORT_LABELS) as CollSortKey[];

const dur = (s: CollectionShot) => s.out - s.in;

export function sortShots(list: CollectionShot[], key: CollSortKey): CollectionShot[] {
  const out = [...list];
  switch (key) {
    case "added-asc": return out.sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
    case "name": return out.sort((a, b) => a.name.localeCompare(b.name, "fr", { numeric: true }));
    case "dur-desc": return out.sort((a, b) => dur(b) - dur(a));
    case "dur-asc": return out.sort((a, b) => dur(a) - dur(b));
    case "rating-desc": return out.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.addedAt ?? 0) - (a.addedAt ?? 0));
    case "added-desc":
    default: return out.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
  }
}

export interface ShotFilter {
  q: string;
  tags: string[];        // ET logique (le plan doit porter tous les tags)
  minRating: number;     // 0 = pas de filtre
  label: string | null;  // id de label ou null
}
export const EMPTY_FILTER: ShotFilter = { q: "", tags: [], minRating: 0, label: null };

export function filterShots(list: CollectionShot[], f: ShotFilter): CollectionShot[] {
  const q = f.q.trim().toLowerCase();
  return list.filter((s) => {
    if (q && !s.name.toLowerCase().includes(q) && !(s.tags ?? []).some((t) => t.toLowerCase().includes(q))) return false;
    if (f.tags.length && !f.tags.every((t) => (s.tags ?? []).includes(t))) return false;
    if (f.minRating && (s.rating ?? 0) < f.minRating) return false;
    if (f.label && s.label !== f.label) return false;
    return true;
  });
}

export function isFilterActive(f: ShotFilter): boolean {
  return !!(f.q.trim() || f.tags.length || f.minRating || f.label);
}

// Toutes les étiquettes présentes dans une collection (pour les suggestions + le filtre).
export function collectTags(list: CollectionShot[]): string[] {
  const set = new Set<string>();
  for (const s of list) for (const t of s.tags ?? []) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b, "fr"));
}

// ---------------------------------------------------------------------------
// LISTE des collections (vue extérieure) : modes d'affichage + tri des DOSSIERS eux-mêmes.
// ---------------------------------------------------------------------------
// Vue « Liste » retirée (peu intéressante) → Galerie (mosaïque) / Grille / Compact.
export type CollListView = "gallery" | "grid" | "compact";
export const LIST_VIEWS: CollListView[] = ["gallery", "grid", "compact"];

export type CollListSort = "recent" | "name" | "count-desc" | "count-asc";
// Valeurs = clés i18n (ns « collections ») résolues au rendu.
export const LIST_SORT_LABELS: Record<CollListSort, string> = {
  "recent": "listSort.recent",
  "name": "listSort.name",
  "count-desc": "listSort.countDesc",
  "count-asc": "listSort.countAsc",
};
export const LIST_SORT_KEYS = Object.keys(LIST_SORT_LABELS) as CollListSort[];

export function sortCollections(list: CollectionMeta[], key: CollListSort): CollectionMeta[] {
  const out = [...list];
  switch (key) {
    case "name": return out.sort((a, b) => a.name.localeCompare(b.name, "fr", { numeric: true }));
    case "count-desc": return out.sort((a, b) => b.count - a.count || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    case "count-asc": return out.sort((a, b) => a.count - b.count || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    case "recent":
    default: return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
}

const LIST_VIEW_KEY = "nr.coll.listview";
const LIST_SORT_PREF_KEY = "nr.coll.listsort";
export function loadListView(): CollListView {
  const v = (typeof localStorage !== "undefined" && localStorage.getItem(LIST_VIEW_KEY)) as CollListView | null;
  return v && LIST_VIEWS.includes(v) ? v : "grid";
}
export function saveListView(v: CollListView) { try { localStorage.setItem(LIST_VIEW_KEY, v); } catch { /* noop */ } }
export function loadListSort(): CollListSort {
  const v = (typeof localStorage !== "undefined" && localStorage.getItem(LIST_SORT_PREF_KEY)) as CollListSort | null;
  return v && LIST_SORT_KEYS.includes(v) ? v : "recent";
}
export function saveListSort(v: CollListSort) { try { localStorage.setItem(LIST_SORT_PREF_KEY, v); } catch { /* noop */ } }

// Préférences de vue persistées (partagées entre dossiers).
const VIEW_KEY = "nr.coll.view";
const SORT_KEY = "nr.coll.sort";
export function loadShotView(): CollShotView {
  const v = (typeof localStorage !== "undefined" && localStorage.getItem(VIEW_KEY)) as CollShotView | null;
  return v && SHOT_VIEWS.includes(v) ? v : "grid";
}
export function saveShotView(v: CollShotView) { try { localStorage.setItem(VIEW_KEY, v); } catch { /* noop */ } }
export function loadShotSort(): CollSortKey {
  const v = (typeof localStorage !== "undefined" && localStorage.getItem(SORT_KEY)) as CollSortKey | null;
  return v && SORT_KEYS.includes(v) ? v : "added-desc";
}
export function saveShotSort(v: CollSortKey) { try { localStorage.setItem(SORT_KEY, v); } catch { /* noop */ } }

// ---------------------------------------------------------------------------
// Dossiers de rangement (hiérarchie) + groupes (collTags) de collections.
// ---------------------------------------------------------------------------
// Fil d'Ariane : racine → dossier courant (protégé contre les cycles).
export function folderTrail(folders: CollectionFolder[], id: string | null): CollectionFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: CollectionFolder[] = [];
  const seen = new Set<string>();
  let cur = id ? byId.get(id) : undefined;
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
  return out;
}
export function childFolders(folders: CollectionFolder[], parentId: string | null): CollectionFolder[] {
  return folders.filter((f) => (f.parentId ?? null) === parentId).sort((a, b) => a.name.localeCompare(b.name, "fr", { numeric: true }));
}
// Groupes (collTags) présents dans une liste de collections → puces de filtre.
export function collectGroups(list: CollectionMeta[]): string[] {
  const set = new Set<string>();
  for (const c of list) for (const t of c.collTags ?? []) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b, "fr"));
}

// Préférences d'AFFICHAGE des cartes de collection (résumé du contenu) — persistées.
export interface CollDisplay { labels: boolean; tags: boolean; description: boolean }
const DISPLAY_KEY = "nr.coll.display:v1";
const DISPLAY_DEFAULT: CollDisplay = { labels: true, tags: true, description: true };
export function loadCollDisplay(): CollDisplay {
  try { return { ...DISPLAY_DEFAULT, ...JSON.parse(localStorage.getItem(DISPLAY_KEY) || "{}") }; } catch { return { ...DISPLAY_DEFAULT }; }
}
export function saveCollDisplay(d: CollDisplay) { try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(d)); } catch { /* noop */ } }
