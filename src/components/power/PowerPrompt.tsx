// Invite « libérer la RAM » + bannière de réouverture du logiciel de montage. Surface non bloquante
// montée par l'App, dans la MÊME colonne flottante que les pastilles d'état (sinon les deux se
// recouvrent, et une tâche lourde en produit justement une de chaque) :
//   • une tâche lourde démarre et l'hôte actif est ouvert → propose de le fermer ;
//   • un hôte a été fermé → propose de le rouvrir sur le même projet (progression pendant l'op).
// Chaque invite se RÉDUIT en une languette discrète collée au bord droit, et se RETIRE tout court —
// depuis la carte comme depuis la languette, qui découvre ses deux boutons au survol. Ce qu'on retire
// n'est jamais qu'un rappel : fermer et rouvrir restent dans le menu du voyant de la barre latérale.
import { useEffect, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { MonitorX, MonitorPlay, Loader2, Minus, X } from "lucide-react";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { hostShort } from "@/lib/host";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

const COLLAPSE_KEY = "nr.power.collapsed";   // pref persistée : garder la bannière « rouvrir » réduite
const DISMISS_KEY = "nr.power.dismissed-at"; // fermeture (`closed.at`) dont le rappel a été retiré

type Tone = "ok" | "warn";

const TONE = {
  ok: { fill: "bg-[var(--color-ok)]", text: "text-[var(--color-ok)]", wash: "bg-[var(--color-ok)]/12 ring-[var(--color-ok)]/25" },
  warn: { fill: "bg-amber-500", text: "text-amber-500", wash: "bg-amber-500/12 ring-amber-500/25" },
} satisfies Record<Tone, { fill: string; text: string; wash: string }>;

function readDismissedAt(): number | null {
  try {
    const value = parseInt(localStorage.getItem(DISMISS_KEY) ?? "", 10);
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

// Languette collée au bord droit. Au REPOS : fin trait COLORÉ (on voit qu'il reste quelque chose).
// Au SURVOL (ou au focus clavier) : s'élargit en deux boutons empilés — retirer, et agir. Tout est
// en CSS, aucune animation JS.
//
// La languette est ancrée en BAS et pousse vers le HAUT : le bouton d'action garde donc la place du
// trait au repos, et « retirer » naît au-dessus, sur du vide. Sans ça, un clic lancé pendant les
// 200 ms d'ouverture atterrirait sur « retirer » alors qu'on visait l'action.
function EdgeNub({ icon: Icon, label, dismissLabel, onClick, onDismiss, tone }: {
  icon: typeof MonitorPlay; label: string; dismissLabel: string;
  onClick: () => void; onDismiss: () => void; tone: Tone;
}) {
  const shades = TONE[tone];
  return (
    <div className="group pointer-events-auto fixed bottom-6 right-0 z-50">
      <div
        className={cn(
          "flex h-10 w-1.5 flex-col overflow-hidden rounded-l-lg border border-r-0 border-border/60 shadow-md",
          "transition-[width,height,background-color] duration-200 ease-out",
          "group-hover:h-[4.5rem] group-hover:w-9 group-hover:bg-card group-hover:shadow-lg group-hover:shadow-black/30",
          "group-focus-within:h-[4.5rem] group-focus-within:w-9 group-focus-within:bg-card",
          shades.fill,
        )}
      >
        <Tooltip>
          <TooltipTrigger render={
            <button type="button" onClick={onDismiss} aria-label={dismissLabel}
              className={cn(
                "flex h-0 shrink-0 items-center justify-center overflow-hidden text-muted-foreground opacity-0 outline-none",
                "transition-[height,opacity] duration-200 ease-out",
                "group-hover:h-7 group-hover:opacity-100 group-focus-within:h-7 group-focus-within:opacity-100",
                "hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60",
              )}>
              <X className="size-3.5 shrink-0" />
            </button>
          } />
          <TooltipContent side="left">{dismissLabel}</TooltipContent>
        </Tooltip>
        <span className="h-0 w-full shrink-0 bg-border/60 transition-[height] duration-200 group-hover:h-px group-focus-within:h-px" />
        <Tooltip>
          <TooltipTrigger render={
            <button type="button" onClick={onClick} aria-label={label}
              className={cn(
                "flex flex-1 items-center justify-center opacity-0 outline-none transition-opacity duration-150",
                "group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-muted/60 focus-visible:bg-muted/60",
              )}>
              <Icon className={cn("size-4 shrink-0", shades.text)} />
            </button>
          } />
          <TooltipContent side="left">{label}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// Action de la carte : ICÔNE seule. « Fermer » et « rouvrir » se lisent sur le pictogramme ; le
// libellé complet vit dans l'infobulle, et la carte tient en trois lignes.
function IconAction({ icon: Icon, label, onClick }: { icon: typeof MonitorPlay; label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button size="icon-sm" onClick={onClick} aria-label={label}>
          <Icon className="size-3.5" />
        </Button>
      } />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// Boutons de coin de la carte : réduire (en languette) puis retirer. « Réduire » disparaît quand la
// languette est désactivée dans les Paramètres — sans elle, réduire et retirer feraient la même chose.
function CardControls({ onCollapse, onDismiss }: { onCollapse?: () => void; onDismiss: () => void }) {
  const { t } = useTranslation("shell");
  return (
    <div className="-mr-1 -mt-0.5 flex shrink-0 items-center gap-0.5 text-muted-foreground">
      {onCollapse && (
        <Tooltip>
          <TooltipTrigger render={
            <Button variant="ghost" size="icon-xs" onClick={onCollapse} aria-label={t("power.collapse")}>
              <Minus className="size-3.5" />
            </Button>
          } />
          <TooltipContent>{t("power.collapseCorner")}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger render={
          <Button variant="ghost" size="icon-xs" onClick={onDismiss} aria-label={t("power.dismiss")}>
            <X className="size-3.5" />
          </Button>
        } />
        <TooltipContent>{t("power.dismissHint")}</TooltipContent>
      </Tooltip>
    </div>
  );
}

// Même habillage que les pastilles d'état (coins, fond, ombre) : les deux vivent dans la même colonne.
function Card({ children }: { children: ReactNode }) {
  return (
    <div className="nr-power-in pointer-events-auto w-[min(17rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-card shadow-lg shadow-black/30">
      {children}
    </div>
  );
}

export function PowerPrompt() {
  const { t } = useTranslation("shell");
  const { power, powerProgress, ramPrompt, prefs, closeHost, reopenHost, dismissRamPrompt } = useApp(
    useShallow((s) => ({
      power: s.power, powerProgress: s.powerProgress, ramPrompt: s.ramPrompt, prefs: s.powerPrompt,
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
  // Rappel de réouverture RETIRÉ : mémorisé sur l'horodatage de la fermeture, donc il revient à la
  // fermeture suivante et survit à un rechargement du renderer (sinon il ressusciterait aussitôt).
  const [dismissedAt, setDismissedAt] = useState<number | null>(readDismissedAt);
  const dismissReopen = (at: number) => {
    setDismissedAt(at);
    try { localStorage.setItem(DISMISS_KEY, String(at)); } catch { /* best-effort */ }
  };
  // L'invite de fermeture est contextuelle (tâche lourde) → collapse LOCAL, non persisté.
  const [ramCollapsed, setRamCollapsed] = useState(false);
  useEffect(() => {
    if (ramPrompt) setRamCollapsed(false);
  }, [ramPrompt]);

  const busy = !!power?.busy;
  const closedState = power?.closed ?? null;
  // Rappel coupé dans les Paramètres, ou déjà retiré pour CETTE fermeture → ni carte ni languette.
  const closed = closedState && prefs.reopen && closedState.at !== dismissedAt ? closedState : null;

  const reopen = async () => { setError(null); const r = await reopenHost(); if (!r.ok) { setError(r.error ?? t("power.failed")); setCollapse(false); } };
  const doClose = async (host: Parameters<typeof closeHost>[0]) => { setError(null); const r = await closeHost(host); if (!r.ok) { setError(r.error ?? t("power.failed")); setRamCollapsed(false); } };

  // Rien à montrer.
  if (!closed && !ramPrompt && !busy) return null;

  // Op en cours → carte pleine (on veut la barre de progression), sinon languette si réduit.
  if (closed && !busy && collapsed && prefs.nub) {
    return <EdgeNub icon={MonitorPlay} tone="ok" onClick={reopen} onDismiss={() => dismissReopen(closed.at)}
      dismissLabel={t("power.dismissHint")}
      label={t("power.reopenHost", { host: hostShort(closed.host) }) + (closed.project ? ` — « ${closed.project} »` : "")} />;
  }
  if (ramPrompt && !closed && !busy && ramCollapsed && prefs.nub) {
    return <EdgeNub icon={MonitorX} tone="warn" onClick={() => doClose(ramPrompt.host)} onDismiss={dismissRamPrompt}
      dismissLabel={t("power.dismissHint")}
      label={t("power.closeNub", { host: hostShort(ramPrompt.host) })} />;
  }

  if (busy) {
    const pct = powerProgress?.pct;
    return (
      <Card>
        <div className="flex items-center gap-2.5 p-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/12 ring-1 ring-inset ring-primary/25">
            <Loader2 className="size-3.5 animate-spin text-primary" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <p className="min-w-0 flex-1 truncate text-xs font-medium">{powerProgress?.msg ?? t("power.opInProgress")}</p>
              {pct != null && <span className="shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground">{Math.round(pct)} %</span>}
            </div>
            {pct != null && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
                  style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
              </div>
            )}
          </div>
        </div>
      </Card>
    );
  }

  const view = closed
    ? {
      tone: "ok" as const,
      icon: MonitorPlay,
      title: t("power.hostClosed", { host: hostShort(closed.host) }),
      desc: closed.project ? `« ${closed.project} »` : null,
      // Un nom de projet peut être long : il se coupe. Une phrase, elle, se replie sur deux lignes.
      clipDesc: true,
      collapse: () => setCollapse(true),
      dismiss: () => dismissReopen(closed.at),
      actions: <IconAction icon={MonitorPlay} label={t("power.reopenHost", { host: hostShort(closed.host) })} onClick={reopen} />,
    }
    : ramPrompt
      ? {
        tone: "warn" as const,
        icon: MonitorX,
        title: t("power.closeHostQ", { host: hostShort(ramPrompt.host) }),
        desc: t(ramPrompt.host === "resolve" ? "power.resolveSafeCloseDesc" : "power.freeRamDesc"),
        clipDesc: false,
        collapse: () => setRamCollapsed(true),
        dismiss: dismissRamPrompt,
        actions: (
          <>
            <Button variant="ghost" size="sm" onClick={dismissRamPrompt}>{t("power.later")}</Button>
            <IconAction icon={MonitorX} label={t("power.closeHost", { host: hostShort(ramPrompt.host) })} onClick={() => doClose(ramPrompt.host)} />
          </>
        ),
      }
      : null;
  if (!view) return null;

  const shades = TONE[view.tone];
  const Icon = view.icon;
  return (
    <Card>
      <div className="flex items-start gap-2.5 p-2.5">
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-md ring-1 ring-inset", shades.wash)}>
          <Icon className={cn("size-3.5", shades.text)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold leading-tight">{view.title}</p>
              {view.desc && (
                <p className={cn("mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground", view.clipDesc && "truncate")}>
                  {view.desc}
                </p>
              )}
            </div>
            <CardControls onCollapse={prefs.nub ? view.collapse : undefined} onDismiss={view.dismiss} />
          </div>
          {error && <p className="mt-1 text-[0.6875rem] text-destructive">{error}</p>}
          <div className="mt-2 flex items-center justify-end gap-1">{view.actions}</div>
        </div>
      </div>
    </Card>
  );
}
