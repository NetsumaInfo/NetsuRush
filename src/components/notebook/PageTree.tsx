// Arbre de pages du carnet actif (sidebar). Créer / renommer (clic droit) / supprimer (corbeille) /
// glisser pour re-parenter. Clic = ouvre dans l'onglet actif ; Alt-clic ou clic-milieu = nouvel onglet.
// Repli local par nœud. Glisser-déposer natif (léger, pas de lib) : déposer une page
// SUR une autre la range comme enfant ; garde-fou anti-cycle (subtree). Étoile = favori.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { buildPageTree, subtreeIds, NBPAGE_LINK_PREFIX, type PageMeta, type PageTreeNode } from "./notebookShared";
import { renderPageIcon } from "./IconPicker";
import { openNotebookSharing } from "./notebookCollabState";

function TreeNode({ node, activeId, collapsed, toggle, onAskDelete, onAskMove }: {
  node: PageTreeNode;
  activeId: string | null;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  onAskDelete: (id: string, title: string) => void;
  onAskMove: (id: string) => void;
}) {
  const { t } = useTranslation("notebook");
  const openPage = useApp((s) => s.nbOpenPage);
  const openInNewTab = useApp((s) => s.nbOpenInNewTab);
  const createPage = useApp((s) => s.nbCreatePage);
  const movePage = useApp((s) => s.nbMovePage);
  const pages = useApp((s) => s.nbPages);
  const setMeta = useApp((s) => s.nbSetPageMeta);
  const isFav = useApp((s) => s.nbFavorites.includes(node.id));
  const toggleFav = useApp((s) => s.nbToggleFavorite);
  const duplicate = useApp((s) => s.nbDuplicatePage);
  const [editing, setEditing] = useState(false);
  const [over, setOver] = useState(false);

  const hasChildren = node.children.length > 0;
  const isOpen = !collapsed.has(node.id);
  const active = node.id === activeId;

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setOver(false);
    const dragId = e.dataTransfer.getData("text/nb-page");
    if (!dragId || dragId === node.id) return;
    if (subtreeIds(pages, dragId).includes(node.id)) return; // pas dans sa propre descendance
    void movePage(dragId, node.id, Date.now());
  };

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            // <div role="button"> (pas <button>) : le row contient d'autres boutons (chevron, +) →
            // un <button> imbriqué dans un <button> est du HTML invalide (erreur d'hydratation).
            <div
              role="button"
              tabIndex={0}
              draggable
              onDragStart={(e) => { e.dataTransfer.setData("text/nb-page", node.id); e.stopPropagation(); }}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={onDrop}
              onClick={(e) => {
                if (e.altKey) { void openInNewTab(node.id); return; }
                if (node.id !== activeId) void openPage(node.id);
              }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void openInNewTab(node.id); } }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (node.id !== activeId) void openPage(node.id); }
              }}
              style={{ paddingLeft: 6 + node.depth * 12 }}
              className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary ${active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"} ${over ? "ring-1 ring-primary" : ""}`}
            >
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggle(node.id); }}
                className={`shrink-0 rounded p-0.5 ${hasChildren ? "text-muted-foreground hover:bg-muted" : "invisible"}`}
              >
                <NetsuIcon name="chevron-toggle" on={isOpen} className="size-3.5" />
              </button>
              <span className="flex size-4 shrink-0 items-center justify-center">
                {node.icon ? renderPageIcon(node.icon, "size-3.5", "text-sm") : <NetsuIcon name="file-text" className="size-3.5" />}
              </span>
              {editing && active ? (
                <input autoComplete="off"
                  autoFocus
                  defaultValue={node.title}
                  onBlur={(e) => { setMeta({ title: e.target.value || t("panel.untitled") }); setEditing(false); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(false); }}
                  onClick={(e) => e.stopPropagation()}
                  className="min-w-0 flex-1 rounded bg-card px-1 text-sm outline-none"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate">{node.title || t("panel.untitled")}</span>
              )}
              {isFav && <NetsuIcon name="star" on className="size-3 shrink-0 text-primary/70" />}
              <Tooltip>
                <TooltipTrigger render={
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void createPage(node.id); }}
                    className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted group-hover:block outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <NetsuIcon name="add" className="size-3.5" />
                  </button>
                } />
                <TooltipContent>{t("tree.subpage")}</TooltipContent>
              </Tooltip>
            </div>
          }
        />
        <ContextMenuContent>
          <ContextMenuItem onClick={() => void openInNewTab(node.id)}><NetsuIcon name="open-external" className="mr-1 size-3.5" /> {t("actions.openNewTab")}</ContextMenuItem>
          <ContextMenuItem onClick={() => openNotebookSharing("notebook-page", node.id)}>{t("share.document")}</ContextMenuItem>
          <ContextMenuItem onClick={() => void navigator.clipboard.writeText(`${NBPAGE_LINK_PREFIX}${node.id}`)}><NetsuIcon name="link" className="mr-1 size-3.5" /> {t("actions.copyPageLink")}</ContextMenuItem>
          <ContextMenuItem onClick={() => toggleFav(node.id)}>
            {isFav ? <><NetsuIcon name="star-off" className="mr-1 size-3.5" /> {t("actions.removeFavorite")}</> : <><NetsuIcon name="star" className="mr-1 size-3.5" /> {t("actions.addFavorite")}</>}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => { if (node.id !== activeId) void openPage(node.id); setEditing(true); }}><NetsuIcon name="edit" className="mr-1 size-3.5" /> {t("tree.rename")}</ContextMenuItem>
          <ContextMenuItem onClick={() => void createPage(node.id)}><NetsuIcon name="add" className="mr-1 size-3.5" /> {t("tree.subpage")}</ContextMenuItem>
          <ContextMenuItem onClick={() => void duplicate(node.id)}><NetsuIcon name="copy" className="mr-1 size-3.5" /> {t("actions.duplicate")}</ContextMenuItem>
          <ContextMenuItem onClick={() => onAskMove(node.id)}><NetsuIcon name="folder-move" className="mr-1 size-3.5" /> {t("navigation.moveTo")}</ContextMenuItem>
          <ContextMenuItem onClick={() => onAskDelete(node.id, node.title)} className="text-destructive"><NetsuIcon name="trash" className="mr-1 size-3.5" /> {t("panel.sendToTrash")}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {hasChildren && isOpen && node.children.map((c) => (
        <TreeNode key={c.id} node={c} activeId={activeId} collapsed={collapsed} toggle={toggle} onAskDelete={onAskDelete} onAskMove={onAskMove} />
      ))}
    </div>
  );
}

export function PageTree({ pages, activeId, onAskDelete, onAskMove }: {
  pages: PageMeta[];
  activeId: string | null;
  onAskDelete: (id: string, title: string) => void;
  onAskMove: (id: string) => void;
}) {
  const { t } = useTranslation("notebook");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const movePage = useApp((s) => s.nbMovePage);
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const tree = buildPageTree(pages);

  return (
    <div
      className="min-h-8"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { const id = e.dataTransfer.getData("text/nb-page"); if (id) void movePage(id, null, Date.now()); }}
    >
      {tree.map((n) => <TreeNode key={n.id} node={n} activeId={activeId} collapsed={collapsed} toggle={toggle} onAskDelete={onAskDelete} onAskMove={onAskMove} />)}
      {tree.length === 0 && <div className="px-1.5 py-2 text-xs text-muted-foreground">{t("tree.empty")}</div>}
    </div>
  );
}
