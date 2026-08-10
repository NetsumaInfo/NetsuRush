// Icône d'un dossier de collection : pictogramme lucide (parmi un jeu choisi) OU petite image
// uploadée, teintée du code couleur du dossier. Source unique partagée (liste, ranger, détail).
import {
  Folder, Star, Heart, Bookmark, Film, Clapperboard, Clapperboard as Slate, Camera, Video,
  Sparkles, Zap, Flame, Music, Mic, Tag, Sword, Ghost, Leaf, Crown, Eye, Rocket, Sun, Moon,
  Cloud, Droplet, Palette, Wand2, type LucideIcon,
} from "lucide-react";
import type { CollectionIcon } from "@/lib/bridge";
import { nr } from "@/lib/bridge";
import { LucideGlyph } from "@/components/common/LucideGlyph";

// Jeu d'icônes proposé au choix (clé = identifiant persisté dans `icon.name`).
const COLLECTION_ICONS: Record<string, LucideIcon> = {
  folder: Folder, star: Star, heart: Heart, bookmark: Bookmark, film: Film, slate: Slate,
  camera: Camera, video: Video, sparkles: Sparkles, zap: Zap, flame: Flame, music: Music,
  mic: Mic, tag: Tag, sword: Sword, ghost: Ghost, leaf: Leaf, crown: Crown, eye: Eye,
  rocket: Rocket, sun: Sun, moon: Moon, cloud: Cloud, droplet: Droplet, palette: Palette,
  wand: Wand2, clapper: Clapperboard,
};

export const DEFAULT_COLLECTION_COLOR = "#3b82f6";

// Le carré est BLOC (jamais `inline-*`) : posé en enfant direct d'un conteneur non-flex (la plaque
// d'une carte Galerie), un inline-block s'aligne sur la ligne de base et laisse dépasser l'espace du
// jambage sous lui — le fond de la plaque s'y voyait comme une bande noire.
// Rend l'icône d'un dossier. `size` = côté du carré (px). La couleur teinte le pictogramme lucide
// et sert de fond léger ; une image uploadée remplit le carré (couleur = contour).
export function CollectionGlyph({
  icon, color, size = 40, className,
}: {
  icon: CollectionIcon | null;
  color: string | null;
  size?: number;
  className?: string;
}) {
  const c = color || DEFAULT_COLLECTION_COLOR;
  if (icon?.kind === "emoji") {
    // Emoji natif : fond NEUTRE (pas de teinte couleur → évite le rendu bizarre sur un pictogramme
    // déjà coloré), emoji centré occupant ~62 % du carré.
    return (
      <span
        className={className}
        style={{
          width: size, height: size, borderRadius: size * 0.28,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "color-mix(in srgb, var(--color-fg) 8%, transparent)",
          fontSize: size * 0.62, lineHeight: 1,
        }}
      >
        {icon.ch}
      </span>
    );
  }
  if (icon?.kind === "image") {
    return (
      <span
        className={className}
        style={{
          width: size, height: size, borderRadius: size * 0.28,
          display: "block", overflow: "hidden",
        }}
      >
        <img src={nr.mediaUrl(icon.path)} alt="" className="h-full w-full object-cover" draggable={false} />
      </span>
    );
  }
  // Jeu curaté d'abord (noms courts historiques, déjà dans le bundle) ; un nom hors jeu vient du
  // sélecteur complet et attend le catalogue asynchrone, repli `Folder` en attendant.
  const lucideName = icon?.kind === "lucide" ? icon.name : "";
  const Curated = lucideName ? COLLECTION_ICONS[lucideName] : Folder;
  const glyphStyle = { width: size * 0.5, height: size * 0.5 };
  return (
    <span
      className={className}
      style={{
        width: size, height: size, borderRadius: size * 0.28,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: `color-mix(in srgb, ${c} 18%, transparent)`, color: c,
      }}
    >
      {Curated
        ? <Curated style={glyphStyle} />
        : <LucideGlyph name={lucideName} fallback={Folder} style={glyphStyle} />}
    </span>
  );
}
