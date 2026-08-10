// Style de sélection COMMUN à toutes les grilles de cartes (référence = carte de rush Derush).
// But : même retour visuel partout — anneau bleu + pastille ronde bleue avec check. Les positions
// de pastille restent libres par carte (un coin peut être pris par un timecode/compteur), seul le
// STYLE est unifié.
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

// Anneau de sélection. `inset` pour les tuiles bord-à-bord (aspect-video sans marge) dont un anneau
// externe serait rogné par la gouttière de la grille.
export const selectionRing = (selected: boolean, inset = false) =>
  selected ? cn("border-primary ring-2 ring-primary", inset && "ring-inset") : "border-border";

// Pastille NON interactive (la carte entière bascule la sélection) : rond plein bleu + check,
// rendue seulement quand sélectionné. Coin par défaut = haut-droite ; surcharger via className.
export function SelectCheck({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm",
        className,
      )}
    >
      <Check className="h-3 w-3" strokeWidth={3} />
    </span>
  );
}

// Bouton de sélection interactif, MÊME look que SelectCheck : rond bleu plein si coché, contour
// discret révélé au survol sinon. Coin par défaut = haut-droite ; surcharger via className.
export function SelectToggle({ selected, onToggle, label, className }: {
  selected: boolean;
  onToggle: () => void;
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation("shell");
  return (
    <button
      type="button"
      aria-label={label ?? (selected ? t("select.deselect") : t("select.select"))}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={cn(
        "absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border transition outline-none focus-visible:ring-2 focus-visible:ring-primary",
        selected
          ? "border-primary bg-primary text-primary-foreground opacity-100"
          // Fond opaque, pas de `backdrop-blur` : cette pastille est posée sur des vignettes qui
          // JOUENT (grilles Derush / Collections / Recherche). Un backdrop-filter au-dessus d'une
          // <video> fait recopier et flouter le fond à chaque image décodée, par carte → défilement
          // haché dès que la lecture auto est active.
          : "border-white/70 bg-black/65 text-white/85 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
        className,
      )}
    >
      <Check className="h-3 w-3" strokeWidth={3} />
    </button>
  );
}
