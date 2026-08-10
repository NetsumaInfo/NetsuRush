// Contrôles de style d'un tracé : largeur (3 paliers), style du trait
// (plein/tirets/points) et — pour les lignes/flèches — type de tracé (droite/courbe/coudée).
// Partagé par la barre du mode dessin (édite le `pen`) et l'inspecteur de forme (édite la forme).

import { useTranslation } from "react-i18next";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { NumberSpin } from "./inspectorControls";
import type { DashStyle, RouteStyle } from "./referenceShared";

// Paliers de largeur (px écran) — fin / moyen / épais.
const WIDTH_PRESETS = [2, 5, 9];

function Item({ value, label, children }: { value: string; label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<ToggleGroupItem value={value} aria-label={label} className="px-2" />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const Glyph = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 22 14" width={22} height={14} aria-hidden style={{ color: "currentColor" }}>{children}</svg>
);
const L = { stroke: "currentColor", fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

// Paliers d'opacité proposés (fraction 0–1).
const OPACITY_PRESETS = [1, 0.75, 0.5, 0.25];

export function DrawStyleControls({ widthPx, dash, route, showRoute, opacity, onWidthPx, onDash, onRoute, onOpacity }: {
  widthPx: number;
  dash: DashStyle;
  route?: RouteStyle;
  showRoute?: boolean;
  opacity?: number; // fourni avec onOpacity → affiche les paliers d'opacité
  onWidthPx: (px: number) => void;
  onDash: (d: DashStyle) => void;
  onRoute?: (r: RouteStyle) => void;
  onOpacity?: (v: number) => void;
}) {
  const { t } = useTranslation("reference");
  const WIDTH_LABELS = [t("drawStyle.thin"), t("drawStyle.medium"), t("drawStyle.thick")];
  // palier actif = le plus proche de la largeur courante.
  const wIdx = WIDTH_PRESETS.reduce((best, p, i) => (Math.abs(p - widthPx) < Math.abs(WIDTH_PRESETS[best] - widthPx) ? i : best), 0);
  return (
    <div className="flex items-center gap-1.5">
      <ToggleGroup value={[String(wIdx)]} onValueChange={(v) => v[0] != null && onWidthPx(WIDTH_PRESETS[Number(v[0])])} variant="outline" size="sm" spacing={0}>
        {WIDTH_PRESETS.map((p, i) => (
          <Item key={p} value={String(i)} label={WIDTH_LABELS[i]}>
            <Glyph><line x1={3} y1={7} x2={19} y2={7} {...L} strokeWidth={1.5 + i * 2} /></Glyph>
          </Item>
        ))}
      </ToggleGroup>

      {/* Taille exacte (px), libre — au-delà des 3 paliers. */}
      <NumberSpin value={Math.max(1, Math.round(widthPx))} min={1} max={100} ariaLabel={t("drawStyle.width")} onCommit={onWidthPx} />


      <ToggleGroup value={[dash]} onValueChange={(v) => v[0] && onDash(v[0] as DashStyle)} variant="outline" size="sm" spacing={0}>
        <Item value="solid" label={t("drawStyle.solid")}><Glyph><line x1={3} y1={7} x2={19} y2={7} {...L} strokeWidth={2} /></Glyph></Item>
        <Item value="dashed" label={t("drawStyle.dashed")}><Glyph><line x1={3} y1={7} x2={19} y2={7} {...L} strokeWidth={2} strokeDasharray="4 3" /></Glyph></Item>
        <Item value="dotted" label={t("drawStyle.dotted")}><Glyph><line x1={3} y1={7} x2={19} y2={7} {...L} strokeWidth={2} strokeDasharray="0.5 3.5" /></Glyph></Item>
      </ToggleGroup>

      {showRoute && route != null && onRoute && (
        <ToggleGroup value={[route]} onValueChange={(v) => v[0] && onRoute(v[0] as RouteStyle)} variant="outline" size="sm" spacing={0}>
          <Item value="straight" label={t("drawStyle.straight")}><Glyph><line x1={3} y1={11} x2={19} y2={3} {...L} strokeWidth={2} /></Glyph></Item>
          <Item value="curved" label={t("drawStyle.curved")}><Glyph><path d="M3 11 Q11 -1 19 4" {...L} strokeWidth={2} /></Glyph></Item>
          <Item value="elbow" label={t("drawStyle.elbow")}><Glyph><path d="M3 11 L11 11 L11 4 L19 4" {...L} strokeWidth={2} /></Glyph></Item>
        </ToggleGroup>
      )}

      {/* Opacité (paliers) — palier actif = le plus proche de la valeur courante. */}
      {opacity != null && onOpacity && (
        <ToggleGroup
          value={[String(OPACITY_PRESETS.reduce((best, p, i) => (Math.abs(p - opacity) < Math.abs(OPACITY_PRESETS[best] - opacity) ? i : best), 0))]}
          onValueChange={(v) => v[0] != null && onOpacity(OPACITY_PRESETS[Number(v[0])])}
          variant="outline" size="sm" spacing={0}
        >
          {OPACITY_PRESETS.map((p, i) => (
            <Item key={p} value={String(i)} label={t("drawStyle.opacity", { pct: Math.round(p * 100) })}>
              <Glyph><line x1={3} y1={7} x2={19} y2={7} {...L} strokeWidth={4} opacity={p} /></Glyph>
            </Item>
          ))}
        </ToggleGroup>
      )}
    </div>
  );
}
