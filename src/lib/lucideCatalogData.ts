// Catalogue COMPLET des glyphes lucide (1 700+), chargé UNIQUEMENT en import dynamique depuis
// `lucideCatalog.ts` — ce module ne doit jamais être importé statiquement.
//
// On glob les modules d'icônes UN PAR UN plutôt que `import * as Lucide from "lucide-react"` :
// le baril de lucide est aussi importé statiquement (icônes nommées) partout dans l'app, donc un
// accès par espace de noms dessus annule l'élagage et réinjecte les 1 700 icônes dans le chunk
// D'ENTRÉE, que les trois renderers parsent au démarrage (dont le panneau CEP, sur un Chromium
// ancien). En passant par les modules feuilles, seules les icônes déjà utilisées restent partagées
// avec l'entrée ; le reste part dans ce chunk asynchrone.
import type { LucideIcon } from "lucide-react";

const ICON_MODULES = import.meta.glob<{ default: LucideIcon }>(
  "/node_modules/lucide-react/dist/esm/icons/*.js",
  { eager: true },
);

// `arrow-up-right.js` → `ArrowUpRight` : la convention de nommage du baril lucide, vérifiée
// exhaustivement (les 1 742 fichiers couvrent tous les noms exportés hors alias `Lucide*`).
function pascalCase(kebab: string): string {
  return kebab
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
    .join("");
}

function buildCatalog(): Record<string, LucideIcon> {
  const catalog: Record<string, LucideIcon> = {};
  for (const [path, mod] of Object.entries(ICON_MODULES)) {
    const slug = path.slice(path.lastIndexOf("/") + 1, -3);
    if (slug === "index") continue;
    const icon = mod?.default;
    if (icon) catalog[pascalCase(slug)] = icon;
  }
  return catalog;
}

export const LUCIDE_CATALOG: Record<string, LucideIcon> = buildCatalog();
export const LUCIDE_NAMES: string[] = Object.keys(LUCIDE_CATALOG).sort();
