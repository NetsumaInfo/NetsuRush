import { Sparkles, Wand2, Gauge, Layers, Scissors, CheckCircle2, AlertTriangle } from "lucide-react";
import { useApp } from "@/store";
import { nr, type ProcMode, type ProcessProgress, type UpscaleProgress as UpscaleProgressT, type ProcessResult } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { UpscaleSources } from "@/components/upscale/UpscaleSources";
import { UpscalePreview } from "@/components/upscale/UpscalePreview";
import { UpscaleProgress } from "@/components/upscale/UpscaleProgress";
import { UpscaleSettings } from "@/components/upscale/UpscaleSettings";
import { InterpSettings } from "@/components/upscale/InterpSettings";
import { DepthSettings } from "@/components/upscale/DepthSettings";
import { RemoveBgSettings } from "@/components/upscale/RemoveBgSettings";
import { useUpscale } from "@/components/upscale/useUpscale";
import { useInterpolate } from "@/components/upscale/useInterpolate";
import { useDepth } from "@/components/upscale/useDepth";
import { useRemoveBg } from "@/components/upscale/useRemoveBg";
import { useProcSources, ProcSourcesContext, type ProcController } from "@/components/upscale/useProcSources";
import { SelectionTray } from "./SelectionTray";
import { ChainPanel } from "./ChainPanel";
import { RotoStudio } from "./roto/RotoStudio";
import { useTranslation } from "react-i18next";
import { useEffect } from "react";

// Shell NetsuLab : colonne gauche = navigateur de sources + bac ; centre = lecteur/aperçu + test ;
// droite = op + réglages + run (ou constructeur de chaîne). Le Roto Studio remplace centre + droite.

const OPS: { id: ProcMode; icon: typeof Wand2 }[] = [
  { id: "upscale", icon: Wand2 }, { id: "interpolate", icon: Gauge },
  { id: "depth", icon: Layers }, { id: "removebg", icon: Scissors },
];

type OpController = ProcController & {
  busy: ProcessProgress | UpscaleProgressT | null;
  batch: { i: number; n: number; name: string } | null;
  result: ProcessResult | null;
  err: string | null;
  run: () => void;
};

