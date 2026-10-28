import { useTranslation } from "react-i18next";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { SendToTimelineIcon } from "@/components/common/SendToTimelineIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { basename } from "@/lib/utils";
import { useAeExport } from "./useAeExport";
import { AeOptionsForm } from "./AeOptionsForm";

export function AfterEffectsExport() {
  const { t } = useTranslation("ae");
  const ae = useAeExport();
  const { timelineName, needsDir, busy, progress, result, run } = ae;
  const canRun = !!timelineName && !busy && !needsDir;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-7">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <NetsuIcon name="film-slate" className="size-5 text-primary" /> {t("header.title")}
        </h1>
        <p className="text-xs text-muted-foreground">
          {t("header.subtitle")}
        </p>
      </header>

      <AeOptionsForm ae={ae} />

      <div className="space-y-3">
        {busy && progress && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>{progress.phase}</span>
              <span className="tabular-nums">{progress.done}/{progress.total}</span>
            </div>
            <Progress value={progress.pct} />
          </div>
        )}

        {result && !result.ok && (
          <Card className="block border-destructive/40 p-3 text-xs text-destructive">
            <NetsuIcon name="warning" className="mr-1.5 inline size-3.5" /> {result.error}
            {result.script && <p className="mt-1 text-muted-foreground">{t("result.scriptPrefix", { name: basename(result.script) })}</p>}
          </Card>
        )}
        {result?.ok && (
          <Card className="block p-3 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-[var(--color-ok)]">
              <NetsuIcon name="status-ok" className="size-3.5" />
              {t("result.clipsDone", { count: result.clips, comp: result.comp })}
            </div>
            <p className="mt-1 text-muted-foreground">
              {result.aeRunning
                ? t("result.imported")
                : t("result.launching")}
            </p>
            {result.missing && result.missing.length > 0 && (
              <p className="mt-1 text-muted-foreground">{t("result.missing", { count: result.missing.length })}</p>
            )}
          </Card>
        )}

        <Button className="w-full" size="lg" onClick={run} disabled={!canRun}>
          <SendToTimelineIcon host="aeft" busy={busy} className="size-4" />
          {busy ? t("run.busy") : t("run.label")}
        </Button>
      </div>
    </div>
  );
}
