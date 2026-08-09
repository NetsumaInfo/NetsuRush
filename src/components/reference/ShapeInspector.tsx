// Inspecteur d'une forme sélectionnée (outil sélection) : couleur, largeur/style/type de tracé,
// opacité, pointes (flèche/ligne), remplissage + coins arrondis (formes fermées), duplication,
// suppression.
import { useTranslation } from "react-i18next";
import { Copy, PaintBucket, Radius, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { DrawHeadPicker } from "./DrawHeadPicker";
import { DrawStyleControls } from "./DrawStyleControls";
import { routeOf } from "./drawGeometry";
import type { DrawShape } from "./referenceShared";

const INSP_COLORS = ["#f43f5e", "#f59e0b", "#10b981", "#3b82f6", "#a855f7", "#ffffff", "#111827"];

export function ShapeInspector({ shape, scale, onPatch, onDuplicate, onDelete }: {
  shape: DrawShape; scale: number; onPatch: (p: Partial<DrawShape>) => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const { t } = useTranslation("reference");
  const isConnector = shape.t === "line" || shape.t === "arrow";
  const isClosed = shape.t === "rect" || shape.t === "ellipse" || shape.t === "diamond";
  const filled = !!shape.fill && shape.fill !== "none";
  return (
    <div
      className="pointer-events-auto absolute bottom-4 left-1/2 z-30 -translate-x-1/2"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex w-max max-w-[96vw] items-center gap-2 overflow-x-auto rounded-xl border border-border bg-card/95 px-3 py-2 shadow-xl backdrop-blur">
        <div className="flex items-center gap-1">
          {INSP_COLORS.map((c) => (
            <button
              key={c} type="button" aria-label={t("shape.colorSwatch", { color: c })}
              onClick={() => onPatch(filled ? { c, fill: `color-mix(in srgb, ${c} 22%, transparent)` } : { c })}
              className={`size-5 rounded-full border outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-primary ${shape.c === c ? "ring-2 ring-primary ring-offset-1 ring-offset-card" : "border-border"}`}
              style={{ background: c }}
            />
          ))}
        </div>

        <Separator orientation="vertical" className="h-6" />

        <DrawStyleControls
          widthPx={Math.max(1, Math.round(shape.w * scale))}
          dash={shape.dash ?? "solid"}
          route={routeOf(shape)}
          showRoute={isConnector}
          opacity={shape.op ?? 1}
          onWidthPx={(px) => onPatch({ w: px / scale })}
          onDash={(d) => onPatch({ dash: d })}
          // courbe → conserve un cintrage existant ; droite/coudée → retire le point de contrôle.
          onRoute={(r) => onPatch({ route: r, cp: r === "curved" ? shape.cp : undefined })}
          onOpacity={(v) => onPatch({ op: v === 1 ? undefined : v })}
        />

        {isConnector && (
          <>
            <Separator orientation="vertical" className="h-6" />
            <DrawHeadPicker value={shape.h1 ?? "none"} onChange={(h) => onPatch({ h1: h })} end="start" label={t("draw.headStart")} />
            <DrawHeadPicker value={shape.h2 ?? (shape.t === "arrow" ? "arrow" : "none")} onChange={(h) => onPatch({ h2: h })} end="end" label={t("draw.headEnd")} />
          </>
        )}

        {isClosed && (
          <>
            <Separator orientation="vertical" className="h-6" />
            <Tooltip>
              <TooltipTrigger render={
                <Button
                  variant={filled ? "default" : "ghost"} size="icon-sm" aria-label={t("shape.fill")} aria-pressed={filled}
                  onClick={() => onPatch({ fill: filled ? "none" : `color-mix(in srgb, ${shape.c} 22%, transparent)` })}
                />
              }>
                <PaintBucket />
              </TooltipTrigger>
              <TooltipContent>{t("shape.fillLabel")}</TooltipContent>
            </Tooltip>
            {shape.t === "rect" && (
              <Tooltip>
                <TooltipTrigger render={
                  <Button
                    variant={shape.r ? "default" : "ghost"} size="icon-sm" aria-label={t("shape.rounded")} aria-pressed={!!shape.r}
                    onClick={() => onPatch({ r: shape.r ? undefined : true })}
                  />
                }>
                  <Radius />
                </TooltipTrigger>
                <TooltipContent>{t("shape.rounded")}</TooltipContent>
              </Tooltip>
            )}
          </>
        )}

        <Separator orientation="vertical" className="h-6" />
        <Button variant="ghost" size="icon-sm" aria-label={t("shape.duplicate")} onClick={onDuplicate}>
          <Copy />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={t("common:action.delete")} onClick={onDelete}>
          <Trash2 className="text-destructive" />
        </Button>
      </div>
    </div>
  );
}
