// Surveillance mémoire pendant les tâches lourdes.
//
// La carte reste volontairement muette au repos : hors rendu ou encodage, la surveillance ne mesure
// rien et il n'y a donc rien à raconter. Elle prend la parole quand une tâche lourde tourne, et
// n'affiche une action que lorsque libérer la mémoire paginable n'a pas suffi — auquel cas l'arrêt
// est PROPOSÉ, jamais exécuté par la boucle.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, Loader2, Skull, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { nr } from "@/lib/bridge";
import type { OptimizeWatchdogState } from "@/lib/bridge";
import { fmtBytes } from "./optimizeShared";

const EMPTY: OptimizeWatchdogState = { prefs: null, armed: false, journal: [], suggestion: null };

export function WatchdogCard() {
  const { t } = useTranslation("optimize");
  const [state, setState] = useState<OptimizeWatchdogState>(EMPTY);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void nr.optimizeWatchdog().then(setState).catch(() => {});
    return nr.onOptimizeWatchdog(setState);
  }, []);

  const prefs = state.prefs;
  const suggestion = state.suggestion;
  const last = state.journal[0];

  const stopSuggested = async () => {
    if (!suggestion) return;
    setBusy(true);
    try {
      await nr.optimizeKillNoise(suggestion.procs.map((p) => p.pid));
      setState(await nr.optimizeDismissWatchdog());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="block p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <ShieldCheck className="h-4 w-4 text-primary" /> {t("watchdog.title")}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {state.armed
              ? t("watchdog.armed", { source: t(`watchdog.source.${state.source || "export"}`) })
              : t("watchdog.idle")}
          </p>
        </div>
        <Toggle
          pressed={!!prefs?.enabled}
          onPressedChange={(on) => void nr.optimizeSetWatchdog({ enabled: on }).then(setState)}
          disabled={!prefs}
        >
          {prefs?.enabled ? t("watchdog.on") : t("watchdog.off")}
        </Toggle>
      </div>

      {state.armed && state.pressure && (
        <p className="mt-2 text-xs tabular-nums text-muted-foreground">
          {t("watchdog.gauges", {
            ram: state.pressure.ramPct ?? "—",
            vram: state.pressure.vramPct ?? "—",
          })}
        </p>
      )}

      {last && (
        <p className="mt-2 text-xs text-[var(--color-ok)]">
          {t("watchdog.lastPurge", { freed: fmtBytes(last.freed), count: last.trimmed })}
        </p>
      )}

      {suggestion && suggestion.procs.length > 0 && (
        <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs font-medium">{t("watchdog.suggestTitle")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("watchdog.suggestBody")}</p>
          <ul className="mt-2 space-y-0.5 text-xs">
            {suggestion.procs.map((p) => (
              <li key={p.pid} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{p.name}</span>
                <span className="tabular-nums text-muted-foreground">{fmtBytes(p.ram)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button variant="destructive" size="sm" onClick={stopSuggested} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Skull className="h-4 w-4" />}
              {t("watchdog.stopThem", { count: suggestion.procs.length })}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void nr.optimizeDismissWatchdog().then(setState)}
              disabled={busy}
            >
              <X className="h-4 w-4" />
              {t("watchdog.ignore")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
