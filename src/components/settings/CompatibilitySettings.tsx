import { CheckCircle2, Cpu, Monitor, RefreshCw, TriangleAlert, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCompatibility } from "@/hooks/useCompatibility";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

type RuntimeKind = "gpu" | "cpu" | "fallback" | "missing";
type RuntimeRow = { key: string; kind: RuntimeKind; detail: string };

function gpuEngine(encoder: string | null): string {
  if (encoder?.endsWith("_nvenc")) return "NVIDIA · NVENC";
  if (encoder?.endsWith("_amf")) return "AMD · AMF";
  if (encoder?.endsWith("_qsv")) return "Intel · Quick Sync";
  return "";
}

function roleLabel(role: "igpu" | "dgpu" | "unknown" | undefined, t: (key: string) => string): string {
  return role === "igpu" ? t("compatibility.igpu") : role === "dgpu" ? t("compatibility.dgpu") : t("compatibility.gpu");
}

function runtimeKind(accelerated: boolean, configured: string | undefined, installed = true): RuntimeKind {
  if (!installed) return "missing";
  if (accelerated) return "gpu";
  return configured && configured !== "cpu" ? "fallback" : "cpu";
}

function StateBadge({ kind, t }: { kind: RuntimeKind; t: (key: string) => string }) {
  const Icon = kind === "gpu" ? CheckCircle2 : kind === "fallback" ? TriangleAlert : kind === "missing" ? XCircle : Cpu;
  return (
    <Badge
      variant={kind === "missing" ? "destructive" : kind === "fallback" ? "outline" : kind === "gpu" ? "default" : "secondary"}
      className={kind === "gpu" ? "bg-[var(--color-ok)] text-black" : undefined}
    >
      <Icon className="size-3" /> {t(`compatibility.state.${kind}`)}
    </Badge>
  );
}

function FunctionRow({ row, t }: { row: RuntimeRow; t: (key: string) => string }) {
  return (
    <div className="flex items-center gap-3 px-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{t(`compatibility.features.${row.key}`)}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t(`compatibility.featureHints.${row.key}`)}</p>
        {row.detail && <p className="mt-1 truncate text-[11px] text-foreground/70">{row.detail}</p>}
      </div>
      <StateBadge kind={row.kind} t={t} />
    </div>
  );
}

export function CompatibilitySettings() {
  const { t } = useTranslation("settings");
  const { status, loading, refresh } = useCompatibility();

  const gpuRows: RuntimeRow[] = status ? [
    {
      key: "netsucut",
      kind: status.encoding.hardwareEncoders.length ? "gpu" : "cpu",
      detail: status.encoding.hardwareEncoders.length
        ? status.encoding.hardwareEncoders.map(gpuEngine).filter(Boolean).join(" · ")
        : "x264 / x265",
    },
    {
      key: "torchModels",
      kind: runtimeKind(!!status.runtime.torch?.accelerated, status.runtime.torch?.configured, !!status.runtime.torch),
      detail: status.runtime.torch?.deviceName || status.runtime.torch?.actual || "",
    },
    {
      key: "onnxModels",
      kind: runtimeKind(!!status.runtime.onnx?.accelerated, status.runtime.onnx?.configured || status.configured.onnx, !!status.runtime.onnx),
      detail: status.runtime.onnx?.selectedProviders[0] || status.configured.onnx || "",
    },
    {
      key: "transcription",
      kind: status.configured.transcribe !== "cpu" ? "gpu" : "cpu",
      detail: status.configured.transcribe || "cpu",
    },
  ] : [];

  const cpuRows: RuntimeRow[] = status ? [
    { key: "netsucut", kind: "cpu", detail: t("compatibility.thumbnailEngine") },
    { key: "notebook", kind: "cpu", detail: "" },
  ] : [];

  return (
    <section className="max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">{t("compatibility.title")}</h2>
          <p className="mt-1 max-w-[68ch] text-xs text-muted-foreground">{t("compatibility.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void refresh()}>
          {loading ? <Spinner /> : <RefreshCw className="size-3.5" />}
          {t("compatibility.refresh")}
        </Button>
      </div>

      {!status && loading && (
        <div className="mt-5 space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" /></div>
      )}
      {!status && !loading && <p className="mt-5 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">{t("compatibility.unavailable")}</p>}

      {status && (
        <div className="mt-6 space-y-6">
          <div>
            <h3 className="text-xs font-medium text-muted-foreground">{t("compatibility.hardware")}</h3>
            <div className="mt-2 divide-y divide-border rounded-lg border border-border">
              {status.hardware.gpus.map((gpu) => (
                <div key={`${gpu.name}-${gpu.pnpDeviceId || ""}`} className="flex items-center gap-3 px-3 py-2.5">
                  <Monitor className="size-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{gpu.name}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{roleLabel(gpu.role, t)} · {gpu.vendor.toUpperCase()}</p>
                  </div>
                  {gpu.driverVersion && <span className="shrink-0 text-[11px] text-muted-foreground">{t("compatibility.driver")} {gpu.driverVersion}</span>}
                </div>
              ))}
              {status.hardware.cpus.map((cpu) => (
                <div key={cpu} className="flex items-center gap-3 px-3 py-2.5">
                  <Cpu className="size-4 shrink-0 text-muted-foreground" />
                  <div><p className="text-xs font-medium">{cpu}</p><p className="text-[11px] text-muted-foreground">{t("compatibility.cpu")}</p></div>
                </div>
              ))}
              {!status.hardware.gpus.length && !status.hardware.cpus.length && <p className="px-3 py-3 text-xs text-muted-foreground">{t("compatibility.noHardware")}</p>}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-medium text-muted-foreground">{t("compatibility.gpuFunctions")}</h3>
            <div className="mt-2 divide-y divide-border rounded-lg border border-border">{gpuRows.map((row) => <FunctionRow key={row.key} row={row} t={t} />)}</div>
          </div>

          <div>
            <h3 className="text-xs font-medium text-muted-foreground">{t("compatibility.cpuFunctions")}</h3>
            <div className="mt-2 divide-y divide-border rounded-lg border border-border">{cpuRows.map((row) => <FunctionRow key={row.key} row={row} t={t} />)}</div>
          </div>
        </div>
      )}
    </section>
  );
}
