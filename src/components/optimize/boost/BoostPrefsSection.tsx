// Réglages de performance de l'hôte Adobe, lus et écrits par le panneau CEP.
//
// Différence de fond avec les préférences Resolve : ici les API sont DOCUMENTÉES et vivantes
// (`app.project.gpuAccelType`, `app.setMemoryUsageLimits`, `app.setScratchDiskPath`) — donc pas de
// fermeture d'application, pas de fichier patché, pas de sauvegarde à restaurer.
//
// Deux natures de lignes que Resolve ne connaît pas et que l'UI doit dire :
//   • writeOnly — l'hôte n'expose AUCUN accesseur en lecture (les limites mémoire d'AE). Afficher
//     « 0 » ou un tiret nu se lirait comme un vrai réglage à zéro : on affiche la raison.
//   • volatile — le réglage retombe à la fin du script (Multi-Frame Rendering, documenté par Adobe).
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, SlidersHorizontal, FolderOpen } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Toggle } from "@/components/ui/toggle";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import type { AdobeApp, BoostDiagnosis, BoostPref } from "@/lib/bridge";

type Val = boolean | number | string;

function PrefRow({
  pref,
  staged,
  onStage,
}: {
  pref: BoostPref;
  staged: Val | undefined;
  onStage: (id: string, v: Val | undefined) => void;
}) {
  const { t } = useTranslation("optimize");
  const current = staged ?? pref.value;
  const dirty = staged !== undefined && staged !== pref.value;

  // Repasser à la valeur d'origine retire le changement de la file plutôt que d'y poser un no-op.
  // Une ligne writeOnly n'a pas de valeur d'origine : tout choix y est donc un vrai changement.
  const stage = (v: Val) => onStage(pref.id, !pref.writeOnly && v === pref.value ? undefined : v);

  async function pickFolder() {
    const dir = await nr.chooseDir();
    if (dir) stage(dir);
  }

  return (
    <div className={`rounded-md border p-3 ${dirty ? "border-primary/50 bg-primary/5" : "border-border"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{t(`boost.prefs.items.${pref.id}.label`)}</span>
            {pref.warn && !dirty && <Badge className="bg-amber-500/15 text-amber-500">{t("boost.prefs.warn")}</Badge>}
            {pref.volatile && <Badge variant="secondary">{t("boost.prefs.volatile")}</Badge>}
            {pref.advisory && !dirty && !pref.volatile && <Badge variant="secondary">{t("boost.prefs.advisory")}</Badge>}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{pref.key}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {pref.kind === "bool" && (
            <Toggle pressed={!!current} onPressedChange={(v) => stage(v)} size="sm">
              {current ? t("boost.prefs.on") : t("boost.prefs.off")}
            </Toggle>
          )}
          {pref.kind === "percent" && (
            <div className="flex w-40 items-center gap-2">
              <Slider
                value={[Number(current ?? pref.min ?? 0)]}
                min={pref.min ?? 0}
                max={pref.max ?? 100}
                step={1}
                onValueChange={(v) => stage(Array.isArray(v) ? v[0] : Number(v))}
              />
              <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                {current == null ? "—" : `${Number(current)}%`}
              </span>
            </div>
          )}
          {pref.kind === "enum" && pref.options && (
            <Select value={current == null ? "" : String(current)} onValueChange={(v) => stage(String(v))}>
              <SelectTrigger className="w-36">
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
          {pref.kind === "path" && (
            <div className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="max-w-40 truncate text-xs text-muted-foreground">
                      {current ? String(current) : t("boost.prefs.noPath")}
                    </span>
                  }
                />
                <TooltipContent>{current ? String(current) : t("boost.prefs.noPath")}</TooltipContent>
              </Tooltip>
              <Button variant="outline" size="icon-sm" onClick={pickFolder}>
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t(`boost.prefs.items.${pref.id}.body`)}</p>
      {pref.writeOnly && <p className="mt-1 text-xs text-muted-foreground italic">{t("boost.prefs.writeOnly")}</p>}
    </div>
  );
}

export function BoostPrefsSection({ diag, app }: { diag: BoostDiagnosis | null; app: AdobeApp }) {
  const { t } = useTranslation(["optimize", "common"]);
  const [prefs, setPrefs] = useState<BoostPref[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<Record<string, Val>>({});
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const ready = !!diag?.panelConnected;

  const load = useCallback(async () => {
    if (!ready) {
      setPrefs([]);
      return;
    }
    try {
      const r = await nr.boostPrefs(app);
      setPrefs(r.prefs || []);
      setError(r.ok ? null : r.error || null);
    } catch (e) {
      setError(String(e));
    }
  }, [app, ready]);

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

  async function apply() {
    setBusy(true);
    try {
      const r = await nr.boostApplyPrefs(app, staged);
      setFailed(!r.ok);
      // Le lot est validé EN BLOC par le core : un refus ne laisse rien d'appliqué à moitié.
      setNotice(r.ok ? t("boost.prefs.applied", { count: r.applied ?? pending }) : r.error || t("notice.failed"));
      if (r.ok) setStaged({});
    } catch (e) {
      setFailed(true);
      setNotice(String(e));
    } finally {
      setBusy(false);
      setConfirm(false);
      await load();
    }
  }

  return (
    <Card className="block p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t("boost.prefs.title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {ready ? t("boost.prefs.subtitle") : t("boost.prefs.needsPanel")}
          </p>
        </div>
        {pending > 0 && (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setStaged({})} disabled={busy}>
              {t("common:action.reset")}
            </Button>
            <Button size="sm" onClick={() => setConfirm(true)} disabled={busy}>
              <SlidersHorizontal className="h-4 w-4" /> {t("boost.prefs.apply", { count: pending })}
            </Button>
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      {prefs.length > 0 && (
        <div className="mt-3 space-y-2">
          {prefs.map((p) => (
            <PrefRow key={p.id} pref={p} staged={staged[p.id]} onStage={stage} />
          ))}
        </div>
      )}

      {ready && !prefs.length && !error && <p className="mt-3 text-xs text-muted-foreground">{t("boost.prefs.none")}</p>}

      {notice && <p className={`mt-3 text-xs ${failed ? "text-destructive" : "text-[var(--color-ok)]"}`}>{notice}</p>}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("boost.prefs.applyTitle")}</DialogTitle>
            <DialogDescription>{t("boost.prefs.applyBody", { count: pending })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(false)} disabled={busy}>
              {t("common:action.cancel")}
            </Button>
            <Button size="sm" onClick={apply} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SlidersHorizontal className="h-4 w-4" />}
              {t("common:action.apply")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
