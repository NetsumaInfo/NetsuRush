import { cn } from "@/lib/utils";
import { CHANNEL_LABEL, IS_PRERELEASE } from "@/lib/release";

// Pastille « BETA » posée à côté de la marque. Ne rend RIEN hors pré-publication (cf. release.ts)
// → aucun nettoyage à faire au passage en stable.
export function BetaBadge({ className }: { className?: string }) {
  if (!IS_PRERELEASE) return null;
  return (
    <span
      className={cn(
        "select-none rounded-full border border-primary/35 bg-primary/12 px-1.5 py-px",
        "text-[9px] font-semibold uppercase leading-[14px] tracking-[0.14em] text-primary",
        className,
      )}
    >
      {CHANNEL_LABEL}
    </span>
  );
}
