// Caches disque de Premiere Pro / After Effects : peser, filtrer par ancienneté, purger.
//
// Voie DISQUE : elle exige l'application FERMÉE — vider un media cache pendant qu'Adobe y écrit
// corrompt sa base. Le core refuse net (`APP_RUNNING`) tant que l'app tourne ; plutôt que d'attendre
// ce refus, l'UI propose directement la séquence « fermer → purger → rouvrir » (via hostPower, qui
// rouvre le projet) et l'énonce dans la confirmation.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Loader2, CheckSquare, Square, AlertTriangle, Power } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
import type { AdobeApp, BoostCacheRoot, BoostDiagnosis } from "@/lib/bridge";
import { useApp } from "@/store";
import { fmtBytes } from "../optimizeShared";
import { AGE_FILTERS, cacheIcon, isSlowToRebuild, rootLabelKey, sortRoots, type AgeFilter } from "./boostShared";

interface RootRowProps {
  root: BoostCacheRoot;
  checked: boolean;
  onToggle: (dir: string) => void;
}

function RootRow({ root, checked, onToggle }: RootRowProps) {
  const { t } = useTranslation("optimize");
  const Icon = cacheIcon(root.kind);
  return (
    <li>
      <button
        type="button"
        onClick={() => onToggle(root.dir)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted/50"
      >
        {checked ? (
          <CheckSquare className="h-4 w-4 shrink-0 text-primary" />
        ) : (
          <Square className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium">{t(rootLabelKey(root.id, root.kind))}</span>
            {root.shared && <Badge variant="secondary">{t("boost.cache.shared")}</Badge>}
            {!root.regenerable && (
              <Badge className="bg-amber-500/15 text-amber-500">{t("boost.cache.notRegenerable")}</Badge>
            )}
            {isSlowToRebuild(root.kind) && (
              <Badge className="bg-amber-500/15 text-amber-500">{t("boost.cache.slowRebuild")}</Badge>
            )}
          </span>
          <Tooltip>
            <TooltipTrigger render={<span className="block truncate text-xs text-muted-foreground">{root.dir}</span>} />
            <TooltipContent>{root.dir}</TooltipContent>
          </Tooltip>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtBytes(root.size ?? 0)}</span>
      </button>
    </li>
  );
}

export function BoostCacheSection({
  diag,
  app,
  onChanged,
}: {
  diag: BoostDiagnosis | null;
  app: AdobeApp;
  onChanged: () => void;
}) {
  const { t } = useTranslation(["optimize", "common"]);
  const boostProgress = useApp((s) => s.boostProgress);
  const powerProgress = useApp((s) => s.powerProgress);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [age, setAge] = useState<AgeFilter>(0);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const roots = useMemo(() => sortRoots(diag?.cacheRoots || []), [diag?.cacheRoots]);
  const selRoots = useMemo(() => roots.filter((r) => sel.has(r.dir)), [roots, sel]);
  const selTotal = selRoots.reduce((a, r) => a + (r.size || 0), 0);

  // Une tranche d'ancienneté ne libère PAS le poids total : il faut demander au core ce que la tranche
  // pèse réellement, racine par racine. On ne le fait que sur la sélection (1 à 3 dossiers en général)
  // et seulement quand un filtre est actif — sinon la somme déjà mesurée suffit.
  useEffect(() => {
    if (!age || !selRoots.length) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    setEstimating(true);
    Promise.all(selRoots.map((r) => nr.boostScanCache(app, r.dir)))
      .then((scans) => {
        if (cancelled) return;
        const bytes = scans.reduce((sum, s) => {
          const bucket = (s.buckets || []).find((b) => b.days === age);
          return sum + (bucket ? bucket.size : 0);
        }, 0);
        setEstimate(bytes);
      })
      .catch(() => {
        // Estimation indisponible : la purge reste possible, on n'affiche simplement pas de prévision.
        if (!cancelled) setEstimate(null);
      })
      .finally(() => {
        if (!cancelled) setEstimating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [app, age, selRoots]);

  const toggle = useCallback((dir: string) => {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(dir)) n.delete(dir);
      else n.add(dir);
      return n;
    });
  }, []);

  const running = !!diag?.running;
  const freeable = age ? estimate : selTotal;

  async function confirmClean() {
    setCleaning(true);
    setFailed(false);
    try {
      const targets = selRoots.map((r) => ({ dir: r.dir, minAgeDays: age || undefined }));
      const res = await nr.boostCleanCache(app, targets, { restart: running });
      if (res.ok) {
        const base = t("boost.cache.freed", { size: fmtBytes(res.freed || 0), count: (res.removed || []).length });
        // Une réouverture ratée n'annule pas la purge : les deux faits doivent être dits.
        setNotice(res.reopenError ? `${base} — ${t("boost.cache.reopenFailed", { error: res.reopenError })}` : base);
      } else {
        setFailed(true);
        setNotice(t("boost.cache.cleanFailed", { error: res.error || "?" }));
      }
    } catch (e) {
      setFailed(true);
      setNotice(t("boost.cache.cleanFailed", { error: String(e) }));
    } finally {
      setCleaning(false);
      setConfirmOpen(false);
      setSel(new Set());
      onChanged();
    }
  }

  const progress = boostProgress ?? powerProgress;

  return (
    <Card className="block p-4">
      <h3 className="text-sm font-semibold">{t("boost.cache.title")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("boost.cache.subtitle")}</p>

      {!roots.length ? (
        <p className="mt-3 text-xs text-muted-foreground">{t("boost.cache.noneFound")}</p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("boost.cache.ageFilter")}</span>
            <ToggleGroup
              value={[String(age)]}
              onValueChange={(v) => {
                const n = v[0];
                if (n !== undefined) setAge(Number(n) as AgeFilter);
              }}
              spacing={0}
              variant="outline"
              size="sm"
            >
              {AGE_FILTERS.map((d) => (
                <ToggleGroupItem
                  key={d}
                  value={String(d)}
                  className="px-2.5 aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary"
                >
                  {d === 0 ? t("boost.cache.ageAll") : t("boost.cache.ageDays", { days: d })}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <ul className="mt-3 divide-y divide-border rounded-md border border-border">
            {roots.map((r) => (
              <RootRow key={r.dir} root={r} checked={sel.has(r.dir)} onToggle={toggle} />
            ))}
          </ul>

          {selRoots.some((r) => isSlowToRebuild(r.kind)) && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-500">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t("boost.cache.dbWarning")}
            </p>
          )}
          {selRoots.some((r) => !r.regenerable) && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-500">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t("boost.cache.autoSaveWarning")}
            </p>
          )}

          <Button
            variant="destructive"
            size="sm"
            className="mt-3"
            disabled={!selRoots.length || estimating}
            onClick={() => setConfirmOpen(true)}
          >
            {estimating ? <Loader2 className="h-4 w-4 animate-spin" /> : running ? <Power className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
            {running
              ? t("boost.cache.closePurgeReopen")
              : t("boost.cache.cleanSelection", { size: fmtBytes(freeable ?? 0) })}
          </Button>
          {running && <p className="mt-1.5 text-xs text-muted-foreground">{t("boost.cache.runningHint")}</p>}
        </>
      )}

      {cleaning && progress && (
        <div className="mt-3">
          <div className="mb-1 text-xs text-muted-foreground">{progress.msg}</div>
          <Progress value={progress.pct} />
        </div>
      )}

      {notice && <p className={`mt-3 text-xs ${failed ? "text-destructive" : "text-[var(--color-ok)]"}`}>{notice}</p>}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{running ? t("boost.cache.confirmRestartTitle") : t("boost.cache.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {running
                ? t("boost.cache.confirmRestartBody", { size: fmtBytes(freeable ?? 0) })
                : t("boost.cache.confirmBody", { size: fmtBytes(freeable ?? 0) })}
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-xs">
            {selRoots.map((r) => (
              <li key={r.dir}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="block truncate py-0.5">
                        {r.dir} — {fmtBytes(r.size ?? 0)}
                      </span>
                    }
                  />
                  <TooltipContent>{r.dir}</TooltipContent>
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
