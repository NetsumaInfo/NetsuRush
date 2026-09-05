import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import type { FlowBakeProgress } from "@/lib/bridge";

const POLL_MS = 500;
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

/// Gibibytes read as "0,00" below a gigabyte, so the unit follows the number.
function formatBytes(bytes: number) {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(2)} Gio` : `${Math.round(bytes / MIB)} Mio`;
}

export function FlowCache({ running }: { running: boolean }) {
  const { t } = useTranslation("flow");
  const [progress, setProgress] = useState<FlowBakeProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!running) return null;
    try {
      const next = await nr.flowBakeProgress();
      setProgress(next);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [running]);

  // Polled only while a bake is in flight: an idle cache panel that keeps
  // asking is a timer nobody needs.
  useEffect(() => {
    void refresh();
    if (!progress?.running) return;
    const timer = setTimeout(() => { void refresh(); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [refresh, progress?.running, progress?.done]);

  const act = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (!running || !progress) return null;

  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-3 p-3">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("cacheTitle")}
      </h4>

      <div className="flex items-baseline gap-2">
        <b className="text-2xl tabular-nums">{formatBytes(progress.bytes)}</b>
        <span className="text-xs text-muted-foreground">
          {progress.frames} {t("frames")}
          {progress.limit > 0 ? ` · ${Math.round(progress.limit / GIB)} Gio max` : ""}
        </span>
      </div>

      {/* Every tier is lossless, so this trades encode time against size and
          never quality. Saying so in the panel matters: a control labelled
          "quality" that cannot lower quality needs to explain itself. */}
      <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
        <Label className="text-xs text-muted-foreground">{t("storage")}</Label>
        <Select
          value={progress.quality}
          onValueChange={(next) => void act(() => nr.flowBakeQuality(String(next ?? "")))}
          disabled={busy || progress.running}
        >
          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {progress.qualities.map((name) => (
              <SelectItem key={name} value={name}>{t(`q_${name}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger render={
            <Button size="sm" disabled={busy || progress.running} onClick={() => void act(nr.flowBake)}>
              {t("bake")}
            </Button>
          } />
          <TooltipContent>{t("bakeHint")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || progress.frames === 0}
              onClick={() => void act(nr.flowBakeClear)}
            >
              {t("clear")}
            </Button>
          } />
          <TooltipContent>{t("clearHint")}</TooltipContent>
        </Tooltip>
      </div>

      {progress.running ? (
        <div className="flex items-center gap-2">
          <Progress value={percent} className="h-1.5 flex-1" />
          <span className="text-xs tabular-nums text-muted-foreground">
            {progress.done} / {progress.total}
          </span>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">{t("cacheAuto")} {t("lossless")}</p>
      {progress.directory ? (
        <code className="break-all font-mono text-[11px] text-muted-foreground">
          {progress.directory}
        </code>
      ) : null}
      {error || progress.error ? (
        <p className="text-xs text-destructive">{error || progress.error}</p>
      ) : null}
    </div>
  );
}
