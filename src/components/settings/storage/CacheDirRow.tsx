// Dossier du cache (vignettes + aperçus). Au changement, on demande quoi faire de l'existant :
// déplacer évite de tout régénérer, laisser garde l'ancien dossier listé et purgeable.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import { useShallow } from "zustand/react/shallow";
import type { CacheOverview } from "@/lib/bridge";
import { fmtBytes } from "./storageShared";

interface Props {
  overview: CacheOverview;
  onDone: (msg: string) => void;
}

export function CacheDirRow({ overview, onDone }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const { progress, reload } = useApp(useShallow((s) => ({ progress: s.cacheProgress, reload: s.loadCache })));
  const [pending, setPending] = useState<string | null>(null);   // dossier choisi, en attente du choix de migration
  const [busy, setBusy] = useState(false);

  // Poids déjà en place : ce que « déplacer » va transporter, et ce que « laisser » abandonnerait.
  const movable = overview.kinds
    .filter((k) => k.kind === "thumb" || k.kind === "proxy")
    .reduce((s, k) => s + (k.onDisk ?? k.bytes), 0);

  async function choose() {
    const dir = await nr.chooseDir();
    if (!dir) return;
    // Rien à migrer → on applique tout de suite, la question n'aurait pas de sens.
    if (movable <= 0) return apply(dir, "leave");
    setPending(dir);
  }

  async function apply(dir: string | null, migrate: "move" | "leave") {
    if (!nr.cache) return;
    setPending(null);
    setBusy(true);
    try {
      const r = await nr.cache.setDir({ dir, migrate });
      if (!r.ok) return onDone(r.error || t("common:action.error"));
      onDone(r.moved ? t("settings:storage.dir.moved", { count: r.moved }) : t("settings:storage.dir.movedNone"));
      void reload();
    } finally {
      setBusy(false);
    }
  }

  const current = overview.root;
  const moving = busy && progress?.phase === "move";

  return (
    <div className="rounded-lg border border-border p-3">
      <h4 className="text-xs font-medium text-foreground">{t("settings:storage.dir.title")}</h4>
      <p className="mt-1 text-xs text-muted-foreground">{t("settings:storage.dir.desc")}</p>

      <div className="mt-3 flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger render={<code className="min-w-0 flex-1 truncate rounded-md bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground" />}>
            {current || t("settings:storage.dir.default")}
          </TooltipTrigger>
          <TooltipContent className="max-w-96 break-all">
            {current || `${overview.defaults.thumb}\n${overview.defaults.proxy}`}
          </TooltipContent>
        </Tooltip>
        <Button variant="outline" size="sm" onClick={choose} disabled={busy}>
          <FolderOpen className="size-3.5" /> {t("settings:storage.dir.choose")}
        </Button>
        {current && (
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => apply(null, "move")} disabled={busy} />}>
              <RotateCcw className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{t("settings:storage.dir.reset")}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {moving && progress && (
        <div className="mt-3 space-y-1">
          <Progress value={progress.pct} />
          <p className="text-[11px] text-muted-foreground">
            {t("settings:storage.dir.moving", { done: progress.done, total: progress.total })}
          </p>
        </div>
      )}

      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings:storage.dir.moveTitle")}</DialogTitle>
            <DialogDescription>{t("settings:storage.dir.moveDesc", { size: fmtBytes(movable) })}</DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">{t("settings:storage.dir.leaveHint")}</p>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>{t("common:action.cancel")}</Button>
            <Button variant="outline" size="sm" onClick={() => apply(pending, "leave")}>{t("settings:storage.dir.leave")}</Button>
            <Button size="sm" onClick={() => apply(pending, "move")}>{t("settings:storage.dir.moveNow")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
