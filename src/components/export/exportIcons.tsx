// Icônes des profils d'export : jeu de glyphes lucide proposés au choix + rendu d'une icône
// de profil (glyphe nommé OU image importée, avec repli sur l'icône par défaut du flux).
import {
  Download, Clapperboard, Film, Video, FileVideo, Copy, Upload, Send, Share2,
  Save, Sparkles, Wand2, Star, Heart, Flag, Bookmark, Folder, Package, Rocket,
  Zap, Scissors, Image as ImageIcon, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LucideGlyph } from "@/components/common/LucideGlyph";
import type { ExportProfile, ExportWorkflow } from "@/features/export/profiles";

export const EXPORT_ICON_CHOICES: { name: string; Icon: LucideIcon }[] = [
  { name: "Clapperboard", Icon: Clapperboard },
  { name: "Download", Icon: Download },
  { name: "Film", Icon: Film },
  { name: "Video", Icon: Video },
  { name: "FileVideo", Icon: FileVideo },
  { name: "Copy", Icon: Copy },
  { name: "Upload", Icon: Upload },
  { name: "Send", Icon: Send },
  { name: "Share2", Icon: Share2 },
  { name: "Save", Icon: Save },
  { name: "Sparkles", Icon: Sparkles },
  { name: "Wand2", Icon: Wand2 },
  { name: "Star", Icon: Star },
  { name: "Heart", Icon: Heart },
  { name: "Flag", Icon: Flag },
  { name: "Bookmark", Icon: Bookmark },
  { name: "Folder", Icon: Folder },
  { name: "Package", Icon: Package },
  { name: "Rocket", Icon: Rocket },
  { name: "Zap", Icon: Zap },
  { name: "Scissors", Icon: Scissors },
  { name: "Image", Icon: ImageIcon },
];

const ICON_MAP: Record<string, LucideIcon> = Object.fromEntries(
  EXPORT_ICON_CHOICES.map((c) => [c.name, c.Icon]),
);

export function defaultExportIconName(workflow: ExportWorkflow): string {
  if (workflow === "timeline_import") return "Clapperboard";
  if (workflow === "video_remux") return "Copy";
  return "Download";
}

// Rendu de l'icône d'un profil — image importée, emoji, ou glyphe lucide (repli flux). Un nom lucide
// arbitraire (grille cherchable) est résolu via l'espace de noms complet, pas seulement les presets.
export function ExportProfileIcon({ profile, className }: { profile: ExportProfile; className?: string }) {
  const icon = profile.icon;
  if (icon?.type === "image") {
    return <img src={icon.src} alt="" className={cn("rounded-[3px] object-cover", className)} draggable={false} />;
  }
  if (icon?.type === "emoji") {
    return <span className={cn("inline-flex items-center justify-center leading-none", className)}>{icon.ch}</span>;
  }
  const name = icon?.type === "lucide" ? icon.name : defaultExportIconName(profile.workflow);
  const Fallback = ICON_MAP[defaultExportIconName(profile.workflow)] ?? Download;
  // Presets d'abord (déjà dans le bundle) ; un nom venu de la grille complète attend le catalogue.
  const Preset = ICON_MAP[name];
  if (Preset) return <Preset className={className} />;
  return <LucideGlyph name={name} fallback={Fallback} className={className} />;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

// Image fixe → réduction 64×64 (recadrage centré, reste petite en localStorage). GIF animé →
// conservé tel quel (le canvas l'aplatirait et tuerait l'animation).
export async function fileToIconDataUrl(file: File): Promise<string> {
  if (file.type === "image/gif") return readAsDataUrl(file);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return readAsDataUrl(file);
    const s = Math.min(img.width, img.height) || size;
    ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}
