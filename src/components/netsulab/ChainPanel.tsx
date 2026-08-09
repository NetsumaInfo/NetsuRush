import { Wand2, Gauge, ArrowUp, ArrowDown, X, Plus, Play, CheckCircle2, AlertTriangle, ListOrdered, Eraser } from "lucide-react";
import { useApp } from "@/store";
import { type PipelineOpKind } from "@/lib/bridge";
import { DEFAULT_SETTINGS } from "@/components/upscale/upscaleShared";
import { DEFAULT_INTERP } from "@/components/upscale/processShared";
import { useSharedProcSources } from "@/components/upscale/useProcSources";
import { ExportRows } from "@/components/upscale/procSettingsParts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { UpscaleProgress } from "@/components/upscale/UpscaleProgress";
import { useChainRun } from "./useChainRun";
import { useTranslation } from "react-i18next";

// Réglages par défaut figés à l'ajout d'une étape (édition fine par étape = amélioration future ;
// on part du défaut recommandé, ajustable ensuite dans les réglages d'op unique).
const STEP_META: Record<PipelineOpKind, { icon: typeof Wand2; defaults: () => Record<string, unknown> }> = {
  upscale: { icon: Wand2, defaults: () => ({ ...DEFAULT_SETTINGS }) },
  interpolate: { icon: Gauge, defaults: () => ({ ...DEFAULT_INTERP }) },
};
const ADD_STEPS: { key: string; kind: PipelineOpKind; icon: typeof Wand2; defaults: () => Record<string, unknown> }[] = [
  { key: "upscale", kind: "upscale", icon: Wand2, defaults: () => ({ ...DEFAULT_SETTINGS, mode: "upscale" }) },
  { key: "restore", kind: "upscale", icon: Wand2, defaults: () => ({ ...DEFAULT_SETTINGS, mode: "restore", engine: "ia", scale: 1, model: "tas-anime1080fixer" }) },
  { key: "interpolate", kind: "interpolate", icon: Gauge, defaults: () => ({ ...DEFAULT_INTERP }) },
];

// Constructeur de chaîne ORDONNÉE : empile des transforms (upscale → interpolation…), réordonne, lance.
// Une source → une sortie (pipeline core, fichier→fichier). Depth/matte restent hors chaîne (dérivés).
export function ChainPanel() {
  const { t } = useTranslation("upscale");
  const base = useSharedProcSources();
  const chain = useApp((s) => s.nlChain);
  const addStep = useApp((s) => s.nlAddStep);
  const removeStep = useApp((s) => s.nlRemoveStep);
  const moveStep = useApp((s) => s.nlMoveStep);
  const clearChain = useApp((s) => s.nlClearChain);
  const { busy, batch, result, err, run } = useChainRun();

  const running = !!busy;
  const has = base.sources.length > 0;

  return (
    <>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <ListOrdered className="h-4 w-4 text-primary" /> {t("chain.title")}
            </h3>
            {chain.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearChain} disabled={running}>{t("chain.clear")}</Button>
            )}
          </div>

          {chain.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              {t("chain.empty")}
            </p>
          ) : (
            <ol className="space-y-1.5">
              {chain.map((step, i) => {
                const meta = STEP_META[step.kind];
                return (
                  // Clic droit sur l'étape : réordonner/retirer sans viser les boutons-icône.
                  <ContextMenu key={step.id}>
                    <ContextMenuTrigger render={<li className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-2 py-1.5 text-xs" />}>
                      <span className="tabular-nums text-muted-foreground">{i + 1}.</span>
                      <meta.icon className="h-3.5 w-3.5 text-primary" />
                      <span className="flex-1 font-medium text-foreground">{t(`steps.${step.kind === "upscale" && step.settings.mode === "restore" ? "restore" : step.kind}`)}</span>
                      <Tooltip>
                        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => moveStep(step.id, -1)} disabled={running || i === 0} aria-label={t("chain.moveUp")}><ArrowUp className="h-3.5 w-3.5" /></Button>} />
                        <TooltipContent>{t("chain.moveUp")}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => moveStep(step.id, 1)} disabled={running || i === chain.length - 1} aria-label={t("chain.moveDown")}><ArrowDown className="h-3.5 w-3.5" /></Button>} />
                        <TooltipContent>{t("chain.moveDown")}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => removeStep(step.id)} disabled={running} aria-label={t("chain.remove")}><X className="h-3.5 w-3.5" /></Button>} />
                        <TooltipContent>{t("chain.remove")}</TooltipContent>
                      </Tooltip>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => moveStep(step.id, -1)} disabled={running || i === 0}><ArrowUp /> {t("chain.moveUp")}</ContextMenuItem>
                      <ContextMenuItem onClick={() => moveStep(step.id, 1)} disabled={running || i === chain.length - 1}><ArrowDown /> {t("chain.moveDown")}</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" onClick={() => removeStep(step.id)} disabled={running}><X /> {t("chain.remove")}</ContextMenuItem>
                      <ContextMenuItem variant="destructive" onClick={clearChain} disabled={running}><Eraser /> {t("chain.clearChain")}</ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </ol>
          )}

          <div className="mt-2 grid grid-cols-2 gap-2">
            {ADD_STEPS.map((step) => {
              const Icon = step.icon;
              return (
                <Button key={step.key} variant="outline" size="sm" className="gap-1.5" onClick={() => addStep(step.kind, step.defaults())} disabled={running}>
                  <Icon className="h-3.5 w-3.5" /> <Plus className="h-3 w-3" /> {t(`steps.${step.key}`)}
                </Button>
              );
            })}
          </div>
        </div>

        <ExportRows outDir={base.outDir} chooseOut={base.chooseOut} importBack={base.importBack} setImportBack={base.setImportBack} disabled={running} />
      </div>

      <div className="space-y-3 border-t border-border p-4">
        {batch && batch.n > 1 && (
          <p className="text-center text-xs text-muted-foreground">{t("panel.clipProgress", { i: batch.i + 1, n: batch.n, name: batch.name })}</p>
        )}
        {busy && <UpscaleProgress busy={busy} label={t("chain.stepLabel", { i: busy.opIndex + 1, n: busy.opCount })} />}
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
        <Button className="w-full" size="lg" onClick={run} disabled={!has || !chain.length || running}>
          {running ? <Spinner className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {running ? t("chain.running") : base.sources.length > 1 ? t("chain.runMulti", { count: base.sources.length }) : t("chain.run")}
        </Button>
      </div>
    </>
  );
}
