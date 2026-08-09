// Onglet « Adobe » : pont NetsuRush ↔ Premiere Pro / After Effects via le panneau CEP.
// Statuts (apps installées/lancées, panneau connecté), installation du panneau, et
// snapshot projet (rushs + timelines) poussé par le panneau — rafraîchi en SSE adobe:update.
import { useEffect, useState } from "react";
import { usePersistedChoice } from "@/lib/persistedChoice";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Download, Check, Stethoscope, Copy, RefreshCw } from "lucide-react";
import { nr } from "@/lib/bridge";
import type { AdobeApp, AdobeDiagnostic } from "@/lib/bridge";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { HostIcon } from "@/components/HostIcon";
import { hostLabel } from "@/lib/host";
import { AdobeStatusCard } from "./AdobeStatusCard";
import { AdobeSnapshotView } from "./AdobeSnapshotView";

export function AdobeBridgePanel() {
  const { t } = useTranslation(["adobe", "common"]);
  const {
    adobeStatus, adobeSnapshots, adobeBusy, adobeNotice,
    refreshAdobeStatus, loadAdobeSnapshot, launchAdobe, scanAdobe, installAdobePanel, setAdobePanelAutoUpdate,
  } = useApp(
    useShallow((s) => ({
      adobeStatus: s.adobeStatus,
      adobeSnapshots: s.adobeSnapshots,
      adobeBusy: s.adobeBusy,
      adobeNotice: s.adobeNotice,
      refreshAdobeStatus: s.refreshAdobeStatus,
      loadAdobeSnapshot: s.loadAdobeSnapshot,
      launchAdobe: s.launchAdobe,
      scanAdobe: s.scanAdobe,
      installAdobePanel: s.installAdobePanel,
      setAdobePanelAutoUpdate: s.setAdobePanelAutoUpdate,
    })),
  );
  const [view, setView] = usePersistedChoice<AdobeApp>("nr.adobe.view", ["ppro", "aeft"], "ppro");
  const [diag, setDiag] = useState<AdobeDiagnostic | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);

  async function runDiagnose() {
    setDiagBusy(true);
    try { setDiag(await nr.adobeDiagnose()); } finally { setDiagBusy(false); }
  }
  const debugOk = diag ? Object.values(diag.playerDebug).some((v) => v === "1") : false;
  const installOk = !!(diag && diag.manifestExists && debugOk);
  const diagText = diag
    ? [
        installOk ? t("diag.verdictOk") : t("diag.verdictIncomplete"),
        "",
        t("diag.folder", { dir: diag.panelDir }),
        t("diag.manifestPresent", { yesNo: diag.manifestExists ? t("diag.yes") : t("diag.no") }),
        t("diag.files", { files: diag.files.join(", ") || t("diag.filesEmpty") }),
        `PlayerDebugMode: ${Object.entries(diag.playerDebug).map(([k, v]) => `${k}=${v}`).join("  ")}`,
        diag.manifestHead ? `\n${t("diag.manifestHead")}\n${diag.manifestHead}` : "",
        diag.cepLogs.length
          ? `\n${t("diag.cepLogFound")}\n${diag.cepLogs.map((l) => `[${l.file}]\n${l.lines.join("\n")}`).join("\n\n")}`
          : `\n${t("diag.cepLogNone")}`,
      ].filter(Boolean).join("\n")
    : "";

  // Statut au montage + poll léger ; snapshots rechargés quand le panneau pousse (SSE).
  useEffect(() => {
    void refreshAdobeStatus();
    void loadAdobeSnapshot("ppro");
    void loadAdobeSnapshot("aeft");
    const t = setInterval(() => void refreshAdobeStatus(), 8000);
    const off = nr.onAdobeUpdate((p) => {
      void loadAdobeSnapshot(p.app);
      void refreshAdobeStatus();
    });
    // Mise à jour automatique du panneau (au démarrage du core) : le statut porte la nouvelle
    // version et les apps à redémarrer.
    const offPanel = nr.onAdobePanelUpdated(() => void refreshAdobeStatus());
    return () => { clearInterval(t); off(); offPanel(); };
  }, [refreshAdobeStatus, loadAdobeSnapshot]);

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("subtitle")}
          </p>
        </div>
        <Button variant="outline" disabled={adobeBusy} onClick={() => void installAdobePanel()}>
          <Download className="size-4" /> {adobeStatus?.panelInstalled ? t("reinstallPanel") : t("installPanel")}
        </Button>
      </div>

      {/* État d'installation du panneau CEP — persistant (le message d'install ci-dessous est fugace). */}
      <Card className="block p-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">{t("panel.cepTitle")}</span>
          {adobeStatus?.panelInstalled ? (
            <Badge className="gap-1 bg-[var(--color-ok)]/15 text-[var(--color-ok)]"><Check className="size-3" /> {t("panel.installed")}</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">{t("panel.notInstalled")}</Badge>
          )}
        </div>
        {adobeStatus?.panelInstalled ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("panel.copiedIn")} <code className="break-all text-foreground">{adobeStatus.panelDir}</code>.
            <br />{t("panel.inApp")}<b className="text-foreground">{t("panel.menuPath")}</b>{t("panel.restartHint")}
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("panel.installHint")}
          </p>
        )}

        {/* Mise à jour : la copie posée dans %APPDATA% ne suit pas les mises à jour de NetsuRush —
            le core la resynchronise au démarrage tant que cette option reste active. */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/20 p-3">
          <div className="min-w-0">
            <p className="text-xs font-medium">{t("panel.autoUpdate")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {adobeStatus?.panelInstalled && adobeStatus.panelOutdated
                ? t("panel.updatePending")
                : t("panel.autoUpdateHint")}
              {adobeStatus?.panelVersion ? ` · v${adobeStatus.panelInstalledVersion || adobeStatus.panelVersion}` : ""}
              {/* L'empreinte identifie le build même quand la version du manifeste n'a pas bougé —
                  c'est la seule chose exploitable dans un rapport de bêta-testeur. */}
              {adobeStatus?.panelBuild ? ` (${adobeStatus.panelBuild})` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {adobeStatus?.panelInstalled && adobeStatus.panelOutdated && (
              <Button size="sm" variant="outline" disabled={adobeBusy} onClick={() => void installAdobePanel()}>
                <RefreshCw className="size-3.5" /> {t("panel.updateNow")}
              </Button>
            )}
            <Toggle
              pressed={adobeStatus?.panelAutoUpdate !== false}
              onPressedChange={(on) => void setAdobePanelAutoUpdate(on)}
              disabled={adobeBusy}
            >
              {adobeStatus?.panelAutoUpdate !== false ? t("panel.autoUpdateOn") : t("panel.autoUpdateOff")}
            </Toggle>
          </div>
        </div>

        {!!adobeStatus?.panelRestartApps?.length && (
          <p className="mt-2 text-xs text-[var(--color-ok)]">
            {t("panel.restartApps", { apps: adobeStatus.panelRestartApps.map(hostLabel).join(" · ") })}
          </p>
        )}
        {adobeNotice && (
          <p className={`mt-2 text-sm font-medium ${adobeNotice.kind === "err" ? "text-destructive" : "text-[var(--color-ok)]"}`}>
            {adobeNotice.text}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={diagBusy} onClick={() => void runDiagnose()}>
            <Stethoscope className="size-3.5" /> {t("panel.diagnose")}
          </Button>
          {diag && (
            <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(diagText)}>
              <Copy className="size-3.5" /> {t("common:action.copy")}
            </Button>
          )}
        </div>
        {diag && (
          <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all">
            {diagText}
          </pre>
        )}
      </Card>

      <div className="flex gap-4">
        <AdobeStatusCard
          app="ppro"
          status={adobeStatus?.ppro ?? null}
          busy={adobeBusy}
          onLaunch={() => void launchAdobe("ppro")}
          onScan={() => void scanAdobe("ppro")}
        />
        <AdobeStatusCard
          app="aeft"
          status={adobeStatus?.aeft ?? null}
          busy={adobeBusy}
          onLaunch={() => void launchAdobe("aeft")}
          onScan={() => void scanAdobe("aeft")}
        />
      </div>

      <Tabs value={view} onValueChange={(v) => setView(v as AdobeApp)}>
        <TabsList>
          <TabsTrigger value="ppro"><HostIcon host="ppro" className="size-4" /> Premiere Pro</TabsTrigger>
          <TabsTrigger value="aeft"><HostIcon host="aeft" className="size-4" /> After Effects</TabsTrigger>
        </TabsList>
        <TabsContent value="ppro" className="mt-4">
          <AdobeSnapshotView snap={adobeSnapshots.ppro} />
        </TabsContent>
        <TabsContent value="aeft" className="mt-4">
          <AdobeSnapshotView snap={adobeSnapshots.aeft} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
