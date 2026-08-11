import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Cpu,
  Download,
  HardDrive,
  Layers3,
  LockKeyhole,
  PackageCheck,
  RotateCw,
  Search,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import { nr } from "@/lib/bridge";
import type { AdobeApp, ModelStatus, SetupDownload, SetupProgress, SetupStatus } from "@/lib/bridge";
import { hostLabel } from "@/lib/host";
import { modulesForModels } from "@/lib/modules";
import { fmtSize, MODEL_REGISTRY, modelById, TASK_LABELS, TASK_ORDER, type ModelEntry } from "@/lib/modelRegistry";
import { hasChosenLang, LANGUAGES, type LangCode } from "@/i18n";
import { useApp } from "@/store";
import { isModelCompatible, useCompatibility } from "@/hooks/useCompatibility";
import { FlagIcon } from "@/components/language/FlagIcon";
import { GateFrame } from "@/components/auth/GateFrame";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { Input } from "@/components/ui/input";
import { ErrorReportButton } from "@/components/common/ErrorReportButton";

type Phase = "checking" | "configure" | "running" | "error" | "restart" | "done";
type ConfigureStep = "language" | "models" | "review";
// La couleur distingue « terminé », « déjà présent » et « échoué » sans relire chaque ligne.
type LogTone = "plain" | "ok" | "warn" | "error" | "muted";
type LogEntry = { text: string; tone: LogTone };
// Téléchargement EN COURS : une ligne vivante qui se met à jour, retirée dès qu'elle se conclut.
type ActiveDownload = SetupDownload & { speed: number; at: number };

const TONE_CLASS: Record<LogTone, string> = {
  plain: "text-foreground/80",
  ok: "text-[var(--color-ok)]",
  warn: "text-[var(--color-warn)]",
  error: "text-destructive",
  muted: "text-muted-foreground",
};

// Un état = une couleur, la même dans la barre et dans la ligne de journal qui lui succède.
const DOWNLOAD_TONE: Record<SetupDownload["state"], LogTone> = {
  download: "ok",
  work: "plain",
  retry: "warn",
  error: "error",
  done: "ok",
  skip: "muted",
};
const BAR_COLOR: Record<SetupDownload["state"], string> = {
  download: "var(--color-ok)",
  work: "var(--primary)",
  retry: "var(--color-warn)",
  error: "var(--destructive)",
  done: "var(--color-ok)",
  skip: "var(--muted-foreground)",
};

// Un modèle par usage, tous légers sauf SigLIP : app complète sans arbitrage à faire.
const RECOMMENDED_MODELS = ["omnishotcut", "siglip2-so400m", "anime", "tas-rife4.25", "face-real", "face-anime"];
const RECOMMENDED_BYTES = RECOMMENDED_MODELS.reduce((sum, id) => sum + (modelById(id)?.sizeBytes ?? 0), 0);

// Verdict du dernier contrôle réussi. Ce gate protège une INSTALLATION incomplète — un état qui ne
// change pas d'un lancement à l'autre. Faire patienter tout le monde devant un écran de chargement
// pour un verdict qui est « prêt » à tous les démarrages sauf le premier revient à payer le cas rare
// avec le temps du cas normal. On rend donc l'application immédiatement et on revérifie EN FOND :
// si l'installation s'est cassée entre-temps, l'écran reprend la main dans la foulée.
const READY_KEY = "nr.setup.ready";
function rememberedReady() {
  try { return localStorage.getItem(READY_KEY) === "1"; } catch { return false; }
}
function rememberReady(ready: boolean) {
  try { localStorage.setItem(READY_KEY, ready ? "1" : "0"); } catch { /* stockage indisponible : contrôle bloquant, comme avant */ }
}

function mlEngineName(backend?: string) {
  if (backend === "cuda") return "NVIDIA CUDA";
  if (backend === "rocm") return "AMD ROCm";
  if (backend === "xpu") return "Intel XPU";
  return "CPU";
}

