// Rapport d'erreur en UN clic — même tuyau que « Signaler un souci » (nr.bugReport), sans le
// formulaire : un échec de téléchargement bloque là où il tombe, parfois avant les Paramètres.
// Envoi raté → le message est enregistré, comme le bouton « Enregistrer le message » du formulaire.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, LifeBuoy } from "lucide-react";
import { nr, type BugContext, type BugReportRequest } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { countLevels, getConsoleSnapshot, serializeConsole } from "@/lib/appConsole";
import { bugRelay } from "@/lib/bugRelay";
import { buildReportText, redact, reportFileName } from "@/components/settings/console/bugReportShared";
import { loadedDiscordProfile } from "@/components/settings/useDiscordProfile";
import { useApp } from "@/store";
import { hostConnected } from "@/store/hostStatus";
import { cn } from "@/lib/utils";

type State = "idle" | "sending" | "sent" | "saved";

interface Props {
  /** Message d'erreur brut, tel qu'affiché. */
  error: string;
  /** Ce qui a échoué, en une ligne (« Téléchargement du modèle X »). Ouvre la description. */
  subject: string;
  /** Ids de `BugReportForm` : le rapport arrive rangé comme ceux du formulaire. */
  module: string;
  moduleLabel: string;
  category?: string;
  severity?: string;
  className?: string;
}

async function readContext(): Promise<BugContext | null> {
  const raw = await nr.bugContext?.().catch(() => null);
  return raw && (raw as BugContext).ok ? (raw as BugContext) : null;
}

function saveReport(request: BugReportRequest, context: BugContext | null) {
  const url = URL.createObjectURL(new Blob([buildReportText(request, context)], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = reportFileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function ErrorReportButton({
  error, subject, module, moduleLabel, category = "download", severity = "blocker", className,
}: Props) {
  const { t, i18n } = useTranslation(["common", "settings"]);
  const [state, setState] = useState<State>("idle");

  async function send() {
    setState("sending");
    const logs = getConsoleSnapshot();
    const counts = countLevels(logs);
    const profile = loadedDiscordProfile();
    const app = useApp.getState();
    const request: BugReportRequest = {
      category,
      categoryLabel: t(`settings:bugReport.categories.${category}`),
      severity,
      severityLabel: t(`settings:bugReport.severities.${severity}`),
      frequency: "always",
      frequencyLabel: t("settings:bugReport.frequencies.always"),
      module,
      moduleLabel,
      issueText: redact(`${subject}\n\n${error}`),
      contact: profile ? { discordId: profile.id, discordName: profile.username, text: null } : null,
      locale: i18n.language,
      activeHost: app.activeHost,
      hostConnected: hostConnected(app),
      attachments: [],
      consoleLogs: redact(serializeConsole(logs)),
      consoleLogCount: logs.length,
      errorCount: counts.errors,
      warnCount: counts.warns,
      redactionApplied: true,
      relay: await bugRelay(),
    };

    try {
      const response = await nr.bugReport(request);
      if (response?.ok) { setState("sent"); return; }
    } catch { /* service muet ou hors ligne : on bascule sur le fichier */ }

    saveReport(request, await readContext());
    setState("saved");
  }

  if (state === "sent" || state === "saved") {
    return (
      <p className={cn("flex items-center gap-1.5 text-xs", state === "sent" ? "text-[var(--color-ok)]" : "text-muted-foreground", className)}>
        <Check className="size-3.5 shrink-0" /> {t(state === "sent" ? "common:report.sent" : "common:report.saved")}
      </p>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="outline" size="sm" className={className} disabled={state === "sending"} onClick={() => void send()} />
        }
      >
        <LifeBuoy className={state === "sending" ? "size-3.5 animate-pulse" : "size-3.5"} />
        {state === "sending" ? t("settings:bugReport.sending") : t("common:report.action")}
      </TooltipTrigger>
      {/* Le formulaire annonce déjà le journal joint : même phrase, même clé. */}
      <TooltipContent>{t("settings:bugReport.logsAttached", { count: getConsoleSnapshot().length })}</TooltipContent>
    </Tooltip>
  );
}
