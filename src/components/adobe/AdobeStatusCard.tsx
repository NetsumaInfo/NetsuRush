// Carte de statut d'une app Adobe (Premiere / After Effects) : installée, lancée,
// panneau CEP connecté + actions Lancer / Scanner.
import { Play, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HostIcon } from "@/components/HostIcon";
import type { AdobeApp, AdobeAppStatus } from "@/lib/bridge";

const APP_LABEL: Record<AdobeApp, string> = { ppro: "Premiere Pro", aeft: "After Effects" };

function StateBadge({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return on ? (
    <Badge className="bg-[var(--color-ok)]/15 text-[var(--color-ok)]">{onLabel}</Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">{offLabel}</Badge>
  );
}

export function AdobeStatusCard({
  app,
  status,
  busy,
  onLaunch,
  onScan,
}: {
  app: AdobeApp;
  status: AdobeAppStatus | null;
  busy: boolean;
  onLaunch: () => void;
  onScan: () => void;
}) {
  const { t } = useTranslation("adobe");
  const installed = !!status?.installed;
  const running = !!status?.running;
  const connected = !!status?.panelConnected;

  return (
    <Card className="block flex-1 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <HostIcon host={app} className="size-5" />
          {APP_LABEL[app]}
        </span>
        <StateBadge on={installed} onLabel={t("status.installed")} offLabel={t("status.notFound")} />
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        <StateBadge on={running} onLabel={t("status.running")} offLabel={t("status.closed")} />
        <StateBadge on={connected} onLabel={t("status.panelConnected")} offLabel={t("status.panelOffline")} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={!installed || running || busy} onClick={onLaunch}>
          <Play className="size-3.5" /> {t("status.launch")}
        </Button>
        <Button size="sm" disabled={!connected || busy} onClick={onScan}>
          <RefreshCw className="size-3.5" /> {t("status.scanProject")}
        </Button>
      </div>
      {installed && !connected && (
        <p className="mt-3 text-xs text-muted-foreground">
          {running
            ? t("status.openPanelHint")
            : t("status.launchThenOpenHint")}
        </p>
      )}
    </Card>
  );
}
