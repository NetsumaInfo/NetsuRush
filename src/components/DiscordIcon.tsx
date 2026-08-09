import { siDiscord } from "simple-icons";
import { cn } from "@/lib/utils";

export function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("shrink-0", className)} aria-hidden>
      <path d={siDiscord.path} fill="currentColor" />
    </svg>
  );
}
