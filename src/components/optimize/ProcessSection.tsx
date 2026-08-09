// Gestionnaire de ressources SYSTÈME : liste les processus du PC les plus gourmands (RAM + VRAM, tous
// programmes confondus — Chrome, Discord, jeux…) et permet d'en TUER un pour rendre la ressource à
// Resolve. Garde-fous : process critiques (Windows/Resolve/core) non tuables, confirmation avant kill
// (équivalent « Fin de tâche » → peut perdre le travail non sauvé de l'app visée).
import { useState } from "react";
import { ListTree, RefreshCw, Loader2, Skull, Eraser } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { nr } from "@/lib/bridge";
import type { OptimizeProc, OptimizeDeadProc } from "@/lib/bridge";
import { fmtBytes } from "./optimizeShared";
import { useTranslation } from "react-i18next";

const vram = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} Go` : `${mb} Mo`);

export function ProcessSection() {
  const { t } = useTranslation("optimize");
  const [procs, setProcs] = useState<OptimizeProc[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [target, setTarget] = useState<OptimizeProc | null>(null);
  const [killing, setKilling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dead, setDead] = useState<OptimizeDeadProc[] | null>(null);
  const [deadBusy, setDeadBusy] = useState(false);

  const scan = async () => {
    setScanning(true);
    setNotice(null);
    try {
      const r = await nr.optimizeListProcesses();
      if (r.ok) setProcs(r.procs);
      else setNotice(r.error || t("notice.failed"));
      setScanned(true);
    } catch (e) {
      setNotice(String(e));
    } finally {
      setScanning(false);
    }
  };

  const kill = async () => {
    if (!target) return;
    setKilling(true);
    try {
      const r = await nr.optimizeKillProcess(target.pid);
      setNotice(r.ok ? t("process.killed", { name: target.name, pid: target.pid }) : r.error || t("notice.failed"));
    } catch (e) {
      setNotice(String(e));
    } finally {
      setKilling(false);
      setTarget(null);
      void scan();
    }
  };

  // Scanne les processus figés (« Ne répond pas »). Si des non-critiques existent → ouvre la confirm.
  const scanDead = async () => {
    setDeadBusy(true);
    setNotice(null);
    try {
      const r = await nr.optimizeDeadProcesses();
      const killable = (r.procs || []).filter((p) => !p.critical);
      if (!r.ok) setNotice(r.error || t("notice.failed"));
      else if (!killable.length) setNotice(t("process.noneBlocked"));
      else setDead(killable);
    } catch (e) {
      setNotice(String(e));
    } finally {
      setDeadBusy(false);
    }
  };

  const cleanDead = async () => {
    setDeadBusy(true);
    try {
      const r = await nr.optimizeCleanDead();
      setNotice(r.ok ? t("process.cleaned", { count: r.killed || 0 }) : r.error || t("notice.failed"));
    } catch (e) {
      setNotice(String(e));
    } finally {
      setDeadBusy(false);
      setDead(null);
      if (scanned) void scan();
    }
  };

  return (
    <Card className="block p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <ListTree className="h-4 w-4 text-primary" /> {t("process.title")}
          </h3>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={scanDead} disabled={deadBusy}>
            {deadBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eraser className="h-4 w-4" />}
            {t("process.cleanBlocked")}
          </Button>
          <Button variant="outline" size="sm" onClick={scan} disabled={scanning}>
            {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("process.scan")}
          </Button>
        </div>
      </div>

      {procs.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-md border border-border">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
            <span>{t("process.colProcess")}</span>
            <span className="text-right">VRAM</span>
            <span className="text-right">RAM</span>
            <span className="text-right">{t("process.colAction")}</span>
          </div>
          <ul className="divide-y divide-border">
            {procs.map((p) => (
              <li
                key={p.pid}
                className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 px-3 py-1.5 text-xs"
              >
                <Tooltip>
                  <TooltipTrigger render={
                    <span className="min-w-0 truncate">
                      {p.name}
                      {p.critical && <span className="ml-1.5 text-[10px] text-muted-foreground">{t("process.protected")}</span>}
                    </span>
                  } />
                  <TooltipContent>PID {p.pid}</TooltipContent>
                </Tooltip>
                <span className="text-right tabular-nums text-muted-foreground">
                  {p.vramMB > 0 ? vram(p.vramMB) : "—"}
                </span>
                <span className="text-right tabular-nums text-muted-foreground">
                  {p.ram > 0 ? fmtBytes(p.ram) : "—"}
                </span>
                <span className="text-right">
                  <Tooltip>
                    <TooltipTrigger render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={p.critical}
                        onClick={() => setTarget(p)}
                      />
                    }>
                      <Skull className="h-4 w-4" />
                    </TooltipTrigger>
                    <TooltipContent>{p.critical ? t("process.protectedTip") : t("process.kill")}</TooltipContent>
                  </Tooltip>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {scanned && !procs.length && !scanning && (
        <p className="mt-3 text-xs text-muted-foreground">{t("process.noneListed")}</p>
      )}

      {notice && <p className="mt-3 text-xs text-[var(--color-ok)]">{notice}</p>}

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("process.killTitle", { name: target?.name })}</DialogTitle>
            <DialogDescription>
              PID {target?.pid} · {target && target.vramMB > 0 ? `${vram(target.vramMB)} VRAM · ` : ""}
              {target && target.ram > 0 ? `${fmtBytes(target.ram)} RAM` : ""}. {t("process.killForced")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setTarget(null)} disabled={killing}>
              {t("common:action.cancel")}
            </Button>
            <Button variant="destructive" size="sm" onClick={kill} disabled={killing}>
              {killing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Skull className="h-4 w-4" />}
              {t("process.kill")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!dead} onOpenChange={(o) => !o && setDead(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("process.cleanTitle", { count: dead?.length })}</DialogTitle>
            <DialogDescription>
              {t("process.cleanBody")}
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-xs">
            {(dead || []).map((p) => (
              <li key={p.pid} className="truncate py-0.5">
                {p.name} <span className="text-muted-foreground">· PID {p.pid}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDead(null)} disabled={deadBusy}>
              {t("common:action.cancel")}
            </Button>
            <Button variant="destructive" size="sm" onClick={cleanDead} disabled={deadBusy}>
              {deadBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eraser className="h-4 w-4" />}
              {t("process.clean")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
