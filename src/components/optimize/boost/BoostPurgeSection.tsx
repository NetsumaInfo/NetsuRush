// Purges et hygiène pilotées DANS l'hôte, par l'extension CEP — sans elle la carte s'affiche,
// désactivée, en disant pourquoi.
//
// After Effects expose une API documentée (`app.purge`) ; Premiere Pro n'en a aucune et passe par le
// QE DOM, non documenté. D'où deux lignes sous chaque bouton : ce qui peut mal tourner, et sur quelles
// versions l'appel tient — sur Premiere Pro 2026 il n'est plus garanti (bascule UXP).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Eraser, Loader2, AlertTriangle, Sparkles, MemoryStick } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { nr } from "@/lib/bridge";
import type { AdobeApp, BoostDiagnosis } from "@/lib/bridge";
import { fmtBytes } from "../optimizeShared";
import { AEFT_PURGE_TARGETS, hostYear, hygieneOps, isUxpEraHost } from "./boostShared";

/** Une action en attente de confirmation : purge lourde ou hygiène projet. */
type Pending = { kind: "purge"; id: string } | { kind: "hygiene"; id: string };

export function BoostPurgeSection({
  diag,
  app,
  onChanged,
}: {
  diag: BoostDiagnosis | null;
  app: AdobeApp;
  onChanged: () => void;
}) {
  const { t } = useTranslation(["optimize", "common"]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const ready = !!diag?.panelConnected;
  const memory = diag?.live?.memoryInUse ?? null;
  const uxpEra = isUxpEraHost(app, diag);

  function report(ok: boolean, message: string) {
    setFailed(!ok);
    setNotice(message);
  }

  async function runPurge(id: string) {
    setBusy(id);
    try {
      const r = await nr.boostPurge(app, id);
      if (!r.ok) {
        report(false, r.error || t("notice.failed"));
        return;
      }
      // AE rend la mémoire avant/après : dire combien a été libéré vaut mieux qu'un « fait ».
      report(
        true,
        r.freed != null
          ? t("boost.purge.doneFreed", { size: fmtBytes(r.freed) })
          : t("boost.purge.done"),
      );
    } catch (e) {
      report(false, String(e));
    } finally {
      setBusy(null);
      setPending(null);
      onChanged();
    }
  }

  async function runHygiene(id: string) {
    setBusy(id);
    try {
      const r = await nr.boostHygiene(app, id);
      report(
        !!r.ok,
        r.ok
          ? r.removed != null
            ? t("boost.purge.hygieneDone", { count: r.removed })
            : t("boost.purge.done")
          : r.error || t("notice.failed"),
      );
    } catch (e) {
      report(false, String(e));
    } finally {
      setBusy(null);
      setPending(null);
      onChanged();
    }
  }

  async function runDeletePreviews() {
    setBusy("previews");
    try {
      const r = await nr.boostDeletePreviews(app);
      report(!!r.ok, r.ok ? t("boost.purge.previewsDone") : r.error || t("notice.failed"));
    } catch (e) {
      report(false, String(e));
    } finally {
      setBusy(null);
      setPending(null);
      onChanged();
    }
  }

  function confirmPending() {
    if (!pending) return;
    if (pending.kind === "purge") void runPurge(pending.id);
    else void runHygiene(pending.id);
  }

  return (
    <Card className="block p-4">
      <h3 className="text-sm font-semibold">{t("boost.purge.title")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {ready ? t("boost.purge.subtitle") : t("boost.purge.needsPanel")}
      </p>

      {app === "aeft" && memory != null && (
        <div className="mt-3 flex items-center gap-2 text-sm">
          <MemoryStick className="h-4 w-4 text-primary" />
          <span className="font-medium tabular-nums">{fmtBytes(memory)}</span>
          <span className="text-xs text-muted-foreground">{t("boost.purge.memoryInUse")}</span>
        </div>
      )}

      {app === "aeft" && (
        <div className="mt-3 flex flex-wrap gap-2">
          {AEFT_PURGE_TARGETS.map((target) => (
            <Button
              key={target.id}
              variant={target.heavy ? "destructive" : "outline"}
              size="sm"
              disabled={!ready || !!busy}
              onClick={() => (target.heavy ? setPending({ kind: "purge", id: target.id }) : runPurge(target.id))}
            >
              {busy === target.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eraser className="h-4 w-4" />}
              {t(`boost.purge.targets.${target.id}`)}
            </Button>
          ))}
        </div>
      )}

      {app === "aeft" && (
        <>
          <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t("boost.purge.allCachesWarning")}
          </p>
          <p className="mt-1.5 text-xs text-muted-foreground">{t("boost.purge.compatAeft")}</p>
        </>
      )}

      {app === "ppro" && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={!ready || !!busy} onClick={runDeletePreviews}>
              {busy === "previews" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eraser className="h-4 w-4" />}
              {t("boost.purge.deletePreviews")}
            </Button>
            <Badge className="bg-amber-500/15 text-amber-500">{t("boost.purge.experimental")}</Badge>
          </div>
          <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {uxpEra ? t("boost.purge.uxpEra", { year: hostYear(diag) }) : t("boost.purge.qeExperimental")}
          </p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {uxpEra ? t("boost.purge.uxpFallback") : t("boost.purge.compatPpro")}
          </p>
        </div>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> {t("boost.purge.hygiene")}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("boost.purge.hygieneHint")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {hygieneOps(app).map((op) => (
            <Button
              key={op.id}
              variant="outline"
              size="sm"
              disabled={!ready || !!busy}
              onClick={() => setPending({ kind: "hygiene", id: op.id })}
            >
              {busy === op.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {t(`boost.purge.hygieneOps.${op.id}`)}
            </Button>
          ))}
        </div>
      </div>

      {notice && <p className={`mt-3 text-xs ${failed ? "text-destructive" : "text-[var(--color-ok)]"}`}>{notice}</p>}

      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === "purge"
                ? t(`boost.purge.targets.${pending.id}`)
                : pending
                  ? t(`boost.purge.hygieneOps.${pending.id}`)
                  : ""}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === "purge" ? t("boost.purge.confirmHeavy") : t("boost.purge.confirmHygiene")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)} disabled={!!busy}>
              {t("common:action.cancel")}
            </Button>
            <Button variant="destructive" size="sm" onClick={confirmPending} disabled={!!busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eraser className="h-4 w-4" />}
              {t("common:action.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
