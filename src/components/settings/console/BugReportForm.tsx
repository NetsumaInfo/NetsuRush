import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Download } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { nr, type BugReportRequest } from "@/lib/bridge";
import { useApp } from "@/store";
import { hostConnected } from "@/store/hostStatus";
import { NAV } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectGroupLabel, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { countLevels, getConsoleSnapshot, serializeConsole, subscribeConsole, type ConsoleEntry } from "@/lib/appConsole";
import { Trans, useTranslation } from "react-i18next";
import {
  BUG_CATEGORIES, BUG_FREQUENCIES, BUG_GROUPS, BUG_SEVERITIES, DEFAULT_CATEGORY, DEFAULT_FREQUENCY,
  DEFAULT_SEVERITY, buildReportText, categoryGroup, descriptionKind, needsOwnLabel, redact, reportFileName, severityFor,
  type BugFrequency, type BugSeverity,
} from "./bugReportShared";
import { BugReporterField, type ReporterIdentity } from "./BugReporterField";
import { AttachmentPicker } from "./AttachmentPicker";
import { SystemSpecsCard } from "./SystemSpecsCard";
import { useBugContext } from "./useBugContext";

// La navigation, plus les deux écrans qui n'y figurent pas.
const MODULES = [...NAV.map((n) => ({ id: n.id as string, label: n.label })), { id: "settings", label: "Paramètres" }, { id: "setup", label: "Installation" }];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const v = String(r.result || ""); const i = v.indexOf(","); resolve(i >= 0 ? v.slice(i + 1) : ""); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {htmlFor
        ? <label htmlFor={htmlFor} className="text-xs text-muted-foreground">{label}</label>
        : <span className="text-xs text-muted-foreground">{label}</span>}
      {children}
    </div>
  );
}

