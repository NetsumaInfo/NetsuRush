// Sélecteur de pointe de flèche/ligne (une extrémité). Glyphes SVG inline = aperçu fidèle de chaque
// type. Partagé par la barre du mode dessin et l'inspecteur de forme.

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import type { ArrowHead } from "./referenceShared";

const HEADS: { v: ArrowHead; labelKey: string }[] = [
  { v: "none", labelKey: "heads.none" },
  { v: "arrow", labelKey: "heads.arrow" },
  { v: "triangle", labelKey: "heads.triangle" },
  { v: "dot", labelKey: "heads.dot" },
  { v: "bar", labelKey: "heads.bar" },
];

// Glyphe : un segment horizontal terminé par la pointe. `flip` = pointe à gauche (extrémité de départ).
function HeadGlyph({ type, flip }: { type: ArrowHead; flip?: boolean }) {
  const s = { stroke: "currentColor", strokeWidth: 1.6, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const head = (() => {
    if (type === "none") return null;
    if (type === "dot") return <circle cx={20} cy={6} r={2.6} fill="currentColor" stroke="none" />;
    if (type === "bar") return <line x1={20} y1={2} x2={20} y2={10} {...s} />;
    if (type === "triangle") return <polygon points="20,6 14,2.5 14,9.5" fill="currentColor" stroke="currentColor" />;
    return <><line x1={20} y1={6} x2={14} y2={2.5} {...s} /><line x1={20} y1={6} x2={14} y2={9.5} {...s} /></>;
  })();
  return (
    <svg viewBox="0 0 24 12" width={24} height={12} aria-hidden style={flip ? { transform: "scaleX(-1)" } : undefined}>
      <line x1={4} y1={6} x2={20} y2={6} {...s} />
      {head}
    </svg>
  );
}

export function DrawHeadPicker({ value, onChange, end, label }: {
  value: ArrowHead; onChange: (h: ArrowHead) => void; end: "start" | "end"; label: string;
}) {
  const { t } = useTranslation("reference");
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} />} />}>
          <HeadGlyph type={value} flip={end === "start"} />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent>
        {HEADS.map((h) => (
          <DropdownMenuItem key={h.v} onClick={() => onChange(h.v)}>
            <span className="text-foreground"><HeadGlyph type={h.v} flip={end === "start"} /></span>
            <span className="ml-1">{t(h.labelKey)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
