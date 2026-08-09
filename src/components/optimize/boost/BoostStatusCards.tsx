// Diagnostic LECTURE SEULE de l'hôte Adobe : application, panneau CEP, poids des caches, disque.
// Rendu même quand rien n'est joignable — l'utilisateur doit voir POURQUOI, pas une page vide.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AppWindow, Plug, HardDrive, Boxes, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import type { AdobeApp, BoostDiagnosis } from "@/lib/bridge";
import { hostLabel } from "@/lib/host";
import { fmtBytes } from "../optimizeShared";
import { hostYear, isUxpEraHost } from "./boostShared";

/** Au-delà, le disque qui porte les caches est le premier suspect d'une lecture qui saccade. */
const DISK_LOW_RATIO = 0.1;

function StateBadge({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return on ? (
    <Badge className="bg-[var(--color-ok)]/15 text-[var(--color-ok)]">{onLabel}</Badge>
  ) : (
    <Badge variant="secondary">{offLabel}</Badge>
  );
}

export function BoostStatusCards({ diag, app }: { diag: BoostDiagnosis | null; app: AdobeApp }) {
  const { t } = useTranslation("optimize");
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState<string | null>(null);

  if (!diag) return null;

  const diskLow = !!diag.disk && diag.disk.total > 0 && diag.disk.free / diag.disk.total < DISK_LOW_RATIO;
  const uxpEra = isUxpEraHost(app, diag);

  async function installPanel() {
    setInstalling(true);
    try {
      const r = await nr.adobeInstallPanel();
      setInstalled(r.ok ? t("boost.status.panelInstalled") : r.error || t("notice.failed"));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card className="block p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <AppWindow className="h-3.5 w-3.5" /> {hostLabel(app)}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <StateBadge on={diag.installed} onLabel={t("boost.status.installed")} offLabel={t("boost.status.notInstalled")} />
          <StateBadge on={diag.running} onLabel={t("boost.status.running")} offLabel={t("boost.status.stopped")} />
        </div>
        <Tooltip>
          <TooltipTrigger
            render={<div className="mt-1 truncate text-xs text-muted-foreground">{diag.project || t("boost.status.noProject")}</div>}
          />
          <TooltipContent>{diag.projectPath || diag.project || t("boost.status.noProject")}</TooltipContent>
        </Tooltip>
      </Card>

      <Card className="block p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Plug className="h-3.5 w-3.5" /> {t("boost.status.panel")}
        </div>
        <div className="mt-1.5">
          <StateBadge
            on={diag.panelConnected}
            onLabel={t("boost.status.panelConnected")}
            offLabel={t("boost.status.panelSilent")}
          />
        </div>
        {/* Le panneau absent du disque est le seul cas réparable d'ici : l'installer. Panneau installé
            mais muet = l'application est fermée ou le panneau n'est pas ouvert, rien à faire ici. */}
        {!diag.panelInstalled ? (
          <Button variant="outline" size="sm" className="mt-2" onClick={installPanel} disabled={installing}>
            {installing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("boost.status.installPanel")}
          </Button>
        ) : (
          !diag.panelConnected && <div className="mt-1 text-xs text-muted-foreground">{t("boost.status.panelHint")}</div>
        )}
        {/* Sur 2026, une extension muette n'est pas forcément une erreur de l'utilisateur. */}
        {!diag.panelConnected && uxpEra && (
          <div className="mt-1 text-xs text-amber-500">{t("boost.status.uxpHint", { year: hostYear(diag) })}</div>
        )}
        {installed && <div className="mt-1 text-xs text-muted-foreground">{installed}</div>}
      </Card>

      <Card className="block p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Boxes className="h-3.5 w-3.5" /> {t("boost.status.caches")}
        </div>
        <div className="mt-1 text-sm font-medium">{fmtBytes(diag.cacheTotal)}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {diag.cacheRoots.length
            ? t("boost.status.cacheFolders", { count: diag.cacheRoots.length })
            : t("boost.status.noCacheFolder")}
        </div>
      </Card>

      <Card className="block p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <HardDrive className="h-3.5 w-3.5" /> {t("boost.status.disk")}
        </div>
        <div className={`mt-1 text-sm font-medium ${diskLow ? "text-amber-500" : ""}`}>
          {diag.disk ? fmtBytes(diag.disk.free) : "—"}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {diag.disk ? t("boost.status.diskFree", { total: fmtBytes(diag.disk.total) }) : t("boost.status.diskUnknown")}
        </div>
      </Card>
    </div>
  );
}