// Une seule colonne sous 640 px : le panneau Adobe fait 560 px, où deux colonnes fixes débordent.
function Row({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

// Segments à parts égales (`grow shrink basis-0`) : à leur largeur de texte, le groupe déborde de sa
// colonne dès qu'un libellé s'allonge (traductions comprises).
function Choice<T extends string>({ value, options, onChange, label }: {
  value: string; // peut sortir de la liste affichée (sévérité `idea`)
  options: readonly T[];
  onChange: (next: T) => void;
  label: (id: T) => string;
}) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(v) => { const next = v[0] as T | undefined; if (next) onChange(next); }}
      spacing={0}
      variant="outline"
      size="sm"
      className="w-full"
    >
      {options.map((id) => (
        <ToggleGroupItem
          key={id}
          value={id}
          className="grow shrink basis-0 px-1.5 text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary"
        >
          {label(id)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

// Ce que la machine sait, elle le remplit (specs, compte Discord, module ouvert, journal) ; le reste
// est demandé. Rien de ce qui a été écrit n'est perdu si l'envoi échoue : le rapport se télécharge.
export function BugReportForm() {
  const { t, i18n } = useTranslation("settings");
  const { tab, activeHost, connected } = useApp(useShallow((s) => ({ tab: s.tab, activeHost: s.activeHost, connected: hostConnected(s) })));
  const { context, loading: ctxLoading, refresh } = useBugContext();

  const [logs, setLogs] = useState<ConsoleEntry[]>(() => getConsoleSnapshot());
  const [category, setCategory] = useState<string>(DEFAULT_CATEGORY);
  const [severity, setSeverity] = useState<BugSeverity>(DEFAULT_SEVERITY);
  const [frequency, setFrequency] = useState<BugFrequency>(DEFAULT_FREQUENCY);
  const [moduleId, setModuleId] = useState<string>(() => (MODULES.some((m) => m.id === tab) ? tab : "settings"));
  const [categoryDetail, setCategoryDetail] = useState("");
  const [manualSpecs, setManualSpecs] = useState("");
  const [issue, setIssue] = useState("");
  const [steps, setSteps] = useState("");
  const [expected, setExpected] = useState("");
  const [videoRef, setVideoRef] = useState("");
  const [contactText, setContactText] = useState("");
  const [identity, setIdentity] = useState<ReporterIdentity>({ discordId: null, discordName: null, text: null });
  const [attachments, setAttachments] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  // Plafonds annoncés par le service : ils dépendent du serveur Discord du webhook (boost).
  const [limits, setLimits] = useState<{ files?: number; mb?: number }>({});

  useEffect(() => subscribeConsole(setLogs), []);
  useEffect(() => {
    void nr.bugStatus?.()
      .then((r) => {
        setConfigured(!!r?.configured);
        setLimits({ files: r?.maxAttachments, mb: r?.maxAttachmentMB });
      })
      .catch(() => setConfigured(false));
  }, []);

  const redacted = useMemo(() => redact(serializeConsole(logs)), [logs]);
  const counts = useMemo(() => countLevels(logs), [logs]);
  const isProblem = categoryGroup(category) === "problem";
  const askOwnLabel = needsOwnLabel(category);
  const onIdentity = useCallback((next: ReporterIdentity) => setIdentity(next), []);

  const label = (key: string) => t(key);
  function buildRequest(files: BugReportRequest["attachments"]): BugReportRequest {
    return {
      category,
      categoryLabel: label(`bugReport.categories.${category}`),
      categoryDetail: askOwnLabel ? categoryDetail.trim() || null : null,
      severity: severityFor(category, severity),
      severityLabel: isProblem ? label(`bugReport.severities.${severity}`) : label("bugReport.severities.idea"),
      frequency,
      frequencyLabel: label(`bugReport.frequencies.${frequency}`),
      module: moduleId,
      moduleLabel: MODULES.find((m) => m.id === moduleId)?.label ?? moduleId,
      issueText: redact(issue.trim()),
      stepsText: redact(steps.trim()) || null,
      expectedText: redact(expected.trim()) || null,
      videoReference: videoRef.trim() || null,
      manualSpecs: context ? null : manualSpecs.trim() || null,
      contact: identity,
      locale: i18n.language,
      activeHost,
      hostConnected: connected,
      attachments: files,
      consoleLogs: redacted,
      consoleLogCount: logs.length,
      errorCount: counts.errors,
      warnCount: counts.warns,
      redactionApplied: true,
    };
  }

  function download() {
    const text = buildReportText(buildRequest([]), context);
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = reportFileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (!issue.trim()) { setNotice({ ok: false, text: t("bugReport.validation.description") }); return; }
    if (askOwnLabel && !categoryDetail.trim()) { setNotice({ ok: false, text: t("bugReport.validation.detail") }); return; }

    setBusy(true);
    try {
      const encoded = await Promise.all(
        attachments.map(async (f) => ({ name: f.name, mimeType: f.type || "application/octet-stream", sizeBytes: f.size, dataBase64: await fileToBase64(f) })),
      );
      const r = await nr.bugReport(buildRequest(encoded));
      setNotice({ ok: r.ok, text: r.ok && r.reportId ? `${r.message} (${r.reportId})` : r.message });
      if (r.ok) {
        setIssue(""); setSteps(""); setExpected(""); setVideoRef(""); setCategoryDetail(""); setAttachments([]);
      }
    } catch {
      setNotice({ ok: false, text: t("bugReport.sendFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-10 border-t border-border pt-7">
      <h2 className="text-sm font-medium">{t("bugReport.title")}</h2>
      {configured === false && (
        <p className="mt-3 rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-3 py-2 text-xs text-[var(--color-warn)]">
          <Trans t={t} i18nKey="bugReport.noWebhook" components={{ c1: <code />, c2: <code /> }} />
        </p>
      )}

      <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
        <Row>
          <Field label={t("bugReport.type")}>
            <Select value={category} onValueChange={(v) => setCategory(String(v))} items={BUG_CATEGORIES.map((c) => ({ value: c.id, label: t(`bugReport.categories.${c.id}`) }))}>
              <SelectTrigger><SelectValue>{t(`bugReport.categories.${category}`)}</SelectValue></SelectTrigger>
              <SelectContent>
                {BUG_GROUPS.map((group) => (
                  <SelectGroup key={group}>
                    <SelectGroupLabel>{t(`bugReport.groups.${group}`)}</SelectGroupLabel>
                    {BUG_CATEGORIES.filter((c) => c.group === group).map((c) => (
                      <SelectItem key={c.id} value={c.id}>{t(`bugReport.categories.${c.id}`)}</SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t("bugReport.module")}>
            <Select value={moduleId} onValueChange={(v) => setModuleId(String(v))} items={MODULES.map((m) => ({ value: m.id, label: m.label }))}>
              <SelectTrigger><SelectValue>{MODULES.find((m) => m.id === moduleId)?.label}</SelectValue></SelectTrigger>
              <SelectContent>
                {MODULES.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </Row>

        {askOwnLabel && (
          <Field label={t("bugReport.detail")} htmlFor="bug-detail">
            <Input id="bug-detail" value={categoryDetail} onChange={(e) => setCategoryDetail(e.target.value)} placeholder={t("bugReport.detailPlaceholder")} />
          </Field>
        )}

        {isProblem && (
          <Row>
            <Field label={t("bugReport.severity")}>
              <Choice value={severity} options={BUG_SEVERITIES} onChange={setSeverity} label={(id) => t(`bugReport.severities.${id}`)} />
            </Field>
            <Field label={t("bugReport.frequency")}>
              <Choice value={frequency} options={BUG_FREQUENCIES} onChange={setFrequency} label={(id) => t(`bugReport.frequencies.${id}`)} />
            </Field>
          </Row>
        )}

        <Field label={t(`bugReport.description${descriptionKind(category)}`)} htmlFor="bug-description">
          <Textarea
            id="bug-description"
            value={issue}
            onChange={(e) => setIssue(e.target.value)}
            rows={3}
            placeholder={t(`bugReport.description${descriptionKind(category)}Placeholder`)}
          />
        </Field>

        {isProblem && (
          <Row>
            <Field label={t("bugReport.steps")} htmlFor="bug-steps">
              <Textarea id="bug-steps" value={steps} onChange={(e) => setSteps(e.target.value)} rows={3} placeholder={t("bugReport.stepsPlaceholder")} />
            </Field>
            <Field label={t("bugReport.expected")} htmlFor="bug-expected">
              <Textarea id="bug-expected" value={expected} onChange={(e) => setExpected(e.target.value)} rows={3} placeholder={t("bugReport.expectedPlaceholder")} />
            </Field>
          </Row>
        )}

        {/* Le récit s'arrête ici ; ce qui suit sert à retrouver l'auteur et situer sa machine. */}
        <div className="mt-1 flex flex-col gap-4 border-t border-border/60 pt-5">
          <Row>
            <Field label={t("bugReport.videoSource")} htmlFor="bug-video-source">
              <Input id="bug-video-source" value={videoRef} onChange={(e) => setVideoRef(e.target.value)} placeholder={t("bugReport.videoPlaceholder")} />
            </Field>
            <BugReporterField manual={contactText} onManualChange={setContactText} onIdentity={onIdentity} />
          </Row>

          <SystemSpecsCard
            context={context}
            loading={ctxLoading}
            onRefresh={refresh}
            manual={manualSpecs}
            onManualChange={setManualSpecs}
          />

          <AttachmentPicker files={attachments} onChange={setAttachments} maxFiles={limits.files} maxMB={limits.mb} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy || configured === false}>{busy ? t("bugReport.sending") : t("bugReport.send")}</Button>
          <Button type="button" variant="outline" onClick={download}>
            <Download className="size-3.5" /> {t("bugReport.download")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("bugReport.logsAttached", { count: logs.length })}
            {counts.errors > 0 && <span className="text-destructive"> · {t("bugReport.logErrors", { count: counts.errors })}</span>}
          </span>
        </div>
        {notice && <p className={cn("text-sm", notice.ok ? "text-[var(--color-ok)]" : "text-destructive")}>{notice.text}</p>}
      </form>
    </section>
  );
}
