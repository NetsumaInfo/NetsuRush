// Accès au catalogue complet des glyphes lucide par NOM (icône d'un dossier de collection, d'un
// profil d'export, d'une page du Carnet — toutes persistent un nom, pas un composant).
//
// Le catalogue vit dans un chunk asynchrone (`lucideCatalogData`) : il pèse ~1 700 modules et n'est
// utile qu'aux sélecteurs d'icône et à l'affichage d'un nom hors jeu curaté. Les modules qui savent
// déjà quelle icône rendre importent lucide normalement.
import type { LucideIcon } from "lucide-react";
import { createLazyModule } from "./lazyModule";

const catalog = createLazyModule("catalogue d'icônes lucide", () => import("./lucideCatalogData"));

// Référence STABLE avant chargement : les grilles la passent en dépendance de `useMemo`, un tableau
// neuf à chaque rendu relancerait le filtrage pour rien.
const NO_NAMES: string[] = [];

/** Résolution synchrone. `undefined` avant chargement — appeler `useLucideCatalog()` pour re-rendre. */
export function lucideIcon(name: string): LucideIcon | undefined {
  const data = catalog.get();
  if (!name || !data) return undefined;
  // Le baril lucide expose chaque glyphe sous deux alias (`Rocket` et `LucideRocket`) ; les anciens
  // sélecteurs listaient les deux, donc un nom persisté peut porter le préfixe.
  return data.LUCIDE_CATALOG[name] ?? data.LUCIDE_CATALOG[name.replace(/^Lucide/, "")];
}

/** Noms canoniques triés (vide avant chargement). */
export function lucideNames(): string[] {
  return catalog.get()?.LUCIDE_NAMES ?? NO_NAMES;
}

/** Déclenche le chargement sans re-rendre — pour préchauffer à l'ouverture d'un sélecteur. */
export function loadLucideCatalog(): void {
  void catalog.load();
}

/** Déclenche le chargement du catalogue et re-rend le composant quand il arrive. */
export function useLucideCatalog(): void {
  catalog.use();
}