export function SetupGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation(["setup", "common", "models", "language"]);
  const lang = useApp((state) => state.lang);
  const setLang = useApp((state) => state.setLang);
  // Le choix de la langue est la PREMIÈRE étape de l'installation, pas un écran à part : un écran de
  // plus avant celui qui compte est une friction pure. Déjà choisie (réparation, mise à jour) ⇒
  // l'étape disparaît, on ne repose pas une question réglée.
  const [steps] = useState<ConfigureStep[]>(() => (hasChosenLang() ? ["models", "review"] : ["language", "models", "review"]));
  // Déjà vérifié une fois : l'application s'ouvre TOUT DE SUITE, le contrôle se fait derrière.
  const [phase, setPhase] = useState<Phase>(() => (rememberedReady() ? "done" : "checking"));
  const [step, setStep] = useState<ConfigureStep>(() => (hasChosenLang() ? "models" : "language"));
  const [status, setStatus] = useState<SetupStatus | null>(null);
  // Apps Adobe présentes sur ce PC → proposition d'installer le panneau CEP dès la configuration.
  const [adobeApps, setAdobeApps] = useState<AdobeApp[]>([]);
  const [adobePanel, setAdobePanel] = useState(true);
  const [models, setModels] = useState<string[]>(RECOMMENDED_MODELS);
  const [modelQuery, setModelQuery] = useState("");
  const [advanced, setAdvanced] = useState(false);
  // Disponibilité RÉELLE (moteur Python présent côté core) : un modèle sans moteur serait coché puis
  // écarté en silence par le core, et l'installation se dirait « réussie » sans lui.
  const [modelStatus, setModelStatus] = useState<Record<string, ModelStatus>>({});
  const { status: compatibility } = useCompatibility();
  const [prog, setProg] = useState<SetupProgress>({});
  const [log, setLog] = useState<LogEntry[]>([]);
  const [downloads, setDownloads] = useState<ActiveDownload[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Incidents NON bloquants remontés par le core pendant le provisionnement (`stage: "error"` :
  // un pack qui rate, un moteur écarté). L'installation continue et peut se terminer « réussie »,
  // donc rien n'alerterait : sans ça, la trace part avec le redémarrage.
  const [issues, setIssues] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, downloads.length]);

  // Sonde Adobe indépendante du provisionnement : son échec ne doit pas bloquer l'installation.
  useEffect(() => {
    let alive = true;
    nr.adobeStatus()
      .then((next) => {
        if (!alive) return;
        setAdobeApps((["ppro", "aeft"] as AdobeApp[]).filter((app) => next[app]?.installed));
        if (next.panelInstalled) setAdobePanel(next.panelAutoUpdate !== false);
      })
      .catch(() => { /* hors application : aucune app Adobe proposée */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    nr.modelsList()
      .then((list) => { if (alive && list.ok) setModelStatus(Object.fromEntries(list.models.map((model) => [model.id, model]))); })
      .catch(() => { /* core injoignable : catalogue affiché tel quel, le core filtrera */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    nr.setupStatus()
      .then((next) => {
        if (!alive) return;
        setStatus(next);
        if (next.installedModels?.length) setModels(next.installedModels);
        rememberReady(next.ready);
        // Le contrôle de fond ne reprend la main que s'il INFIRME le verdict mémorisé : une
        // installation cassée (runtime supprimé, mise à jour incomplète) ramène l'écran de
        // réparation, sinon l'utilisateur ne voit jamais ce gate.
        setPhase(next.ready ? "done" : "configure");
      })
      .catch((cause) => {
        if (!alive) return;
        // Service injoignable : ça ne dit RIEN de l'installation. Sur une application déjà validée,
        // on la laisse ouverte (elle signale elle-même son service hors ligne, qui se relance seul).
        // Au tout premier lancement en revanche, rien n'est vérifié : l'écran reste, avec Réessayer.
        if (rememberedReady()) {
          setPhase("done");
          return;
        }
        setError(String(cause));
        setPhase("error");
      });
    return () => { alive = false; };
  }, []);

  // Catalogue proposé à l'installation = celui des Paramètres › Modèles, MÊME règle : la sélection
  // courante d'abord (2 à 6 modèles par tâche couvrant des situations différentes), le reste derrière
  // « Avancé ». Les modèles fournis par une lib (bundled/auto) ou à importer à la main n'ont rien à
  // faire dans une case à cocher d'installation : ils ne se téléchargent pas ici.
  const catalog = MODEL_REGISTRY.filter((model) =>
    !model.bundled && !model.manual && !model.autoFetch
    && modelStatus[model.id]?.available !== false
    && isModelCompatible(model.id, compatibility));
  const shown = catalog.filter((model) => advanced || !model.advanced || models.includes(model.id));
  const hiddenCount = catalog.length - shown.length;
  const needle = modelQuery.trim().toLocaleLowerCase();
  const filteredModels = shown.filter((model) => `${model.label} ${model.hint ?? ""} ${TASK_LABELS[model.task]}`.toLocaleLowerCase().includes(needle));
  const groupedModels = TASK_ORDER
    .map((task) => ({ task, models: filteredModels.filter((model) => model.task === task) }))
    .filter((group) => group.models.length);
  const selectedModelEntries = models.map(modelById).filter((entry): entry is ModelEntry => !!entry);
  const selectedBytes = selectedModelEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const langLabel = LANGUAGES.find((entry) => entry.code === lang)?.label ?? lang;

  function pickLanguage(code: LangCode) {
    setLang(code);
    goNext();
  }

  function toggleModel(id: string) {
    setModels((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (id.startsWith("siglip2-")) return [...current.filter((item) => !item.startsWith("siglip2-")), id];
      return [...current, id];
    });
  }

  function goNext() {
    const index = steps.indexOf(step);
    if (index < steps.length - 1) setStep(steps[index + 1]);
  }

  function goBack() {
    const index = steps.indexOf(step);
    if (index > 0) setStep(steps[index - 1]);
  }

  // Fin d'un téléchargement : la ligne vivante laisse UNE ligne de journal, sinon l'écran
  // accumulerait des dizaines de barres à 100 %.
  function closeDownload(dl: SetupDownload) {
    const size = dl.total || dl.done;
    const suffix = dl.state === "done"
      ? (size ? fmtSize(size) : t("setup:dl.done"))
      : dl.state === "skip" ? t("setup:dl.skipped") : t("setup:dl.failed");
    setLog((previous) => [...previous.slice(-499), { text: `${dl.name} — ${suffix}`, tone: DOWNLOAD_TONE[dl.state] }]);
  }

  function applyDownload(dl: SetupDownload) {
    if (dl.state === "done" || dl.state === "skip" || dl.state === "error") {
      setDownloads((previous) => previous.filter((row) => row.name !== dl.name));
      closeDownload(dl);
      return;
    }
    const now = Date.now();
    setDownloads((previous) => {
      const index = previous.findIndex((row) => row.name === dl.name);
      if (index < 0) return [...previous, { ...dl, speed: 0, at: now }];
      const before = previous[index];
      const elapsed = (now - before.at) / 1000;
      // Débit mesuré sur ≥ 0,5 s, sinon le chiffre saute à chaque paquet. Entre deux, on garde le dernier.
      const measured = elapsed >= 0.5 && dl.done > before.done ? (dl.done - before.done) / elapsed : null;
      const next = [...previous];
      next[index] = measured != null
        ? { ...dl, speed: measured, at: now }
        : { ...dl, speed: before.speed, at: before.at };
      return next;
    });
  }

  async function install() {
    setPhase("running");
    setError(null);
    setProg({ pct: 0 });
    setLog([]);
    setDownloads([]);
    setIssues([]);
    const off = nr.onSetupProgress((progress) => {
      if (progress.dl) { applyDownload(progress.dl); return; }
      setProg((previous) => ({ ...previous, ...progress }));
      const entry: LogEntry | null = progress.stage === "error"
        ? { text: `✕ ${progress.label ?? ""}`, tone: "error" }
        : progress.line != null
          ? { text: progress.line, tone: "muted" }
          : progress.label
            ? { text: `▶ ${progress.label}`, tone: "plain" }
            : null;
      if (entry != null) setLog((previous) => [...previous.slice(-499), entry]);
      if (progress.stage === "error") setIssues((previous) => [...previous, progress.label ?? progress.line ?? "?"]);
    });
    try {
      const result = await nr.setupRun({ modules: modulesForModels(models), models, adobePanel: adobePanel && adobeApps.length > 0 });
      if (result.ok) setPhase("restart");
      else {
        setError(result.error || t("setup:installFailed"));
        setPhase("error");
      }
    } catch (cause) {
      setError(String(cause));
      setPhase("error");
    } finally {
      off();
      // Plus aucun octet n'arrivera : une barre laissée en place se figerait à mi-course.
      setDownloads([]);
    }
  }

  if (phase === "done") return <>{children}</>;
  if (phase === "checking") {
    return (
      <GateFrame contentClassName="max-w-md">
        <div className="grid min-h-48 place-items-center">
          <div className="space-y-3 text-center"><Spinner className="mx-auto size-6 text-muted-foreground" /><p className="text-sm text-muted-foreground">{t("setup:scan.running")}</p></div>
        </div>
      </GateFrame>
    );
  }

  return (
    <GateFrame contentClassName="max-w-4xl">
      <Card className="w-full max-w-3xl gap-6 p-7">
        <header className="flex items-start justify-between gap-5">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t("setup:title")}</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">{t("setup:desc")}</p>
          </div>
          {phase === "configure" && (
            <div className="flex shrink-0 items-center gap-1" aria-label={t("setup:progressAria")}>
              {steps.map((item, index) => (
                <span key={item} className={cn("h-1.5 w-8 rounded-full", index <= steps.indexOf(step) ? "bg-primary" : "bg-muted")} />
              ))}
            </div>
          )}
        </header>

        {phase === "configure" && step === "language" && (
          <section className="flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-medium">{t("language:gate.title")}</h2>
              {/* Sous-titre bilingue : l'écran s'affiche AVANT tout choix, donc dans une langue que
                  l'utilisateur ne parle peut-être pas. */}
              <p className="mt-1 text-xs text-muted-foreground">Choisis la langue de l'interface · Choose your language</p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {LANGUAGES.map((entry) => (
                <button
                  key={entry.code}
                  type="button"
                  aria-pressed={entry.code === lang}
                  onClick={() => pickLanguage(entry.code)}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    entry.code === lang ? "border-primary bg-accent" : "border-border hover:bg-accent/50",
                  )}
                >
                  <FlagIcon code={entry.code} className="h-4 w-[1.35rem] shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.label}</span>
                  {entry.code === lang && <Check className="size-4 shrink-0 text-primary" />}
                </button>
              ))}
            </div>
          </section>
        )}

        {phase === "configure" && step === "models" && (
          <section className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h2 className="text-sm font-medium">{t("setup:models.title")}</h2>
              <div className="flex items-center gap-2">
                <Toggle pressed={advanced} onPressedChange={setAdvanced} className="gap-1.5">
                  <Layers3 className="size-3.5" />
                  {t("models:advanced.label")}
                  {!advanced && hiddenCount > 0 && <Badge variant="secondary" className="text-[10px] tabular-nums">{hiddenCount}</Badge>}
                </Toggle>
                <Button variant="outline" size="sm" onClick={() => setModels([])}>{t("setup:models.none")}</Button>
              </div>
            </div>

            <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
              <div className="flex items-center gap-3">
                <span className="grid size-8 place-items-center rounded-md bg-primary/15 text-primary"><LockKeyhole className="size-4" /></span>
                <p className="min-w-0 flex-1 text-sm font-medium">{t("setup:models.sceneDetection")}</p>
                <Badge variant="secondary">{t("setup:models.included")}</Badge>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex items-center gap-3"><PackageCheck className="size-5 text-primary" /><div><p className="text-sm font-medium">{t("setup:packs.recommended")}</p><p className="text-xs text-muted-foreground">{t("setup:review.modelCount", { count: RECOMMENDED_MODELS.length })} · ~{fmtSize(RECOMMENDED_BYTES)}</p></div></div>
              <Button variant="outline" size="sm" onClick={() => setModels(RECOMMENDED_MODELS)}>{t("setup:packs.select")}</Button>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={t("setup:models.search")} className="pl-8" />
            </div>

            {filteredModels.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">{t("setup:models.empty")}</p>
            ) : (
              <div className="max-h-80 space-y-4 overflow-auto pr-1">
                {groupedModels.map((group) => <div key={group.task} className="space-y-2"><h3 className="text-xs font-medium text-muted-foreground">{TASK_LABELS[group.task]}</h3><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{group.models.map((model) => {
                  const selected = models.includes(model.id);
                  return (
                    <button
                      key={model.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleModel(model.id)}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                        selected ? "border-primary bg-accent" : "border-border hover:bg-accent/50",
                      )}
                    >
                      <span className={cn("grid size-5 place-items-center rounded border", selected ? "border-primary bg-primary text-primary-foreground" : "border-border")}>
                        {selected && <Check className="size-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{model.label}</span>
                        <span className="text-xs text-muted-foreground">{fmtSize(model.sizeBytes)} · {t(`setup:models.tier.${model.tier}`)}</span>
                      </span>
                    </button>
                  );
                })}</div></div>)}
              </div>
            )}
            <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <span>{t("setup:models.selected", { count: models.length })}</span>
              <span className="flex items-center gap-1.5"><HardDrive className="size-3.5" /> {selectedBytes ? `~${fmtSize(selectedBytes)}` : t("setup:models.noExtraSpace")}</span>
            </div>
          </section>
        )}

        {phase === "configure" && step === "review" && (
          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-medium">{t("setup:review.title")}</h2>
            {status?.hardware && (
              <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-3">
                <Cpu className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0 text-xs">
                  {status.hardware.gpus.map((gpu) => <p key={`${gpu.name}-${gpu.pnpDeviceId || ""}`} className="font-medium text-foreground">{gpu.name}</p>)}
                  {status.hardware.cpus.map((cpu) => <p key={cpu} className="truncate text-muted-foreground">{cpu}</p>)}
                  <p className="mt-1 text-muted-foreground">{t("setup:detectedBackend", { backend: mlEngineName(status.mlBackend) })}</p>
                </div>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <SummaryCard label={t("setup:review.downloads")} value={models.length ? t("setup:review.modelCount", { count: models.length }) : t("setup:review.noOptionalModels")} detail={models.length ? `~${fmtSize(selectedBytes)}` : t("setup:review.mandatoryOnly")} />
              <SummaryCard label={t("language:settings.title")} value={langLabel} detail={t("language:gate.subtitle")} />
            </div>
            {adobeApps.length > 0 && (
              <button
                type="button"
                aria-pressed={adobePanel}
                onClick={() => setAdobePanel((current) => !current)}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  adobePanel ? "border-primary bg-accent" : "border-border hover:bg-accent/50",
                )}
              >
                <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded border", adobePanel ? "border-primary bg-primary text-primary-foreground" : "border-border")}>
                  {adobePanel && <Check className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{t("setup:adobe.title")}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t("setup:adobe.detected", { apps: adobeApps.map(hostLabel).join(" · ") })} — {t("setup:adobe.hint")}
                  </span>
                </span>
              </button>
            )}
            <ul className="space-y-2 rounded-lg border border-border p-3">
              {status?.items.map((item) => (
                <li key={item.id} className="flex items-center gap-2 text-sm">
                  {item.done ? <CheckCircle2 className="size-4 text-[var(--color-ok)]" /> : <Download className="size-4 text-muted-foreground" />}
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(phase === "running" || phase === "error" || phase === "restart") && (
          <section className="flex flex-col gap-4">
            {phase === "restart" ? (
              <div className="flex flex-col items-center gap-3 py-5 text-center">
                <span className="grid size-12 place-items-center rounded-full bg-[var(--color-ok)]/15 text-[var(--color-ok)]"><CheckCircle2 className="size-6" /></span>
                <div><h2 className="text-base font-medium">{t("setup:done")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("setup:restartHint")}</p></div>
              </div>
            ) : (
              <>
                <Progress value={prog.pct ?? null} />
                <p className="truncate text-xs text-muted-foreground">{prog.label || prog.line || t("setup:running")}</p>
              </>
            )}
            {phase === "error" && (
              <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                <div className="flex items-start gap-2">
                  <TriangleAlert className="size-4 shrink-0" /><span className="break-words">{error}</span>
                </div>
                {/* Une installation qui échoue laisse l'app inutilisable : le rapport doit partir d'ICI,
                    les Paramètres étant derrière l'écran bloqué. */}
                <ErrorReportButton
                  className="self-start"
                  error={[error ?? "", ...issues, logText(log.slice(-20))].filter(Boolean).join("\n")}
                  subject="Échec de l'installation (téléchargement des dépendances)"
                  module="setup"
                  moduleLabel="Installation"
                />
              </div>
            )}
            {/* Incident SANS arrêt de l'installation. Le bouton n'existe que dans ce cas : les écrans
                de configuration et une installation propre n'ont rien à signaler, et une aide au
                dépannage posée en permanence sur le premier écran ferait douter avant même le début. */}
            {phase !== "error" && issues.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-3">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {t("setup:issues.detected", { count: issues.length })}
                </p>
                <ErrorReportButton
                  error={[...issues, logText(log.slice(-20))].join("\n")}
                  subject="Incident pendant l'installation (installation poursuivie)"
                  module="setup"
                  moduleLabel="Installation"
                  severity="major"
                />
              </div>
            )}
            {(log.length > 0 || downloads.length > 0) && phase !== "restart" && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Terminal className="size-3.5" /> {t("setup:log")}</span>
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void navigator.clipboard?.writeText(logText(log))}>{t("common:action.copy")}</Button>
                </div>
                <div ref={logRef} className="h-44 overflow-auto rounded-md border border-border bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {log.map((entry, index) => <div key={index} className={cn("whitespace-pre-wrap break-all", TONE_CLASS[entry.tone])}>{entry.text}</div>)}
                  {/* Les téléchargements en cours vivent SOUS le journal, dans le même cadre : une
                      ligne par élément, remplacée par sa ligne de journal une fois conclue. */}
                  {downloads.map((dl) => <DownloadRow key={dl.name} dl={dl} />)}
                </div>
              </div>
            )}
          </section>
        )}

        <footer className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <div>
            {phase === "configure" && step !== steps[0] && <Button variant="ghost" onClick={goBack}><ArrowLeft className="size-4" /> {t("common:action.back")}</Button>}
            {phase === "error" && <Button variant="ghost" onClick={() => { setPhase("configure"); setStep("review"); }}><ArrowLeft className="size-4" /> {t("common:action.back")}</Button>}
          </div>
          <div className="flex gap-2">
            {phase === "configure" && step !== "review" && <Button onClick={goNext}>{t("common:action.continue")}</Button>}
            {phase === "configure" && step === "review" && <Button onClick={() => void install()}><Download className="size-4" /> {status?.items.some((item) => item.done) ? t("setup:repair") : t("setup:install")}</Button>}
            {phase === "running" && <Button disabled><RotateCw className="size-4 animate-spin" /> {t("setup:installing")}</Button>}
            {phase === "error" && <Button onClick={() => void install()}><RotateCw className="size-4" /> {t("common:action.retry")}</Button>}
            {phase === "restart" && <Button onClick={() => void relaunchApp()}><RotateCw className="size-4" /> {t("setup:restartApp")}</Button>}
          </div>
        </footer>
      </Card>
    </GateFrame>
  );
}

