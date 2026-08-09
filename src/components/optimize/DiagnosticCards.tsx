// Diagnostic LECTURE SEULE : état du pont Resolve, projet/timeline, rendu en cours, réglages perf.
import { useTranslation } from "react-i18next";
import { Activity, Film, AlertTriangle, Settings2, Database } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { OptimizeDiagnosis } from "@/lib/bridge";
import { fmtBytes } from "./optimizeShared";

export function DiagnosticCards({ diag }: { diag: OptimizeDiagnosis | null }) {
  const { t } = useTranslation("optimize");
  if (!diag) return null;

  if (!diag.connected) {
    return (
      <Card className="block border-amber-500/30 p-4 text-sm">
        <div className="flex items-center gap-2 font-medium text-amber-500">
          <AlertTriangle className="h-4 w-4" /> {t("diagnostic.offline")}
        </div>
        <p className="mt-1 text-muted-foreground">
          {t("diagnostic.offlineHint")}
        </p>
      </Card>
    );
  }

  const settingKeys = Object.keys(diag.settings || {});
  const dbSize = diag.db?.size ?? null;
  const dbBig = dbSize != null && dbSize > 800 * 1024 * 1024; // ~800 Mo → bloat probable
  const timelineLabel = diag.timeline
    ? t("diagnostic.timelineLabel", { name: diag.timeline })
    : t("diagnostic.noTimeline");

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card className="block p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Film className="h-3.5 w-3.5" /> {t("diagnostic.project")}
        </div>
        <Tooltip>
          <TooltipTrigger render={
            <div className="mt-1 truncate text-sm font-medium">
              {diag.project || "—"}
            </div>
          } />
          <TooltipContent>{diag.project || "—"}</TooltipContent>
        </Tooltip>
        {/* Un fait par ligne : timeline, page et version entassés dans un seul `truncate` se faisaient
            manger par les points de suspension (la version disparaissait toujours). */}
        <Tooltip>
          <TooltipTrigger render={
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {timelineLabel}
            </div>
          } />
          <TooltipContent>{timelineLabel}</TooltipContent>
        </Tooltip>
        {diag.page && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {t("diagnostic.pageLabel", { page: diag.page })}
          </div>
        )}
      </Card>

      <Card className="block p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Activity className="h-3.5 w-3.5" /> {t("diagnostic.render")}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          {diag.render.inProgress ? (
            <Badge className="bg-amber-500/15 text-amber-500">{t("diagnostic.renderActive")}</Badge>
          ) : (
            <Badge variant="secondary">{t("diagnostic.renderIdle")}</Badge>
          )}
          <span className="text-sm text-muted-foreground">
            {t("diagnostic.jobsQueued", { count: diag.render.jobs.length })}
          </span>
        </div>
      </Card>

      <Card className="block p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Settings2 className="h-3.5 w-3.5" /> {t("diagnostic.settingsRead")}
        </div>
        <div className="mt-1 text-sm font-medium">{t("diagnostic.cacheProxyKeys", { count: settingKeys.length })}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {diag.cacheRoots.length
            ? t("diagnostic.cacheFoldersDetected", { count: diag.cacheRoots.length })
            : t("diagnostic.noCacheFolder")}
        </div>
      </Card>

      <Card className="block p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Database className="h-3.5 w-3.5" /> {t("diagnostic.database")}
        </div>
        <div className={`mt-1 text-sm font-medium ${dbBig ? "text-amber-500" : ""}`}>
          {dbSize != null ? fmtBytes(dbSize) : diag.db ? t("diagnostic.dbRemote") : "—"}
        </div>
        {/* Le nom de la base ACTIVE : sans lui, une taille seule ne dit pas laquelle on pèse. */}
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {!diag.db
            ? t("diagnostic.dbMissing")
            : dbSize == null
              ? diag.db.name || "—"
              : t(dbBig ? "diagnostic.dbBig" : "diagnostic.dbHealthy", { name: diag.db.name })}
        </div>
      </Card>
    </div>
  );
}
