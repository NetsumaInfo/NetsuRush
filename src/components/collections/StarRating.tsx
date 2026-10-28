import { NetsuIcon } from "@/components/ui/netsu-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

// Note en étoiles (0-5). Interactif si onChange fourni (clic sur une étoile = note ; reclic même = 0).
// Size is a Tailwind class on the icon: an inline span ignores width/height.
export function StarRating({ value, onChange, iconClassName = "size-3.5", className }: {
  value: number; onChange?: (n: number) => void; iconClassName?: string; className?: string;
}) {
  const { t } = useTranslation("collections");
  const stars = [1, 2, 3, 4, 5];
  return (
    <div className={cn("flex items-center", className)}>
      {stars.map((n) => {
        const on = n <= value;
        const star = (
          <NetsuIcon name="star" on={on} className={cn("shrink-0", iconClassName, on ? "text-amber-400" : "text-muted-foreground/50")} />
        );
        if (!onChange) return <span key={n} className="inline-flex">{star}</span>;
        const label = t("rating.stars", { count: n });
        return (
          <Tooltip key={n}>
            <TooltipTrigger render={<button type="button" aria-label={label} onClick={(e) => { e.stopPropagation(); onChange(value === n ? 0 : n); }}
              className="inline-flex size-6 items-center justify-center rounded outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" />}>
              {star}
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
