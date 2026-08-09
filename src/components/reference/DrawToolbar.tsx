// Barre flottante du mode dessin : outils (stylo, surligneur, ligne, flèche, rectangle, ellipse,
// losange, gomme), couleur, épaisseur, opacité, annuler/rétablir, sortie. Pilote l'état `pen` du
// store. Raccourcis clavier (une lettre, mode dessin seulement) : voir `key` des TOOLS + Échap.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Pen, Highlighter, Slash, MoveUpRight, Square, Circle, Diamond, Eraser, Undo2, Redo2, Check,
  BringToFront, SendToBack,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ColorPicker } from "@/components/ui/color-picker";
import { useBoard } from "./useReferenceBoard";
import { DrawHeadPicker } from "./DrawHeadPicker";
import { DrawStyleControls } from "./DrawStyleControls";
import { DRAW_TOOL_DEFS, type DrawTool } from "./referenceShared";

const PEN_COLORS = ["#f43f5e", "#f59e0b", "#10b981", "#3b82f6", "#a855f7", "#ffffff", "#111827"];
// Icônes par outil ; libellé + raccourci (personnalisable) viennent de DRAW_TOOL_DEFS / prefs.drawKeys.
const TOOL_ICON: Record<string, typeof Pen> = {
  pen: Pen, marker: Highlighter, line: Slash, arrow: MoveUpRight,
  rect: Square, ellipse: Circle, diamond: Diamond, eraser: Eraser,
};
const TOOLS: { tool: DrawTool; labelKey: string; icon: typeof Pen }[] =
  DRAW_TOOL_DEFS.map((d) => ({ tool: d.tool, labelKey: d.labelKey, icon: TOOL_ICON[d.tool] }));

function isTyping(el: Element | null): boolean {
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);
}

function IconBtn({ label, active, disabled, onClick, children }: {
  label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant={active ? "default" : "ghost"} size="icon-sm" aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function DrawToolbar() {
  const { t } = useTranslation("reference");
  const pen = useBoard((s) => s.pen);
  const setPen = useBoard((s) => s.setPen);
  const setDrawMode = useBoard((s) => s.setDrawMode);
  const undo = useBoard((s) => s.undo);
  const redo = useBoard((s) => s.redo);
  const canUndo = useBoard((s) => s.past.length > 0);
  const canRedo = useBoard((s) => s.future.length > 0);
  const drawBack = useBoard((s) => s.drawBack);
  const setDrawBack = useBoard((s) => s.setDrawBack);
  const drawKeys = useBoard((s) => s.prefs.drawKeys); // raccourcis outils personnalisables (Paramètres)

  const connector = pen.tool === "arrow" || pen.tool === "line";
  const styleable = pen.tool !== "select" && pen.tool !== "eraser";

  // Raccourcis outils (monté seulement en mode dessin) : la lettre affectée change d'outil, Échap termine.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(document.activeElement)) return;
      if (e.key === "Escape") { setDrawMode(false); return; }
      const k = e.key.toLowerCase();
      const tool = Object.keys(drawKeys).find((t) => drawKeys[t] === k) as DrawTool | undefined;
      if (tool) { e.preventDefault(); setPen({ tool }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPen, setDrawMode, drawKeys]);

  return (
    <div className="absolute left-1/2 top-4 z-30 -translate-x-1/2">
      <div className="flex w-max max-w-[96vw] items-center gap-1.5 overflow-x-auto rounded-xl border border-border bg-card/95 px-3 py-2 shadow-xl backdrop-blur">
        {TOOLS.map((tool) => {
          const lbl = t(tool.labelKey);
          return (
            <IconBtn key={tool.tool} label={drawKeys[tool.tool] ? `${lbl} (${drawKeys[tool.tool].toUpperCase()})` : lbl} active={pen.tool === tool.tool} onClick={() => setPen({ tool: tool.tool })}>
              <tool.icon />
            </IconBtn>
          );
        })}

        <Separator orientation="vertical" className="h-6" />

        {/* Largeur / style du trait / type de tracé (route = lignes & flèches seulement). */}
        {styleable && (
          <>
            <DrawStyleControls
              widthPx={pen.width}
              dash={pen.dash}
              route={pen.route}
              showRoute={connector}
              opacity={pen.op}
              onWidthPx={(px) => setPen({ width: px })}
              onDash={(d) => setPen({ dash: d })}
              onRoute={(r) => setPen({ route: r })}
              onOpacity={(v) => setPen({ op: v })}
            />
            <Separator orientation="vertical" className="h-6" />
          </>
        )}

        {/* Pointes de flèche (les 2 extrémités) — visibles quand l'outil flèche est actif. */}
        {pen.tool === "arrow" && (
          <>
            <DrawHeadPicker value={pen.head1} onChange={(h) => setPen({ head1: h })} end="start" label={t("draw.headStart")} />
            <DrawHeadPicker value={pen.head2} onChange={(h) => setPen({ head2: h })} end="end" label={t("draw.headEnd")} />
            <Separator orientation="vertical" className="h-6" />
          </>
        )}

        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <ColorPicker value={pen.color} onChange={(c) => setPen({ color: c })} ariaLabel={t("draw.strokeColor")} presets={PEN_COLORS} side="bottom" />
          </TooltipTrigger>
          <TooltipContent>{t("draw.strokeColor")}</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-6" />

        <IconBtn label={t("actions.undo")} disabled={!canUndo} onClick={undo}><Undo2 /></IconBtn>
        <IconBtn label={t("actions.redo")} disabled={!canRedo} onClick={redo}><Redo2 /></IconBtn>

        <Separator orientation="vertical" className="h-6" />

        {/* Plan du calque de dessin : devant (défaut) ou derrière les items. */}
        <IconBtn
          label={drawBack ? t("draw.drawFront") : t("draw.drawBack")}
          active={drawBack}
          onClick={() => setDrawBack(!drawBack)}
        >
          {drawBack ? <BringToFront /> : <SendToBack />}
        </IconBtn>

        <Separator orientation="vertical" className="h-6" />

        <Button size="sm" onClick={() => setDrawMode(false)}>
          <Check className="mr-1 size-4" /> {t("draw.done")}
        </Button>
      </div>
    </div>
  );
}
