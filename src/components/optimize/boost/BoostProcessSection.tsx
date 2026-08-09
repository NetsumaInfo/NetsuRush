// Processus Adobe résiduels. Premiere et After Effects laissent des auxiliaires vivants après leur
// fermeture (dynamiclinkmanager, QT32 Server, moteurs CEP, services Creative Cloud) : chacun est
// petit, mais leur somme tient plusieurs Go pour rien.
//
// Le core interroge Windows PAR NOM plutôt que de lire le top 30 de `optimize:listProcesses` :
// justement parce que ces auxiliaires sont trop petits pour y figurer. La MISE À MORT, elle, repasse
// par `optimize:killProcess` — un seul chemin destructif dans l'application, avec ses garde-fous.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Loader2, Skull } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import type { BoostProc } from "@/lib/bridge";
import { fmtBytes } from "../optimizeShared";

export function BoostProcessSection({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation(["optimize", "common"]);
  const [procs, setProcs] = useState<BoostProc[]>([]);
  const [total, setTotal] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<BoostProc | null>(null);
  const [killing, setKilling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const r = await nr.boostProcs();
      setProcs(r.procs || []);
      setTotal(r.total || 0);
      if (!r.ok) setError(r.error || t("notice.failed"));
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, [t]);

  useEffect(() => {
    void scan();
  }, [scan]);

  async function kill() {
    if (!target) return;
    setKilling(true);
    try {
      const r = await nr.optimizeKillProcess(target.pid);
      setNotice(r.ok ? t("boost.procs.killed", { name: target.name }) : r.error || t("notice.failed"));
    } catch (e) {
      setNotice(String(e));
    } finally {
      setKilling(false);
      setTarget(null);
      await scan();
      onChanged();
    }
  }

  return (
    <Card className="block p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t("boost.procs.title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {procs.length ? t("boost.procs.summary", { count: procs.length, size: fmtBytes(total) }) : t("boost.procs.subtitle")}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={scan} disabled={scanning}>
          {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t("boost.procs.scan")}
        </Button>
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      {procs.length > 0 && (
        <div className="mt-3 rounded-md border border-border">
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-border px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span>{t("boost.procs.colProcess")}</span>
            <span className="text-right">RAM</span>
            <span className="text-right">{t("boost.procs.colAction")}</span>
          </div>
          <ul className="divide-y divide-border">
            {procs.map((p) => (
              <li key={p.pid} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 px-3 py-1.5 text-xs">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="min-w-0 truncate">
                        {p.name}
                        {p.critical && (
                          <span className="ml-1.5 text-[10px] text-muted-foreground">{t("boost.procs.protected")}</span>
                        )}
                      </span>
                    }
                  />
                  <TooltipContent>PID {p.pid}</TooltipContent>
                </Tooltip>
                <span className="text-right tabular-nums text-muted-foreground">{p.ram > 0 ? fmtBytes(p.ram) : "—"}</span>
                <span className="text-right">
                  <Tooltip>
                    <TooltipTrigger
                      render={<Button variant="ghost" size="icon-sm" disabled={p.critical} onClick={() => setTarget(p)} />}
                    >
                      <Skull className="h-4 w-4" />
                    </TooltipTrigger>
                    {/* L'hôte VIVANT n'est pas un résidu : le tuer perdrait le montage en cours. */}
                    <TooltipContent>{p.critical ? t("boost.procs.protectedTip") : t("boost.procs.kill")}</TooltipContent>
                  </Tooltip>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!scanning && !procs.length && !error && <p className="mt-3 text-xs text-muted-foreground">{t("boost.procs.none")}</p>}

      {notice && <p className="mt-3 text-xs text-[var(--color-ok)]">{notice}</p>}

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("boost.procs.killTitle", { name: target?.name })}</DialogTitle>
            <DialogDescription>
              PID {target?.pid}
              {target && target.ram > 0 ? ` · ${fmtBytes(target.ram)} RAM` : ""}. {t("boost.procs.killForced")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setTarget(null)} disabled={killing}>
              {t("common:action.cancel")}
            </Button>
            <Button variant="destructive" size="sm" onClick={kill} disabled={killing}>
              {killing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Skull className="h-4 w-4" />}
              {t("boost.procs.kill")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
