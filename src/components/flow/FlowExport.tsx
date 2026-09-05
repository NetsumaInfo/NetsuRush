import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { nr } from "@/lib/bridge";
import type { FlowExportInfo } from "@/lib/bridge";

const POLL_MS = 500;

export function FlowExport({ running, durationFrames }: {
  running: boolean;
  durationFrames: number;
}) {
  const { t } = useTranslation("flow");
  const [info, setInfo] = useState<FlowExportInfo | null>(null);
  const [format, setFormat] = useState("");
  const [directory, setDirectory] = useState("");
  const [name, setName] = useState("");
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(Math.max(0, durationFrames - 1));
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!running) return;
    try {
      const next = await nr.flowExportInfo();
      setInfo(next);
      // The fields follow the service only until the user has touched them:
      // re-seeding a folder someone just typed is worse than no default.
      setFormat((current) => current || next.formats.find((f) => f.available)?.key || "");
      setDirectory((current) => current || next.defaults.directory);
      setName((current) => current || next.defaults.name);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [running]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Polled only while an export is in flight.
  useEffect(() => {
    if (!info?.running) return;
    const timer = setTimeout(() => { void refresh(); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [info?.running, info?.done, refresh]);

  const act = useCallback(async (work: () => Promise<unknown>) => {
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  const browse = () => act(async () => {
    const picked = await nr.flowBrowseNative(directory);
    // A null path is a cancel, and a cancel leaves the field as it was.
    if (picked.path) setDirectory(picked.path);
  });

  if (!running || !info) return null;

  const percent = info.total > 0 ? Math.round((info.done / info.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
        <Label className="text-xs text-muted-foreground">{t("exportFormat")}</Label>
        <Select value={format} onValueChange={(next) => setFormat(String(next ?? ""))}>
          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {info.formats.map((entry) => (
              <SelectItem key={entry.key} value={entry.key} disabled={!entry.available}>
                {entry.label} — {entry.detail}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Label className="text-xs text-muted-foreground">{t("exportFolder")}</Label>
        <div className="flex gap-2">
          <Input
            className="h-8 flex-1 font-mono text-xs"
            spellCheck={false}
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
          />
          <Button size="sm" variant="secondary" onClick={() => void browse()}>
            {t("browse")}
          </Button>
        </div>

        <Label className="text-xs text-muted-foreground">{t("exportName")}</Label>
        <Input
          className="h-8"
          spellCheck={false}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />

        <Label className="text-xs text-muted-foreground">{t("frames")}</Label>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            className="h-8 w-20 text-right tabular-nums"
            min={0}
            value={from}
            onChange={(event) => setFrom(Number(event.target.value) || 0)}
          />
          <span className="text-xs text-muted-foreground">→</span>
          <Input
            type="number"
            className="h-8 w-20 text-right tabular-nums"
            min={0}
            value={to}
            onChange={(event) => setTo(Number(event.target.value) || 0)}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={info.running || !format || !directory}
          onClick={() => void act(() => nr.flowExportStart({
            format, directory, name, from, to,
          }))}
        >
          {t("exportRun")}
        </Button>
        {info.running ? (
          <Button size="sm" variant="secondary" onClick={() => void act(nr.flowExportCancel)}>
            {t("cancel")}
          </Button>
        ) : null}
      </div>

      {info.running ? (
        <div className="flex items-center gap-2">
          <Progress value={percent} className="h-1.5 flex-1" />
          <span className="text-xs tabular-nums text-muted-foreground">
            {info.done} / {info.total}
          </span>
        </div>
      ) : null}

      {!info.running && info.done > 0 && info.output ? (
        <p className="break-all text-xs text-muted-foreground">{t("writtenTo")} {info.output}</p>
      ) : null}
      {error || info.error ? (
        <p className="text-xs text-destructive">{error || info.error}</p>
      ) : null}
    </div>
  );
}
