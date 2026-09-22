// Lecture typée du journal des versions (`releases.json`).
//
// Deux formes coexistent, et c'est voulu : les versions récentes classent leurs entrées par nature
// (`changes`), les anciennes n'ont qu'une liste (`highlights`). Réécrire l'historique pour le faire
// entrer dans une classification que personne n'a choisie à l'époque produirait des étiquettes
// inventées après coup. Les deux consommateurs — la fenêtre de nouveautés et l'historique des
// paramètres — passent donc par ici plutôt que de deviner chacun de leur côté.

import data from "./releases.json";

export type ChangeKind = "feature" | "improvement" | "performance" | "fix";

export type Release = {
  id: string;
  version: string;
  date: string;
  title: Record<string, string>;
  /** Text per language: `fr` and `en` always, the other interface languages when translated. */
  changes?: ({ kind: ChangeKind } & Record<string, string>)[];
  highlights?: Record<string, string[]>;
};

export const releases = data as Release[];

/** Ordre de lecture : ce qui est nouveau, ce qui va mieux, ce qui va plus vite, ce qui est réparé. */
export const CHANGE_KINDS: ChangeKind[] = ["feature", "improvement", "performance", "fix"];

/** Toutes les lignes d'une version, à plat, dans l'ordre de lecture — quelle que soit sa forme. */
export function releaseLines(release: Release, language: string): string[] {
  if (release.changes?.length) {
    return CHANGE_KINDS.flatMap((kind) =>
      release.changes!.filter((change) => change.kind === kind).map((change) => releaseText(change, language)));
  }
  const lang = language.slice(0, 2);
  return release.highlights?.[lang] ?? release.highlights?.en ?? [];
}

/** A release text in the interface language; English when that language has no translation. */
export function releaseText(text: Record<string, string>, language: string): string {
  return text[language.slice(0, 2)] ?? text.en ?? text.fr ?? "";
}
