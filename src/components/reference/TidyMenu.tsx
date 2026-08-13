// Sélecteur de RANGEMENT d'une sélection : disposition (packing, grille, ligne, colonne) croisée
// avec une uniformisation de taille (même hauteur / largeur / surface), plus l'écart et l'ordre.
// Les deux passes sont appliquées ensemble par le store (`tidy`) → un seul Ctrl+Z.
//
// Partagé par la barre d'outils et la barre de groupe : un seul endroit à faire évoluer.

import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui/react/popover";
import { Columns3, Grid2x2, LayoutGrid, Rows3, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useBoard } from "./useReferenceBoard";
import type { ArrangeLayout } from "./boardPrefs";

const LAYOUTS: { value: ArrangeLayout; labelKey: string; icon: typeof LayoutGrid }[] = [
  { value: "pack", labelKey: "tidy.layoutPack", icon: LayoutGrid },
  { value: "grid", labelKey: "tidy.layoutGrid", icon: Grid2x2 },
  { value: "row", labelKey: "tidy.layoutRow", icon: Columns3 },
  { value: "col", labelKey: "tidy.layoutCol", icon: Rows3 },
];

const UNIFORMS: { value: "none" | "height" | "width" | "area"; labelKey: string }[] = [
  { value: "none", labelKey: "tidy.uniformNone" },
  { value: "height", labelKey: "tidy.uniformHeight" },
  { value: "width", labelKey: "tidy.uniformWidth" },
  { value: "area", labelKey: "tidy.uniformArea" },
];

function Choice({ active, label, onClick, children }: {
  active: boolean; label: string; onClick: () => void; children?: React.ReactNode;
}) {
  return (
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      className="h-8 flex-1 gap-1.5 px-2 text-xs"
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
      {label}
    </Button>
  );
}

export function TidyMenu({ disabled, trigger }: { disabled?: boolean; trigger: React.ReactElement }) {
  const { t } = useTranslation("reference");
  const prefs = useBoard((s) => s.prefs);
  const setPrefs = useBoard((s) => s.setPrefs);
  const tidy = useBoard((s) => s.tidy);

  const run = () => tidy({
    layout: prefs.arrangeLayout,
    uniform: prefs.arrangeUniform,
    gap: prefs.arrangeGap,
    sort: prefs.arrangeSort,
  });

  return (
    <Popover.Root>
      <Tooltip>
        <TooltipTrigger render={<Popover.Trigger render={trigger} disabled={disabled} />} />
        <TooltipContent>{t("tidy.title")}</TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" sideOffset={8} className="z-50 outline-none">
          <Popover.Popup className="w-72 origin-[var(--transform-origin)] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{t("tidy.layout")}</p>
            <div className="flex gap-1.5">
              {LAYOUTS.map((l) => (
                <Choice
                  key={l.value}
                  active={prefs.arrangeLayout === l.value}
                  label={t(l.labelKey)}
                  onClick={() => setPrefs({ arrangeLayout: l.value })}
                >
                  <l.icon className="size-3.5" />
                </Choice>
              ))}
            </div>

            <p className="mb-2 mt-3 text-xs font-medium text-muted-foreground">{t("tidy.uniform")}</p>
            <div className="flex flex-wrap gap-1.5">
              {UNIFORMS.map((u) => (
                <Choice
                  key={u.value}
                  active={prefs.arrangeUniform === u.value}
                  label={t(u.labelKey)}
                  onClick={() => setPrefs({ arrangeUniform: u.value })}
                />
              ))}
            </div>

            <div className="mt-3 flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span>{t("tidy.gap")}</span>
              <span className="tabular-nums text-foreground">{prefs.arrangeGap}</span>
            </div>
            <Slider
              className="mt-1.5"
              min={0}
              max={200}
              step={2}
              value={prefs.arrangeGap}
              onValueChange={(v) => setPrefs({ arrangeGap: Array.isArray(v) ? v[0] : v })}
            />

            <p className="mb-2 mt-3 text-xs font-medium text-muted-foreground">{t("tidy.sort")}</p>
            <div className="flex gap-1.5">
              <Choice
                active={prefs.arrangeSort === "none"}
                label={t("tidy.sortCurrent")}
                onClick={() => setPrefs({ arrangeSort: "none" })}
              />
              <Choice
                active={prefs.arrangeSort === "name"}
                label={t("tidy.sortName")}
                onClick={() => setPrefs({ arrangeSort: "name" })}
              />
            </div>

            <Popover.Close
              render={
                <Button className="mt-3 w-full gap-1.5" size="sm" onClick={run} disabled={disabled}>
                  <Wand2 className="size-3.5" />
                  {t("tidy.apply")}
                </Button>
              }
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
