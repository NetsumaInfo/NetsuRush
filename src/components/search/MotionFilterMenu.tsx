import { useTranslation } from "react-i18next";
import { Move } from "lucide-react";
import { useApp } from "@/store";
import { NO_MOTION_FILTER, motionFilterActive } from "@/store/search";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { MotionFilter } from "@/lib/bridge";

const SUBJECTS = ["left", "right", "up", "down", "still"] as const;
const CAMERAS = ["pan-left", "pan-right", "pan-up", "pan-down", "zoom-in", "zoom-out", "static"] as const;

// Filters on how a shot moves as it opens or closes (measured at indexing, see python/nrsearch/motion.py),
// plus leaving out each rush's opening and ending. Every change re-runs the search on screen.
export function MotionFilterMenu() {
  const { t } = useTranslation("search");
  const filter = useApp((s) => s.motionFilter);
  const setFilter = useApp((s) => s.setMotionFilter);
  const skipEdges = useApp((s) => s.skipEpisodeEdges);
  const setSkipEdges = useApp((s) => s.setSkipEpisodeEdges);
  const active = motionFilterActive(filter) || skipEdges;

  const toggle = (key: "subject" | "camera", value: string, on: boolean) => {
    const list = filter[key].filter((x) => x !== value);
    setFilter({ ...filter, [key]: on ? [...list, value] : list });
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <DropdownMenuTrigger render={
            <Button variant="ghost" size="icon-sm" aria-label={t("motion.aria")}
              className={cn("text-muted-foreground hover:text-foreground", active && "bg-accent text-foreground")} />
          }>
            <Move className="size-4" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("motion.tooltip")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>{t("motion.at")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={filter.at} onValueChange={(v) => setFilter({ ...filter, at: v as MotionFilter["at"] })}>
          <DropdownMenuRadioItem value="any">{t("motion.atAny")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="start">{t("motion.atStart")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="end">{t("motion.atEnd")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("motion.subject")}</DropdownMenuLabel>
        {SUBJECTS.map((value) => (
          <DropdownMenuCheckboxItem key={value} checked={filter.subject.includes(value)}
            onCheckedChange={(on) => toggle("subject", value, on)}>
            {t(`motion.subjectTag.${value}`)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("motion.camera")}</DropdownMenuLabel>
        {CAMERAS.map((value) => (
          <DropdownMenuCheckboxItem key={value} checked={filter.camera.includes(value)}
            onCheckedChange={(on) => toggle("camera", value, on)}>
            {t(`motion.cameraTag.${value}`)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={skipEdges} onCheckedChange={setSkipEdges}>
          {t("motion.skipEdges")}
        </DropdownMenuCheckboxItem>
        {active && (<>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => { setFilter(NO_MOTION_FILTER); if (skipEdges) setSkipEdges(false); }}>
            {t("motion.reset")}
          </DropdownMenuItem>
        </>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
