// Variante 256 px : l'icône est rendue jusqu'à 64 px CSS (« À propos ») — la 128 px y devient molle
// sur écran hidpi, alors que la barre de titre (24 px) ne perd rien à downscaler.
import netsurushIcon from "../../src-tauri/icons/128x128@2x.png";
import { cn } from "@/lib/utils";

export function BrandIcon({ className, alt = "" }: { className?: string; alt?: string }) {
  return (
    <img
      src={netsurushIcon}
      alt={alt}
      className={cn("shrink-0 object-contain", className)}
      draggable={false}
    />
  );
}
