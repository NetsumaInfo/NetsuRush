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

const EXPORT_ICON_CHOICES: { name: string; Icon: LucideIcon }[] = [
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

function defaultExportIconName(workflow: ExportWorkflow): string {
  if (workflow === "timeline_import") return "Clapperboard";
  if (workflow === "video_remux") return "Copy";
  return "Download";
}

// Rendu de l'icône d'un profil — image importée, emoji, ou glyphe lucide (repli flux). Un nom lucide
// arbitraire (grille cherchable) est résolu via l'espace de noms complet, pas seulement les presets.
export function ExportProfileIcon({ profile, className }: { profile: ExportProfile; className?: string }) {
  const icon = profile.icon;
  if (icon?.type === "image") {
    // Une image importée n'a pas la marge intérieure d'un glyphe lucide : rendue à la taille du
    // glyphe, un logo devient illisible. On la laisse déborder de sa boîte (150 %, centrée) et on
    // ne la recadre JAMAIS — `object-contain` garde l'alpha et les proportions entières.
    return (
      <span className={cn("relative inline-block align-middle", className)}>
        <img
          src={icon.src}
          alt=""
          className="absolute left-1/2 top-1/2 h-auto max-h-[150%] w-auto max-w-[150%] -translate-x-1/2 -translate-y-1/2 object-contain"
          draggable={false}
        />
      </span>
    );
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

// Image fixe → réduction à 128 px sur le plus grand côté, PROPORTIONS CONSERVÉES (aucun recadrage :
// une bannière ou un logo large perdrait ses bords, et l'alpha du PNG est préservé). GIF animé →
// conservé tel quel (le canvas l'aplatirait et tuerait l'animation).
const ICON_MAX_SIDE = 128;

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
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return readAsDataUrl(file);
    const scale = Math.min(1, ICON_MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return readAsDataUrl(file);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}
