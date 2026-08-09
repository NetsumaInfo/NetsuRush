// Icônes des logiciels pilotés (DaVinci Resolve / Premiere Pro / After Effects).
// Icônes d'application ORIGINALES, extraites des exécutables installés par
// `scripts/extract-host-icons.ps1` (256×256 RGBA) — pas de tracé redessiné, pas d'icône générique
// lucide. Relancer le script quand un éditeur change son icône.
// © Blackmagic Design (Resolve) · © Adobe (Premiere Pro, After Effects).
import type { HostId } from "@/store/types";
import { cn } from "@/lib/utils";
import davinciIcon from "@/assets/hosts/davinci-resolve.png";
import premiereIcon from "@/assets/hosts/premiere-pro.png";
import afterEffectsIcon from "@/assets/hosts/after-effects.png";

const ICONS: Record<HostId, string> = {
  resolve: davinciIcon,
  ppro: premiereIcon,
  aeft: afterEffectsIcon,
};

export function HostIcon({ host, className }: { host: HostId; className?: string }) {
  return <img src={ICONS[host]} className={cn("shrink-0", className)} alt="" aria-hidden draggable={false} />;
}

// Logo Adobe — monochrome (suit la couleur du texte) pour l'entrée « Adobe » des paramètres.
export function AdobeLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 151 134" className={cn("shrink-0", className)} aria-hidden>
      <path
        d="M75.3135179,49.1373089 L110.779671,133.285436 L87.5353754,133.285436 L76.923849,106.487306 L50.9697546,106.487306 L75.3135179,49.1373089 Z M150.599272,0 L150.599272,133.268778 L94.9206868,0 L150.599272,0 Z M55.7007962,0 L0,133.268778 L0,0 L55.7007962,0 Z"
        fill="currentColor"
      />
    </svg>
  );
}
