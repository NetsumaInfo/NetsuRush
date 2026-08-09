// « Plus je l'utilise longtemps, plus c'est lent » : la VRAM de Resolve est un high-water mark et le
// cache Fusion comme la pile d'undo s'empilent sans jamais se vider en cours de session. Cette carte
// mesure ce que Resolve a pris depuis son ouverture (core/optimize.js, lecture seule) et propose les
// deux seuls correctifs, du plus léger au plus fort :
//   • Recharger le projet  → rend la RAM des timelines empilées, Resolve reste ouvert (~5 s)
//   • Redémarrer Resolve   → rend AUSSI la VRAM et le cache Fusion, qu'aucune API ne purge (~1-2 min)
// Diagnostic et remède dans la même carte : le verdict dit lequel vaut le coup.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MemoryStick, Power, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { nr } from "@/lib/bridge";
import type { OptimizeDiagnosis, OptimizeSessionHealth } from "@/lib/bridge";
import { useApp } from "@/store";
import { fmtBytes } from "./optimizeShared";

type Action = "reload" | "restart";

const fmtDur = (ms: number) => {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
};

export function MemorySection({ diag, onChanged }: { diag: OptimizeDiagnosis | null; onChanged: () => void }) {
  const { t } = useTranslation(["optimize", "common"]);
  const [health, setHealth] = useState<OptimizeSessionHealth | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const restartHost = useApp((s) => s.restartHost);
  const powerProgress = useApp((s) => s.powerProgress);

  // Le core échantillonne toutes les 60 s → un poll à 30 s suffit à ne jamais afficher de valeur périmée.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await nr.optimizeSessionHealth();
        if (alive) setHealth(h);
      } catch {
        /* le moniteur GPU signale déjà l'indisponibilité */
      }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const run = async (a: Action) => {
    setBusy(a);
    setNotice(null);
    setConfirm(null);
    try {
      if (a === "reload") {
        const r = await nr.optimizeReloadProject();
        setNotice(r.ok ? t("memory.reloadDone", { project: r.project }) : r.error || t("notice.failed"));
      } else {
        const r = await restartHost("resolve");
        setNotice(r.ok ? t("memory.restartDone", { project: r.project ?? diag?.project }) : r.error || t("notice.failed"));
      }
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(null);
      onChanged();
      try {
        setHealth(await nr.optimizeSessionHealth());
      } catch {
        /* la prochaine mesure corrigera */
      }
    }
  };

  const verdict = health?.verdict ?? "ok";
  const measuring = !health?.running || !health.measured || health.measured < 60_000;
  const drift = health?.driftRam ?? 0;
  const vramGo = (mb: number) => (mb / 1024).toFixed(1);
  const resolveReady = !!diag?.connected && !!diag.project;

  return (
    <Card className="block p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <MemoryStick className="h-4 w-4 text-primary" /> {t("memory.title")}
        </h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={!resolveReady || !!busy} onClick={() => setConfirm("reload")}>
            {busy === "reload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MemoryStick className="h-4 w-4" />}
            {t("memory.reload")}
          </Button>
          <Button
            variant={verdict === "high" ? "default" : "outline"}
            size="sm"
            disabled={!resolveReady || !!busy}
            onClick={() => setConfirm("restart")}
          >
            {busy === "restart" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
            {t("memory.restart")}
          </Button>
        </div>
      </div>

      {!diag?.connected ? (
        <p className="mt-3 text-xs text-muted-foreground">{t("diagnostic.offlineHint")}</p>
      ) : measuring ? (
        <p className="mt-3 text-xs text-muted-foreground">{t("memory.measuring")}</p>
      ) : (
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          <p className="tabular-nums">
            {drift > 0
              ? t("memory.drift", {
                  now: fmtBytes(health?.ram),
                  drift: `+${fmtBytes(drift)}`,
                  elapsed: fmtDur(health?.measured ?? 0),
                })
              : t("memory.driftDown", { now: fmtBytes(health?.ram), elapsed: fmtDur(health?.measured ?? 0) })}
          </p>
          {health?.vram != null && health.vramTotal ? (
            <p className="tabular-nums">
              {t("memory.vram", { used: vramGo(health.vram), total: vramGo(health.vramTotal) })}
            </p>
          ) : null}
        </div>
      )}

      {!measuring && verdict !== "ok" && (
        <p
          className={
            verdict === "high"
              ? "mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              : "mt-3 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
          }
        >
          {t(verdict === "high" ? "memory.verdictHigh" : "memory.verdictWatch")}
        </p>
      )}

      {/* Le redémarrage prend une à deux minutes : la progression du core (SSE) évite l'écran mort. */}
      {busy === "restart" && powerProgress && (
        <div className="mt-3 space-y-1">
          <p className="text-xs text-muted-foreground">{powerProgress.msg}</p>
          <Progress value={powerProgress.pct ?? 0} />
        </div>
      )}

      {notice && <p className="mt-3 text-xs text-[var(--color-ok)]">{notice}</p>}

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === "restart" ? t("memory.restartTitle") : t("memory.reloadTitle", { project: diag?.project })}
            </DialogTitle>
            <DialogDescription>
              {confirm === "restart" ? t("memory.restartBody", { project: diag?.project }) : t("memory.reloadBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
              {t("common:action.cancel")}
            </Button>
            <Button variant="default" size="sm" onClick={() => confirm && run(confirm)}>
              {confirm === "restart" ? <Power className="h-4 w-4" /> : <MemoryStick className="h-4 w-4" />}
              {confirm === "restart" ? t("memory.restart") : t("memory.reload")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
