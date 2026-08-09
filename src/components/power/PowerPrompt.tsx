// Invite « libérer la RAM » + bannière de réouverture du logiciel de montage. Surface non bloquante
// (carte flottante en bas à droite) montée par l'App :
//   • une tâche lourde démarre et l'hôte actif est ouvert → propose de le fermer ;
//   • un hôte a été fermé → propose de le rouvrir sur le même projet (progression pendant l'op).
// Chaque invite est RÉDUCTIBLE en un onglet DISCRET collé au bord droit (l'icône n'apparaît qu'au
// survol) → un clic déclenche l'action (rouvrir / fermer). Prend un minimum de place.
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { MonitorX, MonitorPlay, Loader2, Minus } from "lucide-react";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { hostShort } from "@/lib/host";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const COLLAPSE_KEY = "nr.power.collapsed"; // pref persistée : garder la bannière « rouvrir » réduite

// Onglet discret collé au bord droit. Au REPOS : fine languette COLORÉE (le petit indicateur — on voit
// qu'il y a quelque chose). Au SURVOL : s'élargit, fond neutre, l'icône apparaît → clic = action.
// Tooltip pour le libellé. Aucune anim JS (CSS only).
function EdgeNub({ icon: Icon, label, onClick, tone }: {
  icon: typeof MonitorPlay; label: string; onClick: () => void; tone: "ok" | "warn";
}) {
  const col = tone === "ok" ? "text-[var(--color-ok)]" : "text-amber-500";
  return (
    <div className="group fixed bottom-6 right-0 z-50">
      <Tooltip>
        <TooltipTrigger render={
          <button type="button" onClick={onClick} aria-label={label}
            className={cn(
              "flex h-10 w-2 items-center justify-center rounded-l-md border border-r-0 border-border/50 shadow-md transition-all duration-200 group-hover:w-9 group-hover:bg-card",
              tone === "ok" ? "bg-[var(--color-ok)]" : "bg-amber-500",
            )}>
            <Icon className={cn("size-4 shrink-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100", col)} />
          </button>
        } />
        <TooltipContent side="left">{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function PowerPrompt() {
  const { t } = useTranslation("shell");
  const { power, powerProgress, ramPrompt, closeHost, reopenHost, dismissRamPrompt } = useApp(
    useShallow((s) => ({
      power: s.power, powerProgress: s.powerProgress, ramPrompt: s.ramPrompt,
      closeHost: s.closeHost, reopenHost: s.reopenHost, dismissRamPrompt: s.dismissRamPrompt,
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });
  const setCollapse = (v: boolean) => {
    setCollapsed(v);
    try { localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0"); } catch { /* best-effort */ }
  };
  // L'invite de fermeture est contextuelle (tâche lourde) → collapse LOCAL, non persisté.
  const [ramCollapsed, setRamCollapsed] = useState(false);
  useEffect(() => {
    if (ramPrompt) setRamCollapsed(false);
  }, [ramPrompt]);
  const closed = power?.closed ?? null;
  const busy = !!power?.busy;

  const reopen = async () => { setError(null); const r = await reopenHost(); if (!r.ok) { setError(r.error ?? t("power.failed")); setCollapse(false); } };
  const doClose = async (host: Parameters<typeof closeHost>[0]) => { setError(null); const r = await closeHost(host); if (!r.ok) { setError(r.error ?? t("power.failed")); setRamCollapsed(false); } };

  // Rien à montrer.
  if (!closed && !ramPrompt && !busy) return null;

  // Op en cours → carte pleine (on veut la barre de progression), sinon onglet discret si réduit.
  if (closed && !busy && collapsed) {
    return <EdgeNub icon={MonitorPlay} tone="ok" onClick={reopen}
      label={t("power.reopenHost", { host: hostShort(closed.host) }) + (closed.project ? ` — « ${closed.project} »` : "")} />;
  }
  if (ramPrompt && !closed && !busy && ramCollapsed) {
    return <EdgeNub icon={MonitorX} tone="warn" onClick={() => doClose(ramPrompt.host)}
      label={t("power.closeNub", { host: hostShort(ramPrompt.host) })} />;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-3 shadow-2xl shadow-black/40">
      {busy ? (
        <div className="flex items-center gap-3">
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{powerProgress?.msg ?? t("power.opInProgress")}</p>
            {powerProgress?.pct != null && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${powerProgress.pct}%` }} />
              </div>
            )}
          </div>
        </div>
      ) : closed ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-start gap-2.5">
            <MonitorPlay className="mt-0.5 size-4 shrink-0 text-[var(--color-ok)]" />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">{t("power.hostClosed", { host: hostShort(closed.host) })}</p>
              <p className="text-xs text-muted-foreground">
                {closed.project ? t("power.reopenToResume", { project: closed.project }) : t("power.reopenToResumeNoProject")}
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger render={
                <Button variant="ghost" size="icon-sm" onClick={() => setCollapse(true)} aria-label={t("power.collapse")}
                  className="-mr-1 -mt-1 shrink-0 text-muted-foreground" />
              }>
                <Minus className="size-4" />
              </TooltipTrigger>
              <TooltipContent>{t("power.collapseCorner")}</TooltipContent>
            </Tooltip>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={reopen}>{t("power.reopenHost", { host: hostShort(closed.host) })}</Button>
          </div>
        </div>
      ) : ramPrompt ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-start gap-2.5">
            <MonitorX className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">{t("power.closeHostQ", { host: hostShort(ramPrompt.host) })}</p>
              <p className="text-xs text-muted-foreground">
                {t(ramPrompt.host === "resolve" ? "power.resolveSafeCloseDesc" : "power.freeRamDesc")}
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger render={
                <Button variant="ghost" size="icon-sm" onClick={() => setRamCollapsed(true)} aria-label={t("power.collapse")}
                  className="-mr-1 -mt-1 shrink-0 text-muted-foreground" />
              }>
                <Minus className="size-4" />
              </TooltipTrigger>
              <TooltipContent>{t("power.collapseCorner")}</TooltipContent>
            </Tooltip>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={dismissRamPrompt}>{t("power.later")}</Button>
            <Button variant="outline" size="sm" onClick={() => doClose(ramPrompt.host)}>
              {t("power.closeHost", { host: hostShort(ramPrompt.host) })}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