function logText(entries: LogEntry[]) {
  return entries.map((entry) => entry.text).join("\n");
}

// Nom, chiffres, barre colorée par l'état. Sans total annoncé, la barre reste indéterminée.
function DownloadRow({ dl }: { dl: ActiveDownload }) {
  const { t } = useTranslation(["setup"]);
  const known = dl.total > 0 && dl.state === "download";
  const ratio = known ? Math.min(1, dl.done / dl.total) : 0;
  const figures = dl.state === "retry"
    ? t("setup:dl.retry")
    : dl.state === "work"
      ? t("setup:dl.working")
      : [
        known ? `${fmtSize(dl.done)} / ${fmtSize(dl.total)}` : dl.done > 0 ? fmtSize(dl.done) : t("setup:dl.working"),
        dl.speed > 0 ? `${fmtSize(dl.speed)}/s` : null,
      ].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn("min-w-0 truncate", TONE_CLASS[DOWNLOAD_TONE[dl.state]])}>{dl.name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{figures}</span>
      </div>
      <div className="h-[3px] overflow-hidden rounded-full bg-muted-foreground/20">
        <div
          className={cn("h-full rounded-full transition-[width] duration-300", !known && "animate-pulse")}
          style={{ width: known ? `${ratio * 100}%` : "100%", background: BAR_COLOR[dl.state], opacity: known ? 1 : 0.5 }}
        />
      </div>
    </div>
  );
}

function SummaryCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

async function relaunchApp() {
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch {
    // Hors Tauri : le bouton reste sans effet, l'application native n'existe pas.
  }
}
