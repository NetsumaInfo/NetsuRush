// Point de restauration : exporte le projet courant en .drp (ExportProject) → un crash Resolve devient
// indolore (ré-importe le .drp). Liste les snapshots existants + ouvre leur dossier. Le .drp ne
// contient QUE le montage (pas les médias) → léger.
import { useCallback, useEffect, useState } from "react";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import type { OptimizeDiagnosis, OptimizeSnapshot } from "@/lib/bridge";
import { fmtBytes } from "./optimizeShared";
import { useTranslation } from "react-i18next";
import { errorText } from "@/lib/errorText";

export function SnapshotSection({ diag }: { diag: OptimizeDiagnosis | null }) {
  const { t } = useTranslation("optimize");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [list, setList] = useState<OptimizeSnapshot[]>([]);
  const [dir, setDir] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const r = await nr.optimizeListSnapshots();
      setList(r.snapshots || []);
      setDir(r.dir || "");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const snapshot = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await nr.optimizeSnapshot();
      setNotice(r.ok ? t("snapshot.created", { size: fmtBytes(r.size) }) : r.error || t("notice.failed"));
      if (r.ok) void refresh();
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const connected = !!diag?.connected;

  return (
    <Card className="block p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t("snapshot.title")}</h3>
        </div>
        <div className="flex gap-2">
          {dir && (
            <Button variant="ghost" size="sm" onClick={() => nr.openPath(dir)} disabled={!list.length}>
              <NetsuIcon name="folder-open" className="size-4" /> {t("snapshot.folder")}
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={!connected || !diag?.project || busy} onClick={snapshot}>
            {busy ? <NetsuIcon name="loading" busy className="size-4" /> : <NetsuIcon name="save" className="size-4" />}
            {t("snapshot.create")}
          </Button>
        </div>
      </div>

      {list.length > 0 && (
        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {list.slice(0, 6).map((s) => (
            <li key={s.path} className="flex items-center gap-2 px-3 py-2 text-xs">
              <NetsuIcon name="history" className="size-3.5 shrink-0 text-muted-foreground" />
              <Tooltip>
                <TooltipTrigger render={
                  <span className="min-w-0 flex-1 truncate">
                    {s.name}
                  </span>
                } />
                <TooltipContent>{s.path}</TooltipContent>
              </Tooltip>
              <span className="shrink-0 tabular-nums text-muted-foreground">{fmtBytes(s.size)}</span>
            </li>
          ))}
        </ul>
      )}

      {notice && <p className="mt-3 text-xs text-[var(--color-ok)]">{notice}</p>}
    </Card>
  );
}
