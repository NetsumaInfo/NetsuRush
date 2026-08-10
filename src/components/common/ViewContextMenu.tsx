// Menu clic droit GLOBAL de la coquille — coiffe le contenu du module actif (`<main>`).
// But : le menu natif du navigateur ne sort JAMAIS ; à la place un menu custom, PERTINENT selon la
// vue (onglet) ou selon la cible (champ de texte → couper/copier/coller). Les menus imbriqués des
// cartes/board/éditeurs GAGNENT (Base UI `stopPropagation` sur le trigger interne → ce menu parent
// ne s'ouvre pas dessus). Voir CLAUDE.md « UI ».
import { useRef, useState, type ReactNode } from "react";
import {
  Home, RotateCw, Scissors, LayoutGrid, Eraser, Sparkles, Layers3,
  AudioLines, Settings, Terminal, Pin, PanelLeft, Compass, Copy, ClipboardPaste,
  TextCursorInput, SquareStack, RefreshCw, Trash2,
} from "lucide-react";
import { NAV } from "@/components/nav";
import { useApp, type TabId } from "@/store";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuLabel, ContextMenuCheckboxItem, ContextMenuSub, ContextMenuSubTrigger,
  ContextMenuSubContent, ContextMenuGroup,
} from "@/components/ui/context-menu";
import { useTranslation } from "react-i18next";

// Repère le champ éditable sous le curseur (input texte / textarea / contenteditable).
// Exporté : les fenêtres détachées (Carnet) rendent le même menu d'édition — le menu natif est
// supprimé partout, chaque surface doit donc offrir couper/copier/coller.
export function editableFrom(target: EventTarget | null): HTMLElement | null {
  const node = target as HTMLElement | null;
  const ed = node?.closest?.("input, textarea, [contenteditable='true'], [contenteditable='']") as HTMLElement | null;
  if (!ed) return null;
  if (ed instanceof HTMLInputElement) {
    const t = ed.type;
    // Seuls les inputs qui portent réellement du texte éditable méritent un menu couper/copier/coller.
    return ["text", "search", "url", "email", "tel", "password", "number", ""].includes(t) ? ed : null;
  }
  return ed;
}

// ── Menu d'édition (champ de texte) ───────────────────────────────────────────
export function EditItems({ el }: { el: HTMLElement | null }) {
  const { t } = useTranslation("shell");
  // Refocalise avant d'agir : ouvrir le menu (portail) a pu retirer le focus du champ.
  const focus = () => el?.focus();
  const hasSel = () => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.selectionStart !== el.selectionEnd;
    const s = window.getSelection(); return !!s && !s.isCollapsed;
  };
  const cut = () => { focus(); document.execCommand("cut"); };
  const copy = () => { focus(); document.execCommand("copy"); };
  const paste = async () => {
    focus();
    try { const t = await navigator.clipboard.readText(); document.execCommand("insertText", false, t); } catch { /* clipboard refusé */ }
  };
  const selectAll = () => {
    focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
    else document.execCommand("selectAll");
  };
  return (
    <ContextMenuGroup>
      <ContextMenuLabel>{t("menu.edit")}</ContextMenuLabel>
      <ContextMenuItem onClick={cut} disabled={!hasSel()}><Scissors /> {t("menu.cut")}</ContextMenuItem>
      <ContextMenuItem onClick={copy} disabled={!hasSel()}><Copy /> {t("common:action.copy")}</ContextMenuItem>
      <ContextMenuItem onClick={() => void paste()}><ClipboardPaste /> {t("menu.paste")}</ContextMenuItem>
      <ContextMenuItem onClick={selectAll}><TextCursorInput /> {t("menu.selectAll")}</ContextMenuItem>
    </ContextMenuGroup>
  );
}

