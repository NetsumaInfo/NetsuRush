import { useTranslation } from "react-i18next";
import type { MotionEnd, ShotMotion } from "@/lib/bridge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ARROWS: Record<string, string> = {
  right: "→", "down-right": "↘", down: "↓", "down-left": "↙",
  left: "←", "up-left": "↖", up: "↑", "up-right": "↗",
};

/** What one end of the shot shows at a glance: the subject's direction first, the camera's otherwise. */
function glyph(end: MotionEnd): { text: string; camera: boolean } | null {
  if (ARROWS[end.subject]) return { text: ARROWS[end.subject], camera: false };
  if (end.camera.startsWith("pan-")) return { text: ARROWS[end.camera.slice(4)] ?? "", camera: true };
  if (end.camera === "zoom-in") return { text: "+", camera: true };
  if (end.camera === "zoom-out") return { text: "−", camera: true };
  return null;
}

// Start and end motion of a search hit, as two arrows (subject in white, camera dimmed). Hidden for a
// shot that does not move at either end: most anime shots are static and a badge on every card is noise.
export function MotionBadge({ motion, interactive }: { motion: ShotMotion; interactive: boolean }) {
  const { t } = useTranslation("search");
  const start = glyph(motion.start);
  const end = glyph(motion.end);
  if (!start && !end) return null;

  const describe = (e: MotionEnd) => {
    const subject = ARROWS[e.subject]
      ? t("motion.describe.subjectMoving", { dir: t(`motion.dir.${e.subject}`) }) + (e.speed ? ` (${t(`motion.describe.speed.${e.speed}`)})` : "")
      : e.subject === "still" ? t("motion.describe.subjectStill") : t("motion.describe.subjectUnclear");
    const camera = e.camera.startsWith("pan-")
      ? t("motion.describe.cameraPan", { dir: t(`motion.dir.${e.camera.slice(4)}`) })
      : e.camera === "zoom-in" ? t("motion.describe.zoomIn")
      : e.camera === "zoom-out" ? t("motion.describe.zoomOut")
      : e.camera === "static" ? t("motion.describe.cameraStatic") : t("motion.describe.cameraUnclear");
    return `${subject}, ${camera}`;
  };

  const cell = (g: ReturnType<typeof glyph>) => (
    <span className={cn("inline-block w-2.5 text-center", g?.camera && "opacity-60")}>{g?.text ?? "·"}</span>
  );
  const chip = (
    <span className="nr-chip inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[11px] font-semibold leading-none text-white"
      aria-label={t("motion.badgeAria")}>
      {cell(start)}<span className="opacity-50">›</span>{cell(end)}
    </span>
  );
  if (!interactive) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipContent>
        <div>{t("motion.badgeStart", { desc: describe(motion.start) })}</div>
        <div>{t("motion.badgeEnd", { desc: describe(motion.end) })}</div>
      </TooltipContent>
    </Tooltip>
  );
}
