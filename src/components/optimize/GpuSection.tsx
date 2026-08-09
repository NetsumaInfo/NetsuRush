// Moniteur live VRAM/CPU/RAM (pré-crash) + actions « Libérer le GPU » / « Libérer le CPU ». Poll
// toutes les 2,5 s : VRAM (nvidia-smi), CPU% (delta os.cpus), RAM système, RAM de Resolve.exe. Barre
// ROUGE + alerte quand ça sature → agir AVANT le « GPU memory full » qui crashe Resolve. Les deux
// boutons arrêtent les tâches lourdes de NetsuRush (encodes NVENC + daemons IA) : ces process chargent
// GPU ET CPU/RAM → chaque bouton les tue réellement, la jauge associée chute en preuve.
import { useEffect, useRef, useState } from "react";
import { Cpu, Loader2, Activity, MemoryStick, Microchip } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { nr } from "@/lib/bridge";
import type { OptimizeResources } from "@/lib/bridge";
import { fmtBytes } from "./optimizeShared";
import { useTranslation } from "react-i18next";

const go = (mb: number) => (mb / 1024).toFixed(1);

function Gauge({ label, pct, detail, danger }: { label: string; pct: number; detail: string; danger: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{detail}</span>
      </div>
      <div className="mt-1">
        <Progress value={pct} className={danger ? "[&_[data-slot=progress-indicator]]:bg-destructive" : ""} />
      </div>
    </div>
  );
}

export function GpuSection() {
  const { t } = useTranslation("optimize");
  const [res, setRes] = useState<OptimizeResources | null>(null);
  const [busy, setBusy] = useState<"gpu" | "cpu" | "ram" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inflight = useRef(false);

  // Poll des ressources tant que le composant est monté. Garde anti-chevauchement (inflight).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (inflight.current) return;
      inflight.current = true;
      try {
        const r = await nr.optimizeResources();
        if (alive) setRes(r);
      } catch {
        /* ignore */
      } finally {
        inflight.current = false;
      }
    };
    void tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const gpu = res?.gpu ?? null;
  const ram = res?.ram ?? null;
  const cpu = res?.cpu ?? null;
  const vramPct = gpu && gpu.totalMB ? Math.round((gpu.usedMB / gpu.totalMB) * 100) : null;
  const ramPct = ram && ram.total ? Math.round(((ram.total - ram.free) / ram.total) * 100) : null;
  const vramDanger = vramPct !== null && vramPct > 90;
  const ramDanger = ramPct !== null && ramPct > 90;
  const cpuDanger = cpu !== null && cpu > 90;
  const alert = vramDanger || ramDanger;

  const free = async (kind: "gpu" | "cpu" | "ram") => {
    setBusy(kind);
    setNotice(null);
    try {
      const r =
        kind === "gpu" ? await nr.optimizeFreeGpu() : kind === "cpu" ? await nr.optimizeFreeCpu() : await nr.optimizeFreeRam();
      if (!r.ok) {
        setNotice(r.error || t("notice.failed"));
      } else {
        const dead = r.deadKilled ? t("gpu.deadKilledSuffix", { count: r.deadKilled }) : "";
        let main = t("gpu.nothingToFree");
        if (kind === "ram" && "ramFreed" in r && (r.ramFreed || 0) > 0) main = t("gpu.ramFreed", { mb: Math.round((r.ramFreed || 0) / 1048576) });
        else if (kind === "gpu" && "vramFreedMB" in r && (r.vramFreedMB || 0) > 0) main = t("gpu.vramFreed", { mb: r.vramFreedMB });
        else if (r.deadKilled) main = t("gpu.residuesCleaned");
        setNotice(main + dead);
      }
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="block p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Activity className="h-4 w-4 text-primary" /> {t("gpu.title")}
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("gpu.free")}</span>
          <Button variant="outline" size="sm" disabled={!!busy} onClick={() => free("gpu")}>
            {busy === "gpu" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Microchip className="h-4 w-4" />}
            GPU
          </Button>
          <Button variant="outline" size="sm" disabled={!!busy} onClick={() => free("cpu")}>
            {busy === "cpu" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cpu className="h-4 w-4" />}
            CPU
          </Button>
          <Button variant="outline" size="sm" disabled={!!busy} onClick={() => free("ram")}>
            {busy === "ram" ? <Loader2 className="h-4 w-4 animate-spin" /> : <MemoryStick className="h-4 w-4" />}
            RAM
          </Button>
        </div>
      </div>

      {alert && (
        <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t("gpu.saturated", { what: vramDanger ? "VRAM" : "RAM" })}
        </p>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {gpu ? (
          <Gauge
            label="VRAM"
            pct={vramPct ?? 0}
            detail={`${go(gpu.usedMB)} / ${go(gpu.totalMB)} Go`}
            danger={vramDanger}
          />
        ) : (
          <div className="text-xs text-muted-foreground">{t("gpu.vramUnreadable")}</div>
        )}
        <Gauge label="CPU" pct={cpu ?? 0} detail={cpu !== null ? `${cpu}%` : "—"} danger={cpuDanger} />
        {ram && ram.total > 0 && (
          <Gauge
            label={t("gpu.ramSystem")}
            pct={ramPct ?? 0}
            detail={`${fmtBytes(ram.total - ram.free)} / ${fmtBytes(ram.total)}`}
            danger={ramDanger}
          />
        )}
      </div>

      {res?.resolveRam != null && (
        <p className="mt-2 text-xs text-muted-foreground">{t("gpu.resolveRam", { size: fmtBytes(res.resolveRam) })}</p>
      )}

      {notice && <p className="mt-3 text-xs text-[var(--color-ok)]">{notice}</p>}
    </Card>
  );
}
