// Sélecteur de RANGEMENT d'une sélection : disposition (packing, grille, ligne, colonne) croisée
// avec une uniformisation de taille (même hauteur / largeur / surface), plus l'écart et l'ordre.
// Les deux passes sont appliquées ensemble par le store (`tidy`) → un seul Ctrl+Z.
//
// Partagé par la barre d'outils et la barre de groupe : un seul endroit à faire évoluer.

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui/react/popover";
import { Blocks, Columns3, Grid2x2, LayoutGrid, Rows3, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useBoard } from "./useReferenceBoard";
import type { ArrangeLayout } from "./boardPrefs";

const LAYOUTS: { value: ArrangeLayout; labelKey: string; icon: typeof LayoutGrid }[] = [
  { value: "block", labelKey: "tidy.layoutBlock", icon: LayoutGrid },
  { value: "pack", labelKey: "tidy.layoutPack", icon: Blocks },
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
  // Géométrie de la sélection à l'ouverture du panneau, et étiquette d'annulation de la session.
  // Chaque réglage rejoue le rangement DEPUIS cet état : comparer deux dispositions compare deux
  // rangements de la même planche, sans dérive d'échelle, et toute la session tient en un Ctrl+Z.
  const base = useRef<Map<string, { x: number; y: number; w: number; h: number }> | null>(null);
  const tag = useRef("");

  const openChange = (next: boolean) => {
    if (!next) { base.current = null; return; }
    const st = useBoard.getState();
    const snap = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const it of st.items) {
      if (st.selectedIds.includes(it.id) && it.kind !== "draw") snap.set(it.id, { x: it.x, y: it.y, w: it.w, h: it.h });
    }
    base.current = snap;
    tag.current = `tidy:${snap.size}:${st.selectedIds.join(",")}`;
  };

  // Tout réglage s'APPLIQUE aussitôt : un panneau où l'on clique « Grille » sans que rien ne bouge
  // se lit comme un bouton mort — il fallait penser à valider ensuite pour voir quoi que ce soit.
  const run = (over: Partial<typeof prefs> = {}) => {
    const p = { ...useBoard.getState().prefs, ...over };
    if (Object.keys(over).length) setPrefs(over);
    tidy({
      layout: p.arrangeLayout,
      uniform: p.arrangeUniform,
      gap: p.arrangeGap,
      sort: p.arrangeSort,
      base: base.current ?? undefined,
      tag: tag.current || undefined,
    });
  };

  return (
    <Popover.Root onOpenChange={openChange}>
      <Tooltip>
        <TooltipTrigger render={<Popover.Trigger render={trigger} disabled={disabled} />} />
        <TooltipContent>{t("tidy.title")}</TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" sideOffset={8} className="z-50 outline-none">
          <Popover.Popup className="w-80 origin-[var(--transform-origin)] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{t("tidy.layout")}</p>
            {/* Grille de 3 : cinq dispositions ne tiennent pas sur une ligne sans tronquer les libellés. */}
            <div className="grid grid-cols-3 gap-1.5">
              {LAYOUTS.map((l) => (
                <Choice
                  key={l.value}
                  active={prefs.arrangeLayout === l.value}
                  label={t(l.labelKey)}
                  onClick={() => run({ arrangeLayout: l.value })}
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
                  onClick={() => run({ arrangeUniform: u.value })}
                />
              ))}
            </div>

            <div className="mt-3 flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span>{t("tidy.gap")}</span>
              <div className="flex items-center gap-2">
                {/* « Collé » : écart 0 ET disposition en bloc, en un clic. Les deux vont ensemble —
                    seul le bloc pave vraiment (lignes justifiées à la même largeur, donc rectangle
                    plein) ; une grille à écart 0 laisserait quand même de l'air autour des médias
                    plus petits que leur case, et l'utilisateur verrait encore « des petits espaces ». */}
                <Button
                  variant={prefs.arrangeGap === 0 ? "default" : "outline"}
                  size="xs"
                  className="h-6 px-2 text-[11px]"
                  aria-pressed={prefs.arrangeGap === 0}
                  onClick={() => run(prefs.arrangeGap === 0 ? { arrangeGap: 16 } : { arrangeGap: 0, arrangeLayout: "block" })}
                >
                  {t("tidy.gapNone")}
                </Button>
                <span className="tabular-nums text-foreground">{prefs.arrangeGap}</span>
              </div>
            </div>
            <Slider
              className="mt-1.5"
              min={0}
              max={200}
              step={2}
              value={prefs.arrangeGap}
              onValueChange={(v) => run({ arrangeGap: Array.isArray(v) ? v[0] : v })}
            />

            <p className="mb-2 mt-3 text-xs font-medium text-muted-foreground">{t("tidy.sort")}</p>
            <div className="flex gap-1.5">
              <Choice
                active={prefs.arrangeSort === "none"}
                label={t("tidy.sortCurrent")}
                onClick={() => run({ arrangeSort: "none" })}
              />
              <Choice
                active={prefs.arrangeSort === "name"}
                label={t("tidy.sortName")}
                onClick={() => run({ arrangeSort: "name" })}
              />
            </div>

            <Popover.Close
              render={
                <Button className="mt-3 w-full gap-1.5" size="sm" onClick={() => run()} disabled={disabled}>
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
