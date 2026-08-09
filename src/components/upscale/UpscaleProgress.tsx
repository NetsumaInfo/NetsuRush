import NumberFlow from "@number-flow/react";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { UpscaleProgress as UpProg } from "@/lib/bridge";
import { useTranslation } from "react-i18next";

// `label` = libellé de la phase d'inférence (défaut « Upscaling » ; le hub passe « Interpolation »…).
export function UpscaleProgress({ busy, label }: { busy: UpProg; label?: string }) {
  const { t } = useTranslation("upscale");
  const ph = busy.phase === "model"
    ? { t: t("progress.model"), dot: "bg-primary animate-pulse", cls: "text-primary bg-primary/10" }
    : { t: label ?? t("progress.upscaling"), dot: "bg-[var(--color-ok)]", cls: "text-[var(--color-ok)] bg-[var(--color-ok)]/10" };
  return (
    <Card className="block p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium", ph.cls)}>
            <span className={cn("h-1.5 w-1.5 rounded-full", ph.dot)} />
            {ph.t}
          </span>
          <span className="truncate text-muted-foreground">{busy.file}</span>
        </div>
        <span className="shrink-0 tabular-nums text-muted-foreground"><NumberFlow value={busy.done + 1} />/<NumberFlow value={busy.total} /></span>
      </div>
      <Progress value={busy.pct ?? 0} />
    </Card>
  );
}
