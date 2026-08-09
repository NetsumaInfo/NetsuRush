// Helpers PURS de l'accueil NetsuDraft (date relative, tri, filtre). Zéro import du store : la vue
// les consomme, les tests de régression n'ont besoin d'aucun runtime.

import i18n from "@/i18n";
import type { ScriptDocMeta } from "@/lib/bridge";

export const HOME_SORTS = ["recent", "title", "duration"] as const;
export const HOME_VIEWS = ["grid", "list"] as const;
export const HOME_SCOPES = ["project", "all"] as const;
export type HomeSort = (typeof HOME_SORTS)[number];
export type HomeView = (typeof HOME_VIEWS)[number];
export type HomeScope = (typeof HOME_SCOPES)[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;

// Un `Intl.RelativeTimeFormat` par langue : la locale suit i18n (une locale figée mentirait sur les
// cinq autres langues livrées), et l'objet est réutilisé entre les cartes.
const formatters = new Map<string, Intl.RelativeTimeFormat>();
function relativeFormatter(): Intl.RelativeTimeFormat {
  const lang = i18n.language || "fr";
  let f = formatters.get(lang);
  if (!f) {
    f = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
    formatters.set(lang, f);
  }
  return f;
}

export function relDate(ts: number): string {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const f = relativeFormatter();
  if (abs < HOUR) return f.format(Math.round(diff / MINUTE), "minute");
  if (abs < DAY) return f.format(Math.round(diff / HOUR), "hour");
  if (abs < MONTH) return f.format(Math.round(diff / DAY), "day");
  return f.format(Math.round(diff / MONTH), "month");
}

// Recherche insensible à la casse ET aux accents : taper « resume » doit trouver « Résumé ».
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function filterDocs(docs: ScriptDocMeta[], query: string): ScriptDocMeta[] {
  const q = fold(query.trim());
  if (!q) return docs;
  return docs.filter((d) => fold(d.title || "").includes(q));
}

export function sortDocs(docs: ScriptDocMeta[], sort: HomeSort): ScriptDocMeta[] {
  const list = [...docs];
  if (sort === "title") return list.sort((a, b) => (a.title || "").localeCompare(b.title || "", i18n.language));
  if (sort === "duration") return list.sort((a, b) => (b.stats?.seconds ?? 0) - (a.stats?.seconds ?? 0));
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}
