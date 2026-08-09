// Découpe en lot : barre de sélection (choix du modèle + lancement) et panneau de progression
// (un rush par ligne). La détection sérielle vit dans le store (runBatchDetect) ; ici, l'UI seule.
import { useTranslation } from "react-i18next";
import { Scissors, X, CheckCheck, Check, TriangleAlert, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { DetectModel } from "@/lib/bridge";
import { useApp } from "@/store";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SELECTION_BAR_CLASS } from "./cutStudioShared";
import { DetectionAdvancedSettings } from "./DetectionAdvancedSettings";
import { DetectionModelSelect, DetectionPresetSelect } from "./DetectionControls";

// Barre d'actions affichée en mode sélection : compteur, tout/aucun, modèle, lancer, quitter.
export function BatchDetectBar({ total, count, model, setModel, presetIdx, setPresetIdx, onSelectAll, onClear, onRun, onRemove, removeCount, onExit, busy }: {
  total: number;
  count: number;
  model: DetectModel;
  setModel: (m: DetectModel) => void;
  presetIdx: number;
  setPresetIdx: (i: number) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onRun: () => void;
  // Retrait de la sélection. `removeCount` = ceux qui ont une entrée de bibliothèque (un rush du
  // Media Pool n'en a pas — rien à en retirer) ; 0 = bouton masqué.
  onRemove: () => void;
  removeCount: number;
  onExit: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation("derush");
  const allSelected = count > 0 && count === total;
  return (
    <Card className={cn(SELECTION_BAR_CLASS, "flex-wrap items-center gap-2.5")}>
      <span className="text-sm font-medium">{t("batch.selected", { count })}</span>
      <Button variant="ghost" size="sm" onClick={allSelected ? onClear : onSelectAll}>
        {allSelected ? t("shared.deselectAll") : t("shared.selectAll")}
      </Button>
      <div className="flex-1" />
      <DetectionModelSelect model={model} onChange={setModel} disabled={busy} />
      <DetectionPresetSelect model={model} preset={presetIdx} onChange={setPresetIdx} disabled={busy} />
      <DetectionAdvancedSettings model={model} disabled={busy} compact />
      <Button size="sm" disabled={count === 0 || busy} onClick={onRun}>
        <Scissors className="h-4 w-4" /> {t("batch.cut", { count })}
      </Button>
      {removeCount > 0 && (
        <Tooltip>
          <TooltipTrigger render={
            <Button variant="outline" size="sm" disabled={busy} onClick={onRemove}
              className="border-destructive/40 text-destructive hover:text-destructive" />
          }>
            <Trash2 className="h-4 w-4" /> {removeCount}
          </TooltipTrigger>
          <TooltipContent>{t("library.removeManyFromLibrary", { count: removeCount })}</TooltipContent>
        </Tooltip>
      )}
      <Button variant="outline" size="sm" onClick={onExit}>
        <X className="h-4 w-4" /> {t("batch.quit")}
      </Button>
    </Card>
  );
}

// Panneau de progression : un rush par ligne (status + barre). Lit le store directement.
export function BatchDetectProgress() {
  const { t } = useTranslation("derush");
  const { batchDetect, cancelBatchDetect, dismissBatchDetect } = useApp(
    useShallow((s) => ({
      batchDetect: s.batchDetect,
      cancelBatchDetect: s.cancelBatchDetect,
      dismissBatchDetect: s.dismissBatchDetect,
    })),
  );
  if (!batchDetect) return null;
  const { items, running } = batchDetect;
  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "error").length;

  return (
    <Card className="gap-3 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">
          {t("batch.progressTitle", { done, total: items.length })}{failed ? t("batch.failures", { count: failed }) : ""}
        </div>
        {running ? (
          <Button variant="ghost" size="sm" onClick={cancelBatchDetect}>{t("shared.stop")}</Button>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label={t("common:action.close")} onClick={dismissBatchDetect}><X /></Button>
        )}
      </div>
      <ul className="max-h-64 space-y-2 overflow-y-auto">
        {items.map((it) => (
          <li key={it.path} className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <StatusIcon status={it.status} />
              <span className="min-w-0 flex-1 truncate">{it.name}</span>
              <span className="shrink-0 text-muted-foreground">
                {it.status === "done" ? t("batch.shots", { count: it.scenes ?? 0 })
                  : it.status === "error" ? t("shared.failedShort")
                  : it.status === "running" ? `${it.pct}%`
                  : t("batch.pending")}
              </span>
            </div>
            {it.status === "running" && <Progress value={it.pct} />}
            {it.status === "error" && it.error && <p className="truncate text-[11px] text-destructive">{it.error}</p>}
          </li>
        ))}
      </ul>
      {!running && (
        <p className="text-xs text-muted-foreground">
          {t("batch.doneHint")}
        </p>
      )}
    </Card>
  );
}

function StatusIcon({ status }: { status: "pending" | "running" | "done" | "error" }) {
  if (status === "running") return <Spinner className="h-3.5 w-3.5 shrink-0 text-primary" />;
  if (status === "done") return <Check className="h-3.5 w-3.5 shrink-0 text-[var(--color-ok)]" />;
  if (status === "error") return <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  return <CheckCheck className="h-3.5 w-3.5 shrink-0 opacity-30" />;
}
