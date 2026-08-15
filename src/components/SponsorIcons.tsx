// Icônes des deux guichets de dons cités par « À propos ». Même forme que DiscordIcon : un chemin
// de simple-icons peint en `currentColor`, la teinte reste décidée par l'appelant.
import { siGithub, siBuymeacoffee } from "simple-icons";
import { cn } from "@/lib/utils";

export function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("shrink-0", className)} aria-hidden>
      <path d={siGithub.path} fill="currentColor" />
    </svg>
  );
}

export function BuyMeACoffeeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("shrink-0", className)} aria-hidden>
      <path d={siBuymeacoffee.path} fill="currentColor" />
    </svg>
  );
}
