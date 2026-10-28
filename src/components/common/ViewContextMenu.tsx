// Menu clic droit GLOBAL de la coquille — coiffe le contenu du module actif (`<main>`).
// But : le menu natif du navigateur ne sort JAMAIS ; à la place un menu custom, PERTINENT selon la
// vue (onglet). Les champs de texte ont leur menu d'édition (TextContextMenu, monté dans App, qui passe
// avant celui-ci). Les menus imbriqués des cartes/board/éditeurs GAGNENT (Base UI `stopPropagation` sur le trigger interne → ce menu parent
// ne s'ouvre pas dessus). Voir CLAUDE.md « UI ».
import type { ReactNode } from "react";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { NAV } from "@/components/nav";
import { useApp, type TabId } from "@/store";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuLabel, ContextMenuCheckboxItem, ContextMenuSub, ContextMenuSubTrigger,
  ContextMenuSubContent, ContextMenuGroup,
} from "@/components/ui/context-menu";
import { useTranslation } from "react-i18next";

// ── Actions propres à la vue (fond du panneau du module) ──────────────────────
function ViewItems({ tab }: { tab: TabId }) {
  const { t } = useTranslation("shell");
  const s = useApp.getState();
  switch (tab) {
    case "derush":
      return (
        <ContextMenuGroup>
          <ContextMenuLabel>{t("menu.derush")}</ContextMenuLabel>
          <ContextMenuItem onClick={() => s.backHome()}><NetsuIcon name="home" /> {t("menu.derushHome")}</ContextMenuItem>
          <ContextMenuItem onClick={() => void s.loadClips()}><NetsuIcon name="restart" /> {t("menu.reloadRushes")}</ContextMenuItem>
          <ContextMenuItem onClick={() => s.openCutTimeline()}><NetsuIcon name="scissors" /> {t("menu.cutTimeline")}</ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger><NetsuIcon name="layout-grid" /> {t("menu.section")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuCheckboxItem checked={s.derushSection === "decoupage"} onClick={() => s.setDerushSection("decoupage")}>{t("menu.sectionDecoupage")}</ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem checked={s.derushSection === "collections"} onClick={() => s.setDerushSection("collections")}>{t("menu.sectionCollections")}</ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem checked={s.derushSection === "timeline"} onClick={() => s.setDerushSection("timeline")}>{t("menu.sectionTimeline")}</ContextMenuCheckboxItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuGroup>
      );
    case "search":
      return (
        <ContextMenuGroup>
          <ContextMenuLabel>{t("menu.search")}</ContextMenuLabel>
          <ContextMenuSub>
            <ContextMenuSubTrigger><NetsuIcon name="layout-grid" /> {t("menu.resultView")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuCheckboxItem checked={s.resultView === "flat"} onClick={() => s.setResultView("flat")}>{t("menu.resultFlat")}</ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem checked={s.resultView === "clusters"} onClick={() => s.setResultView("clusters")}>{t("menu.resultClusters")}</ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem checked={s.resultView === "dedup"} onClick={() => s.setResultView("dedup")}>{t("menu.resultDedup")}</ContextMenuCheckboxItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem onClick={() => s.clearRefs()}><NetsuIcon name="erase" /> {t("menu.clearRefs")}</ContextMenuItem>
        </ContextMenuGroup>
      );
    case "upscale":
      return (
        <ContextMenuGroup>
          <ContextMenuLabel>NetsuLab</ContextMenuLabel>
          <ContextMenuCheckboxItem checked={s.nlRoto} onClick={() => s.nlSetRoto(!s.nlRoto)}><NetsuIcon name="sparkles" /> Roto Studio</ContextMenuCheckboxItem>
          <ContextMenuItem onClick={() => s.nlClearChain()}><NetsuIcon name="layers" /> {t("menu.clearChain")}</ContextMenuItem>
          <ContextMenuItem onClick={() => s.nlClearSources()}><NetsuIcon name="erase" /> {t("menu.clearSources")}</ContextMenuItem>
        </ContextMenuGroup>
      );
    case "chat":
      return (
        <ContextMenuGroup>
          <ContextMenuLabel>{t("menu.chat")}</ContextMenuLabel>
          <ContextMenuItem variant="destructive" onClick={() => s.chatClear()}><NetsuIcon name="erase" /> {t("menu.clearChat")}</ContextMenuItem>
        </ContextMenuGroup>
      );
    default:
      return null;
  }
}

// ── Groupe transversal (toujours présent, hors mode édition) ──────────────────
// Exporté : réutilisé par le menu clic droit du rail de la sidebar et le RemotePanel.
// `remote` = rendu dans le panneau CEP Adobe (iframe) : pas de fenêtre OS à épingler ni de rail
// latéral → ces items disparaissent, remplacés par un « Recharger » (seul moyen de recharger l'app
// dans l'iframe sans repasser par la barre du panneau).
function SharedAppItems({ tab, remote = false }: { tab: TabId; remote?: boolean }) {
  const { t } = useTranslation("shell");
  const s = useApp.getState();
  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger><NetsuIcon name="compass" /> {t("menu.gotoModule")}</ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-44">
          {NAV.map((n) => {
            const Icon = n.icon;
            return (
              <ContextMenuCheckboxItem key={n.id} checked={tab === n.id} onClick={() => s.setTab(n.id)}>
                <Icon /> {t(n.labelKey)}
              </ContextMenuCheckboxItem>
            );
          })}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem onClick={() => s.setTab("settings")}><NetsuIcon name="sidebar-settings" /> {t("sidebar.settings")}</ContextMenuItem>
      <ContextMenuItem onClick={() => s.openConsole()}><NetsuIcon name="console" /> {t("menu.console")}</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void s.refreshStatus(false)}><NetsuIcon name="sidebar-refresh" /> {t("menu.refreshStatus")}</ContextMenuItem>
      {remote ? (
        <ContextMenuItem onClick={() => window.location.reload()}><NetsuIcon name="restart" /> {t("menu.reloadApp")}</ContextMenuItem>
      ) : (
        <>
          <ContextMenuCheckboxItem checked={s.pinned} onClick={() => s.togglePinned()}><NetsuIcon name="window-pin" on={s.pinned} /> {t("menu.pinned")}</ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem checked={s.sidebarHidden} onClick={() => s.toggleSidebar()}><NetsuIcon name="panel-left-toggle" on={s.sidebarHidden} /> {t("menu.hideSidebar")}</ContextMenuCheckboxItem>
        </>
      )}
    </>
  );
}