// ── Actions propres à la vue (fond du panneau du module) ──────────────────────
function ViewItems({ tab }: { tab: TabId }) {
  const { t } = useTranslation("shell");
  const s = useApp.getState();
  switch (tab) {
    case "derush":
      return (
        <ContextMenuGroup>
          <ContextMenuLabel>{t("menu.derush")}</ContextMenuLabel>
          <ContextMenuItem onClick={() => s.backHome()}><Home /> {t("menu.derushHome")}</ContextMenuItem>
          <ContextMenuItem onClick={() => void s.loadClips()}><RotateCw /> {t("menu.reloadRushes")}</ContextMenuItem>
          <ContextMenuItem onClick={() => s.openCutTimeline()}><Scissors /> {t("menu.cutTimeline")}</ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger><LayoutGrid /> {t("menu.section")}</ContextMenuSubTrigger>
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
            <ContextMenuSubTrigger><LayoutGrid /> {t("menu.resultView")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuCheckboxItem checked={s.resultView === "flat"} onClick={() => s.setResultView("flat")}>{t("menu.resultFlat")}</ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem checked={s.resultView === "clusters"} onClick={() => s.setResultView("clusters")}>{t("menu.resultClusters")}</ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem checked={s.resultView === "dedup"} onClick={() => s.setResultView("dedup")}>{t("menu.resultDedup")}</ContextMenuCheckboxItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem onClick={() => s.clearRefs()}><Eraser /> {t("menu.clearRefs")}</ContextMenuItem>
        </ContextMenuGroup>
      );
    case "upscale":
      return (
        <ContextMenuGroup>
          <ContextMenuLabel>NetsuLab</ContextMenuLabel>
          <ContextMenuCheckboxItem checked={s.nlRoto} onClick={() => s.nlSetRoto(!s.nlRoto)}><Sparkles /> Roto Studio</ContextMenuCheckboxItem>
          <ContextMenuItem onClick={() => s.nlClearChain()}><Layers3 /> {t("menu.clearChain")}</ContextMenuItem>
          <ContextMenuItem onClick={() => s.nlClearSources()}><Eraser /> {t("menu.clearSources")}</ContextMenuItem>
        </ContextMenuGroup>
      );
    case "voice":
      return (
        <ContextMenuGroup>
          <ContextMenuLabel>{t("menu.voice")}</ContextMenuLabel>
          <ContextMenuSub>
            <ContextMenuSubTrigger><AudioLines /> {t("menu.listen")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuCheckboxItem checked={s.previewMode === "none"} onClick={() => s.setPreviewMode("none")}>{t("menu.listenNone")}</ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem checked={s.previewMode === "all"} onClick={() => s.setPreviewMode("all")}>{t("menu.listenAll")}</ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem checked={s.previewMode === "silences"} onClick={() => s.setPreviewMode("silences")}>{t("menu.listenSilences")}</ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem checked={s.previewMode === "fillers"} onClick={() => s.setPreviewMode("fillers")}>{t("menu.listenFillers")}</ContextMenuCheckboxItem>
              <ContextMenuCheckboxItem checked={s.previewMode === "repeats"} onClick={() => s.setPreviewMode("repeats")}>{t("menu.listenRepeats")}</ContextMenuCheckboxItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem variant="destructive" onClick={() => s.resetVoice()}><Trash2 /> {t("menu.reset")}</ContextMenuItem>
        </ContextMenuGroup>
      );
    case "chat":
      return (
        <ContextMenuGroup>
          <ContextMenuLabel>{t("menu.chat")}</ContextMenuLabel>
          <ContextMenuItem variant="destructive" onClick={() => s.chatClear()}><Eraser /> {t("menu.clearChat")}</ContextMenuItem>
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
        <ContextMenuSubTrigger><Compass /> {t("menu.gotoModule")}</ContextMenuSubTrigger>
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
      <ContextMenuItem onClick={() => s.setTab("settings")}><Settings /> {t("sidebar.settings")}</ContextMenuItem>
      <ContextMenuItem onClick={() => s.openConsole()}><Terminal /> {t("menu.console")}</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void s.refreshStatus(false)}><RefreshCw /> {t("menu.refreshStatus")}</ContextMenuItem>
      {remote ? (
        <ContextMenuItem onClick={() => window.location.reload()}><RotateCw /> {t("menu.reloadApp")}</ContextMenuItem>
      ) : (
        <>
          <ContextMenuCheckboxItem checked={s.pinned} onClick={() => s.togglePinned()}><Pin /> {t("menu.pinned")}</ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem checked={s.sidebarHidden} onClick={() => s.toggleSidebar()}><PanelLeft /> {t("menu.hideSidebar")}</ContextMenuCheckboxItem>
        </>
      )}
    </>
  );
}

// Coiffe `<main>` (rendu VIA le trigger pour ne pas ajouter de div qui casserait les chaînes h-full).
// `remote` : rendu dans le panneau CEP Adobe → items fenêtre remplacés (cf. SharedAppItems).
export function ViewContextMenu({ children, remote = false }: { children: ReactNode; remote?: boolean }) {
  const tab = useApp((s) => s.tab);
  const [edit, setEdit] = useState(false);
  const elRef = useRef<HTMLElement | null>(null);
  const hasView = ["derush", "search", "upscale", "voice", "chat"].includes(tab);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<main className="min-h-0 min-w-0 flex-1 overflow-auto" />}
        onContextMenuCapture={(e: React.MouseEvent) => {
          const ed = editableFrom(e.target);
          elRef.current = ed;
          setEdit(!!ed);
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        {edit ? (
          <EditItems el={elRef.current} />
        ) : (
          <>
            {hasView && (
              <>
                <ViewItems tab={tab} />
                <ContextMenuSeparator />
              </>
            )}
            <SharedAppItems tab={tab} remote={remote} />
          </>
        )}
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
        <ContextMenuCheckboxItem checked={useApp.getState().pinned} onClick={() => s.togglePinned()}><Pin /> {t("menu.pinAbove")}</ContextMenuCheckboxItem>
        <ContextMenuCheckboxItem checked={useApp.getState().sidebarHidden} onClick={() => s.toggleSidebar()}><PanelLeft /> {t("menu.hideSidebar")}</ContextMenuCheckboxItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => s.setTab("settings")}><Settings /> {t("sidebar.settings")}</ContextMenuItem>
        <ContextMenuItem onClick={() => s.openConsole()}><Terminal /> {t("menu.console")}</ContextMenuItem>
        <ContextMenuItem onClick={() => void s.refreshStatus(false)}><SquareStack /> {t("menu.refreshStatus")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
