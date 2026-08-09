// « Arrêter des tâches » : contrôle de la file de rendu Resolve via l'API NATIVE. N'arrête/supprime
// que des jobs — ne lance jamais de rendu, ne crée aucun fichier. Boutons : arrêter le rendu actif,
// vider la file, supprimer un job précis.
import { useState } from "react";
import { Square, Trash2, X, Loader2, CheckCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import type { OptimizeDiagnosis } from "@/lib/bridge";
import { useTranslation } from "react-i18next";

export function StopTasksSection({
  diag,
  onChanged,
}: {
  diag: OptimizeDiagnosis | null;
  onChanged: () => void;
}) {
  const { t } = useTranslation("optimize");
  const [busy, setBusy] = useState<string | null>(null);
  if (!diag || !diag.connected) return null;

  const jobs = diag.render.jobs;
  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  return (
    <Card className="block p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t("stop.title")}</h3>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!diag.render.inProgress || !!busy}
            onClick={() => run("stop", () => nr.optimizeStopRender())}
          >
            {busy === "stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
            {t("stop.stopRender")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!jobs.length || !!busy}
            onClick={() => run("finished", () => nr.optimizeClearFinishedJobs())}
          >
            {busy === "finished" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCheck className="h-4 w-4" />}
            {t("stop.clearFinished")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={!jobs.length || !!busy}
            onClick={() => run("clear", () => nr.optimizeClearRenderQueue())}
          >
            {busy === "clear" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {t("stop.clearQueue")}
          </Button>
        </div>
      </div>

      {jobs.length > 0 && (
        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {jobs.map((j) => (
            <li key={j.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <Tooltip>
                <TooltipTrigger render={
                  <span className="min-w-0 flex-1 truncate">
                    {j.name}
                  </span>
                } />
                <TooltipContent>{j.target || j.name}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={!!busy}
                    onClick={() => run(j.id, () => nr.optimizeDeleteRenderJob(j.id))}
                  />
                }>
                  {busy === j.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                </TooltipTrigger>
                <TooltipContent>{t("stop.deleteJob")}</TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      {!jobs.length && (
        <p className="mt-3 text-xs text-muted-foreground">{t("stop.queueEmpty")}</p>
      )}
    </Card>
  );
}
