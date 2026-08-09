// « Nettoyer le cache » : scanne un dossier de cache (auto-détecté ou choisi à la main), liste les
// dossiers de cache Resolve connus (render/proxy/gallery) avec leur taille, et supprime ceux cochés
// APRÈS confirmation (dialog montrant chemin + taille). Suppression whitelist-guardée côté serveur.
// En bonus : vidage des caches PROPRES à NetsuRush (proxies/vignettes), sans risque.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, RefreshCw, Trash2, Loader2, HardDrive, CheckSquare, Square } from "lucide-react";
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
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import type { OptimizeCacheScan } from "@/lib/bridge";
import { fmtBytes } from "./optimizeShared";

export function CleanupSection({ cacheRoots }: { cacheRoots: string[] }) {
  const { t } = useTranslation(["optimize", "common"]);
  const [root, setRoot] = useState<string | null>(null);
  const [scan, setScan] = useState<OptimizeCacheScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const autoTried = useRef(false);

  const doScan = useCallback(async (r: string) => {
    setRoot(r);
    setScanning(true);
    setNotice(null);
    setSel(new Set());
    try {
      const res = await nr.optimizeScanCache(r);
      setScan(res);
    } catch (e) {
      setScan({ ok: false, error: String(e), entries: [], disk: null });
    } finally {
      setScanning(false);
    }
  }, []);

  // Auto-scan du premier dossier cache détecté (une seule fois).
  useEffect(() => {
    if (autoTried.current || root || !cacheRoots.length) return;
    autoTried.current = true;
    void doScan(cacheRoots[0]);
  }, [cacheRoots, root, doScan]);

  const pick = async () => {
    const dir = await nr.chooseDir();
    if (dir) void doScan(dir);
  };

  const toggle = (p: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const entries = scan?.entries || [];
  const selEntries = entries.filter((e) => sel.has(e.path));
  const selBytes = selEntries.reduce((a, e) => a + e.size, 0);

  const confirmClean = async () => {
    setCleaning(true);
    try {
      const res = await nr.optimizeCleanCache(selEntries.map((e) => e.path));
      setNotice(res.ok ? t("cleanup.freed", { size: fmtBytes(res.freed), count: res.removed.length }) : t("cleanup.cleanFailed", { error: res.error || "?" }));
    } catch (e) {
      setNotice(t("cleanup.cleanFailed", { error: String(e) }));
    } finally {
      setCleaning(false);
      setConfirmOpen(false);
      if (root) void doScan(root);
    }
  };

  const disk = scan?.disk;
  const diskPct = disk && disk.total ? Math.round((disk.used / disk.total) * 100) : null;

  return (
    <Card className="block p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t("cleanup.title")}</h3>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={pick} disabled={scanning}>
            <FolderOpen className="h-4 w-4" /> {t("cleanup.browse")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => root && doScan(root)}
            disabled={scanning || !root}
          >
            {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("cleanup.rescan")}
          </Button>
        </div>
      </div>

      {root && (
        <Tooltip>
          <TooltipTrigger render={
            <p className="mt-2 truncate text-xs text-muted-foreground">
              {t("cleanup.folder", { path: root })}
            </p>
          } />
          <TooltipContent>{root}</TooltipContent>
        </Tooltip>
      )}

      {disk && diskPct !== null && (
        <div className="mt-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <HardDrive className="h-3.5 w-3.5" />
            {t("cleanup.disk", { free: fmtBytes(disk.free), total: fmtBytes(disk.total) })}
          </div>
          <div className="mt-1">
            <Progress value={diskPct} className={diskPct > 90 ? "[&_[data-slot=progress-indicator]]:bg-destructive" : ""} />
          </div>
          {diskPct > 90 && (
            <p className="mt-1 text-xs text-destructive">{t("cleanup.diskFull")}</p>
          )}
        </div>
      )}

      {!scanning && root && !entries.length && (
        <p className="mt-3 text-xs text-muted-foreground">{t("cleanup.noneFound")}</p>
      )}

      {entries.length > 0 && (
        <>
          <ul className="mt-3 divide-y divide-border rounded-md border border-border">
            {entries.map((e) => {
              const on = sel.has(e.path);
              return (
                <li key={e.path}>
                  <button
                    type="button"
                    onClick={() => toggle(e.path)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted/50"
                  >
                    {on ? (
                      <CheckSquare className="h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <Square className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{e.label}</span>
                      <Tooltip>
                        <TooltipTrigger render={
                          <span className="block truncate text-xs text-muted-foreground">
                            {e.path}
                          </span>
                        } />
                        <TooltipContent>{e.path}</TooltipContent>
                      </Tooltip>
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtBytes(e.size)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <Button
            variant="destructive"
            size="sm"
            className="mt-3"
            disabled={!selEntries.length}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="h-4 w-4" /> {t("cleanup.cleanSelection", { size: fmtBytes(selBytes) })}
          </Button>
        </>
      )}

      {notice && <p className="mt-3 text-xs text-[var(--color-ok)]">{notice}</p>}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cleanup.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("cleanup.confirmBody", { size: fmtBytes(selBytes) })}
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-xs">
            {selEntries.map((e) => (
              <li key={e.path}>
                <Tooltip>
                  <TooltipTrigger render={
                    <span className="block truncate py-0.5">
                      {e.path} — {fmtBytes(e.size)}
                    </span>
                  } />
                  <TooltipContent>{e.path}</TooltipContent>
                </Tooltip>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)} disabled={cleaning}>
              {t("common:action.cancel")}
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmClean} disabled={cleaning}>
              {cleaning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("common:action.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
