// Réglages Resolve : les VRAIES valeurs lues sur disque, pas des conseils génériques.
// L'API de scripting n'expose aucune préférence d'application — elles vivent dans `.config.data` et
// `config.user.xml`, que Resolve relit au démarrage et réécrit en sortant. Une écriture n'a donc de
// sens que fenêtre fermée → les modifications sont MISES EN ATTENTE ici et parties en un seul lot :
// sauvegarde du projet, backup de la config, fermeture, écriture, réouverture. Un seul redémarrage,
// quel que soit le nombre de réglages touchés.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal, Loader2, RotateCcw, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Toggle } from "@/components/ui/toggle";
import { Slider } from "@/components/ui/slider";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
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
import type { OptimizeDiagnosis, OptimizePref, OptimizePrefBackup } from "@/lib/bridge";
import { useApp } from "@/store";

type Val = boolean | number | string;

function PrefRow({
  pref,
  staged,
  onStage,
}: {
  pref: OptimizePref;
  staged: Val | undefined;
  onStage: (id: string, v: Val | undefined) => void;
}) {
  const { t } = useTranslation("optimize");
  const current = staged ?? pref.value;
  const dirty = staged !== undefined && staged !== pref.value;
  const label = t(`prefs.items.${pref.id}.label`);
  const where = t(`prefs.items.${pref.id}.where`);
  const body = t(`prefs.items.${pref.id}.body`);

  // Repasser à la valeur d'origine retire le changement de la file plutôt que d'y poser un no-op.
  const stage = (v: Val) => onStage(pref.id, v === pref.value ? undefined : v);

  return (
    <div className={`rounded-md border p-3 ${dirty ? "border-primary/50 bg-primary/5" : "border-border"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{label}</span>
            {pref.warn && !dirty && (
              <Badge className="bg-amber-500/15 text-amber-500">{t("prefs.warn")}</Badge>
            )}
            {pref.advisory && !dirty && (
              <Badge variant="secondary">{t("prefs.advisory")}</Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{where}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {pref.kind === "bool" && (
            <Toggle pressed={!!current} onPressedChange={(v) => stage(v)} size="sm">
              {current ? t("prefs.on") : t("prefs.off")}
            </Toggle>
          )}
          {pref.kind === "percent" && (
            <div className="flex w-40 items-center gap-2">
              <Slider
                value={[Number(current)]}
                min={pref.min ?? 0}
                max={pref.max ?? 100}
                step={1}
                onValueChange={(v) => stage(Array.isArray(v) ? v[0] : Number(v))}
              />
              <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{Number(current)}%</span>
            </div>
          )}
          {pref.kind === "enum" && pref.options && (
            <Select value={String(current)} onValueChange={(v) => stage(String(v))}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pref.options.map((o) => (
                  <SelectItem key={o} value={o}>
                    {o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{body}</p>
      {pref.warn && pref.recommended != null && (
        <p className="mt-1 text-xs text-amber-500">
          {t("prefs.recommended", {
            value:
              pref.kind === "bool"
                ? pref.recommended
                  ? t("prefs.on")
                  : t("prefs.off")
                : String(pref.recommended),
          })}
        </p>
      )}
    </div>
  );
}

export function PrefsSection({ diag, onChanged }: { diag: OptimizeDiagnosis | null; onChanged: () => void }) {
  const { t } = useTranslation(["optimize", "common"]);
  const [prefs, setPrefs] = useState<OptimizePref[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<Record<string, Val>>({});
  const [backups, setBackups] = useState<OptimizePrefBackup[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const powerProgress = useApp((s) => s.powerProgress);

  const load = useCallback(async () => {
    try {
      const r = await nr.optimizePrefs();
      setPrefs(r.prefs || []);
      setError(r.ok ? null : r.error || null);
      const b = await nr.optimizePrefsBackups();
      setBackups(b.backups || []);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stage = (id: string, v: Val | undefined) =>
    setStaged((s) => {
      const next = { ...s };
      if (v === undefined) delete next[id];
      else next[id] = v;
      return next;
    });

  const pending = Object.keys(staged).length;

  const apply = async () => {
    setBusy(true);
    setNotice(null);
    setConfirm(false);
    try {
      const r = await nr.optimizeApplyPrefs(staged);
      if (!r.ok) {
        setNotice(r.error || t("notice.failed"));
      } else {
        setStaged({});
        setNotice(
          r.restarted
            ? t("prefs.applyDone", { count: r.applied ?? 0 })
            : t("prefs.applyNoRestart", { error: r.reopenError || "—" }),
        );
      }
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
      await load();
      onChanged();
    }
  };

  const restore = async (name: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await nr.optimizeRestorePrefs(name);
      setNotice(r.ok ? t("prefs.restoreDone") : r.error || t("notice.failed"));
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  // Les préférences sont sur disque : elles se lisent même Resolve fermé. On n'affiche donc la carte
  // que si on a vraiment quelque chose à dire.
  if (!prefs.length && !error) return null;

  return (
    <Card className="block p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <SlidersHorizontal className="h-4 w-4 text-primary" /> {t("prefs.title")}
          </h3>
          <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">{t("prefs.subtitle")}</p>
        </div>
        {pending > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("prefs.pending", { count: pending })}</span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStaged({})}>
              {t("prefs.reset")}
            </Button>
            <Button variant="default" size="sm" disabled={busy} onClick={() => setConfirm(true)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("prefs.apply")}
            </Button>
          </div>
        )}
      </div>

      {error && (
        <p className="mt-3 flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {t("prefs.unavailable", { error })}
        </p>
      )}

      <div className="mt-3 space-y-2">
        {prefs.map((p) => (
          <PrefRow key={p.id} pref={p} staged={staged[p.id]} onStage={stage} />
        ))}
      </div>

      {busy && powerProgress && (
        <div className="mt-3 space-y-1">
          <p className="text-xs text-muted-foreground">{powerProgress.msg}</p>
          <Progress value={powerProgress.pct ?? 0} />
        </div>
      )}

      {notice && <p className="mt-3 text-xs text-[var(--color-ok)]">{notice}</p>}

      {backups.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">{t("prefs.backups")}</span>
            <span className="text-xs text-muted-foreground">{t("prefs.backupsHint")}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {backups.slice(0, 5).map((b) => (
              <Tooltip key={b.name}>
                <TooltipTrigger render={
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => restore(b.name)}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    {new Date(b.at).toLocaleString()}
                  </Button>
                } />
                <TooltipContent>{t("prefs.restore")} · {b.files.join(", ")}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
      )}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("prefs.applyTitle", { count: pending })}</DialogTitle>
            <DialogDescription>
              {t("prefs.applyBody", { project: diag?.project || "—" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
              {t("common:action.cancel")}
            </Button>
            <Button variant="default" size="sm" onClick={apply}>
              {t("prefs.apply")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
