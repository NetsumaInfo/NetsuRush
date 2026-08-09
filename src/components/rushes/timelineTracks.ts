// Pistes d'une timeline ouverte (Timeline Live). Les options du tiroir se DÉDUISENT des plans, pas
// d'un index de pistes envoyé à part : le cache projet hors ligne ne persiste que les plans, et un
// panneau CEP ancien n'envoie aucun nom — dans les deux cas la piste garde au moins son rang.
// Une piste sans plan n'apparaît donc pas : le tiroir ne propose que ce qu'il peut afficher.
import type { TimelineCut } from "@/lib/bridge";

export interface TrackOption {
  index: number;      // rang de la piste chez l'hôte (1 = piste du bas)
  name: string;       // nom EXACT chez l'hôte ; "" quand il n'en a pas envoyé
  count: number;      // plans vidéo présents sur cette piste
}

/**
 * Options du tiroir, dans l'ordre des pistes de l'hôte (la plus basse en tête).
 * Le nom n'est jamais réécrit : « Vidéo 1 » reste « Vidéo 1 ». C'est le libellé que l'utilisateur
 * lit dans Resolve ou Premiere — un rang abrégé maison l'obligerait à faire la traduction lui-même.
 */
export function trackOptions(cuts: TimelineCut[]): TrackOption[] {
  const byIndex = new Map<number, TrackOption>();
  for (const cut of cuts) {
    let option = byIndex.get(cut.track);
    if (!option) {
      option = { index: cut.track, name: "", count: 0 };
      byIndex.set(cut.track, option);
    }
    option.count++;
    // Le nom voyage sur CHAQUE plan : le premier non vide de la piste fait foi.
    if (!option.name) option.name = (cut.trackName ?? "").trim();
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/** Plans visibles pour la piste choisie ; `null` = toutes les pistes. */
export function cutsOfTrack(cuts: TimelineCut[], track: number | null): TimelineCut[] {
  return track == null ? cuts : cuts.filter((cut) => cut.track === track);
}
