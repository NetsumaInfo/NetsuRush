import { Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

// Note en étoiles (0-5). Interactif si onChange fourni (clic sur une étoile = note ; reclic même = 0).
export function StarRating({ value, onChange, size = 14, className }: {
  value: number; onChange?: (n: number) => void; size?: number; className?: string;
}) {
  const { t } = useTranslation("collections");
  const stars = [1, 2, 3, 4, 5];
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      {stars.map((n) => {
        const on = n <= value;
        const star = <Star style={{ width: size, height: size }} className={on ? "fill-amber-400 text-amber-400" : "text-muted-foreground/50"} />;
        if (!onChange) return <span key={n}>{star}</span>;
        return (
          <button key={n} type="button" aria-label={t("rating.stars", { n })} onClick={(e) => { e.stopPropagation(); onChange(value === n ? 0 : n); }}
            className="transition-transform hover:scale-110 outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
            {star}
          </button>
        );
      })}
    </div>
  );
}
