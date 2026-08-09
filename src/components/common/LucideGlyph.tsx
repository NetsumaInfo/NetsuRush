// Rend un glyphe lucide désigné par son NOM persisté (icône de dossier, de profil d'export, de page
// du Carnet). Le catalogue complet arrive dans un chunk asynchrone : le repli s'affiche d'ici là.
import { createElement, type CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import { lucideIcon, useLucideCatalog } from "@/lib/lucideCatalog";

export function LucideGlyph({
  name,
  fallback,
  className,
  style,
}: {
  name: string;
  fallback: LucideIcon;
  className?: string;
  style?: CSSProperties;
}) {
  useLucideCatalog();
  return createElement(lucideIcon(name) ?? fallback, { className, style });
}
