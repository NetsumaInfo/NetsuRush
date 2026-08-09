import { useState } from "react";
import { Check, ChevronDown, Copy, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { BugContext } from "@/lib/bridge";
import { formatContext } from "./bugReportShared";
import { useTranslation } from "react-i18next";

// Assez pour situer une machine d'un coup d'œil ; le reste est dans le repli.
function summaryLines(ctx: BugContext): string[] {
  const vram = ctx.gpu.vram ? ` · ${Math.round(ctx.gpu.vram.totalMB / 1024)} Go VRAM` : "";
  return [
    `${ctx.gpu.label ?? "GPU inconnu"}${vram}`,
    `${ctx.cpu.name} · ${Math.round(ctx.memory.totalMB / 1024)} Go RAM`,
    `${ctx.os.label} · v${ctx.app.version || "?"}`,
    `torch ${ctx.runtime.backends.ml} · onnx ${ctx.runtime.backends.onnx} · ${ctx.runtime.ffmpeg ? "ffmpeg ok" : "ffmpeg absent"}`,
  ];
}

type Props = {
  context: BugContext | null;
  loading: boolean;
  onRefresh: () => void;
  manual: string;
  onManualChange: (value: string) => void;
};

// Si la lecture échoue (service coupé), la saisie prend le relais — sinon le rapport part sans machine.
export function SystemSpecsCard({ context, loading, onRefresh, manual, onManualChange }: Props) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!context) return;
    try {
      await navigator.clipboard.writeText(formatContext(context));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* presse-papier indisponible */ }
  }

  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-xs font-medium">{t("bugReport.specs.title")}</p>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={copy} disabled={!context} aria-label={t("bugReport.specs.copy")} />}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </TooltipTrigger>
            <TooltipContent>{t("bugReport.specs.copy")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={onRefresh} disabled={loading} aria-label={t("bugReport.specs.refresh")} />}>
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </TooltipTrigger>
            <TooltipContent>{t("bugReport.specs.refresh")}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {loading && !context ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" /> {t("bugReport.specs.loading")}
        </div>
      ) : !context ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <label htmlFor="bug-specs-manual" className="text-[11px] text-muted-foreground">
            {t("bugReport.specs.manual")}
          </label>
          <Input
            id="bug-specs-manual"
            value={manual}
            onChange={(e) => onManualChange(e.target.value)}
            placeholder={t("bugReport.specs.manualPlaceholder")}
          />
        </div>
      ) : (
        <>
          <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
            {summaryLines(context).map((line) => <li key={line} className="truncate">{line}</li>)}
          </ul>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
            {open ? t("bugReport.specs.less") : t("bugReport.specs.more")}
          </button>
          {open && (
            <pre className="mt-2 overflow-x-auto rounded-md bg-input/40 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
              {formatContext(context)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
