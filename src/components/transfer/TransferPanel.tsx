// NetsuBridge — transfert d'une timeline d'un logiciel de montage vers un autre. La page choisit un
// couple, montre ce qui a été lu, puis délègue lecture et montage au core (core/transfer/).
import { Suspense, lazy, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeftRight, CheckCircle2, FolderOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import { Section, Row } from "@/components/ae/aeShared";
import { hostShort } from "@/lib/host";
import { useTransfer } from "./useTransfer";
import { TransferHostPicker } from "./TransferHostPicker";
import { TransferMediaOptions } from "./TransferMediaOptions";
import { TransferPreviewCard } from "./TransferPreviewCard";

// Le pipeline AE riche n'est chargé que pour le couple qui l'expose.
const TransferAeOptions = lazy(() => import("./TransferAeOptions").then((m) => ({ default: m.TransferAeOptions })));

export function TransferPanel() {
  const { t } = useTranslation("transfer");
  const ctl = useTransfer();
  const {
    from, to, setFrom, setTo, swap, swappable, rich,
    sources, targets, loadSources,
    timelineName, setTimelineName, target, setTarget,
    name, setName, mode, setMode, videoOnly, setVideoOnly,
    richAe, setRichAe, setAeOptions, needsDir,
    preview, previewBusy, busy, progress, result, run,
  } = ctl;

  const setOptions = useCallback((opts: Parameters<typeof setAeOptions>[0]) => setAeOptions(opts), [setAeOptions]);
  const canRun = !!timelineName && !busy && !needsDir && (mode !== "append" || !!target);

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-7">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <ArrowLeftRight className="size-5 text-primary" /> {t("header.title")}
        </h1>
        <p className="text-xs text-muted-foreground">{t("header.subtitle")}</p>
      </header>

      <TransferHostPicker
        from={from} to={to} setFrom={setFrom} setTo={setTo}
        swap={swap} swappable={swappable} disabled={busy}
      />

      <Card className="block space-y-6 p-6">
        <Section title={t("sections.source", { host: hostShort(from) })}>
          {sources.error ? (
            <p className="text-xs text-destructive">{sources.error}</p>
          ) : (
            <div className="flex items-center gap-2">
              <Select
                value={timelineName ?? ""}
                onValueChange={(v) => setTimelineName(String(v))}
                items={sources.entries.map((tl) => ({ value: tl.name, label: tl.name }))}
                disabled={busy || !sources.entries.length}
              >
                <SelectTrigger className="flex-1"><SelectValue placeholder={t("form.noTimeline")} /></SelectTrigger>
                <SelectContent>
                  {sources.entries.map((tl) => (
                    <SelectItem key={tl.name} value={tl.name}>
                      {tl.current ? t("form.timelineOpen", { name: tl.name }) : tl.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button variant="outline" size="icon" onClick={() => void loadSources()} disabled={busy}>
                      <RefreshCw className="size-4" />
                    </Button>
                  }
                />
                <TooltipContent>{t("form.refresh")}</TooltipContent>
              </Tooltip>
            </div>
          )}
        </Section>

        <Section title={t("sections.target", { host: hostShort(to) })}>
          <ToggleGroup
            value={[mode]}
            onValueChange={(v) => { const next = v[0]; if (next === "new" || next === "append") setMode(next); }}
            disabled={busy}
          >
            <ToggleGroupItem value="new" className="flex-1">{t("form.modeNew")}</ToggleGroupItem>
            <ToggleGroupItem value="append" className="flex-1">{t("form.modeAppend")}</ToggleGroupItem>
          </ToggleGroup>
          {mode === "new" ? (
            <Input
              value={name}
              disabled={busy}
              placeholder={timelineName ?? t("form.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          ) : targets.error ? (
            <p className="text-xs text-destructive">{targets.error}</p>
          ) : (
            <Select
              value={target ?? ""}
              onValueChange={(v) => setTarget(String(v))}
              items={targets.entries.map((tl) => ({ value: tl.name, label: tl.name }))}
              disabled={busy || !targets.entries.length}
            >
              <SelectTrigger><SelectValue placeholder={t("form.noTimeline")} /></SelectTrigger>
              <SelectContent>
                {targets.entries.map((tl) => (
                  <SelectItem key={tl.name} value={tl.name}>
                    {tl.current ? t("form.timelineOpen", { name: tl.name }) : tl.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Section>

        <TransferMediaOptions ctl={ctl} />

        <Section title={t("sections.options")}>
          <Row label={t("form.videoOnly")}>
            <Toggle pressed={videoOnly} onPressedChange={setVideoOnly} disabled={busy}>
              {videoOnly ? t("form.yes") : t("form.no")}
            </Toggle>
          </Row>
          {rich && (
            <Row label={t("form.richAe")}>
              <Toggle pressed={richAe} onPressedChange={setRichAe} disabled={busy}>
                {richAe ? t("form.yes") : t("form.no")}
              </Toggle>
            </Row>
          )}
          {rich && <p className="text-[11px] text-muted-foreground">{t("form.richAeHint")}</p>}
        </Section>
      </Card>

      <TransferPreviewCard preview={preview} busy={previewBusy} />

      {rich && richAe && (
        <Suspense fallback={<Card className="block p-6"><Spinner className="size-4" /></Card>}>
          <TransferAeOptions onChange={setOptions} />
        </Suspense>
      )}

      <div className="space-y-3">
        {busy && progress && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>{t(`phases.${progress.phase}`, { defaultValue: progress.phase })}</span>
              <span className="tabular-nums">{progress.done}/{progress.total}</span>
            </div>
            <Progress value={progress.pct} />
          </div>
        )}

        {result && !result.ok && (
          <Card className="block border-destructive/40 p-3 text-xs text-destructive">
            <AlertTriangle className="mr-1.5 inline size-3.5" /> {result.error}
          </Card>
        )}
        {result?.ok && (
          <Card className="block p-3 text-xs">
            <div className={`flex items-center gap-1.5 font-medium ${result.fidelity?.verified ? "text-[var(--color-ok)]" : "text-foreground"}`}>
              {result.fidelity?.verified
                ? <CheckCircle2 className="size-3.5" />
                : <AlertTriangle className="size-3.5 text-amber-400" />}
              {t("result.done", { count: result.count ?? 0, timeline: result.timeline, host: hostShort(to) })}
            </div>
            {result.fidelity && (
              <p className="mt-1 text-muted-foreground">
                {result.fidelity.verified
                  ? t("result.verified")
                  : t("result.unverified", {
                      applied: result.fidelity.actual.applied,
                      issues: result.fidelity.actual.unsupported + result.fidelity.actual.deferred
                        + result.fidelity.actual.readbackMismatch + result.fidelity.actual.declaredIssues,
                    })}
              </p>
            )}
            {result.exchangeFile && (
              // L'import à la main donne un résultat que la pose par script ne peut PAS atteindre
              // (l'API de Resolve n'écrit aucun niveau audio) : le chemin doit être à portée de clic.
              <div className="mt-2 space-y-1 border-t border-border pt-2">
                <p className="text-muted-foreground">{t("result.exchangeFile")}</p>
                <Button size="sm" variant="outline" onClick={() => nr.openPath(result.exchangeFile!)}>
                  <FolderOpen className="size-3.5" /> {result.exchangeFile}
                </Button>
              </div>
            )}
            {result.vehicle && (
              // La voie change ce qui arrive vraiment : l'import applique l'animation lui-même, la
              // pose par script ne peut y prétendre. Le taire rendait deux résultats très
              // différents indiscernables.
              <p className="mt-1 text-muted-foreground">
                {t(result.vehicle === "import" ? "result.vehicleImport" : "result.vehicleApi")}
              </p>
            )}
            {result.tracksClamped && <p className="mt-1 text-muted-foreground">{t("result.tracksClamped")}</p>}
            {!!result.titles && <p className="mt-1 text-muted-foreground">{t("result.titles", { count: result.titles })}</p>}
            {!!result.titlesRetimed && (
              <p className="mt-1 text-muted-foreground">{t("result.titlesRetimed", { count: result.titlesRetimed })}</p>
            )}
            {!!result.titlesFailed && (
              <p className="mt-1 text-muted-foreground">{t("result.titlesFailed", { count: result.titlesFailed })}</p>
            )}
            {!!result.mediaLess?.length && (
              <p className="mt-1 text-muted-foreground">{t("result.mediaLess", { count: result.mediaLess.length })}</p>
            )}
            {!!result.missing?.length && (
              <p className="mt-1 text-muted-foreground">{t("result.missing", { count: result.missing.length })}</p>
            )}
          </Card>
        )}

        <Button className="w-full" size="lg" onClick={run} disabled={!canRun}>
          {busy ? <Spinner className="size-4" /> : <ArrowLeftRight className="size-4" />}
          {busy ? t("run.busy") : t("run.label", { from: hostShort(from), to: hostShort(to) })}
        </Button>
      </div>
    </div>
  );
}