// Coiffe `<main>` (rendu VIA le trigger pour ne pas ajouter de div qui casserait les chaînes h-full).
// `remote` : rendu dans le panneau CEP Adobe → items fenêtre remplacés (cf. SharedAppItems).
export function ViewContextMenu({ children, remote = false }: { children: ReactNode; remote?: boolean }) {
  const tab = useApp((s) => s.tab);
  const hasView = ["derush", "search", "upscale", "chat"].includes(tab);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<main className="min-h-0 min-w-0 flex-1 overflow-auto" />}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        {hasView && (
          <>
            <ViewItems tab={tab} />
            <ContextMenuSeparator />
          </>
        )}
        <SharedAppItems tab={tab} remote={remote} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Menu clic droit de la BARRE DE TITRE (fenêtre) — actions fenêtre + navigation rapide.
export function TitleBarMenu({
  children,
}: {
  children: ReactNode;
}) {
  const { t } = useTranslation("shell");
  const s = useApp.getState();
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <header
            data-tauri-drag-region
            className="relative flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3 select-none"
          />
        }
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        <ContextMenuCheckboxItem checked={useApp.getState().pinned} onClick={() => s.togglePinned()}><NetsuIcon name="window-pin" on={useApp.getState().pinned} /> {t("menu.pinAbove")}</ContextMenuCheckboxItem>
        <ContextMenuCheckboxItem checked={useApp.getState().sidebarHidden} onClick={() => s.toggleSidebar()}><NetsuIcon name="panel-left-toggle" on={useApp.getState().sidebarHidden} /> {t("menu.hideSidebar")}</ContextMenuCheckboxItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => s.setTab("settings")}><NetsuIcon name="sidebar-settings" /> {t("sidebar.settings")}</ContextMenuItem>
        <ContextMenuItem onClick={() => s.openConsole()}><NetsuIcon name="console" /> {t("menu.console")}</ContextMenuItem>
        <ContextMenuItem onClick={() => void s.refreshStatus(false)}><NetsuIcon name="stack" /> {t("menu.refreshStatus")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
