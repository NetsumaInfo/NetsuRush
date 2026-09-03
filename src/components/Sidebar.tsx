import { useState, type FocusEvent } from "react";
import { Settings, MonitorPlay, MonitorX } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { RefreshIcon } from "@/components/ui/animated-icons";
import { useApp } from "@/store";
import { hasCacheAlert } from "@/store/storage";
import { cn } from "@/lib/utils";
import { NAV } from "@/components/nav";
import { prefetchPanel } from "@/components/panels";
import { HostIcon } from "@/components/HostIcon";
import { HOSTS, hostShort } from "@/lib/host";
import { Trans, useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function Sidebar() {
  const { t } = useTranslation("shell");
  // Selector ciblé : la sidebar (toujours montée) ne re-render plus à chaque tick d'indexation.
  const { tab, setTab, moduleOrder, hiddenModules, status, statusLoading, refreshStatus, activeHost, setActiveHost, adobeStatus, refreshAdobeStatus, power, closeHost, reopenHost } = useApp(
    useShallow((s) => ({
      tab: s.tab, setTab: s.setTab, moduleOrder: s.moduleOrder, hiddenModules: s.hiddenModules,
      status: s.status, statusLoading: s.statusLoading, refreshStatus: s.refreshStatus,
      activeHost: s.activeHost, setActiveHost: s.setActiveHost, adobeStatus: s.adobeStatus, refreshAdobeStatus: s.refreshAdobeStatus,
      power: s.power, closeHost: s.closeHost, reopenHost: s.reopenHost,
    })),
  );
  // Seuil de stockage dépassé → pastille sur l'engrenage. Selector à part (booléen dérivé) : ça ne
  // re-render la sidebar que quand l'alerte bascule.
  const storageAlert = useApp(hasCacheAlert);
  // Connexion d'un hôte pour la pastille du sélecteur : Resolve = pont natif, Adobe = panneau CEP.
  const hostConnected = (id: string) =>
    id === "resolve" ? !!status?.connected : id === "ppro" ? !!adobeStatus?.ppro.panelConnected : !!adobeStatus?.aeft.panelConnected;

  // Rail replié par défaut ; s'étend au survol OU quand le focus clavier entre dedans (sinon un
  // utilisateur au clavier tombe sur des icônes sans libellé).
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Un clic souris laisse le focus sur le bouton : sans le test :focus-visible, le rail resterait
  // déplié après le départ du curseur.
  const onFocusIn = (e: FocusEvent) => {
    const el = e.target as Element;
    if (el.matches?.(":focus-visible")) setFocused(true);
  };
  const collapsed = !hovered && !focused;
  const connected = status?.connected;

  // Pastille du BAS = état de l'HÔTE ACTIF (pas toujours Resolve) → plus de rouge trompeur quand on
  // pilote After Effects. Resolve = statut du pont ; Adobe = connexion du panneau CEP.
  const adobeActive = activeHost !== "resolve";
  const adobeApp = activeHost === "ppro" ? adobeStatus?.ppro : activeHost === "aeft" ? adobeStatus?.aeft : undefined;
  const activeConnected = adobeActive ? !!adobeApp?.panelConnected : !!connected;
  const knownState = adobeActive ? !!adobeStatus : !!status;
  const activeDot = activeConnected ? "bg-[var(--color-ok)]" : knownState ? "bg-destructive" : "bg-muted-foreground animate-pulse";
  const activeLabel = adobeActive
    ? `${hostShort(activeHost)} ${activeConnected ? t("status.connectedLower") : t("status.offlineLower")}`
    : connected ? status?.project || t("status.connected") : t("status.offline");
  const navById = new Map(NAV.map((item) => [item.id, item]));
  const hiddenSet = new Set(hiddenModules);
  const visibleNav = moduleOrder
    .filter((id) => !hiddenSet.has(id))
    .map((id) => navById.get(id))
    .filter((item): item is (typeof NAV)[number] => !!item);

  return (
    <div
      className="absolute inset-y-0 left-0 z-40 overflow-hidden shadow-xl shadow-black/30"
      style={{ width: collapsed ? "46px" : "15rem", transition: "width 220ms cubic-bezier(0.4, 0, 0.2, 1)" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={onFocusIn}
      onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false); }}
    >
      {/* `nr-wp-surface` : sous un fond d'écran, ce panneau survole le contenu — il repeint le fond
          lui-même au lieu d'être translucide, sinon on verrait les boutons du module par transparence. */}
      <aside className="nr-wp-surface flex h-full w-60 flex-col bg-card">
        <ul className="flex flex-1 flex-col gap-1 px-1.5 pb-2 pt-3">
          {visibleNav.map((n) => {
            const Icon = n.icon;
            const active = n.id === tab;
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => setTab(n.id)}
                  onPointerEnter={() => prefetchPanel(n.id)}
                  className={cn(
                    "flex h-9 w-full items-center gap-3 rounded-md px-2 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    active
                      ? "bg-accent text-primary"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <Icon className="size-[18px] shrink-0" />
                  <span
                    className="whitespace-nowrap"
                    style={{
                      opacity: collapsed ? 0 : 1,
                      transform: collapsed ? "translateX(-6px)" : "translateX(0)",
                      transition: collapsed
                        ? "opacity 120ms ease-in, transform 120ms ease-in"
                        : "opacity 180ms ease-out 80ms, transform 180ms ease-out 80ms",
                    }}
                  >
                    {t(n.labelKey)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {/* Séparateurs encartés (marge latérale) : un trait pleine largeur découpait le rail en tranches. */}
        <div className="mx-2 h-px bg-border" />
        <div className="px-1.5">
          <button
            type="button"
            onClick={() => setTab("settings")}
            onPointerEnter={() => prefetchPanel("settings")}
            className={cn(
              "flex h-9 w-full items-center gap-3 rounded-md px-2 text-sm transition-colors",
              tab === "settings"
                ? "bg-accent text-primary"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {/* Pastille ANCRÉE À L'ICÔNE, pas au libellé : le rail est replié par défaut et le
                libellé disparaît — une alerte accrochée au texte serait invisible au repos. */}
            <span className="relative shrink-0">
              <Settings className="size-[18px]" />
              {storageAlert && (
                <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-destructive ring-2 ring-[var(--color-bg)]" />
              )}
            </span>
            <span
              className="whitespace-nowrap"
              style={{
                opacity: collapsed ? 0 : 1,
                transform: collapsed ? "translateX(-6px)" : "translateX(0)",
                transition: collapsed
                  ? "opacity 120ms ease-in, transform 120ms ease-in"
                  : "opacity 180ms ease-out 80ms, transform 180ms ease-out 80ms",
              }}
            >
              {t("sidebar.settings")}
            </span>
          </button>
        </div>

        {/* Sélecteur d'hôte : quel logiciel NetsuRush pilote (Resolve / Premiere / After Effects). */}
        <div className="mx-2 h-px bg-border" />
        <div className="px-1.5">
          <DropdownMenu onOpenChange={(open) => { if (open) void refreshAdobeStatus(); }}>
            <DropdownMenuTrigger
              render={
                <button type="button" className="flex h-9 w-full min-w-0 items-center gap-3 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                  <HostIcon host={activeHost} className="size-[18px]" />
                  <span
                    className="flex-1 truncate text-left"
                    style={{
                      opacity: collapsed ? 0 : 1,
                      transform: collapsed ? "translateX(-6px)" : "translateX(0)",
                      transition: collapsed
                        ? "opacity 120ms ease-in, transform 120ms ease-in"
                        : "opacity 180ms ease-out 80ms, transform 180ms ease-out 80ms",
                    }}
                  >
                    {hostShort(activeHost)}
                  </span>
                </button>
              }
            />
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("sidebar.hostPicked")}</DropdownMenuLabel>
                {HOSTS.map((h) => (
                  <DropdownMenuItem
                    key={h.id}
                    onClick={() => setActiveHost(h.id)}
                    className={cn(activeHost === h.id && "ring-1 ring-inset ring-primary")}
                  >
                    <HostIcon host={h.id} className="size-4" />
                    <span className="flex-1">{h.label}</span>
                    <span className={cn("size-2 shrink-0 rounded-full", hostConnected(h.id) ? "bg-[var(--color-ok)]" : "bg-destructive")} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="mx-2 h-px bg-border" />
        <div className="flex items-center gap-1 px-1.5">
          <DropdownMenu onOpenChange={(open) => { if (open && adobeActive) void refreshAdobeStatus(); }}>
            <DropdownMenuTrigger
              render={
                <button type="button" className="flex h-9 min-w-0 flex-1 items-center gap-3 rounded-md px-2 text-xs transition-colors hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                  <span className={cn("size-2.5 shrink-0 rounded-full", activeDot)} />
                  <span
                    className="flex-1 truncate text-left"
                    style={{
                      opacity: collapsed ? 0 : 1,
                      transform: collapsed ? "translateX(-6px)" : "translateX(0)",
                      transition: collapsed
                        ? "opacity 120ms ease-in, transform 120ms ease-in"
                        : "opacity 180ms ease-out 80ms, transform 180ms ease-out 80ms",
                    }}
                  >
                    {activeLabel}
                  </span>
                </button>
              }
            />
            <DropdownMenuContent side="top" align="start" className="w-72">
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  {adobeActive
                    ? `${hostShort(activeHost)} — ${activeConnected ? t("status.panelConnected") : t("status.panelOffline")}`
                    : connected ? t("status.resolveConnected") : t("status.resolveOffline")}
                </DropdownMenuLabel>
                {!adobeActive && connected && status?.project && (
                  <DropdownMenuItem disabled>{t("status.project", { project: status.project })}</DropdownMenuItem>
                )}
                {!adobeActive && !connected && (
                  <div className="px-2 py-1.5 text-xs leading-snug text-muted-foreground">
                    <Trans t={t} i18nKey="status.resolveHint" components={{ b1: <b />, b2: <b /> }} />
                  </div>
                )}
                {adobeActive && !activeConnected && (
                  <div className="px-2 py-1.5 text-xs leading-snug text-muted-foreground">
                    <Trans t={t} i18nKey="status.adobeHint" values={{ host: hostShort(activeHost) }} components={{ b: <b /> }} />
                  </div>
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => (adobeActive ? refreshAdobeStatus() : refreshStatus())}>
                <RefreshIcon /> {t("status.refresh")}
              </DropdownMenuItem>
              {/* Fermer / rouvrir le logiciel de montage pour libérer la RAM pendant une tâche lourde. */}
              {power?.closed ? (
                <DropdownMenuItem disabled={power.busy} onClick={() => void reopenHost()}>
                  <MonitorPlay className="size-3.5" /> {t("power.reopenHost", { host: hostShort(power.closed.host) })}
                </DropdownMenuItem>
              ) : activeConnected ? (
                <DropdownMenuItem disabled={power?.busy} onClick={() => void closeHost(activeHost)}>
                  <MonitorX className="size-3.5" /> {t("power.freeRam")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Clic DIRECT = rafraîchir (sans ouvrir le menu). Le menu reste sur la pastille/projet. */}
          <button
            type="button"
            onClick={() => (adobeActive ? refreshAdobeStatus() : refreshStatus())}
            aria-label={t("status.refresh")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            style={{
              opacity: collapsed ? 0 : 1,
              transition: collapsed ? "opacity 120ms ease-in" : "opacity 180ms ease-out 80ms",
            }}
          >
            <RefreshIcon size={14} spinning={statusLoading} />
          </button>
        </div>
      </aside>
    </div>
  );
}