function OpLayout({
  up, title, titleMeta, runLabel, runIcon: RunIcon, busyLabel, progressLabel, settings,
}: {
  up: OpController;
  title: string;
  titleMeta: string;
  runLabel: { idle: string; running: string };
  runIcon: typeof Wand2;
  busyLabel: string;
  progressLabel: string;
  settings: React.ReactNode;
}) {
  const { t } = useTranslation("upscale");
  const procMode = useApp((s) => s.procMode);
  const setProcMode = useApp((s) => s.setProcMode);
  const chainMode = useApp((s) => s.nlChainMode);
  const setChainMode = useApp((s) => s.nlSetChainMode);
  const { sources, busy, batch, result, err } = up;
  const running = !!busy;
  const has = sources.length > 0;

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <LeftColumn up={up} />

      {/* Centre : lecteur/aperçu + test d'image */}
      <section className="min-w-0 flex-1">
        <UpscalePreview up={up} />
      </section>

      {/* Droite : bascule op unique / chaîne, puis op + réglages + run OU constructeur de chaîne */}
      <aside className="flex w-80 shrink-0 flex-col border-l border-border">
        {/* Barre resserrée (rangées h-8, paddings courts) : elle coiffe le panneau de réglages, qui
            est la zone utile — les cibles restent pleine largeur. */}
        <div className="space-y-1.5 border-b border-border px-2.5 py-2">
          <ToggleGroup size="sm" className="w-full" value={[chainMode ? "chain" : "single"]} onValueChange={(v) => v[0] && setChainMode(v[0] === "chain")}>
            <ToggleGroupItem value="single" className="flex-1 text-xs" disabled={running}>{t("panel.opSingle")}</ToggleGroupItem>
            <ToggleGroupItem value="chain" className="flex-1 text-xs" disabled={running}>{t("panel.chain")}</ToggleGroupItem>
          </ToggleGroup>
          {!chainMode && (
            <>
              <ToggleGroup size="sm" className="w-full" value={[procMode]} onValueChange={(v) => v[0] && setProcMode(v[0] as ProcMode)}>
                {OPS.map((m) => (
                  <Tooltip key={m.id}>
                    <TooltipTrigger render={<ToggleGroupItem value={m.id} className="flex-1" disabled={running} aria-label={t(`ops.${m.id}`)}>
                      <m.icon className="h-4 w-4" />
                    </ToggleGroupItem>} />
                    <TooltipContent>{t(`ops.${m.id}`)}</TooltipContent>
                  </Tooltip>
                ))}
              </ToggleGroup>
              <h2 className="flex items-center gap-1.5 px-1 text-sm font-semibold">
                <Sparkles className="h-4 w-4 shrink-0 text-primary" />
                <span>{title}</span>
                <span className="text-xs font-medium text-muted-foreground">{titleMeta}</span>
              </h2>
            </>
          )}
        </div>

        {chainMode ? (
          <ChainPanel />
        ) : (
          <>
            {has ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-4">{settings}</div>
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
                {t("panel.selectRush")}
              </div>
            )}

            <div className="space-y-2 border-t border-border p-2.5">
              {batch && batch.n > 1 && (
                <p className="text-center text-xs text-muted-foreground">{t("panel.clipProgress", { i: batch.i + 1, n: batch.n, name: batch.name })}</p>
              )}
              {busy && <UpscaleProgress busy={busy} label={progressLabel} />}

              {err && (
                <Card className="block border-destructive/40 p-2.5 text-xs text-destructive">
                  <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" /> {err}
                </Card>
              )}
              {result?.ok && !running && (
                <Card className="block p-3 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-[var(--color-ok)]">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {t("result.files", { count: result.outputs?.length ?? 0 })}{result.imported ? t("result.imported", { count: result.imported }) : ""}.
                  </div>
                  {result.failed ? <p className="mt-1 text-muted-foreground">{t("result.failed", { count: result.failed })}</p> : null}
                </Card>
              )}

              <Button className="w-full" size="lg" onClick={up.run} disabled={!has || running}>
                {running ? <Spinner className="h-4 w-4" /> : <RunIcon className="h-4 w-4" />}
                {running ? busyLabel
                  : sources.length > 1 ? t("run.idleMulti", { label: runLabel.idle, count: sources.length })
                  : runLabel.idle}
              </Button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function UpscaleOp() {
  const { t } = useTranslation("upscale");
  const up = useUpscale();
  return (
    <OpLayout
      up={up} title={t(up.settings.mode === "restore" ? "titles.restore" : "titles.upscale")} titleMeta={t(up.settings.engine === "turbo" && up.settings.mode !== "restore" ? "settings.sectionShaderTurbo" : "settings.sectionModelIa")} runIcon={Wand2}
      runLabel={{ idle: t("run.upscaleIdle"), running: t("run.upscaleBusy") }} busyLabel={t("run.upscaleBusy")} progressLabel={t("progress.upscaling")}
      settings={
        <UpscaleSettings
          settings={up.settings} patch={up.patch} audioTracks={up.audioTracks}
          outDir={up.outDir} chooseOut={up.chooseOut}
          importBack={up.importBack} setImportBack={up.setImportBack}
          disabled={!!up.busy || up.testing}
        />
      }
    />
  );
}

function InterpOp() {
  const { t } = useTranslation("upscale");
  const up = useInterpolate();
  return (
    <OpLayout
      up={up} title={t("titles.interpolate")} titleMeta={t("settings.sectionModelIa")} runIcon={Gauge}
      runLabel={{ idle: t("run.interpolateIdle"), running: t("run.interpolateBusy") }} busyLabel={t("run.interpolateBusy")} progressLabel={t("progress.interpolation")}
      settings={
        <InterpSettings
          settings={up.settings} patch={up.patch} audioTracks={up.audioTracks}
          outDir={up.outDir} chooseOut={up.chooseOut}
          importBack={up.importBack} setImportBack={up.setImportBack}
          disabled={!!up.busy}
        />
      }
    />
  );
}

function DepthOp() {
  const { t } = useTranslation("upscale");
  const up = useDepth();
  return (
    <OpLayout
      up={up} title={t("titles.depth")} titleMeta={t("settings.sectionModelIa")} runIcon={Layers}
      runLabel={{ idle: t("run.depthIdle"), running: t("run.depthBusy") }} busyLabel={t("run.depthBusy")} progressLabel={t("progress.depth")}
      settings={
        <DepthSettings
          settings={up.settings} patch={up.patch} audioTracks={up.audioTracks}
          outDir={up.outDir} chooseOut={up.chooseOut}
          importBack={up.importBack} setImportBack={up.setImportBack}
          disabled={!!up.busy}
        />
      }
    />
  );
}

function RemoveBgOp() {
  const { t } = useTranslation("upscale");
  const up = useRemoveBg();
  return (
    <OpLayout
      up={up} title={t("titles.removebg")} titleMeta={t("settings.sectionModelIa")} runIcon={Scissors}
      runLabel={{ idle: t("run.removebgIdle"), running: t("run.removebgBusy") }} busyLabel={t("run.removebgBusy")} progressLabel={t("progress.removebg")}
      settings={
        <RemoveBgSettings
          settings={up.settings} patch={up.patch} audioTracks={up.audioTracks}
          outDir={up.outDir} chooseOut={up.chooseOut}
          importBack={up.importBack} setImportBack={up.setImportBack}
          disabled={!!up.busy}
        />
      }
    />
  );
}

// Colonne gauche partagée (traitements ET roto) : bascule + navigateur de sources + bac de sélection.
function LeftColumn({ up }: { up: ProcController }) {
  const { t } = useTranslation("upscale");
  const roto = useApp((s) => s.nlRoto);
  const setRoto = useApp((s) => s.nlSetRoto);
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-border">
      <div className="border-b border-border px-2 py-1">
        <ToggleGroup className="w-full" value={[roto ? "roto" : "process"]} onValueChange={(v) => v[0] && setRoto(v[0] === "roto")}>
          <ToggleGroupItem value="process" className="flex-1 text-xs">{t("panel.process")}</ToggleGroupItem>
          <ToggleGroupItem value="roto" className="flex-1 text-xs">{t("panel.rotoStudio")}</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <UpscaleSources up={up} />
      </div>
      <SelectionTray />
    </aside>
  );
}

function ActiveOp() {
  const procMode = useApp((s) => s.procMode);
  switch (procMode) {
    case "interpolate": return <InterpOp />;
    case "depth": return <DepthOp />;
    case "removebg": return <RemoveBgOp />;
    default: return <UpscaleOp />;
  }
}

// Vue Roto : réutilise un contrôleur d'op (useUpscale) uniquement pour alimenter le navigateur/bac.
function RotoView() {
  const up = useUpscale();
  useEffect(() => () => {
    void nr.cache?.sessionEvent({ trigger: "page", kinds: ["roto"] }).catch(() => {});
  }, []);
  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <LeftColumn up={up} />
      <RotoStudio />
    </div>
  );
}

function Shell() {
  const roto = useApp((s) => s.nlRoto);
  return roto ? <RotoView /> : <ActiveOp />;
}

export function NetsuLabPanel() {
  // UNE instance de sources (bac store-adossé) montée au-dessus du switch d'op/roto → source, portée,
  // plage et plans cochés survivent au changement d'op ET au passage traitements ↔ roto.
  const shared = useProcSources();
  useEffect(() => () => {
    void nr.cache?.sessionEvent({ trigger: "page", kinds: ["upscaleTest"] }).catch(() => {});
  }, []);
  return (
    <ProcSourcesContext.Provider value={shared}>
      <Shell />
    </ProcSourcesContext.Provider>
  );
}
